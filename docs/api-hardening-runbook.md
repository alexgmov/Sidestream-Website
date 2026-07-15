# Sidestream API hardening operations runbook

This is the operator contract for the hardened Sidestream API. It documents the
reviewed implementation and the human gates required to release it. It is not
evidence that a production migration, Stripe configuration change, Vercel WAF
rule, deployment, secret change, cron change, traffic change, production query,
or cutover has occurred. The documentation-remediation worker that wrote this
revision ran local checks only; it did not call live Stripe or Vercel endpoints
or read or mutate production data.

This document is the sole production migration, baseline, backfill, cutover, and
application-rollback procedure. It supersedes the older migration/cutover prose
in `docs/single-device-entitlements.md`; use that document only for device-domain
behavior, privacy, and conceptual support decisions. That reference now carries
its own prominent supersession notice and contains no executable production
mutation/support block. Do not reconstruct its retired procedure from Git
history or tickets.

## Contract at a glance

- Public reads and redirects remain server-owned. Runtime handlers never run
  schema DDL.
- All runtime database users share the pool in `api/_lib/postgres.ts` and use a
  pooled URL in production. Migration and backfill tools use a reviewed direct
  URL.
- `GET /api/checkout/start` is a read/confirmation boundary. Only a confirmed
  same-origin `POST /api/checkout/create` may create or reuse a Stripe Checkout
  Session.
- Stripe webhook requests durably record an event and acknowledge it. A claimed,
  leased queue reconciles entitlements; account and activation reads never drain
  webhook backlog.
- Download leads converge on one Postgres identity. Private Blob is a bounded
  fallback, not a second source of truth, and replay is explicit and observable.
- Three `CRON_SECRET`-protected jobs process Stripe events, replay fallback leads,
  and run retention maintenance.
- The repository does not currently contain a production maintenance rule,
  operator WAF bypass, per-job cron kill switch, Stripe dead-letter reset/replay
  tool, qualified runtime-distinct rollback artifact, failed-refund recovery
  transition, complete current-dispute-status mapping, a claim-side total-attempt
  cap, authenticated-transport support in the migration/legacy/device/reporting
  tools, or historical lifecycle repair tool.
  Every one is treated below as a control to prove or an explicit pre-production
  blocker, never as an existing capability.

## HTTP and release contract

Unless a row says otherwise, an unsupported method returns `405` with `Allow`,
and JSON responses are `no-store`.

| Route | Method | Success contract | Important failures |
| --- | --- | --- | --- |
| `/api/download` | `HEAD` | `200` attachment metadata from the selected, validated private Blob | `404` missing/unknown platform; `503` manifest or Blob metadata mismatch; `500` Blob control-plane configuration failure |
| `/api/download` | `GET` | `302` to a five-minute signed private Blob URL; matching ETag returns `304` | Same `404`/`500`/`503` failures as HEAD |
| `/api/releases/latest` | `GET` | `200` public manifest: `schemaVersion`, `product`, `channel`, `platform`, `version`, `minSupportedVersion`, `critical`, `rolloutPercent`, `publishedAt`, `releaseNotesUrl`, and public `artifact` fields | `404` unknown platform or a channel whose final normalized value is not `stable`; omitted and literal empty channel default to `stable` |
| `/api/releases/latest` | `HEAD` | `200` with the GET metadata headers and no body | Same selection failures as GET |
| `/api/releases/latest` | `OPTIONS` | `204` CORS preflight | — |
| `/api/download-lead` | `POST` | `200 {"ok":true}` after Postgres commit or `200 {"ok":true,"queued":true}` after Blob fallback | `400` validation, `409` idempotency conflict, `413` body over 8 KiB, `415` non-JSON, `429` rate limit, `503` no durable destination |
| `/api/auth/google/start` | `GET` | Sets bounded OAuth cookies and `302` redirects to Google | Invalid server configuration fails as a server error; unsafe `next` values collapse to `/account.html` |
| `/api/auth/google/callback` | `GET` | Creates the server session and `303` redirects to the allowlisted next path | `400` invalid state/code, `500` exchange/account/session failure |
| `/api/auth/session` | `GET` | Always `200`: `{"authenticated":false}` or authenticated `user`, `license`, and `billing.hasCustomer` | Dependency failure is a server `500`; this read never processes Stripe events |
| `/api/auth/logout` | `POST` | `200 {"ok":true}` after clearing the session | Dependency failure is a server `500` |
| `/api/checkout/start` | `GET` | `200` no-store confirmation HTML; an active owner redirects to account/claim | `409` unavailable intent; legacy-host activation failures redirect to `activation_required`; no Stripe write occurs |
| `/api/checkout/create` | `POST` | Form clients receive `303` to Stripe; JSON clients receive `200 {"url":"...","reused":boolean}` | `400` malformed; `401 authentication_required`; `403 csrf_rejected` or `intent_account_mismatch`; `409 active_license`, `intent_expired`, `activation_unavailable`, or `activation_window_too_short`; `429 rate_limited`; unhandled DB/Stripe failure is `500` |
| `/api/checkout/complete` | `GET` | Verifies the exact attached Session/Price/Product, reconciles payment, then `303` to thank-you | `400` missing session, `409` payment not ready or exact contract mismatch |
| `/api/billing/portal` | `POST` | Authenticated `200 {"url":"..."}` for a Stripe Customer Portal Session | `401` unauthenticated, `400` no linked Stripe customer, Stripe failure is a server `500` |
| `/api/billing/receipt` | `POST` | Authenticated `200 {"url":"..."}` for the latest owned charge receipt | `401` unauthenticated, `403` customer mismatch, `404` no purchase/receipt URL, Stripe failure is a server `500` |
| `/api/stripe/webhook` | `POST` | `200 {"received":true}` after durable insert; duplicate acknowledgment also includes `"duplicate":true` | `400` missing/invalid signature; an unhandled durable-storage failure is a server `500` and must be retried by Stripe |
| `/api/activation/start` | `POST` | `200` with `activationKey`, 24-hour `expiresAt`, `upgradeUrl`, and `restoreUrl` | `400 invalid_request` for missing device; an unexpected dependency failure is a server `500` |
| `/api/activation/status` | `POST` | `200` state payload: `pending`, `pending_payment`, `active`, `completed`, `not_found`, `device_mismatch`, `expired`, `transfer_required`, `transfer_limit_reached`, `device_replaced`, or `device_deactivated` | A parsed non-null JSON value missing valid `activationKey` or `deviceId` returns `400 invalid_request`; valid JSON `null`, malformed JSON, and body-read failures currently escape as an unshaped platform `5xx`, not `400`; `503` environment unavailable |
| `/api/activation/claim` | `GET` / `POST` | GET is read-only sign-in/confirmation HTML; same-origin CSRF-valid POST restores/reconnects/transfers | `400` invalid/transfer intent; `401` sign-in required; `403` inactive or CSRF; `409` unavailable, binding changed, transfer limit, or claim conflict; `503` environment unavailable |
| `/api/license/verify` | `POST` | `200` current credential result | `400 invalid_request`; `401 invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`; `403 license_inactive`; `503` retryable environment failure |
| `/api/license/refresh` | `POST` | `200` atomically rotated access/refresh pair; predecessor replay is deterministic for two minutes | Same stable `400`/`401`/`403`/`503` classes as verify |
| `/api/license/authorize-download` | `POST` | Exactly `200 {"active":true}` for the active device | `401` revoked/replaced/deactivated device; `403` inactive; `503 {"code":"authorization_unavailable"}` is retryable |
| `/api/account/device` | `GET` | `200 {"active":boolean,"device":object|null}` with coarse device data | `401` unauthenticated; `503` unavailable |
| `/api/license/deactivate` | `POST` | `200 {"active":false,"deactivated":boolean}` for intent `deactivate_active_device` | `400 invalid_intent`, `401 authentication_required`, `403 same_origin_required`, or retryable `503 deactivation_unavailable` |
| `/api/internal/stripe-events/process` | `GET` | `200 {"ok":true,"claimed":n,"processed":n,"ignored":n,"retryable":n,"deadLetter":n}` | `401 unauthorized`, `503 processor_unavailable`, `500 processing_failed` |
| `/api/internal/download-leads/replay` | `GET` / `POST` | `200 {"ok":true,"summary":{...},"nextCursor":string|null,"hasMore":boolean}` | `400` invalid controls/JSON, `401 unauthorized`, `415` non-JSON POST, `503 replay_unavailable`, `blob_unavailable`, or `invalid_blob_page`; per-record failures stay in the summary |
| `/api/internal/maintenance` | `GET` | `200 {"ok":true,"outcome":"completed"|"locked","durationMs":n,"batchSize":n,"hasMore":boolean,"counts":{...}}` | `401 unauthorized`, `503 maintenance_unavailable`, `500 maintenance_failed` |

Browser/account behavior and device support procedures are expanded in
`docs/single-device-entitlements.md`, but its production migration/cutover prose
is superseded by this runbook. None of those reads processes the Stripe event
queue.

### Platform matrix

The release and download routes call the same manifest selector. A mismatch
between these surfaces is a release-blocking incident.

The URL parser decodes `platform`, then the selector trims and lowercases it.
The table therefore lists normalized aliases: casing is ignored (`WINDOWS` is
accepted) and surrounding decoded whitespace is ignored (`%20windows%20` is
accepted). Omission alone selects Mac; an empty value after trimming or any
unknown normalized value returns `404`.

| Query `platform` | Public platform | Manifest | Artifact | Result |
| --- | --- | --- | --- | --- |
| omitted, `darwin-arm64`, `darwin-x64`, `macos`, `macos-arm64`, `macos-x64` | `macos` | `data/release-manifest.json` | DMG | Mac release |
| `win32-x64`, `windows`, `windows-x64` | `win32-x64` | `data/release-manifest.windows.json` | EXE | Windows release |
| empty or any other value | — | — | — | `404`; never fall back to another OS |

Compare the manifest response with download `HEAD`: platform, version, SHA-256,
filename, and size must agree with `X-Sidestream-Platform`,
`X-Sidestream-Version`, `X-Sidestream-Sha256`, `Content-Disposition`, and
`Content-Length`.

### Release-channel normalization

Only `/api/releases/latest` reads `channel`. `URLSearchParams` first URL-decodes
the query value. An omitted value (`null`) or literal empty `channel=` is replaced
with `stable` before sanitization. Every non-empty decoded value is trimmed,
lowercased, stripped of every character outside `[a-z0-9_.-]`, and truncated to
40 characters. The request succeeds only when that final value is exactly
`stable`. Thus `channel=STABLE`, `channel=%20stable%20`, and
`channel=s%20table` currently resolve to `stable`; a whitespace-only non-empty
value sanitizes to empty and returns `404`, as does every other final value.
`/api/download` does not read this parameter. This permissive stripping behavior
is current implementation truth, not a recommended new parser contract.

## Checkout, activation, and entitlement lifecycle

### Confirmed Checkout flow

1. `GET /api/checkout/start` creates or resumes a database Checkout intent and
   renders a no-store confirmation page. It must not initialize Stripe, create a
   Customer, resolve/create a Price, or create a Checkout Session.
2. The form submits signed intent fields to same-origin
   `POST /api/checkout/create`. The signed confirmation is valid for 10 minutes;
   the database intent expires after 24 hours.
3. The POST atomically consumes limits of 8 requests per intent and 20 per IP in
   a 15-minute window. It locks the intent, creates or reuses one Stripe Session
   with a stable idempotency key, and persists the exact Session/Price/Product.
4. Checkout uses `mode=payment`, one card line item with quantity one, invoice
   creation, promotion codes, and the copy `One-time payment. No subscription.`
5. The success URL keeps Stripe's literal `{CHECKOUT_SESSION_ID}` placeholder and
   returns through `/api/checkout/complete`. Completion re-fetches Stripe truth;
   the browser URL is never payment proof.
6. The signed webhook remains the primary durable path. Completion and the
   device-validated activation fallback converge on the same locked,
   watermark-protected reconciliation helper.

Persisted intent state is constrained to `pending`, `open`, `completed`,
`cancelled`, `expired`, or `failed`. A cancelled browser return remains a GET
read; its next signed confirmation POST may explicitly request bounded Session
rotation. A caller cannot supply its own Stripe or activation tuple.

New one-time purchases must match both allowlisted resources: Product
`SIDESTREAM_PRO_PRODUCT_ID` (default `prod_UpwXh6oO1OmPyQ`) and either the exact
`SIDESTREAM_PRO_PRICE_ID` or the active `$9.99` one-time Price with lookup key
`sidestream_pro_once_999`. `SIDESTREAM_UNLIMITED_PRICE_ID` is accepted only as a
legacy fallback when it belongs to that Product.

### Activation compatibility

Activation is device-bound and lasts 24 hours. A Checkout activation must retain
at least 31 minutes, persists Stripe expiry, and gets a 10-minute post-payment
claim grace. Current clients (1.0.14 and later) receive a seven-day access token
plus a rotating 365-day refresh credential; status replays the credential family
for only 10 minutes, then returns `completed`. Legacy clients through 1.0.13
cannot persist refresh credentials, so they receive a rolling 365-day access
token and status remains `active` for the activation's 24-hour life. Compatibility
uses the persisted activation version, never a request user agent.

Production permits one active device per account. Test is a separate restricted
namespace and not a second seat. A same-device reconnect is free; a confirmed
move revokes the previous device and is bounded to three moves in a rolling 30
days. See `docs/single-device-entitlements.md` for support actions and privacy
rules.

### Current entitlement transitions and unresolved blockers

Only `entitlement_status=active` with plan `sidestream_pro` or the compatible
`sidestream_unlimited` is paid access.

The following table describes current code; it is not yet complete canonical
Stripe truth and must not be used to approve production cutover:

| Stripe fact | Current result | Credential effect / limitation |
| --- | --- | --- |
| Exact one-time payment paid | `active / payment_paid` | May issue credentials |
| Partial refund | `active / partial_refund` | Remains active |
| Full refund | `revoked / full_refund` | Irreversible in current code; later Checkout or a failed-refund update cannot restore access |
| `warning_needs_response`, `warning_under_review`, `needs_response`, or `under_review` dispute | `suspended / dispute_open` | Conservative suspension while inquiry/dispute is open |
| `warning_closed` or `prevented` dispute | **Incorrectly** `suspended / dispute_open` | Stripe defines these as non-open terminal outcomes, but current code treats every nonempty status other than `won` as open |
| Dispute won | `active / dispute_won` | May reactivate only when the stored reason is not already irreversible `dispute_lost` |
| Dispute lost | `revoked / dispute_lost` | Irreversible in current code, including if later canonical Stripe truth reports `won` |
| Payment not paid | `revoked / payment_not_paid` | No credentials |
| Unknown or unallowlisted legacy subscription | `unknown` or quarantined `revoked` | No paid access |

The `(stripe_created_at, event_id)` watermark makes lifecycle application
deterministic under duplicate or out-of-order delivery. Never edit entitlement
state by hand to jump ahead of that watermark.

Two implementation gaps block production. First, Stripe returns failed refund
funds to the merchant balance and emits `refund.failed`, but
`reconcileStripeEvent()` neither subscribes to nor handles that type. The current
`full_refund` transition and persisted maximum refunded amount are irreversible,
so later canonical recovery cannot restore access. A separate code-owned change
must add `refund.failed` handling, tests, and a reviewed recovery transition (or
obtain explicit business approval for permanent refund-intent revocation plus a
tested manual customer-recovery procedure). No such approval or procedure exists
today. Second, Stripe's current Dispute object includes `warning_closed` and
`prevented` as non-open outcomes, while the current mapper suspends both; it also
makes `lost` irreversible. A separate change must explicitly map and test every
current status, or obtain documented approval for a conservative anti-abuse
policy and its recovery consequences. Until both gaps are resolved and proved in
Preview/Test, this runbook is not executable in production. Primary contracts:
[Stripe refunds](https://docs.stripe.com/refunds) and the
[Stripe Dispute object](https://docs.stripe.com/api/disputes/object).

<!-- BLOCKER: HISTORICAL-LIFECYCLE-RECONCILIATION -->

There is an additional pre-cutover **historical lifecycle** blocker. Existing
rows for refund/dispute events may already be terminal `ignored` or `processed`
under the known-bad mapper. `recordStripeEvent()` uses event-ID conflict-ignore,
claims require `terminal_at is null`, and ignored/processed rows have
`terminal_at`, so resending an old event cannot repair it after the mapper is
fixed. The repository currently has no historical audit/reconciliation tool.

Production remains blocked until a separately owned implementation supplies a
tested, idempotent tool that scans the complete relevant Stripe account history
and local ledger, identifies every affected event by exact event ID and type,
re-derives canonical Stripe truth, performs only watermark-safe reconciliation,
and retains the input event-ID set, before/after outcome, and resulting
entitlement watermark. An initial full scan before maintenance is only
provisional. It must retain an inclusive `HISTORICAL_LIFECYCLE_SCAN_WATERMARK`,
the complete exact-ID/type input manifest and checksum, source bounds/counts,
authenticated target evidence, canonical outcomes, and each resulting
`stripe_state_event_created_at` / `stripe_state_event_id` pair. A bare maximum
Stripe event ID or `stripe_created_at` is not a safe cursor: event IDs are not
sortable clocks, and an older event can be delivered after the scan. A delta must
therefore be derived by exact manifest comparison, or the tool must repeat the
complete scan under a stable snapshot.

That provisional scan cannot close the blocker while the known-bad artifact can
still accept and terminalize another lifecycle event. At the explicit point in
step 9 after the deny is proved active and every old in-flight invocation/write
has drained, the tool must run a final canonical full scan or exact
manifest-derived delta. It must cover every refund/dispute lifecycle ID through
the deny boundary, including every lifecycle ID in `PREDRAIN_EVENT_IDS` and every
transition-window ID accepted or observed after the provisional scan. Retain the
final exact-ID manifest/checksum and `HISTORICAL_LIFECYCLE_DENY_WATERMARK`, repair
affected terminal `processed`/`ignored` history through the reviewed idempotent
reconciler, prove canonical entitlement state plus each resulting entitlement
watermark, and prove an immediate second run is a no-op. A terminal queue status
is transport evidence, not canonical lifecycle evidence. The gate may instead
close only with the same final post-deny evidence proving no affected history.
Any missing ID, unstable snapshot, watermark regression, late through-boundary
ID, or canonical mismatch blocks step 10 and reopening.

Manual updates to event status, `terminal_at`, payload, entitlement state,
credentials, or watermarks are forbidden. This documentation-only step does not
invent the required tool, and the at-most-72-hour maintenance-window enumeration
later in this runbook is not a substitute for either phase of this gate.

Legacy subscriptions are fail-closed. Eligibility requires an exact Product in
`SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and exact Price in
`SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS`, one licensed item with quantity one,
and a valid active/trialing monthly recurring term. Both comma-separated
allowlists default empty. Inventory first; backfill eligible rows and quarantine
everything else only after human review.

## Postgres ownership and migrations

`api/_lib/postgres.ts` owns the single attached runtime pool, query helpers, and
transactions for accounts, activation, Checkout, Stripe, leads, rate limits,
installer referrals, and maintenance. Production URL precedence is:

1. `SIDESTREAM_POSTGRES_URL`
2. `SIDESTREAM_POSTGRES_PRISMA_URL`
3. `POSTGRES_URL`
4. `POSTGRES_PRISMA_URL`

`SIDESTREAM_POSTGRES_URL_NON_POOLING` and `POSTGRES_URL_NON_POOLING` are permitted
as development/test fallback and for operator tools. A production runtime with
only a direct URL fails closed. Do not give direct migration credentials to a
browser, CEP build, or normal serverless runtime.

The ordered SQL chain is checksummed in
`public.sidestream_schema_migrations`. The runner takes a global advisory lock,
refuses checksum drift, and commits each migration plus its ledger row in one
transaction. Only the following modes are executable without a database; they
return before env-file loading and target selection and are safe for local
repository verification, not Production-state evidence:

```bash
npm run db:migrate -- --validate
npm run db:migrate -- --dry-run
```

Database-backed `--status`, `--baseline`, and apply require a connection. Use the
current implementation only with a loopback disposable database. Never run those
three current modes, or `verify-migration-baseline.mjs`, against Production; the
human-gated procedure below keeps them blocked pending authenticated tooling.

An existing non-empty schema without the ledger is not automatically assumed to
be current. `--status` reports that a baseline is required; `--baseline` checks
the known pre-hardening schema and records only migrations it can prove. Applying
refuses an unbaselined non-empty schema. The chain currently ends with
`20260714200000_remove_redundant_download_lead_key_unique.sql`: canonical lead
uniqueness is `(email, cta_source)` and `lead_key` remains a non-unique lookup
index. Runtime DDL is prohibited and checked by
`node scripts/assert-no-runtime-ddl.mjs`.

`npm run db:migrate -- --status` is the authoritative read-only applied/pending
filename inventory for the complete checksummed chain. When a ledger exists it
loads every ledger checksum and fails on any local mismatch, but `printStatuses`
emits only `<status>: <filename>`; it does not print retainable checksum values.
`--validate` checks only local ordering/checksums and `--dry-run` lists local
files; both exit before env-file loading or database selection. Retain future
authenticated status plus the separate local-and-ledger checksum export in
cutover step 7 before and after mutation. `scripts/verify-migration-baseline.mjs`
is narrower. It recognizes a known pre-20260713 catalog, verifies its conditional
RLS state, and reports only the baseline-era/activation-rotation guard it
understands. It neither loads `SIDESTREAM_DB_ENV_FILE` nor enumerates every later
hardening migration, so it must use explicit process injection and must never
replace or contradict status/checksum evidence.

## Stripe event ledger

### Required Stripe webhook subscriptions

After the lifecycle blockers above are fixed and tested, the target production
endpoint must select exactly the reviewed lifecycle events:

- Checkout completion: `checkout.session.completed`
- Refund lifecycle: `charge.refunded`, `charge.updated`, `refund.created`,
  `refund.updated`, `refund.failed`
- Dispute lifecycle: `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed`
- Allowlisted legacy subscriptions: `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`

The current exhaustive switch implements every item above **except**
`refund.failed`; an unimplemented event is durably recorded and then ignored.
Do not add that event to the live destination and do not cut over while this gap
exists. Expanding behavior requires code, tests, endpoint selection, and this
contract to change together. Stripe's endpoint `enabled_events` is the selection
for that endpoint, while Workbench Event deliveries show attempts to that
endpoint; neither is an account-wide event inventory. See the primary
[Webhook Endpoint object](https://docs.stripe.com/api/webhook_endpoints/object),
[Workbench overview](https://docs.stripe.com/workbench/overview), and
[List Events API](https://docs.stripe.com/api/events/list).

### State machine and retry policy

```text
received ──claim──> processing ──success──> processed (terminal)
                        │        └────────> ignored (terminal)
                        ├─caught failure, attempt < 8──> retryable ──due claim──┐
                        ├─caught failure, attempt >= 8─> dead_letter (terminal)│
                        └─process termination──> expired lease ────────────────┘
```

Claims use `FOR UPDATE SKIP LOCKED`, a UUID claim token, an incremented attempt,
and a lease. The general worker defaults are batch 10 and a five-minute lease;
the cron is fixed at batch 25 with a ten-minute lease. A **caught** processing
failure uses a maximum-attempt argument of eight: below it the row becomes
`retryable`, and at or above it the failure handler makes the row `dead_letter`.
Backoff is exponential from five seconds, jittered to 50-100%, capped at 15
minutes, and at least one second.

That is not an absolute eight-claim bound. If the process terminates after claim,
the failure handler never runs. After lease expiry, the claim query has no
`attempt_count` predicate, reclaims the row, and increments the counter again.
Repeated termination/reclaim cycles can therefore continue indefinitely. This is
an explicit Production blocker: a separately owned code change must impose a
claim/reclaim-side total-attempt terminal cap, preserve race-safe claim semantics,
and test repeated process termination plus lease expiry. Until that exists, any
nonterminal row at or above attempt eight is a critical incident and no document
may call local processing absolutely bounded. Poison events still cannot make
`/api/auth/session` or other customer reads process the queue.

`dead_letter` is terminal: the row has `terminal_at` set and the claim query
cannot select it. This repository currently has no Stripe dead-letter reset or
replay CLI, API route, or audited SQL procedure. Do not change queue status,
`terminal_at`, watermarks, or entitlement rows by hand. Any dead letter in
Preview/Test blocks production promotion. A production dead letter is a critical
incident: preserve its payload before retention redacts it, globally disable
project cron scheduling if processing must stop, fix the cause, and add separately
reviewed event-specific recovery tooling plus tests before any replay attempt.
Until that tooling exists, the event remains terminal.

The live Stripe event destination must remain enabled throughout maintenance and
rollback. Stripe documents that events created while a destination is disabled
are not automatically resent. Maintenance therefore denies the webhook at the
edge so delivery receives a non-`2xx`, records the exact UTC/event-ID window,
then explicitly reconciles every delivery before other writes reopen. A live
automatic retry path lasts only up to three days. Dashboard/Workbench manual
Resend is available only up to 15 days after event creation, and
`stripe events resend` only up to 30 days. These are recovery ceilings, not a
license for an open-ended maintenance window. This runbook caps the planned
closed-write maintenance window at two hours, pages the incident/cutover owner if
complete reconciliation is still unresolved 24 hours after the earliest event
in the window, and hard-aborts the cutover by 48 hours after that earliest event,
leaving at least a 24-hour margin before automatic retry eligibility can expire.
The webhook stays open for reconciliation but all other writes remain blocked;
the operator must start explicit reviewed resend/export recovery before any
applicable 15-day or 30-day ceiling. Stripe's
[event-destination operations](https://docs.stripe.com/workbench/event-destinations)
and [webhook retry contract](https://docs.stripe.com/webhooks) are the primary
platform references. A Stripe delivery retry is distinct from the local
terminal dead-letter state described above.

## Download-lead fallback and replay

`POST /api/download-lead` normalizes email/source, converges on one row per
`(email, cta_source)`, keeps first/last timestamps and submission count, and
supports `Idempotency-Key` up to 128 characters. Atomic Postgres rate limits are
5 per email and 20 per IP per 10 minutes. Only HMACs of limiter dimensions and
idempotency material are stored.

When an otherwise-valid capture cannot use Postgres, the route writes a deterministic private Blob
under `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX` (default
`sidestream/download-leads`). It merges with ETag compare-and-swap for at most
five attempts and rejects Blob bodies over 16 KiB. Because the database limiter
is unavailable in this path, an edge WAF limit is required before production.

Scheduled `GET /api/internal/download-leads/replay` always scans at most 25 and
uses delete-after-commit. Manual `POST` accepts only `cursor`, `limit` 1-100, and
`disposition` `preserve` or `delete`; its default is preserve. Replay understands
canonical and legacy date/UUID paths. An unmapped record is counted but never
read or deleted. A mapped Blob is deleted only after its database transaction
commits and only while its captured ETag still matches. Malformed, read-failed,
database-failed, or delete-failed records remain for operator review.

The exact replay `summary` fields are `listed`, `mapped`, `replayed`,
`idempotent`, `malformed`, `unmapped`, `readFailed`, `databaseFailed`, `deleted`,
and `deleteFailed`.

## Configuration reference

Never paste values into this document, tickets, chat, browser code, or CEP code.

| Area | Variables and bounded contract |
| --- | --- |
| Scheduler | `CRON_SECRET`: one stable random value, 16-512 printable non-space ASCII characters (`U+0021`-`U+007E`), sent as `Authorization: Bearer ...` to every internal route. Generate 32 random bytes as a 64-character hexadecimal token in the approved secret manager; spaces, tabs, newlines, and non-ASCII are outside the shared contract because lead replay rejects them even though the other two validators do not enforce this character class. |
| Runtime database | Pooled URL precedence above; `POSTGRES_POOL_MAX` default 4, range 2-20; `POSTGRES_POOL_IDLE_TIMEOUT_MS` 10000, 1000-60000; `POSTGRES_CONNECTION_TIMEOUT_MS` 5000, 250-30000; `POSTGRES_QUERY_TIMEOUT_MS` and `POSTGRES_STATEMENT_TIMEOUT_MS` 10000, 250-60000; `POSTGRES_SSL=0` only for a known local target |
| Migration database | `SIDESTREAM_POSTGRES_URL_NON_POOLING` preferred; `POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS` defaults to 300000 and is bounded 1000-1800000; runner pool max is 1 |
| Test database | `SIDESTREAM_TEST_POSTGRES_URL` is mandatory for integration tests, must be disposable, and must not normalize to any runtime host/port/database target |
| Rate limiter | `SIDESTREAM_RATE_LIMIT_HASH_SECRET`, at least 32 characters and stable; no production fallback. Checkout is fixed at 8/intent and 20/IP per 15 minutes; lead capture is fixed at 5/email and 20/IP per 10 minutes |
| Checkout intent | Signed confirmation TTL 10 minutes; database intent TTL 24 hours; fixed code constants. Product/Price variables are `SIDESTREAM_PRO_PRODUCT_ID`, `SIDESTREAM_PRO_PRICE_ID`, and legacy `SIDESTREAM_UNLIMITED_PRICE_ID` |
| Stripe retries | Batch/lease/backoff and caught-failure attempt-8 behavior are described above. Crash/lease-reclaim attempts are currently unbounded because the claim query has no total-attempt cap; that is a Production blocker. Legacy allowlists are `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS` |
| Lead fallback | `SIDESTREAM_LEAD_HASH_SECRET` at least 32 characters (may intentionally share the rate-limit secret), `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX`, plus Vercel Blob auth variables |
| License/device | If `SIDESTREAM_LICENSE_HASH_SECRET` is absent, the current device HMAC secret falls back to the first configured runtime value in this order: `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`. The runtime trims/selects and URL-normalizes that connection value before hashing; before any URL/pool change, securely capture the exact resulting bytes and duplicate them into `SIDESTREAM_LICENSE_HASH_SECRET` without logging or further parsing/re-encoding/normalization. Prove continuity with the same real device/token before and after promotion. `SIDESTREAM_DEVICE_POLICY_MODE` is `off`, `observe`, or `enforce`; `SIDESTREAM_TEST_API_HOSTS` strictly identifies Test hosts. |
| Maintenance | `SIDESTREAM_MAINTENANCE_BATCH_SIZE` 100 (1-500); `SIDESTREAM_LICENSE_WRITE_THROTTLE_SECONDS` 3600 (60-86400); `SIDESTREAM_LEGACY_TOKEN_RENEWAL_THRESHOLD_DAYS` 30 (1-180); `SIDESTREAM_WEB_SESSION_GRACE_DAYS` 7 (1-90); `SIDESTREAM_ACTIVATION_SESSION_GRACE_DAYS` and `SIDESTREAM_CREDENTIAL_AUDIT_GRACE_DAYS` 30 (7-365); `SIDESTREAM_RATE_LIMIT_GRACE_HOURS` 24 (1-168); `SIDESTREAM_CHECKOUT_INTENT_GRACE_DAYS` 7 (1-90); `SIDESTREAM_STRIPE_PAYLOAD_RETENTION_DAYS` 14 (1-90); `SIDESTREAM_STRIPE_DEAD_LETTER_PAYLOAD_RETENTION_DAYS` 90 (14-365 and not below processed retention) |

### Pool budget

Choose `POSTGRES_POOL_MAX` from the provider connection limit, not from traffic
hope. Reserve at least 20% for migrations, support, and provider overhead, then
use:

```text
per-instance pool budget = floor((provider connection limit - reserve) / maximum concurrent warm instances)
POSTGRES_POOL_MAX = min(20, max(2, per-instance pool budget))
```

If the result is below 2, reduce serverless concurrency or increase the database
limit before deployment. Do not compensate by using the direct URL at runtime.

## Metrics, dashboards, and alerts

Logs must preserve event IDs/outcomes and aggregate counts, never raw secrets,
tokens, device IDs, full Stripe payloads, or lead email addresses.

| Signal | Metric/query | Alert threshold and response |
| --- | --- | --- |
| Pending/retry Stripe events | Count `received`, due `retryable`, and expired `processing` leases | Warning when any due work remains for 10 minutes; critical at 30 minutes. Check cron auth, database, then worker errors. |
| Dead-letter Stripe events | Count `processing_status='dead_letter'` and newest transition | Critical on any new dead-letter. Preserve payload and fix the root cause. No reset/replay tool currently exists, so Preview/Test promotion is blocked and production recovery requires separately reviewed tooling; never mutate queue or entitlement rows manually. |
| Crash/reclaim attempt overflow | Count `terminal_at is null and attempt_count >= 8`, including future retryable rows and unexpired processing leases | Critical on any row. The current claim path can reclaim indefinitely after repeated process termination; stop promotion and require the total-attempt implementation blocker to close. |
| Oldest event age | Age of oldest due nonterminal event | Warning over 10 minutes, critical over 30 minutes; the processor runs every five minutes. |
| Event failures | `retryable + deadLetter` divided by claimed, plus `processing_failed` route outcomes | Warning above 5% with at least 5 claims in 15 minutes; critical above 20% or any route-level failure for 5 minutes. |
| Checkout volume | Confirmation GETs, confirmed POSTs, created/reused Sessions, `csrf_rejected`, dependency errors | Warning when create failures exceed 1% or 5 in 15 minutes. A GET without a matching confirmation POST is abandonment, not a Stripe failure. |
| Rate limit | `429 code=rate_limited` by scope and total eligible requests | Warning when checkout or lead 429s exceed 5% with at least 10 requests in 15 minutes; investigate abuse before raising limits. |
| Lead fallback backlog | Private Blob count and oldest age under the configured prefix | Warning if nonzero for 15 minutes after Postgres recovers or oldest exceeds 30 minutes; critical over 2 hours or growth across two replay intervals. |
| Unmapped Blob records | Replay `summary.unmapped` and path sample without lead contents | Critical on any new unmapped record. Quarantine/preserve it; do not auto-delete. |
| Maintenance | Missing run, `maintenance_failed`, `hasMore`, duration, and every deletion/redaction count | Critical on any failed run or no completed/locked run in 26 hours; warning when `hasMore` or a count reaches batch size for 3 runs, or a count exceeds 4x its rolling seven-day median. |
| DB pool saturation | Provider connections, pool waiters/acquisition timeouts, query/statement timeouts | Warning at 80% provider connections for 5 minutes or waiters for 1 minute; critical at 90% or any sustained acquisition timeout. Reduce concurrency/pool, do not switch to direct runtime URLs. |
| Release-platform mismatch | Compare manifest and download HEAD platform/version/SHA/filename/size for Mac and Windows aliases | Critical on any mismatch or an unknown platform that does not return `404`; stop promotion and use only the pre-qualified schema-compatible manifests/application artifact. |

Useful read-only queue snapshot:

```sql
select processing_status, count(*)
from public.sidestream_stripe_events
group by processing_status
order by processing_status;

select min(coalesce(next_attempt_at, received_at)) as oldest_due_at
from public.sidestream_stripe_events
where terminal_at is null
  and (
    (processing_status in ('received', 'retryable') and next_attempt_at <= now())
    or (processing_status = 'processing' and lease_expires_at <= now())
  );

select event_id, event_type, processing_status, attempt_count,
       next_attempt_at, lease_expires_at
from public.sidestream_stripe_events
where terminal_at is null
order by stripe_created_at, event_id;
```

The due/expired query drives normal scheduling alerts. It is **not** the
pre-maintenance zero-backlog test: that gate uses the final query and requires no
row at all with `terminal_at is null`, including future retryable work and an
unexpired processing lease.

Maintenance runs under an advisory transaction lock and deletes only expired
credential, activation, web-session, rate-limit, and Checkout-intent rows. It
redacts retained Stripe payloads while preserving event identity and billing
audit metadata. It does not delete canonical leads or active entitlements.
The exact `counts` fields are `credentialRowsDeleted`,
`activationSessionsDeleted`, `webSessionsDeleted`, `rateLimitBucketsDeleted`,
`checkoutIntentsDeleted`, and `stripePayloadsRedacted`.

## Scheduled and manual operations

`vercel.json` owns these exact schedules:

| Schedule (UTC) | Route | Bound |
| --- | --- | --- |
| `*/5 * * * *` | `GET /api/internal/stripe-events/process` | 25 events, ten-minute leases |
| `*/10 * * * *` | `GET /api/internal/download-leads/replay` | 25 Blobs, delete only after commit and ETag match |
| `13 4 * * *` | `GET /api/internal/maintenance` | Configured batch per retention category, advisory locked |

Vercel exposes a project-level **Disable Cron Jobs** control. It does not expose
an operator control that pauses or resumes these three declared schedules one at
a time; changing one schedule requires configuration plus a new deployment. The
repository also has no per-job kill switch. During cutover, keep scheduling
globally disabled, manually invoke the three protected GET routes sequentially,
then enable project scheduling once only after all three pass. If this sequencing
is unacceptable, cutover is blocked until separately reviewed per-job kill
switches exist. See Vercel's primary [cron management contract](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

For a manual protected invocation, load `CRON_SECRET` from the approved secret
manager into the process environment without exposing it to shell history or
`set -x`; first verify it is 16-512 printable non-space ASCII characters. The
request also needs the short-lived maintenance WAF bypass described below. Send
both headers without printing either value. Scheduled/manual GET lead replay is
delete-after-commit; the maintenance bypass intentionally does not permit the
manual replay POST surface.

### Production device support and backfill

The device-domain behavior and privacy/support facts live in
`docs/single-device-entitlements.md`; this runbook is the sole Production
procedure. The current device audit and management tools load inherited
`SIDESTREAM_ENV_FILE`, `SIDESTREAM_DB_ENV_FILE`, and Postgres variables before
their explicit selector and open remote Postgres with certificate verification
disabled. They therefore cannot safely prove a Production target. Do not run
their audit, view, clear, override, enforcement, or backfill modes against
Production, and do not improvise a `psql` substitute.

Production device support/backfill remains blocked until a separately owned code
change makes each tool start from a minimal clean environment, accept only the
reviewed direct selector, pin the approved provider CA, validate the hostname and
certificate with verify-full-equivalent semantics, and emit only the selected
variable, non-secret target/CA fingerprints, and connected database. That change
must be tested in disposable/Test infrastructure and independently reviewed
before this runbook may add a Production command surface. Never print a
connection string. Until then, support may use only conceptual guidance and
non-Production verification from the device reference; no Production action is
authorized.

The same prohibition applies to `scripts/report-installer-referrals.mjs` and
`scripts/dump-download-leads.mjs`. Both currently load env-file/inherited database
selectors and set remote TLS to `rejectUnauthorized:false`; `env -i` alone does
not authenticate the server. They may be used only with loopback disposable/local
databases. Production reporting/export remains blocked until separately owned
tools implement clean selection, strict endpoint/TLS-option rejection, pinned
provider-CA and hostname validation, and connected-target evidence without
printing a URL or customer data to uncontrolled output.

## Human-gated production cutover

Nothing in this section was executed by the documentation-remediation step.
Future operators must record operator, approver, UTC timestamp, target, exact
deployment/commit identity, redacted output, and abort decision for every gate.
No gate authorizes secrets or customer data to be copied into this repository.
Every multi-command shell block below uses exit-on-error; do not remove `set -e`
or continue a gate after any command, assertion, or evidence write fails.

Every `/secure/*.env` reference below means a mode-`0600`, ignored,
command-specific file materialized by the approved secret manager. Use three
separate files: `/secure/prod-db.env` contains only the reviewed direct
`SIDESTREAM_POSTGRES_URL_NON_POOLING`, whose connection parameters require
`sslmode=verify-full` and the reviewed `/secure/` provider-CA path;
`/secure/prod-legacy.env` carries that same reviewed URL plus only
`STRIPE_SECRET_KEY` and the two exact legacy allowlists for the catalog gate; it
does not make the current legacy database client authenticated or executable; and
`/secure/prod-stripe-read.env` contains only the live Stripe key for account-level
read/reconciliation. The CA file is materialized separately, pinned by an
approved SHA-256, and never replaced by an unreviewed downloaded bundle. None may define
`SIDESTREAM_ENV_FILE`, `SIDESTREAM_DB_ENV_FILE`, another Postgres URL name, or an
unrelated application setting. Never source, print, archive, or commit them.

A URL-derived host/database fingerprint and `current_database()` are target
selection evidence only. They become authenticated database evidence only when
the same connection validates the provider CA and hostname/certificate with
verify-full-equivalent semantics. If a future provider truly cannot supply that
capability, stop: a named security owner must record an explicit scoped risk
acceptance before any exception, and every document/evidence item must call it a
risk exception rather than identity proof. The current Neon provider documents
provider-CA plus `verify-full`, so no exception is justified for this run. See
PostgreSQL's primary [`verify-full` contract](https://www.postgresql.org/docs/current/libpq-ssl.html),
Neon's [secure-connection guidance](https://neon.com/docs/connect/connect-securely),
and node-postgres's warning that connection-string SSL parameters can overwrite
an explicit [`ssl` object](https://node-postgres.com/features/ssl).

For every authenticated Node client below, the URL is secret input only: reject
duplicate `sslmode`/`sslrootcert`, reject every other query parameter (including
`host`, `port`, `dbname`, `user`, `password`, `ssl`, `sslcert`, `sslkey`, and
connection-routing options), then construct the client from separately validated
host, numeric port, database, user, password, pinned CA, and TLS server name.
Never pass the original or partly sanitized URL as `connectionString` alongside
an `ssl` object. For libpq backup, pass the same validated values through discrete
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSFILE`, `PGSSLMODE`, and
`PGSSLROOTCERT`. A preflight connection never authenticates a later tool's
separate client.

An unset list is not isolation. The migration runner loads
`SIDESTREAM_ENV_FILE` before `SIDESTREAM_DB_ENV_FILE` and refuses to replace an
already populated value; Node's `--env-file` likewise leaves an inherited value
in place. Every database or live-Stripe command below therefore starts with
`env -i` and passes only an explicit allowlist such as `PATH`, `HOME`, a required
output path, reviewed non-secret expected identities, and one env-file selector.
Do not add inherited proxy, runtime, Test, Postgres, Stripe, or legacy-allowlist
variables for convenience. A reviewed secret-manager process launcher is an
acceptable substitute only if it proves the same empty-base/allowlisted contract.
Run with `set +x`. The identity preflight in step 4 must pass immediately before
each legacy audit/apply; migration commands must report selection of
`SIDESTREAM_POSTGRES_URL_NON_POOLING`, and every retained evidence set must bind
to the approved database-target fingerprint and Stripe account without exposing
credentials.

1. **Review the release and prove a real fallback.** Pin `RELEASE_SHA` and an
   explicitly reviewed `FALLBACK_SHA`. Inspect API methods, `vercel.json`, the
   complete migration chain/checksums, manifests, and this runbook. The fallback
   must be runtime-distinct, not a docs-only commit difference:

   ```bash
   set -e
   if git diff --quiet "$FALLBACK_SHA" "$RELEASE_SHA" \
     -- api vercel.json package.json; then
     echo 'Fallback is not runtime-distinct' >&2
     exit 1
   fi
   git diff --name-only "$FALLBACK_SHA" "$RELEASE_SHA" -- api vercel.json package.json
   ```

   Require the guarded diff to continue only on a runtime difference and review
   every listed change. Apply the release's full checksummed chain to a disposable database,
   then build and test the fallback against that already-migrated database,
   including a healthy-Postgres canonical lead write that does not return
   `queued`. Migration
   `20260714200000_remove_redundant_download_lead_key_unique.sql` makes the
   pre-hardening `c34ef25` writer incompatible: its otherwise-valid Postgres lead
   write uses `ON CONFLICT (lead_key)` after that unique constraint is removed
   and can fall into Blob fallback without consuming the database limiter.
   `c93bc09` is also not a rollback: the current branch changes only documentation
   above that hardened runtime. No runtime-distinct, full-chain-qualified fallback
   is currently recorded, so production mutation remains blocked until one is.

2. **Qualify lifecycle behavior only in Preview/Test.** Deploy the reviewed
   release to an exact allowlisted Test host with a distinct disposable/Test
   Postgres target, Test namespace, test-mode Stripe Product/Price/webhook secret,
   stable Test HMAC values, and Test `CRON_SECRET`. Run `npx vercel@latest build`
   plus `npm run verify:vercel-build`, `npm run test:api`,
   `npm run test:postgres-integration`, `npm run typecheck`, `npm run build`,
   `node scripts/assert-no-runtime-ddl.mjs`, and
   `node scripts/validate-vercel-contract.mjs`. Exercise missing/wrong/correct
   cron auth and the signed confirmation POST, Checkout, webhook, activation,
   authorization, partial/full/failed refund, every current Stripe Dispute status
   (`warning_needs_response`, `warning_under_review`, `warning_closed`,
   `needs_response`, `under_review`, `won`, `lost`, and `prevented`), and
   allowlisted legacy-subscription lifecycle in Stripe test mode. Prove the
   reviewed recovery consequence of each terminal outcome and require zero dead
   letters. Also terminate the worker repeatedly after claim, advance through
   lease expiry, and prove a claim-side total-attempt cap terminalizes the row
   without an extra claim. Current code cannot pass that crash/reclaim case or the
   failed-refund, `warning_closed`, and `prevented` cases, so this gate blocks
   until the separately owned retry/lifecycle changes or approved/tested lifecycle
   policy exist. This Preview/Test target is the only
   place the cutover procedure proves Stripe test-mode lifecycle; never point test
   resources at a Production artifact or hostname.

3. **Approve the permanent lead limit without mutating Production.** Vercel Pro
   WAF exposes a per-region fixed window. One source can consume `L` at the end
   of a window and another `L` at the start of the next in each reachable region.
   With exactly one shared rule/counter domain covering every reachable hostname
   (`H=1`), exposure across a trailing boundary window is approximately
   `2 * L * R`, plus regional counter reconciliation risk. It is not a global
   20-request bound.

   Separate host-specific or duplicated rate-limit rules can create `H`
   independent counter domains. In that configuration the exposure is
   approximately `2 * L * R * H`, plus reconciliation risk. The preferred gate
   therefore requires one shared rule whose hostname condition safely includes
   the complete reviewed host set, and cross-host tests must prove that consuming
   the source-IP budget on one host reduces the same budget on every other host.
   If the UI cannot express one shared rule or the test shows independent
   counters, do not silently duplicate the rule: inventory `H`, measure/test the
   boundary on every rule/host domain, and obtain explicit security-owner
   acceptance of the larger bound, or block pending a durable shared limiter.

   The security owner must also inventory and cap the reachable region set `R`,
   choose a reviewed regional limit `L` no greater than 20, require the rule's
   enforcing/rejecting action (never Log), and prove database-outage behavior
   with concurrent multi-region Preview traffic. If `R` or `H` cannot be
   capped/proved, the bound is unacceptable, or the product requires a hard
   global cap, implement and test a durable shared fallback limiter instead. This
   docs step establishes neither an approved exposure nor a shared limiter, so
   production remains blocked.

   Do **not** install or change the Production rule in this step. Its exact match,
   fixed-window threshold, rejecting action, priority, and interactions belong to
   step 8's single reviewed firewall inventory/order/matrix. That matrix is the
   only Production WAF mutation gate and retains the permanent rule after cutover.
   See Vercel's primary
   [WAF rate-limiting contract](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
   and [fixed-window/per-region limitations](https://vercel.com/i/rate-limiting-algorithms).

4. **Freeze Production configuration and license-hash continuity.** Confirm the
   Vercel plan supports the declared cron frequencies. Inventory the Production
   pooled URL, pool budget, `CRON_SECRET`, rate/lead/installer HMAC values, Stripe
   live signing secret and exact Product/Price/legacy allowlists, retention
   values, and license environment without printing values. The legacy audit
   script retrieves only Product/Price objects referenced by existing database
   subscription rows and silently drops malformed allowlist entries; it is not a
   complete catalog gate. Prepare `/secure/prod-legacy-catalog.json` independently
   with the exact expected live resources and reviewed terms:

   ```json
   {
     "products": [{ "id": "prod_..." }],
     "prices": [{
       "id": "price_...",
       "productId": "prod_...",
       "currency": "usd",
       "unitAmount": 999,
       "type": "recurring",
       "interval": "month",
       "intervalCount": 1,
       "usageType": "licensed"
     }]
   }
   ```

   An intentionally empty legacy set uses two empty arrays and two empty
   allowlists; it is not inferred from an empty database query. Before **every**
   legacy audit or apply, run the following clean-environment direct-retrieval
   gate. The database fingerprint and provider-CA checksum are non-secret expected
   identity evidence. The gate rejects blank, duplicate, or malformed allowlist
   entries instead of copying the audit script's silent filtering.

   <!-- SAFETY: LEGACY-CATALOG-BEFORE-AUDIT -->

   ```bash
   (
     set -e
     set +x
     export EXPECTED_PROD_DB_TARGET_SHA256='<approved sha256>'
     export EXPECTED_PROD_DB_CA_SHA256='<approved provider CA sha256>'
     export EXPECTED_STRIPE_ACCOUNT_ID='<approved acct_...>'
     export EXPECTED_LEGACY_CATALOG='/secure/prod-legacy-catalog.json'
     env -i PATH="$PATH" HOME="$HOME" \
       EXPECTED_PROD_DB_TARGET_SHA256="$EXPECTED_PROD_DB_TARGET_SHA256" \
       EXPECTED_PROD_DB_CA_SHA256="$EXPECTED_PROD_DB_CA_SHA256" \
       EXPECTED_STRIPE_ACCOUNT_ID="$EXPECTED_STRIPE_ACCOUNT_ID" \
       EXPECTED_LEGACY_CATALOG="$EXPECTED_LEGACY_CATALOG" \
       node --env-file=/secure/prod-legacy.env --input-type=module <<'NODE'
   import { createHash } from "node:crypto";
   import { readFile } from "node:fs/promises";
   import Stripe from "stripe";

   const databaseNames = [
     "SIDESTREAM_POSTGRES_URL_NON_POOLING", "POSTGRES_URL_NON_POOLING",
     "SIDESTREAM_TEST_POSTGRES_URL", "SIDESTREAM_POSTGRES_URL",
     "SIDESTREAM_POSTGRES_PRISMA_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
   ];
   const selected = databaseNames.filter((name) => process.env[name]?.trim());
   if (selected.length !== 1 || selected[0] !== "SIDESTREAM_POSTGRES_URL_NON_POOLING") {
     throw new Error(`Unexpected database variable selection: ${selected.join(",")}`);
   }
   if (process.env.SIDESTREAM_ENV_FILE || process.env.SIDESTREAM_DB_ENV_FILE) {
     throw new Error("Nested env-file selectors are forbidden");
   }
   const url = new URL(process.env.SIDESTREAM_POSTGRES_URL_NON_POOLING.trim());
   if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash ||
       !url.hostname || url.hostname.includes(",")) {
     throw new Error("Direct database URL must use Postgres");
   }
   if (url.hostname.includes("pooler") || url.port === "6543") {
     throw new Error("Reviewed legacy target must be non-pooling");
   }
   const allowedParameters = new Set(["sslmode", "sslrootcert"]);
   for (const key of url.searchParams.keys()) {
     if (!allowedParameters.has(key)) {
       throw new Error(`Forbidden endpoint/TLS query parameter: ${key}`);
     }
   }
   for (const key of allowedParameters) {
     if (url.searchParams.getAll(key).length !== 1) {
       throw new Error(`Expected exactly one ${key} query parameter`);
     }
   }
   if (url.searchParams.get("sslmode") !== "verify-full") {
     throw new Error("Legacy audit URL must require sslmode=verify-full");
   }
   const caPath = url.searchParams.get("sslrootcert") || "";
   if (!caPath.startsWith("/secure/") || !process.env.EXPECTED_PROD_DB_CA_SHA256) {
     throw new Error("Reviewed provider CA is required");
   }
   const caSha256 = createHash("sha256").update(await readFile(caPath)).digest("hex");
   if (caSha256 !== process.env.EXPECTED_PROD_DB_CA_SHA256) {
     throw new Error("Provider CA checksum mismatch");
   }
   const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
   const portText = url.port || "5432";
   const port = Number(portText);
   if (!databaseName || !url.username || !url.password || !/^\d+$/.test(portText) ||
       !Number.isSafeInteger(port) || port < 1 || port > 65535) {
     throw new Error("Legacy URL has invalid explicit connection fields");
   }
   const target = `${url.hostname.toLowerCase()}:${portText}/${
     databaseName
   }`;
   const targetSha256 = createHash("sha256").update(target).digest("hex");
   if (targetSha256 !== process.env.EXPECTED_PROD_DB_TARGET_SHA256) {
     throw new Error("Production database target fingerprint mismatch");
   }
   const parseIds = (value, pattern, label) => {
     const raw = String(value || "");
     const ids = raw === "" ? [] : raw.split(",").map((id) => id.trim());
     if (ids.some((id) => !id || !pattern.test(id)) ||
         new Set(ids).size !== ids.length) {
       throw new Error(`Invalid ${label} allowlist`);
     }
     return ids.sort();
   };
   const products = parseIds(
     process.env.SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS,
     /^prod_[A-Za-z0-9]+$/, "Product",
   );
   const prices = parseIds(
     process.env.SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS,
     /^price_[A-Za-z0-9]+$/, "Price",
   );
   const catalog = JSON.parse(await readFile(process.env.EXPECTED_LEGACY_CATALOG, "utf8"));
   if (!Array.isArray(catalog.products) || !Array.isArray(catalog.prices)) {
     throw new Error("Legacy catalog must contain Product and Price arrays");
   }
   const expectedProducts = catalog.products.map((entry) => entry.id).sort();
   const expectedPrices = catalog.prices.map((entry) => entry.id).sort();
   parseIds(expectedProducts.join(","), /^prod_[A-Za-z0-9]+$/, "catalog Product");
   parseIds(expectedPrices.join(","), /^price_[A-Za-z0-9]+$/, "catalog Price");
   if (JSON.stringify(products) !== JSON.stringify(expectedProducts) ||
       JSON.stringify(prices) !== JSON.stringify(expectedPrices)) {
     throw new Error("Legacy Product/Price allowlist mismatch");
   }
   const stripeKey = process.env.STRIPE_SECRET_KEY?.trim() || "";
   if (!stripeKey.startsWith("sk_live_")) throw new Error("Expected a live Stripe key");
   const stripe = new Stripe(stripeKey);
   const account = await stripe.accounts.retrieve();
   if (account.id !== process.env.EXPECTED_STRIPE_ACCOUNT_ID) {
     throw new Error("Stripe account mismatch");
   }
   const retrievedProducts = [];
   for (const expected of catalog.products) {
     if (Object.keys(expected).sort().join(",") !== "id") {
       throw new Error(`Unexpected Product catalog fields for ${expected.id}`);
     }
     const product = await stripe.products.retrieve(expected.id);
     if (product.id !== expected.id || product.object !== "product" ||
         product.livemode !== true || product.active !== true || product.deleted === true) {
       throw new Error(`Invalid live Product ${expected.id}`);
     }
     retrievedProducts.push(product.id);
   }
   const retrievedPrices = [];
   for (const expected of catalog.prices) {
     const fields = ["currency", "id", "interval", "intervalCount", "productId",
       "type", "unitAmount", "usageType"];
     if (Object.keys(expected).sort().join(",") !== fields.sort().join(",") ||
         !Number.isSafeInteger(expected.unitAmount) || expected.unitAmount <= 0) {
       throw new Error(`Malformed expected Price ${expected.id}`);
     }
     const price = await stripe.prices.retrieve(expected.id);
     const productId = typeof price.product === "string" ? price.product : price.product?.id;
     if (price.id !== expected.id || price.object !== "price" ||
         price.livemode !== true || price.active !== true ||
         productId !== expected.productId || !products.includes(productId) ||
         price.type !== expected.type || price.type !== "recurring" ||
         price.recurring?.interval !== expected.interval ||
         price.recurring?.interval_count !== expected.intervalCount ||
         price.recurring?.usage_type !== expected.usageType ||
         price.currency !== expected.currency || price.unit_amount !== expected.unitAmount) {
       throw new Error(`Live Price contract mismatch for ${expected.id}`);
     }
     retrievedPrices.push(price.id);
   }
   if (JSON.stringify(retrievedProducts.sort()) !== JSON.stringify(products) ||
       JSON.stringify(retrievedPrices.sort()) !== JSON.stringify(prices)) {
     throw new Error("Retrieved legacy catalog is incomplete");
   }
   console.log(JSON.stringify({
     databaseEnvironmentVariable: selected[0],
     databaseTargetSha256: targetSha256,
     providerCaSha256: caSha256,
     stripeAccountId: account.id,
     productIds: products,
     priceIds: prices,
   }));
   NODE
   )
   ```

   Retain the non-secret JSON result, catalog checksum, and secret-manager file
   version/hash in access-controlled evidence. Any extra selector, malformed or
   mismatched exact ID set, pooled target, target/CA mismatch, non-live account,
   inactive/missing object, wrong linkage, recurring shape, amount, or currency
   blocks both audit and apply. Direct retrieval covers unreferenced expected
   resources; the later audit covers database subscriptions. The preflight is a
   future human gate and was not run by this documentation step. The asserted
   fields come from Stripe's primary [Product object](https://docs.stripe.com/api/products/object),
   [Price object](https://docs.stripe.com/api/prices/object), and
   [Price-list pagination](https://docs.stripe.com/api/prices/list) contracts.

   <!-- ACTION: RUN-LEGACY-AUDIT-OR-APPLY -->

   The action marker remains **closed**. The catalog block proves the live Stripe
   account and exact Product/Price set, and its URL checks are only non-secret
   target-selection evidence; it does not authenticate the database connection
   later opened by `scripts/audit-legacy-subscriptions.mjs`. That script currently
   reuses a connection string and permits remote TLS without verified
   certificate/hostname proof. Do not run either its read-only or `--apply` mode
   against Production. A separately owned change must make the script itself
   start clean, reject duplicate and every endpoint/TLS-overriding query option,
   construct its client from validated explicit host/port/database/credential
   fields plus the pinned provider CA, and emit the same authenticated connected
   target evidence. Only after tests and independent review may this runbook add
   an executable Production audit/apply command; the complete catalog gate must
   still run immediately before each one.

   Before changing any database URL or pool, handle the legacy device-hash
   fallback. If `SIDESTREAM_LICENSE_HASH_SECRET` is absent, the application uses
   the first configured value selected from `SIDESTREAM_POSTGRES_URL`,
   `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, or
   `POSTGRES_PRISMA_URL`. `api/_lib/postgres.ts` currently trims the configured
   value, validates and serializes it as a Postgres URL, and removes
   `sslmode=prefer` or `sslmode=require` before returning the connection string
   consumed by the hash fallback. Securely capture that exact resulting byte
   sequence, not an assumed/raw URL spelling, and duplicate it into the dedicated
   variable. Once captured, do not print, trim, URL-decode, parse/re-serialize,
   hash into ordinary logs, or otherwise normalize it again. Retain only
   secret-manager audit/version evidence and the selected variable name. The
   repository has no secret-export/continuity-copy command; if the approved
   secret system cannot perform this byte-for-byte operation without disclosure,
   production is blocked until a reviewed non-logging tool exists. Capture a
   same-real-device/token verification before mutation in step 9
   and repeat it after promotion in step 10. If the value cannot be recovered
   exactly or continuity cannot be proved, block cutover until a separately
   implemented and tested dual-hash migration exists.

   Inventory the existing live Stripe destination, status, endpoint ID, API
   version, `enabled_events`, account ID, and target event list. Do not proceed
   until the failed-refund and dispute-status blockers above are implemented and
   Preview/Test-qualified. Preserve endpoint and signing-secret continuity for
   the staged artifact. If selection must change, prepare the exact reviewed
   update now but apply it only after step 9's webhook deny is active; keep the
   destination enabled so selected deliveries fail non-`2xx` and enter the
   bounded retry window. Because `enabled_events` controls endpoint selection and
   Workbench deliveries contain only attempts to that endpoint, record a
   conservative account-event `created` interval beginning before both the
   maintenance boundary and selection change. Step 11 must paginate the
   account-level List Events API for every required type and union those IDs with
   endpoint deliveries; endpoint deliveries alone are never complete evidence.

5. **Stage and qualify the exact Production-environment artifacts.** Finalize
   every Production environment value first, including the license-hash
   continuity value. `.vercel/` is ignored and absent from a clean checkout, so a
   bare deploy command is not deterministic. Vercel generated URLs are publicly
   accessible by default. **Before creating either Production-configured URL,**
   the project owner must record the current project-level Deployment Protection
   method and scope and prove that it covers generated Production deployment
   URLs at creation time **while leaving the canonical Production domain public**.
   This cutover requires current **Standard Protection**: it protects generated
   Production deployment URLs but excludes production domains. `All Deployments`
   is not sufficient because it also protects the canonical public domain and
   would make the required unauthenticated post-promotion smoke and public reopen
   fail. `None`, Legacy Standard, and Legacy Pre-Production are also insufficient.
   If the project starts on All Deployments, complete and independently verify an
   explicitly approved transition to Standard before staging; do not defer that
   scope change until promotion. Record the approved team/project IDs, exact
   Standard setting, owner, UTC time, and dashboard evidence. If Standard cannot
   be established before staging, do not put finalized Production secrets in a
   generated artifact at all; production remains blocked. See Vercel's primary
   [Deployment Protection scope](https://vercel.com/docs/deployment-protection)
   and [generated-URL default](https://vercel.com/docs/deployments/generated-urls).

   <!-- SAFETY: DEPLOYMENT-PROTECTION-BEFORE-STAGE -->

   Obtain the approved non-secret team/project IDs from the same inventory. Have
   the approved secret manager inject only `VERCEL_TOKEN`; run every Vercel
   selection/deploy command from `env -i`, pass explicit `--scope` and
   `--project`, and never inherit `VERCEL_ORG_ID` or `VERCEL_PROJECT_ID`. The CLI
   gives `--project` higher precedence than those inherited values, but the empty
   base removes the ambiguity entirely. Do not copy `.vercel/` between checkouts.

   <!-- ACTION: STAGE-PRODUCTION-ARTIFACT -->

   In the clean pinned release checkout, stage and immediately persist the one
   immutable release ID/URL as `RELEASE_DEPLOYMENT`:

   ```bash
   set -euo pipefail
   set +x
   export VERCEL_TEAM_SLUG='alex-3685s-projects'
   export VERCEL_PROJECT_NAME='sidestream'
   export EXPECTED_VERCEL_ORG_ID='<approved team ID>'
   export EXPECTED_VERCEL_PROJECT_ID='<approved project ID>'
   export RELEASE_SHA='<approved release commit>'
   export RELEASE_EVIDENCE_DIR='<fresh absolute access-controlled release evidence directory>'

   test -n "${VERCEL_TOKEN:-}"
   test -n "$RELEASE_EVIDENCE_DIR"
   test "${RELEASE_EVIDENCE_DIR#/}" != "$RELEASE_EVIDENCE_DIR"
   mkdir -p "$RELEASE_EVIDENCE_DIR"
   test -z "$(find "$RELEASE_EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -print -quit)"
   test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
   git diff --quiet
   git diff --cached --quiet
   test -z "$(git ls-files --others --exclude-standard)"
   test -z "$(git ls-files --others --ignored --exclude-standard | \
     awk '$0 !~ /^\.vercel\//')"
   RELEASE_TREE="$(git rev-parse 'HEAD^{tree}')"
   readonly RELEASE_TREE
   printf '%s\n' "$RELEASE_TREE" > "$RELEASE_EVIDENCE_DIR/release-source-tree.txt"
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest link --yes \
     --team "$VERCEL_TEAM_SLUG" --project "$VERCEL_PROJECT_NAME"
   env -i PATH="$PATH" HOME="$HOME" \
     VERCEL_PROJECT_NAME="$VERCEL_PROJECT_NAME" \
     EXPECTED_VERCEL_ORG_ID="$EXPECTED_VERCEL_ORG_ID" \
     EXPECTED_VERCEL_PROJECT_ID="$EXPECTED_VERCEL_PROJECT_ID" \
     node --input-type=module \
     > "$RELEASE_EVIDENCE_DIR/release-project-link.json" <<'NODE'
   import { readFile } from "node:fs/promises";
   const link = JSON.parse(await readFile(".vercel/project.json", "utf8"));
   const expected = {
     projectName: process.env.VERCEL_PROJECT_NAME,
     orgId: process.env.EXPECTED_VERCEL_ORG_ID,
     projectId: process.env.EXPECTED_VERCEL_PROJECT_ID,
   };
   for (const [field, value] of Object.entries(expected)) {
     if (!value || value.startsWith("<") || link[field] !== value) {
       throw new Error(`Vercel link identity mismatch for ${field}`);
     }
   }
   console.log(JSON.stringify(link));
   NODE
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest project inspect "$EXPECTED_VERCEL_PROJECT_ID" \
     --scope "$VERCEL_TEAM_SLUG" \
     > "$RELEASE_EVIDENCE_DIR/release-project-inspect.txt"
   test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
   git diff --quiet
   git diff --cached --quiet
   test -z "$(git ls-files --others --exclude-standard)"
   test -z "$(git ls-files --others --ignored --exclude-standard | \
     awk '$0 !~ /^\.vercel\//')"
   RELEASE_DEPLOYMENT="$(env -i PATH="$PATH" HOME="$HOME" \
     VERCEL_TOKEN="$VERCEL_TOKEN" npx vercel@latest deploy \
     --prod --skip-domain --scope "$VERCEL_TEAM_SLUG" \
     --project "$EXPECTED_VERCEL_PROJECT_ID")"
   readonly RELEASE_DEPLOYMENT
   test -n "$RELEASE_DEPLOYMENT"
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest inspect "$RELEASE_DEPLOYMENT" --wait --format=json \
     --scope "$VERCEL_TEAM_SLUG" \
     > "$RELEASE_EVIDENCE_DIR/release-deployment-inspect.json"
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest inspect "$RELEASE_DEPLOYMENT" --logs \
     --scope "$VERCEL_TEAM_SLUG" \
     > "$RELEASE_EVIDENCE_DIR/release-build.log"
   ```

   The cleanliness assertions reject modified tracked files, staged changes, and
   every non-ignored untracked file before Vercel builds the uploaded working
   directory. The second untracked check rejects ignored content too, allowing
   only the freshly verified `.vercel/` link metadata. Build/dependency caches,
   `dist`, local env files, ignored media, and every other ignored file must be
   absent from these pinned staging checkouts even when `.vercelignore` would
   normally exclude them. The recorded Git tree is the source/config identity
   only because all deployable working-tree drift has been rejected.

   In the separate clean pinned fallback checkout, rerun the same empty-base
   link/identity inspection using the exact same approved project identity, prove
   `git rev-parse HEAD` equals `FALLBACK_SHA`, and stage the result into a
   different immutable variable:

   ```bash
   set -euo pipefail
   set +x
   export FALLBACK_SHA='<approved runtime-distinct fallback commit>'
   export RELEASE_DEPLOYMENT='<preserved immutable release deployment ID or URL>'
   export FALLBACK_EVIDENCE_DIR='<fresh absolute access-controlled fallback evidence directory>'
   readonly RELEASE_DEPLOYMENT
   test -n "${VERCEL_TOKEN:-}"
   test -n "${VERCEL_TEAM_SLUG:-}"
   test -n "${VERCEL_PROJECT_NAME:-}"
   test -n "${EXPECTED_VERCEL_ORG_ID:-}"
   test -n "${EXPECTED_VERCEL_PROJECT_ID:-}"
   test -n "$FALLBACK_EVIDENCE_DIR"
   test "${FALLBACK_EVIDENCE_DIR#/}" != "$FALLBACK_EVIDENCE_DIR"
   mkdir -p "$FALLBACK_EVIDENCE_DIR"
   test -z "$(find "$FALLBACK_EVIDENCE_DIR" -mindepth 1 -maxdepth 1 -print -quit)"
   test "$(git rev-parse HEAD)" = "$FALLBACK_SHA"
   git diff --quiet
   git diff --cached --quiet
   test -z "$(git ls-files --others --exclude-standard)"
   test -z "$(git ls-files --others --ignored --exclude-standard | \
     awk '$0 !~ /^\.vercel\//')"
   FALLBACK_TREE="$(git rev-parse 'HEAD^{tree}')"
   readonly FALLBACK_TREE
   printf '%s\n' "$FALLBACK_TREE" > "$FALLBACK_EVIDENCE_DIR/fallback-source-tree.txt"
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest link --yes \
     --team "$VERCEL_TEAM_SLUG" --project "$VERCEL_PROJECT_NAME"
   env -i PATH="$PATH" HOME="$HOME" \
     VERCEL_PROJECT_NAME="$VERCEL_PROJECT_NAME" \
     EXPECTED_VERCEL_ORG_ID="$EXPECTED_VERCEL_ORG_ID" \
     EXPECTED_VERCEL_PROJECT_ID="$EXPECTED_VERCEL_PROJECT_ID" \
     node --input-type=module \
     > "$FALLBACK_EVIDENCE_DIR/fallback-project-link.json" <<'NODE'
   import { readFile } from "node:fs/promises";
   const link = JSON.parse(await readFile(".vercel/project.json", "utf8"));
   const expected = {
     projectName: process.env.VERCEL_PROJECT_NAME,
     orgId: process.env.EXPECTED_VERCEL_ORG_ID,
     projectId: process.env.EXPECTED_VERCEL_PROJECT_ID,
   };
   for (const [field, value] of Object.entries(expected)) {
     if (!value || value.startsWith("<") || link[field] !== value) {
       throw new Error(`Vercel link identity mismatch for ${field}`);
     }
   }
   console.log(JSON.stringify(link));
   NODE
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest project inspect "$EXPECTED_VERCEL_PROJECT_ID" \
     --scope "$VERCEL_TEAM_SLUG" \
     > "$FALLBACK_EVIDENCE_DIR/fallback-project-inspect.txt"
   test "$(git rev-parse HEAD)" = "$FALLBACK_SHA"
   test "$(git rev-parse 'HEAD^{tree}')" = "$FALLBACK_TREE"
   git diff --quiet
   git diff --cached --quiet
   test -z "$(git ls-files --others --exclude-standard)"
   test -z "$(git ls-files --others --ignored --exclude-standard | \
     awk '$0 !~ /^\.vercel\//')"
   FALLBACK_DEPLOYMENT="$(env -i PATH="$PATH" HOME="$HOME" \
     VERCEL_TOKEN="$VERCEL_TOKEN" npx vercel@latest deploy \
     --prod --skip-domain --scope "$VERCEL_TEAM_SLUG" \
     --project "$EXPECTED_VERCEL_PROJECT_ID")"
   readonly FALLBACK_DEPLOYMENT
   test -n "$FALLBACK_DEPLOYMENT"
   test "$FALLBACK_DEPLOYMENT" != "$RELEASE_DEPLOYMENT"
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest inspect "$FALLBACK_DEPLOYMENT" --wait --format=json \
     --scope "$VERCEL_TEAM_SLUG" \
     > "$FALLBACK_EVIDENCE_DIR/fallback-deployment-inspect.json"
   env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest inspect "$FALLBACK_DEPLOYMENT" --logs \
     --scope "$VERCEL_TEAM_SLUG" \
     > "$FALLBACK_EVIDENCE_DIR/fallback-build.log"
   ```

   Persist both immutable values and their checkout paths/commits in
   access-controlled evidence; never assign either value to a shared mutable
   alias. `vercel link --yes --team ... --project ...` is the non-interactive
   existing-project contract. Abort before deployment if linking prompts,
   creates/targets another project, or any ID differs. See the primary
   [`vercel link`](https://vercel.com/docs/cli/link) and
   [project-selection precedence](https://vercel.com/docs/cli/global-options)
   contracts.

   Immediately after **each** deploy and before any qualification request, prove
   the generated URL is protected: retain the fresh project-level protection
   setting and an unauthenticated `HEAD` to an inert path that receives Vercel's
   current authentication/protection response rather than an application
   response. Abort and rotate any exposed finalized secret if the request reaches
   the application. Do not enable protection after the fact and call the artifact
   safe. Then record each commit, immutable deployment ID/URL, Production
   environment, build identity/logs, source/config checksum, protection state,
   and absence of assigned production domains. Store the release setting export
   and raw probe headers as `release-protection-setting.txt` and
   `release-protection-probe.headers` in `RELEASE_EVIDENCE_DIR`; use the analogous
   `fallback-*` names in `FALLBACK_EVIDENCE_DIR`. Record and reject any Deployment
   Protection exception that makes the generated URL public.

   With `RELEASE_DEPLOYMENT` set to the exact protected release ID/URL and
   `EVIDENCE_DIR` set to the already-fresh `RELEASE_EVIDENCE_DIR` outside the
   repository, execute this read-only
   matrix. `vercel curl` requires the path first, Vercel options before `--`, and
   underlying curl flags after `--`:

   ```bash
   set -euo pipefail
   set +x
   test -n "${VERCEL_TOKEN:-}"
   test "$EVIDENCE_DIR" = "$RELEASE_EVIDENCE_DIR"
   test -s "$EVIDENCE_DIR/release-protection-setting.txt"
   test -s "$EVIDENCE_DIR/release-protection-probe.headers"

   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl \
     '/api/releases/latest?channel=stable&platform=macos' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --request GET \
     --dump-header "$EVIDENCE_DIR/release-macos-get.headers" \
     --output "$EVIDENCE_DIR/release-macos-get.json" --write-out '%{http_code}')"
   test "$status" = 200
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl \
     '/api/releases/latest?channel=stable&platform=win32-x64' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --request GET \
     --dump-header "$EVIDENCE_DIR/release-windows-get.headers" \
     --output "$EVIDENCE_DIR/release-windows-get.json" --write-out '%{http_code}')"
   test "$status" = 200
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl \
     '/api/releases/latest?channel=stable&platform=macos' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --head \
     --dump-header "$EVIDENCE_DIR/release-macos-head.headers" \
     --output /dev/null --write-out '%{http_code}')"
   test "$status" = 200
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl \
     '/api/releases/latest?channel=stable&platform=win32-x64' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --head \
     --dump-header "$EVIDENCE_DIR/release-windows-head.headers" \
     --output /dev/null --write-out '%{http_code}')"
   test "$status" = 200
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl '/api/download?platform=macos' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --head \
     --dump-header "$EVIDENCE_DIR/download-macos-head.headers" \
     --output /dev/null --write-out '%{http_code}')"
   test "$status" = 200
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl '/api/download?platform=win32-x64' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --head \
     --dump-header "$EVIDENCE_DIR/download-windows-head.headers" \
     --output /dev/null --write-out '%{http_code}')"
   test "$status" = 200
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl \
     '/api/releases/latest?channel=stable&platform=unknown' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --request GET \
     --dump-header "$EVIDENCE_DIR/release-unknown-get.headers" \
     --output "$EVIDENCE_DIR/release-unknown-get.json" --write-out '%{http_code}')"
   test "$status" = 404
   status="$(env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
     npx vercel@latest curl '/api/download?platform=unknown' \
     --deployment "$RELEASE_DEPLOYMENT" --yes -- \
     --silent --show-error --head \
     --dump-header "$EVIDENCE_DIR/download-unknown-head.headers" \
     --output /dev/null --write-out '%{http_code}')"
   test "$status" = 404
   ```

   In the fallback checkout, execute the exact same matrix with every
   `--deployment` argument set directly to `"$FALLBACK_DEPLOYMENT"` and a
   separate fallback evidence directory. Do not reassign either immutable
   variable or route both roles through a generic deployment alias. Both complete
   matrices and protection probes must pass before either artifact is qualified.

   Compare both GET bodies with their HEAD metadata and each platform's download
   HEAD for platform, version, SHA-256, filename, and size. Do not weaken
   Deployment Protection or call Production database-write/live Checkout
   surfaces. Record the machine-readable comparison as
   `release-parity-review.json` and the reviewed project/commit/build/Production
   environment/immutable-ID/no-domain/Standard-protection assertions as
   `release-identity-review.json`; both must explicitly fail rather than omit an
   unknown field. Use the analogous `fallback-*` names for the fallback. The
   repository smoke script has no Deployment Protection credential
   option, so it runs only after promotion on the production domain. See the
   primary [`vercel curl` contract](https://vercel.com/docs/cli/curl). Preview
   promotion is not this artifact: Vercel rebuilds Preview for Production values.
   A staged Production deployment created with `--prod --skip-domain` can later
   be attached without rebuilding via `vercel promote <deployment-id-or-url>`.
   See Vercel's primary [staged-deployment procedure](https://vercel.com/docs/cli/deploying-from-cli),
   [promotion semantics](https://vercel.com/docs/deployments/promoting-a-deployment),
   and [environment immutability](https://vercel.com/docs/environment-variables).
   Any source, build configuration, or environment change after staging
   invalidates the artifact and requires a new build plus full qualification.
   Abort on a Preview target, attached domain, team/project mismatch,
   commit/build mismatch, missing protection, environment drift, failed
   inspection, or any matrix/parity failure.

   Finally create a deterministic qualification manifest for the release. This
   runs only after every required evidence file exists, rejects empty files,
   directories, symlinks, placeholders, and an already-used manifest path, and
   hashes every evidence artifact in sorted filename order. It binds the exact
   immutable deployment, Git commit/tree, approved team/project, Production
   environment, and Standard Protection scope:

   ```bash
   (
     set -euo pipefail
     set +x
     test -n "$RELEASE_DEPLOYMENT"
     test -n "$RELEASE_SHA"
     test -n "$RELEASE_TREE"
     test -n "$EXPECTED_VERCEL_ORG_ID"
     test -n "$EXPECTED_VERCEL_PROJECT_ID"
     test -n "$RELEASE_EVIDENCE_DIR"
     export RELEASE_QUALIFICATION_MANIFEST="$RELEASE_EVIDENCE_DIR/release-qualification-manifest.json"
     test ! -e "$RELEASE_QUALIFICATION_MANIFEST"
     env -i PATH="$PATH" HOME="$HOME" \
       EVIDENCE_DIR="$RELEASE_EVIDENCE_DIR" ROLE='release' \
       DEPLOYMENT="$RELEASE_DEPLOYMENT" GIT_COMMIT="$RELEASE_SHA" \
       GIT_TREE="$RELEASE_TREE" VERCEL_ORG_ID="$EXPECTED_VERCEL_ORG_ID" \
       VERCEL_PROJECT_ID="$EXPECTED_VERCEL_PROJECT_ID" \
       QUALIFICATION_MANIFEST="$RELEASE_QUALIFICATION_MANIFEST" \
       node --input-type=module <<'NODE'
   import { createHash } from "node:crypto";
   import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
   import path from "node:path";

   const required = [
     "release-source-tree.txt", "release-project-link.json",
     "release-project-inspect.txt", "release-deployment-inspect.json",
     "release-build.log", "release-protection-setting.txt",
     "release-protection-probe.headers", "release-macos-get.headers",
     "release-macos-get.json", "release-windows-get.headers",
     "release-windows-get.json", "release-macos-head.headers",
     "release-windows-head.headers", "download-macos-head.headers",
     "download-windows-head.headers", "release-unknown-get.headers",
     "release-unknown-get.json", "download-unknown-head.headers",
     "release-parity-review.json", "release-identity-review.json",
   ].sort();
   const values = ["EVIDENCE_DIR", "DEPLOYMENT", "GIT_COMMIT", "GIT_TREE",
     "VERCEL_ORG_ID", "VERCEL_PROJECT_ID", "QUALIFICATION_MANIFEST"];
   for (const name of values) {
     const value = process.env[name] || "";
     if (!value || value.includes("<") || value.includes(">")) {
       throw new Error(`Missing or placeholder qualification value: ${name}`);
     }
   }
   const entries = (await readdir(process.env.EVIDENCE_DIR)).sort();
   for (const name of required) {
     if (!entries.includes(name)) throw new Error(`Missing qualification evidence: ${name}`);
   }
   const artifacts = [];
   for (const name of entries) {
     if (name.startsWith("release-qualification")) {
       throw new Error(`Qualification output already exists: ${name}`);
     }
     const absolute = path.join(process.env.EVIDENCE_DIR, name);
     const stat = await lstat(absolute);
     if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
       throw new Error(`Invalid qualification evidence: ${name}`);
     }
     const body = await readFile(absolute);
     artifacts.push({
       path: name,
       bytes: body.length,
       sha256: createHash("sha256").update(body).digest("hex"),
     });
   }
   const manifest = {
     schemaVersion: 1,
     role: "release",
     deployment: process.env.DEPLOYMENT,
     gitCommit: process.env.GIT_COMMIT,
     gitTree: process.env.GIT_TREE,
     vercelOrgId: process.env.VERCEL_ORG_ID,
     vercelProjectId: process.env.VERCEL_PROJECT_ID,
     environment: "production",
     deploymentProtectionScope: "standard",
     artifacts,
   };
   await writeFile(
     process.env.QUALIFICATION_MANIFEST,
     `${JSON.stringify(manifest, null, 2)}\n`,
     { flag: "wx", mode: 0o600 },
   );
   NODE
     test -s "$RELEASE_QUALIFICATION_MANIFEST"
     EXPECTED_RELEASE_QUALIFICATION_SHA256="$(
       shasum -a 256 "$RELEASE_QUALIFICATION_MANIFEST" | awk '{print $1}'
     )"
     [[ "$EXPECTED_RELEASE_QUALIFICATION_SHA256" =~ ^[0-9a-f]{64}$ ]]
     printf '%s  %s\n' "$EXPECTED_RELEASE_QUALIFICATION_SHA256" \
       "$(basename "$RELEASE_QUALIFICATION_MANIFEST")" \
       > "$RELEASE_EVIDENCE_DIR/release-qualification.sha256"
     test -s "$RELEASE_EVIDENCE_DIR/release-qualification.sha256"
   )
   ```

   Store `RELEASE_QUALIFICATION_MANIFEST` and
   `EXPECTED_RELEASE_QUALIFICATION_SHA256` in the immutable release record. A
   different authorized approver must sign that exact digest with the
   organization's approved signing service and retain signature-verification
   evidence as `release-qualification-signature.txt`. That verification receipt
   must identify the approved signer, exact 64-hex digest, verification result,
   and UTC time; a nonempty file or digest copied from the same mutable directory
   without independent cryptographic verification is not approval.

   Rerun the same fail-closed manifest procedure in the fallback checkout with
   role/prefix `fallback`, `FALLBACK_DEPLOYMENT`, `FALLBACK_SHA`, `FALLBACK_TREE`,
   and `FALLBACK_EVIDENCE_DIR`. It must create and retain the distinct variables
   `FALLBACK_QUALIFICATION_MANIFEST` and
   `EXPECTED_FALLBACK_QUALIFICATION_SHA256` (a nonempty 64-hex digest), plus a
   separately verified `fallback-qualification-signature.txt` receipt binding
   that digest and approved signer. The fallback required-file list uses every
   analogous `fallback-*` identity, inspection, build, protection, request,
   parity, and review artifact; changing only `ROLE` while leaving release file
   names is an error. Never reuse the release manifest, digest, signature, or
   evidence directory for fallback. If the approved signing service cannot
   produce machine-verifiable receipts for both roles, neither artifact is
   qualified and Production remains blocked.

6. **Take and verify a fresh database backup.** Before this gate and immediately
   before every later `/secure/prod-db.env` gate, run the following
   empty-environment authenticated-target preflight with independently approved
   target and provider-CA fingerprints. It permits only the one direct database
   selector, requires verify-full-equivalent hostname/certificate validation,
   rejects a pooler/nested env file, connects read-only, and emits no URL or
   credential:

   ```bash
   (
     set -e
     set +x
     export EXPECTED_PROD_DB_TARGET_SHA256='<approved sha256>'
     export EXPECTED_PROD_DB_CA_SHA256='<approved provider CA sha256>'
     env -i PATH="$PATH" HOME="$HOME" \
       EXPECTED_PROD_DB_TARGET_SHA256="$EXPECTED_PROD_DB_TARGET_SHA256" \
       EXPECTED_PROD_DB_CA_SHA256="$EXPECTED_PROD_DB_CA_SHA256" \
       node --env-file=/secure/prod-db.env --input-type=module <<'NODE'
   import { createHash } from "node:crypto";
   import { readFile } from "node:fs/promises";
   import { Pool } from "pg";

   const databaseNames = [
     "SIDESTREAM_POSTGRES_URL_NON_POOLING", "POSTGRES_URL_NON_POOLING",
     "SIDESTREAM_TEST_POSTGRES_URL", "SIDESTREAM_POSTGRES_URL",
     "SIDESTREAM_POSTGRES_PRISMA_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
   ];
   const selected = databaseNames.filter((name) => process.env[name]?.trim());
   if (selected.length !== 1 || selected[0] !== "SIDESTREAM_POSTGRES_URL_NON_POOLING" ||
       process.env.SIDESTREAM_ENV_FILE || process.env.SIDESTREAM_DB_ENV_FILE ||
       process.env.STRIPE_SECRET_KEY ||
       process.env.SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS ||
       process.env.SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS) {
     throw new Error(`Unexpected database/env-file selection: ${selected.join(",")}`);
   }
   const url = new URL(process.env.SIDESTREAM_POSTGRES_URL_NON_POOLING.trim());
   if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash ||
       !url.hostname || url.hostname.includes(",") ||
       url.hostname.includes("pooler") || url.port === "6543") {
     throw new Error("Expected the reviewed direct Postgres target");
   }
   const allowedParameters = new Set(["sslmode", "sslrootcert"]);
   for (const key of url.searchParams.keys()) {
     if (!allowedParameters.has(key)) {
       throw new Error(`Forbidden endpoint/TLS query parameter: ${key}`);
     }
   }
   for (const key of allowedParameters) {
     if (url.searchParams.getAll(key).length !== 1) {
       throw new Error(`Expected exactly one ${key} query parameter`);
     }
   }
   const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
   const user = decodeURIComponent(url.username);
   const password = decodeURIComponent(url.password);
   const portText = url.port || "5432";
   const port = Number(portText);
   if (!databaseName || !user || !password || !/^\d+$/.test(portText) ||
       !Number.isSafeInteger(port) || port < 1 || port > 65535) {
     throw new Error("Direct database URL has invalid explicit connection fields");
   }
   const target = `${url.hostname.toLowerCase()}:${portText}/${databaseName}`;
   const targetSha256 = createHash("sha256").update(target).digest("hex");
   if (targetSha256 !== process.env.EXPECTED_PROD_DB_TARGET_SHA256) {
     throw new Error("Production database target fingerprint mismatch");
   }
   if (url.searchParams.get("sslmode") !== "verify-full") {
     throw new Error("Production database requires sslmode=verify-full");
   }
   const caPath = url.searchParams.get("sslrootcert") || "";
   if (!caPath.startsWith("/secure/") || url.searchParams.has("sslcert") ||
       url.searchParams.has("sslkey") || process.env.POSTGRES_SSL === "0") {
     throw new Error("Production database requires the reviewed provider CA");
   }
   const ca = await readFile(caPath);
   const providerCaSha256 = createHash("sha256").update(ca).digest("hex");
   if (providerCaSha256 !== process.env.EXPECTED_PROD_DB_CA_SHA256) {
     throw new Error("Production database provider CA fingerprint mismatch");
   }
   const pool = new Pool({
     host: url.hostname, port, database: databaseName, user, password, max: 1,
     connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
     ssl: {
       ca: ca.toString("utf8"),
       rejectUnauthorized: true,
       servername: url.hostname,
     },
   });
   try {
     const result = await pool.query("select current_database() as database_name");
     if (result.rows[0]?.database_name !== databaseName) {
       throw new Error("Connected database identity mismatch");
     }
     console.log(JSON.stringify({
       databaseEnvironmentVariable: selected[0],
       databaseTargetSha256: targetSha256,
       providerCaSha256,
       tlsServerName: url.hostname,
       connectedDatabase: result.rows[0].database_name,
     }));
   } finally {
     await pool.end();
   }
   NODE
   )
   ```

   Retain that non-secret authenticated-identity result with each gate. Prefer the provider's
   reviewed snapshot/restore verification. For `pg_dump`, do not put the
   connection URL in argv. Set `BACKUP_PATH` to access-controlled storage outside
   the repository. Reject every query option except one `sslmode` and one
   `sslrootcert`, parse the reviewed URL once, and pass libpq discrete
   `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER` plus a temporary mode-`0600` password
   file, `PGSSLMODE=verify-full`, and `PGSSLROOTCERT`:

   ```bash
   (
     set -euo pipefail
     set +x
     test -n "$BACKUP_PATH"
     test -n "$EXPECTED_PROD_DB_TARGET_SHA256"
     test -n "$EXPECTED_PROD_DB_CA_SHA256"
     env -i PATH="$PATH" HOME="$HOME" BACKUP_PATH="$BACKUP_PATH" \
       EXPECTED_PROD_DB_TARGET_SHA256="$EXPECTED_PROD_DB_TARGET_SHA256" \
       EXPECTED_PROD_DB_CA_SHA256="$EXPECTED_PROD_DB_CA_SHA256" \
       node --env-file=/secure/prod-db.env --input-type=module <<'NODE'
   import { createHash } from "node:crypto";
   import { spawn } from "node:child_process";
   import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   const connection = process.env.SIDESTREAM_POSTGRES_URL_NON_POOLING?.trim()
     || process.env.POSTGRES_URL_NON_POOLING?.trim();
   if (!connection || process.env.POSTGRES_URL_NON_POOLING ||
       process.env.SIDESTREAM_ENV_FILE || process.env.SIDESTREAM_DB_ENV_FILE) {
     throw new Error("Expected only the reviewed Sidestream direct Postgres URL");
   }
   const url = new URL(connection);
   if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hash ||
       !url.hostname || url.hostname.includes(",") ||
       url.hostname.includes("pooler") || url.port === "6543") {
     throw new Error("Expected the reviewed direct backup target");
   }
   const allowedParameters = new Set(["sslmode", "sslrootcert"]);
   for (const key of url.searchParams.keys()) {
     if (!allowedParameters.has(key)) {
       throw new Error(`Forbidden endpoint/TLS query parameter: ${key}`);
     }
   }
   for (const key of allowedParameters) {
     if (url.searchParams.getAll(key).length !== 1) {
       throw new Error(`Expected exactly one ${key} query parameter`);
     }
   }
   const caPath = url.searchParams.get("sslrootcert") || "";
   if (url.searchParams.get("sslmode") !== "verify-full" ||
       !caPath.startsWith("/secure/")) {
     throw new Error("Backup requires verify-full and the reviewed provider CA");
   }
   const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
   const user = decodeURIComponent(url.username);
   const password = decodeURIComponent(url.password);
   const portText = url.port || "5432";
   const port = Number(portText);
   if (!databaseName || !user || !password || !/^\d+$/.test(portText) ||
       !Number.isSafeInteger(port) || port < 1 || port > 65535) {
     throw new Error("Backup URL has invalid explicit connection fields");
   }
   const target = `${url.hostname.toLowerCase()}:${portText}/${databaseName}`;
   const targetSha256 = createHash("sha256").update(target).digest("hex");
   if (targetSha256 !== process.env.EXPECTED_PROD_DB_TARGET_SHA256) {
     throw new Error("Backup database target fingerprint mismatch");
   }
   const providerCaSha256 = createHash("sha256")
     .update(await readFile(caPath)).digest("hex");
   if (providerCaSha256 !== process.env.EXPECTED_PROD_DB_CA_SHA256) {
     throw new Error("Backup provider CA fingerprint mismatch");
   }
   const escapePassfile = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
   const passDirectory = await mkdtemp(join(tmpdir(), "sidestream-pgpass-"));
   const passfile = join(passDirectory, "pgpass");
   try {
     await writeFile(
       passfile,
       `${[url.hostname, portText, databaseName, user, password]
         .map(escapePassfile).join(":")}\n`,
       { mode: 0o600 },
     );
     const child = spawn(
       "pg_dump",
       ["--no-password", "--format=custom", "--file", process.env.BACKUP_PATH],
       {
         env: {
           PATH: process.env.PATH,
           HOME: process.env.HOME,
           PGHOST: url.hostname,
           PGPORT: portText,
           PGDATABASE: databaseName,
           PGUSER: user,
           PGPASSFILE: passfile,
           PGSSLMODE: "verify-full",
           PGSSLROOTCERT: caPath,
         },
         stdio: "inherit",
       },
     );
     const code = await new Promise((resolve, reject) => {
       child.once("error", reject);
       child.once("close", resolve);
     });
     if (code !== 0) throw new Error(`pg_dump exited ${code}`);
   } finally {
     await rm(passDirectory, { recursive: true, force: true });
   }
   NODE
     shasum -a 256 "$BACKUP_PATH"
     pg_restore --list "$BACKUP_PATH" > "${BACKUP_PATH}.restore-list.txt"
   )
   ```

   Retain the backup checksum and restore list (or provider equivalent). Do not
   put the URL, backup, or restore listing in the repository. Any failed backup or
   restore verification blocks cutover.

7. **Capture authoritative migration state read-only only after authenticated
   tooling exists.** The current migration runner and baseline verifier open
   their own remote connections with certificate verification disabled. Step 6's
   successful connection cannot authenticate those separate connections. Do not
   run the current `db:migrate --status`, `--baseline`, apply, or
   baseline-verifier paths against Production. `--validate` and `--dry-run` are
   local-only: they return before env-file loading or database selection, so they
   may be retained as source-file evidence but cannot authenticate or report
   Production state. Production remains blocked until a separately owned code
   change makes every database-backed runner/verifier mode
   start from a clean environment, load the reviewed provider CA, validate the
   hostname/certificate with verify-full-equivalent semantics, and report the
   selected variable plus connected database without exposing a URL. After that
   implementation is reviewed and tested, retain its status as the authoritative
   complete applied/pending filename state and pair it with the local validation
   and dry-run output.

   The future authenticated status is authoritative for complete applied/pending
   filenames and must fail on a
   tracked checksum mismatch, but it does not print checksum values. Retain
   explicit local and ledger checksum values with this separate authenticated,
   read-only export. This block does not make the current migration runner safe.
   Rerun step 6 first; set `CHECKSUM_EVIDENCE` to an access-controlled path outside
   the repository:

   ```bash
   (
     set -e
     set +x
     set -o pipefail
     test -n "$CHECKSUM_EVIDENCE"
     test -n "$EXPECTED_PROD_DB_TARGET_SHA256"
     test -n "$EXPECTED_PROD_DB_CA_SHA256"
     env -i PATH="$PATH" HOME="$HOME" CHECKSUM_EVIDENCE="$CHECKSUM_EVIDENCE" \
       EXPECTED_PROD_DB_TARGET_SHA256="$EXPECTED_PROD_DB_TARGET_SHA256" \
       EXPECTED_PROD_DB_CA_SHA256="$EXPECTED_PROD_DB_CA_SHA256" \
       node --env-file=/secure/prod-db.env --input-type=module \
       <<'NODE' | tee "$CHECKSUM_EVIDENCE"
   import { createHash } from "node:crypto";
   import { readFile } from "node:fs/promises";
   import { Pool } from "pg";
   import {
     loadMigrationFiles,
     validateMigrationFiles,
   } from "./scripts/apply-postgres-migrations.mjs";

   const databaseNames = [
     "SIDESTREAM_POSTGRES_URL_NON_POOLING", "POSTGRES_URL_NON_POOLING",
     "SIDESTREAM_TEST_POSTGRES_URL", "SIDESTREAM_POSTGRES_URL",
     "SIDESTREAM_POSTGRES_PRISMA_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
   ];
   const selected = databaseNames.filter((name) => process.env[name]?.trim());
   if (selected.length !== 1 || selected[0] !== "SIDESTREAM_POSTGRES_URL_NON_POOLING" ||
       process.env.SIDESTREAM_ENV_FILE || process.env.SIDESTREAM_DB_ENV_FILE ||
       process.env.POSTGRES_SSL === "0") {
     throw new Error(`Unexpected database/env-file selection: ${selected.join(",")}`);
   }
   const raw = process.env.SIDESTREAM_POSTGRES_URL_NON_POOLING.trim();
   const url = new URL(raw);
   if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash ||
       !url.hostname || url.hostname.includes(',') ||
       url.hostname.includes('pooler') || url.port === '6543') {
     throw new Error("Direct migration URL must use postgres protocol");
   }
   const allowedParameters = new Set(['sslmode', 'sslrootcert']);
   for (const key of url.searchParams.keys()) {
     if (!allowedParameters.has(key)) {
       throw new Error(`Forbidden endpoint/TLS query parameter: ${key}`);
     }
   }
   for (const key of allowedParameters) {
     if (url.searchParams.getAll(key).length !== 1) {
       throw new Error(`Expected exactly one ${key} query parameter`);
     }
   }
   const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
   const user = decodeURIComponent(url.username);
   const password = decodeURIComponent(url.password);
   const portText = url.port || '5432';
   const port = Number(portText);
   if (!databaseName || !user || !password || !/^\d+$/.test(portText) ||
       !Number.isSafeInteger(port) || port < 1 || port > 65535) {
     throw new Error('Direct migration URL has invalid explicit connection fields');
   }
   const target = `${url.hostname.toLowerCase()}:${portText}/${databaseName}`;
   const targetSha256 = createHash('sha256').update(target).digest('hex');
   if (targetSha256 !== process.env.EXPECTED_PROD_DB_TARGET_SHA256) {
     throw new Error('Production database target fingerprint mismatch');
   }
   const caPath = url.searchParams.get('sslrootcert') || '';
   if (url.searchParams.get('sslmode') !== 'verify-full' ||
       !caPath.startsWith('/secure/') || url.searchParams.has('sslcert') ||
       url.searchParams.has('sslkey')) {
     throw new Error('Checksum evidence requires verify-full and the reviewed provider CA');
   }
   const ca = await readFile(caPath);
   const providerCaSha256 = createHash('sha256').update(ca).digest('hex');
   if (providerCaSha256 !== process.env.EXPECTED_PROD_DB_CA_SHA256) {
     throw new Error('Production database provider CA fingerprint mismatch');
   }
   const migrations = validateMigrationFiles(await loadMigrationFiles());
   const pool = new Pool({
     host: url.hostname,
     port,
     database: databaseName,
     user,
     password,
     max: 1,
     connectionTimeoutMillis: 10_000,
     statement_timeout: 300_000,
     ssl: {
       ca: ca.toString('utf8'),
       rejectUnauthorized: true,
       servername: url.hostname,
     },
   });
   try {
     const client = await pool.connect();
     try {
       await client.query('begin read only');
       const relation = await client.query(
         "select to_regclass('public.sidestream_schema_migrations') as ledger",
       );
       const rows = relation.rows[0].ledger
         ? (await client.query(`
             select filename, checksum_sha256
             from public.sidestream_schema_migrations
             order by filename
           `)).rows
         : [];
       const connected = await client.query('select current_database() as database_name');
       if (connected.rows[0]?.database_name !== databaseName) {
         throw new Error('Connected database identity mismatch');
       }
       await client.query('commit');
       const ledger = new Map(rows.map((row) => [
         String(row.filename), String(row.checksum_sha256),
       ]));
       const localNames = new Set(migrations.map(({ filename }) => filename));
       const extra = [...ledger.keys()].filter((filename) => !localNames.has(filename));
       if (extra.length) throw new Error(`Ledger-only files: ${extra.join(', ')}`);
       let mismatch = false;
       for (const migration of migrations) {
         const ledgerChecksum = ledger.get(migration.filename) || null;
         if (ledgerChecksum && ledgerChecksum !== migration.checksum) mismatch = true;
         console.log(JSON.stringify({
           databaseEnvironmentVariable: selected[0],
           databaseTargetSha256: targetSha256,
           providerCaSha256,
           tlsServerName: url.hostname,
           connectedDatabase: connected.rows[0].database_name,
           filename: migration.filename,
           ledgerStatus: ledgerChecksum ? 'recorded' : 'not-recorded',
           localChecksumSha256: migration.checksum,
           ledgerChecksumSha256: ledgerChecksum,
         }));
       }
       if (mismatch) throw new Error('Local and ledger migration checksums differ');
     } finally {
       client.release();
     }
   } finally {
     await pool.end();
   }
   NODE
   )
   ```

   Before baseline, a missing ledger is recorded as `ledgerStatus=not-recorded`
   and `ledgerChecksumSha256=null`; after migration, every file must be `recorded`
   with identical local and ledger SHA-256 values. If status requires a baseline,
   independently compare the catalog and backup. The current
   `verify-migration-baseline.mjs` reads only `process.env`, disables certificate
   verification, recognizes only a named pre-20260713/RLS profile, and does not
   list every later hardening migration. It is neither safe Production transport
   nor complete status/checksum evidence. Do not run it or mutating `--baseline`
   against Production until the authenticated-tooling blocker above is closed.
   Any unexplained drift, incomplete filename state, missing checksum export, or
   checksum mismatch blocks cutover.

8. **Implement and separately prove executable write maintenance.** The current
   `vercel.json` has no maintenance rule or operator bypass. Configure the rules
   in the Vercel Firewall dashboard because dashboard `bypass` actions are not
   available in `vercel.json`. Before **every** Production WAF mutation, export and
   review the complete effective firewall order: platform/DDoS controls, IP
   blocks, every existing custom rule with ID/action/order, every enabled managed
   ruleset, and the proposed final order. Also inventory every hostname that can
   reach the Production environment/database, including canonical, `www`, legacy,
   current generated deployment, and staged Production deployment URLs. A prior
   export is stale after any mutation; retain a fresh pre-change export and
   reviewed diff for each change.

   <!-- SAFETY: WAF-INVENTORY-BEFORE-MUTATION -->

   Vercel evaluates custom rules before managed rules. A matching custom `bypass`
   does not merely skip this runbook's maintenance deny: it allows the request
   through all subsequent custom **and managed** WAF rules. Earlier platform/DDoS
   and IP-blocking layers are not that custom-bypass action. Because the following
   maintenance bypasses must precede the API deny, the security owner must map and
   explicitly accept every unrelated protection each exact tuple suppresses, or
   production mutation is blocked. Review this one exact custom-rule order. The
   permanent limiter must be one shared rule/counter domain spanning the complete
   exact host set; if that cannot be proved, apply step 3's `H` blocker rather
   than duplicating it:

   | Priority/control | Environment, host, path, and method | Additional match | Action |
   | --- | --- | --- | --- |
   | 1. Permanent lead fixed-window control | Production; one shared rule whose exact host set contains every inventoried host; exact `POST /api/download-lead` only | One source-IP counter domain (`H=1`); reviewed `L` requests per ten-minute fixed window in each approved reachable region `R` | **Rate Limit / reject**, never Log; owner accepts approximate trailing-boundary exposure `2 * L * R` plus regional reconciliation risk. If cross-host proof reveals `H>1`, block or separately approve/test `2 * L * R * H` |
   | 2. Operator bypass | Production; each inventoried host; exact `POST /api/download-lead`, `POST /api/license/verify`, or exact `GET` for each of `/api/internal/stripe-events/process`, `/api/internal/download-leads/replay`, `/api/internal/maintenance` | Exact approved source IP **and** `x-sidestream-maintenance-bypass` equal to a short-lived secret | Bypass every subsequent custom and managed WAF rule; it cannot bypass priority 1; approved only with the inventory/risk acceptance above |
   | 3. Stripe reconciliation allow (initially disabled) | Production; only the configured Stripe endpoint host; exact `POST /api/stripe/webhook` | None; application signature verification remains mandatory | After compatible promotion only, bypass every subsequent custom and managed WAF rule; approved only for this exact tuple |
   | 4. Public release reads | Production; every inventoried host; exact `/api/releases/latest`; `GET`, `HEAD`, or `OPTIONS` only | None | Bypass every subsequent custom and managed WAF rule for this exact public read tuple |
   | 5. Public download metadata | Production; every inventoried host; exact `/api/download`; `HEAD` only | None | Bypass every subsequent custom and managed WAF rule for this exact public metadata tuple |
   | 6. API deny | Production; every inventoried host; every `/api/**` path and method | None | Deny |

   These are exact tuples, not prefix exceptions. In particular, tagged and
   untagged `GET /api/download` are denied because a successful tagged GET can
   schedule a referral write. Every Checkout, OAuth, billing, activation, claim,
   license, device, lead, webhook, and internal route not explicitly listed is
   denied. `scripts/smoke-release-endpoints.mjs` needs no bypass only because it
   performs manifest GETs and download HEADs from the public read allowlist.

   Use a dedicated WAF secret distinct from `CRON_SECRET`; never place its value
   in source, shell history, request evidence, or logs. Clone the complete
   reviewed rule order and relevant managed rulesets to Preview first. Prove the
   priority-1 control rejects request `L+1`, is not Log-only, exercises concurrent
   traffic on both sides of a fixed-window boundary in every approved region, and
   shares one source-IP budget across every reachable hostname. Record the
   observed bound plus any cross-region or cross-host counter divergence; any
   independent host/rule counter changes the approved formula to
   `2 * L * R * H` and reopens the blocker.
   Also prove each maintenance dimension independently before any data mutation:
   missing/wrong bypass, wrong IP, host, path, or method is denied; the correct
   WAF bypass reaches application validation without mutation (valid empty JSON
   for lead or license returns application `400`, and missing cron authorization
   returns application `401`); release methods pass; download HEAD passes; tagged and
   untagged download GETs fail; every other API probe fails. For every bypass row,
   prove from published order and traffic evidence that it reaches the application
   and record the complete list of later custom/managed controls it skips. Record
   redacted rule IDs/order/configuration, managed-ruleset inventory, security-owner
   acceptance, and response status/timestamp for every host. Prove the Stripe
   allow's exact tuple on Preview with an invalid Stripe signature that reaches
   the application `400` without recording an event. Vercel documents the available match
   fields and ordered bypass behavior in its [WAF rule reference](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration),
   [firewall execution-order contract](https://vercel.com/docs/vercel-firewall/firewall-concepts),
   and [custom-rule guide](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules).
   If the existing-rule inventory is incomplete, the bypass effect is not
   accepted, or the environment/host/path/method/IP/header scopes cannot all be
   implemented and separately tested, production mutation is blocked. If the
   rejecting limit, `L/R/H` evidence, boundary/cross-host tests, and regional-risk
   acceptance are absent, production mutation is also blocked.

   <!-- ACTION: MUTATE-WAF -->

   Only after every gate above passes, publish the **entire** exact Production
   order in one reviewed configuration change; do not create or alter the
   permanent lead rule in an earlier change. The permanent priority-1 limiter may
   be enabled only after its rejecting, regional, boundary, and shared-cross-host
   proof passes. Stage priorities 2-6 **disabled**. In particular, priority 6 must
   not deny `/api/stripe/webhook` or any API request during the pre-drain, and
   priority 3 remains disabled. Immediately export the complete effective
   firewall, hostname inventory, enabled/disabled state, and final rule order
   again and reject any drift.

   A no-schema Production rehearsal may verify the permanent limiter and disabled
   maintenance configuration identity, but it must not activate the API deny. Any
   rehearsal that activates priority 6 creates a real Stripe maintenance window
   and must perform its own complete step-9 pre-drain, boundary/timers, cron
   disable, and steps 11-12 event reconciliation before the deny is removed. It
   may not reuse or reset a later cutover window. Repeat the full pre-mutation
   inventory/review before any later activation and re-prove the exact reviewed
   configuration identity immediately afterward.

9. **Enter maintenance without disabling Stripe delivery.** While the compatible
   current artifact is still serving the webhook and the destination remains
   enabled, enumerate **every** Workbench page and reconcile every pre-existing
   `Failed` or `Pending` delivery. Require a successful `2xx` delivery to the exact
   endpoint and its matching local ledger row. Retain that exact Workbench ID set
   and also retain every local row whose `terminal_at is null`, including
   `received`, future `retryable`, and unexpired `processing` rows; the ordinary
   due/expired query is not this gate. Run the local processor and wait through
   leases/backoff until **every retained ID** is terminal `processed` or `ignored`,
   a fresh full-table query returns zero rows with `terminal_at is null`, and a
   separate query returns zero `dead_letter` rows. Include any event arriving
   before the boundary in the retained set and repeat the all-nonterminal query.
   Retain exact event IDs, types, attempts, terminal outcomes, and the oldest
   creation time in an immutable `PREDRAIN_EVENT_IDS` evidence set. A future
   retryable row or unexpired lease is backlog, not zero. This exact set remains
   an input to step 11 even when an event predates the bounded maintenance
   account-event interval or no longer appears in a default Workbench view.
   If any exact ID cannot terminalize, retain/carry it into incident evidence and
   stop before the deny; do not hide it by waiting only for `next_attempt_at` to be
   due. If the
   current artifact cannot safely return `2xx` and create/process the ledger row,
   stop: do not ask Stripe to retry into a deny and do not record a maintenance
   boundary. A narrowly scoped temporary webhook allowance is permitted only if
   it was separately reviewed, proved against the compatible current artifact,
   recorded with exact host/path/method/order, and removed before the boundary.

   <!-- SAFETY: STRIPE-DRAIN-BEFORE-DENY -->

   <!-- ACTION: ENTER-MAINTENANCE -->

   Only after that complete pre-existing delivery/local backlog is zero, record a UTC
   maintenance start, a planned closed-write end no more than two hours later, a
   24-hour reconciliation escalation, and a 48-hour hard-abort timestamp. Compute
   the latter two conservatively from the earlier of maintenance start or the
   oldest event creation time discovered above. Record the earliest boundary
   event ID and inclusive `STRIPE_EVENT_WINDOW_GTE`, announce the window, and
   globally disable Vercel Cron Jobs **while priority 6 is still disabled**. Only
   then atomically activate the exact reviewed maintenance state: priorities 2,
   4, 5, and 6 enabled, priority 3 disabled, and the permanent priority 1
   unchanged. Immediately export and compare the active configuration identity,
   then prove the deny and wait for old in-flight writes and function invocations
   to drain. Do not pause or disable the live Stripe event
   destination. The edge deny must instead return non-`2xx` for webhook attempts
   while old code and the migrated schema would be incompatible, entering
   Stripe's bounded retry window. The retained boundary starts only after the
   pre-existing backlog is reconciled but before cron disable/deny, so every event
   accepted during that short transition is inside step 11's account-event and
   Workbench union. All later retries wait for step 11's compatible-artifact
   webhook allowance. If the matrix cannot be activated atomically from the
   reviewed disabled state, production remains blocked.

   Only now, after the deny is proved active and the old artifact's in-flight
   writes and processors have drained, may the historical lifecycle gate at the
   start of this runbook close. Freeze the complete exact transition-ID manifest,
   then run the separately implemented and Preview/Test-proved historical tool in
   canonical full-scan or exact manifest-derived delta mode. Its input must cover
   every refund/dispute lifecycle event through the deny boundary: the provisional
   scan manifest at `HISTORICAL_LIFECYCLE_SCAN_WATERMARK`, every lifecycle ID in
   `PREDRAIN_EVENT_IDS`, and every lifecycle ID accepted or observed between that
   scan and the proved deny/drain. Event-ID ordering or a bounded created-time
   query cannot substitute for the exact set comparison.

   Retain the final input manifest/checksum, source counts, authenticated target,
   `HISTORICAL_LIFECYCLE_DENY_WATERMARK`, before/after outcomes, canonical
   entitlement states, and resulting `stripe_state_event_created_at` /
   `stripe_state_event_id` pairs. Require an immediate idempotency rerun to report
   no changes. A `processed` or `ignored` queue row does not close this gate: the
   reviewed tool must reconcile terminal history independently of the queue's
   conflict-ignore/`terminal_at` path. If a through-boundary ID appears after the
   retained final snapshot, repeat the final audit/reconciliation from the last
   retained manifest; if coverage, canonical state, or the no-op proof is
   incomplete, keep maintenance active and do not enter step 10.

   With that deny proved active, and only after the lifecycle implementation
   blockers have already passed Preview/Test, apply any pre-reviewed live
   event-selection change needed to reach the exact required list. Record the
   old and new `enabled_events`, endpoint/account IDs, and exact update timestamp.
   Do not rotate the signing secret away from the value embedded in the staged
   Production artifact.

   Record the endpoint/account IDs, UTC start, boundary event ID immediately
   before the window, exact selection-update time, every lifecycle event/delivery
   ID observed during it, and later the UTC end/boundary ID; event IDs are
   evidence, not sortable clocks. Set an inclusive `STRIPE_EVENT_WINDOW_GTE`
   epoch at least five minutes before the earlier of maintenance start or the
   selection update, and later an inclusive `STRIPE_EVENT_WINDOW_LTE` at least
   five minutes after the compatible artifact, final selection, and webhook allow
   are stable. The wider interval intentionally over-includes rather than loses a
   boundary event. Classify Checkout, refund, dispute, and allowlisted
   legacy-subscription families even when a family has zero events. Through the
   exact license bypass, use one existing real
   device ID and its existing token to call `POST /api/license/verify`; retain the
   `2xx`/active outcome and timestamp without logging either credential. Confirm
   all other writes and both tagged/untagged download GETs are denied before any
   schema change. If compatible promotion cannot finish inside the approved
   two-hour window, stop the cutover, leave maintenance protection and Stripe
   delivery/reconciliation active, and enter the qualified fallback/fix-forward
   incident path; never extend the window informally.

10. **Migrate, qualify, and promote as one closed-write gate.** Public writes and
    the Stripe webhook remain denied throughout this step.

    The current migration runner and baseline verifier disable remote certificate
    verification. They cannot satisfy step 6's authenticated-transport contract,
    and this documentation-only change does not repair them. A URL fingerprint
    plus `current_database()` is not a substitute. The following action boundary
    therefore remains closed until a separately owned, tested implementation uses
    the reviewed provider CA and verify-full-equivalent hostname/certificate
    validation for **every** database-backed status, baseline, apply, and
    baseline-verifier connection. Local `--validate` and `--dry-run` do not open a
    connection and remain source-file evidence only. The current provider supports that contract, so
    a risk-acceptance exception is not an available shortcut.

    <!-- SAFETY: AUTHENTICATED-DB-BEFORE-MUTATION -->

    <!-- ACTION: APPLY-MIGRATIONS -->

    Do not cross this action marker while the authenticated-tooling blocker is
    open. Once a reviewed implementation closes it, preserve this exact sequence:

    1. Rerun and retain step 6's authenticated-target preflight. Run the future
       authenticated status path and separately retain local validate/dry-run
       evidence. If and only if complete state
       proves a baseline is required, run its explicit authenticated baseline,
       then retain complete filename status. Set `CHECKSUM_EVIDENCE` to a new
       baseline-after path and rerun step 7's separate authenticated read-only
       checksum export. Baseline is not complete evidence unless each recorded
       row's local and ledger SHA-256 values are identical.

    2. Rerun and retain step 6's authenticated-target preflight, use the reviewed
       authenticated runner to apply every pending migration, and retain complete
       filename status. Set `CHECKSUM_EVIDENCE` to the migration-after evidence
       path and rerun the exact step 7 checksum export. Require every local
       migration through the chain tip to be `recorded`, every local/ledger
       SHA-256 pair to match, and no ledger-only filename. Status alone is not
       retainable checksum evidence.

    3. Do not run the current legacy audit/apply tool. Step 4's exact live catalog
       proof remains required, but it cannot authenticate the separate database
       connection opened by `audit-legacy-subscriptions.mjs`. This action stays
       blocked until the tool itself implements clean selection, strict
       endpoint/TLS-option rejection, explicit connection fields, pinned provider
       CA and hostname verification, and connected-target evidence. After that
       separately owned implementation passes disposable/Test proof and review,
       rematerialize its command-specific secrets, rerun step 4's entire catalog
       gate immediately before the future authenticated apply, and rerun the
       authenticated read-only audit afterward. Retain the database identity,
       Stripe account, exact Product/Price, secret-file version/hash, and counts.
       This documentation-only revision intentionally provides no executable
       Production legacy command.

    4. Against the protected, staged Production deployment ID from step 5,
       repeat the bounded release matrix with authenticated `vercel curl`
       requests. Through Deployment Protection authentication plus the exact
       maintenance operator bypass, submit one approved synthetic valid lead
       and require `200 {"ok":true}` without `queued`, then prove its canonical
       Postgres row. Use a reserved `.invalid` address and unique
       lowercase compact-UTC source such as
       `cutover-canary-20260714t123456z`. The repository has no synthetic-lead cleanup
       command. Before submission, record an approved disposition: retain and
       exclude that source from reporting, or supply a separately reviewed cleanup
       procedure. If neither disposition is approved, do not create the row and
       block cutover. Capture the final disposition after the canary.

    5. Through `env -i` with only `PATH`, `HOME`, approved expected account/resource
       IDs, and `/secure/prod-stripe-read.env`, first retrieve and assert the exact
       live Stripe account as in steps 4/11, then read only the configured Product
       and Price. Require `livemode=true`, active Product and Price, one-time USD
       999, and exact Product ownership; record only IDs/mode/outcomes. An inherited
       `STRIPE_SECRET_KEY` is never acceptable. Do not call
       `GET /api/checkout/start`, activation status, or any other production
       maintenance smoke: Checkout start inserts an intent, while activation
       status can reconcile payment or issue credentials. Do not run a test-mode
       Checkout or a synthetic live charge against Production.

    6. Reassert the release identity and only then promote the already-built staged
       Production artifact without rebuilding. Keep `RELEASE_DEPLOYMENT` and
       `FALLBACK_DEPLOYMENT` separate and immutable; never introduce a mutable
       `DEPLOYMENT` alias. Immediately before promotion, require the exact release
       ID to equal its approved recorded value and differ from the fallback, the
       pinned checkout to equal `RELEASE_SHA`, and a fresh explicit-scope project
       inspection to equal the approved team/project. Capture a fresh inspection
       of that exact release ID and reject unless it reasserts the approved project,
       commit, build identity, Production environment, protected generated URL,
       no attached Production domain, and immutable deployment ID. Re-run the
       unauthenticated protection probe and require Vercel's protection response,
       not an application response. Finally, recompute the retained step-5
       qualification-manifest checksum and require its complete release matrix,
       source/config checksum, build logs, and protection evidence to remain
       unchanged. Any missing machine-readable field or ambiguous inspection is a
       blocker, not permission to promote.

       ```bash
       (
         set -euo pipefail
         set +x
         test -n "${VERCEL_TOKEN:-}"
         test -n "${RELEASE_DEPLOYMENT:-}"
         test -n "${FALLBACK_DEPLOYMENT:-}"
         test -n "${APPROVED_RELEASE_DEPLOYMENT:-}"
         test -n "${RELEASE_SHA:-}"
         test -n "${RELEASE_TREE:-}"
         test -n "${RELEASE_EVIDENCE_DIR:-}"
         test -n "${RELEASE_QUALIFICATION_MANIFEST:-}"
         test -n "${EXPECTED_RELEASE_QUALIFICATION_SHA256:-}"
         test -n "${RELEASE_PROJECT_REASSERTION:-}"
         test -n "${RELEASE_IDENTITY_REASSERTION:-}"
         [[ "$EXPECTED_RELEASE_QUALIFICATION_SHA256" =~ ^[0-9a-f]{64}$ ]]
         RELEASE_QUALIFICATION_SIGNATURE_EVIDENCE="$RELEASE_EVIDENCE_DIR/release-qualification-signature.txt"
         test -s "$RELEASE_QUALIFICATION_SIGNATURE_EVIDENCE"
         readonly RELEASE_DEPLOYMENT
         readonly FALLBACK_DEPLOYMENT
         test "$RELEASE_DEPLOYMENT" = "$APPROVED_RELEASE_DEPLOYMENT"
         test "$RELEASE_DEPLOYMENT" != "$FALLBACK_DEPLOYMENT"
         test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
         test "$(git rev-parse 'HEAD^{tree}')" = "$RELEASE_TREE"
         git diff --quiet
         git diff --cached --quiet
         test -z "$(git ls-files --others --exclude-standard)"
         test -z "$(git ls-files --others --ignored --exclude-standard | \
           awk '$0 !~ /^\.vercel\//')"
         actual_manifest_sha256="$(
           shasum -a 256 "$RELEASE_QUALIFICATION_MANIFEST" | awk '{print $1}'
         )"
         [[ "$actual_manifest_sha256" =~ ^[0-9a-f]{64}$ ]]
         test "$actual_manifest_sha256" = "$EXPECTED_RELEASE_QUALIFICATION_SHA256"
         env -i PATH="$PATH" HOME="$HOME" \
           EVIDENCE_DIR="$RELEASE_EVIDENCE_DIR" \
           QUALIFICATION_MANIFEST="$RELEASE_QUALIFICATION_MANIFEST" \
           DEPLOYMENT="$RELEASE_DEPLOYMENT" GIT_COMMIT="$RELEASE_SHA" \
           GIT_TREE="$RELEASE_TREE" VERCEL_ORG_ID="$EXPECTED_VERCEL_ORG_ID" \
           VERCEL_PROJECT_ID="$EXPECTED_VERCEL_PROJECT_ID" \
           node --input-type=module <<'NODE'
         import { createHash } from "node:crypto";
         import { readFile } from "node:fs/promises";
         import path from "node:path";
         const manifest = JSON.parse(await readFile(
           process.env.QUALIFICATION_MANIFEST, "utf8",
         ));
         const expected = {
           schemaVersion: 1,
           role: "release",
           deployment: process.env.DEPLOYMENT,
           gitCommit: process.env.GIT_COMMIT,
           gitTree: process.env.GIT_TREE,
           vercelOrgId: process.env.VERCEL_ORG_ID,
           vercelProjectId: process.env.VERCEL_PROJECT_ID,
           environment: "production",
           deploymentProtectionScope: "standard",
         };
         for (const [field, value] of Object.entries(expected)) {
           if (!value || value.includes?.("<") || manifest[field] !== value) {
             throw new Error(`Qualification identity mismatch: ${field}`);
           }
         }
         if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
           throw new Error("Qualification manifest has no artifacts");
         }
         const names = manifest.artifacts.map((artifact) => artifact.path);
         if ([...names].sort().join("\n") !== names.join("\n") ||
             new Set(names).size !== names.length) {
           throw new Error("Qualification artifacts are not unique and sorted");
         }
         for (const artifact of manifest.artifacts) {
           if (path.basename(artifact.path) !== artifact.path ||
               !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
               !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
             throw new Error(`Invalid qualification artifact: ${artifact.path}`);
           }
           const body = await readFile(path.join(process.env.EVIDENCE_DIR, artifact.path));
           const digest = createHash("sha256").update(body).digest("hex");
           if (body.length !== artifact.bytes || digest !== artifact.sha256) {
             throw new Error(`Qualification artifact drift: ${artifact.path}`);
           }
         }
       NODE
         env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
           npx vercel@latest project inspect "$EXPECTED_VERCEL_PROJECT_ID" \
           --scope "$VERCEL_TEAM_SLUG" > "$RELEASE_PROJECT_REASSERTION"
         env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
           npx vercel@latest inspect "$RELEASE_DEPLOYMENT" --wait --format=json \
           --scope "$VERCEL_TEAM_SLUG" > "$RELEASE_IDENTITY_REASSERTION"
         test -s "$RELEASE_PROJECT_REASSERTION"
         test -s "$RELEASE_IDENTITY_REASSERTION"
       )
       ```

       The release owner and independent approver must compare and sign those two
       fresh nonempty reassertion files against the approved values above, verify
       the manifest's independent signature receipt cryptographically binds the
       exact expected digest, approved signer, successful result, and UTC time,
       re-confirm current Standard
       Protection with no public exception, and record a repeated unauthenticated
       protection probe before crossing this boundary. Any missing file, empty or
       malformed digest, failed artifact rehash, dirty deployable tree, or unknown
       inspection field fails closed:

       <!-- SAFETY: RELEASE-IDENTITY-BEFORE-PROMOTE -->
       <!-- ACTION: PROMOTE-RELEASE -->

       ```bash
       (
         set -euo pipefail
         set +x
         test -n "${VERCEL_TOKEN:-}"
         test "$RELEASE_DEPLOYMENT" = "$APPROVED_RELEASE_DEPLOYMENT"
         env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
           npx vercel@latest promote "$RELEASE_DEPLOYMENT" \
           --scope "$VERCEL_TEAM_SLUG"
         env -i PATH="$PATH" HOME="$HOME" VERCEL_TOKEN="$VERCEL_TOKEN" \
           npx vercel@latest inspect "$RELEASE_DEPLOYMENT" --format=json \
           --scope "$VERCEL_TEAM_SLUG"
       )
       ```

       Require the recorded deployment/build identity to become Current unchanged;
       any new deployment ID/build or source/config/environment drift aborts.
       Run `node scripts/smoke-release-endpoints.mjs --base-url "$DEPLOY_BASE_URL"`
       on the canonical host; it needs no maintenance WAF bypass because its
       manifest GETs and download HEADs are exactly the public allowlist reads.
       Then, through the
       exact maintenance bypass on the promoted production hostname, repeat
       `POST /api/license/verify` with the same real device/token from step 9 and
       require the same successful active result. The staged Production hostname
       may not satisfy the license host allowlist; wait for this post-promotion
       canary rather than changing host/environment configuration and invalidating
       the artifact. A continuity failure blocks reopening until a tested dual-hash
       migration exists.

    7. Recheck authoritative filename status and rerun the separate checksum
       export, then inspect entitlement states/watermarks, pool health, lead
       canary/fallback state, and release parity. Any schema/checksum drift,
       missing checksum evidence, queued canary, missing fallback, artifact
       mismatch, or failed license canary leaves maintenance active and triggers
       the fallback/fix-forward gate.

11. **Reopen only Stripe webhook delivery and reconcile the exact window.** Keep
    every other write denied. Enable only matrix priority 3 for exact
    `POST /api/stripe/webhook` on the configured endpoint host; Stripe cannot send
    the operator header, so this is a separate narrowly scoped phase. Keep the
    destination enabled. In Stripe Workbench, close the recorded UTC/boundary-ID
    window and enumerate **every page** of endpoint deliveries. Record IDs, types,
    status, attempts, and counts for Checkout completion, refund (including
    `refund.failed`), dispute, and allowlisted legacy-subscription families,
    explicitly recording zero where applicable. Workbench is endpoint-attempt
    evidence, not the complete account event set.

    Independently enumerate the account-level Stripe Events API over the inclusive
    conservative `created` interval. The API accepts up to 20 `types` and returns
    at most 100 per page; `autoPagingEach` below must finish. Set the output to an
    access-controlled path outside the repository. The clean Stripe file contains
    only `STRIPE_SECRET_KEY`; this script asserts live mode and the approved
    account, writes only event identity/type/time, and never writes payloads or the
    key:

    ```bash
    (
      set -e
      set +x
      test -n "$STRIPE_EVENT_WINDOW_GTE"
      test -n "$STRIPE_EVENT_WINDOW_LTE"
      test -n "$STRIPE_ACCOUNT_EVENTS"
      test -n "$EXPECTED_STRIPE_ACCOUNT_ID"
      env -i PATH="$PATH" HOME="$HOME" \
        EXPECTED_STRIPE_ACCOUNT_ID="$EXPECTED_STRIPE_ACCOUNT_ID" \
        STRIPE_EVENT_WINDOW_GTE="$STRIPE_EVENT_WINDOW_GTE" \
        STRIPE_EVENT_WINDOW_LTE="$STRIPE_EVENT_WINDOW_LTE" \
        STRIPE_ACCOUNT_EVENTS="$STRIPE_ACCOUNT_EVENTS" \
        node --env-file=/secure/prod-stripe-read.env --input-type=module <<'NODE'
    import { open } from "node:fs/promises";
    import Stripe from "stripe";

    const types = [
      "checkout.session.completed",
      "charge.refunded", "charge.updated",
      "refund.created", "refund.updated", "refund.failed",
      "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
      "customer.subscription.created", "customer.subscription.updated",
      "customer.subscription.deleted",
    ];
    const integer = (name) => {
      const raw = process.env[name] || "";
      if (!/^\d+$/.test(raw)) throw new Error(`${name} must be epoch seconds`);
      return Number(raw);
    };
    const gte = integer("STRIPE_EVENT_WINDOW_GTE");
    const lte = integer("STRIPE_EVENT_WINDOW_LTE");
    if (gte > lte || lte - gte > 72 * 60 * 60) {
      throw new Error("Stripe account-event interval must be ordered and at most 72 hours");
    }
    const forbidden = [
      "SIDESTREAM_ENV_FILE", "SIDESTREAM_DB_ENV_FILE",
      "SIDESTREAM_POSTGRES_URL_NON_POOLING", "POSTGRES_URL_NON_POOLING",
      "SIDESTREAM_TEST_POSTGRES_URL", "SIDESTREAM_POSTGRES_URL",
      "SIDESTREAM_POSTGRES_PRISMA_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL",
      "SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS",
      "SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS",
    ].filter((name) => process.env[name]?.trim());
    if (forbidden.length) {
      throw new Error("Stripe event enumeration received forbidden inherited configuration");
    }
    const stripeKey = process.env.STRIPE_SECRET_KEY?.trim() || "";
    if (!stripeKey.startsWith("sk_live_")) throw new Error("Expected a live Stripe key");
    const stripe = new Stripe(stripeKey);
    const account = await stripe.accounts.retrieve();
    if (account.id !== process.env.EXPECTED_STRIPE_ACCOUNT_ID) {
      throw new Error("Stripe account mismatch");
    }
    const counts = Object.fromEntries(types.map((type) => [type, 0]));
    const output = await open(process.env.STRIPE_ACCOUNT_EVENTS, "wx", 0o600);
    try {
      await stripe.events.list({ types, created: { gte, lte }, limit: 100 })
        .autoPagingEach(async (event) => {
          if (!event.livemode || !types.includes(event.type) ||
              event.created < gte || event.created > lte) {
            throw new Error(`Unexpected Stripe event ${event.id}`);
          }
          counts[event.type] += 1;
          await output.write(`${JSON.stringify({
            id: event.id, type: event.type, created: event.created,
          })}\n`);
        });
    } finally {
      await output.close();
    }
    console.log(JSON.stringify({
      stripeAccountId: account.id, gte, lte, counts,
      output: process.env.STRIPE_ACCOUNT_EVENTS,
    }));
    NODE
      shasum -a 256 "$STRIPE_ACCOUNT_EVENTS"
    )
    ```

    Retain the account/type counts and file checksum. Union these account-event
    IDs with all paginated Workbench endpoint-delivery IDs **and every exact ID
    in step 9's immutable `PREDRAIN_EVENT_IDS` set**; deduplicate only by exact
    event ID and preserve all three evidence sources. An account event absent
    from endpoint deliveries is not zero activity: it is evidence of the
    selection gap and must be explicitly sent/retried to this exact endpoint with
    reviewed Stripe tooling. If Workbench pagination/export or the List Events
    enumeration cannot be completed, if the event interval has aged beyond the
    API's 30-day full-payload window, or if reviewed tooling cannot deliver every
    unioned ID, production remains blocked.

    For every refund/dispute lifecycle ID at or before step 9's retained deny
    boundary, also prove membership and canonical outcome in the final historical
    lifecycle receipt; a local `processed`/`ignored` row and `2xx` delivery are not
    substitutes. Any lifecycle event first created or observed after that boundary
    must be handled by the fixed artifact and have its canonical entitlement state
    plus resulting watermark retained here. If account enumeration reveals a
    through-boundary ID missing from the final historical manifest, return to the
    post-deny full/delta gate, extend the exact manifest without moving either
    watermark or boundary forward, rerun reconciliation to a no-op, and keep all
    non-webhook writes denied.

    Calculate and retain each event's creation time before relying on a resend.
    Live automatic attempts stop after at most three days; Dashboard/Workbench
    Resend stops after 15 days; `stripe events resend` stops after 30 days.
    Individually Retry/Resend every `Failed` or `Pending` delivery in Workbench
    while it is eligible and require a `2xx` attempt. For every ID in the union,
    including step-9 pre-drain IDs, already Delivered events, and account events
    initially missing from endpoint deliveries, prove a `2xx` attempt to the exact endpoint and a matching
    `public.sidestream_stripe_events` ledger row with the expected type. Manually invoke
    `GET /api/internal/stripe-events/process` through both the WAF bypass and
    `CRON_SECRET` until every exact unioned ID is terminal; require expected
    `processed`/`ignored` outcomes, entitlement watermarks, zero rows across every
    `terminal_at is null` state (including future retryable and unexpired
    processing work), and zero `dead_letter` rows. A manual
    Stripe resend does not reset a local dead letter. This repository still has
    no local dead-letter reset/replay tool, so any dead letter blocks reopening.
    If the destination is discovered to have been disabled during any part of the
    window, do not assume events created then will auto-resend: enumerate those
    event IDs separately and resend/reconcile each with reviewed Stripe tooling.
    If complete reconciliation remains unresolved 24 hours after the conservative
    start/oldest-event timestamp from step 9, page the incident owner, verify
    reviewed Stripe CLI/export access immediately, and begin explicit event-ID
    recovery rather than waiting for automatic retries. At 48 hours, hard-abort
    the cutover: keep every non-webhook write denied, keep the destination and
    exact webhook reconciliation path enabled, and enter qualified
    fallback/fix-forward recovery. Never reopen merely because a later 15-day
    Dashboard or 30-day CLI ceiling still exists. If an older discovered event is
    already outside Dashboard eligibility, use reviewed CLI resend before its
    30-day ceiling; if it is outside all available resend tooling, or Workbench
    pagination, credentials, export, or other reviewed tooling cannot prove the
    complete event-ID set, production remains blocked. Crossing any deadline is
    an incident/abort signal, not authorization to omit an ID.

12. **Manually prove all jobs, then reopen once.** Keep project cron scheduling
    globally disabled and public writes denied. Sequentially, never concurrently:

    1. Record the final zero-nonterminal and zero-dead Stripe processor/query
       evidence from step 11. Reverify that the final post-deny historical
       lifecycle receipt covers every exact lifecycle ID through the retained
       deny boundary, including lifecycle IDs from `PREDRAIN_EVENT_IDS` and the
       transition window, and proves canonical entitlement state, resulting
       watermarks, and a no-op idempotency rerun. Queue terminality alone does not
       authorize reopening.
    2. Invoke protected GET lead replay through the operator bypass until
       `hasMore=false`; require no malformed, unmapped, read, database, or delete
       failures and record the fallback disposition.
    3. Invoke protected GET maintenance through the operator bypass until its
       bounded outcome is understood; record every count and investigate failure,
       unexpected deletion/redaction, or persistent `hasMore`.

    There is no available one-job schedule toggle. If all three manual gates and
    every prior abort check pass, enable project cron scheduling once while the
    maintenance deny still protects the API, then immediately publish the normal
    WAF configuration: remove the broad maintenance deny, temporary public-read
    and Stripe reconciliation bypass rules, and operator bypass; retain exact
    priority 1, the approved permanent regional lead control installed in step 8,
    or the separately implemented durable shared fallback limiter from step 3.
    Revoke the WAF bypass secret and record its rule
    removal/disposition. Verify the next scheduled invocation of all three jobs,
    Stripe due/dead counts, fallback backlog, maintenance counts, pool use,
    Checkout/rate-limit signals, and release parity. If global cron enablement or
    WAF publication fails, keep maintenance active; do not claim cutover complete.

## Qualified fallback or fix-forward (no current application rollback)

No application rollback exists for this release until cutover step 1 qualifies
and step 5 stages a runtime-distinct fallback. If that gate is later satisfied,
fallback is application-forward, not a destructive schema reversal:

1. Branch on the existing maintenance state **before** changing traffic; never
   reset a reconciliation window:

   - If cutover or incident maintenance is already active, preserve the earliest
     recorded maintenance start, `STRIPE_EVENT_WINDOW_GTE`, boundary event IDs,
     `HISTORICAL_LIFECYCLE_SCAN_WATERMARK`, final historical manifest/watermark,
     exact retained/unioned ID sets, two-hour cap, 24-hour escalation, and 48-hour
     hard-abort timestamp. Keep cron disabled, the live Stripe destination
     enabled, and the already-reviewed deny/allow state in place. Extend evidence
     only by adding newly observed IDs and a later inclusive end; never move the
     start forward, restart a timer, or create a replacement window merely because
     fallback begins. If the final post-deny historical lifecycle gate has not yet
     passed, complete it after old in-flight drain before fallback promotion or
     reopening; a previous provisional scan is insufficient.
   - If no maintenance window is active, priority 6 must remain disabled while the
     currently serving compatible artifact receives the webhook. Repeat step 9's
     complete paginated Workbench drain and local all-nonterminal drain: every
     retained exact ID must be terminal `processed`/`ignored`, the full
     `terminal_at is null` query must return zero across future retryable and
     unexpired processing rows, and dead letters must be zero. Only then record the
     new boundary and timers, disable cron, and atomically activate the reviewed
     deny with the Stripe reconciliation allow disabled. If the serving artifact
     cannot complete that drain, do not deny first; keep/restore the narrowly
     reviewed webhook path and fix forward. After the deny is active and old
     in-flight work drains, repeat step 9's final historical full/delta audit and
     idempotent reconciliation through this new deny boundary before promoting or
     reopening.

   In both branches, never disable the destination as a drain mechanism. Retain
   the same three-day automatic, 15-day Dashboard, and 30-day CLI resend ceilings
   from steps 9-11. A prior Production rehearsal window is existing maintenance
   state until it has been fully reconciled and closed; fallback cannot discard it.
2. Promote only the exact immutable `FALLBACK_DEPLOYMENT` staged with the
   Production environment and qualified against the full migrated chain. Never
   assign it to `RELEASE_DEPLOYMENT` or a generic alias. Immediately repeat step
   10's clean-environment project and artifact reassertion against the approved
   fallback values: runtime-distinct `FALLBACK_SHA`, project, immutable deployment
   ID, build identity, Production environment, protection state/probe, full
   qualification-manifest checksum, and absence of an attached Production domain.
   Promote that exact ID only after independent sign-off. Keep the migrated schema
   and checksummed ledger. Neither `c34ef25` nor `c93bc09` is eligible. If the
   fallback does not exist, production mutation should never have begun; if it is
   unavailable after mutation, leave maintenance active and fix forward through
   Preview/Test.
3. Do **not** change device-policy or any other environment value on an existing
   artifact, run down migrations, rewrite/delete the ledger, drop new objects,
   reverse a backfill/quarantine, or restore over later writes. Any source,
   configuration, or environment change requires a new staged build and full
   requalification. Refund, dispute, replay-receipt, redaction, and watermark
   history must survive.
4. Run only the bounded release GET/HEAD smoke, approved lead canary/disposition,
   and same-device/token continuity canary while other writes remain blocked.
   Then follow cutover steps 11-12 exactly: separately allow only the Stripe
   webhook, repeat step 11's paginated account-level event enumeration plus
   Workbench delivery union, reconcile every Failed/Pending delivery and every
   unioned event ID to `2xx` plus a ledger row, require zero
   all-nonterminal/dead work, manually prove all three jobs, enable project
   scheduling once, remove maintenance rules, and
   revoke the bypass. Existing local `dead_letter` rows remain terminal because
   no reset/replay tool exists; do not claim one was replayed without separately
   implemented, reviewed, and tested recovery tooling.

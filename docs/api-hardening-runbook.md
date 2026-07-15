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
behavior, privacy, and support actions.

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
  tool, or qualified runtime-distinct rollback artifact. Every one is treated
  below as a control to prove or an explicit pre-production blocker, never as an
  existing capability.

## HTTP and release contract

Unless a row says otherwise, an unsupported method returns `405` with `Allow`,
and JSON responses are `no-store`.

| Route | Method | Success contract | Important failures |
| --- | --- | --- | --- |
| `/api/download` | `HEAD` | `200` attachment metadata from the selected, validated private Blob | `404` missing/unknown platform; `503` manifest or Blob metadata mismatch; `500` Blob control-plane configuration failure |
| `/api/download` | `GET` | `302` to a five-minute signed private Blob URL; matching ETag returns `304` | Same `404`/`500`/`503` failures as HEAD |
| `/api/releases/latest` | `GET` | `200` public manifest: `schemaVersion`, `product`, `channel`, `platform`, `version`, `minSupportedVersion`, `critical`, `rolloutPercent`, `publishedAt`, `releaseNotesUrl`, and public `artifact` fields | `404` unknown platform; only `channel=stable` is accepted |
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

### Canonical entitlement states

Only `entitlement_status=active` with plan `sidestream_pro` or the compatible
`sidestream_unlimited` is paid access.

| Stripe fact | Canonical result | Credential effect |
| --- | --- | --- |
| Exact one-time payment paid | `active / payment_paid` | May issue credentials |
| Partial refund | `active / partial_refund` | Remains active |
| Full refund | `revoked / full_refund` | Revoke credentials; later stale Checkout cannot resurrect |
| Dispute opened | `suspended / dispute_open` | Revoke credentials while disputed |
| Dispute won | `active / dispute_won` | May reactivate from canonical facts |
| Dispute lost | `revoked / dispute_lost` | Permanently revoked |
| Payment not paid | `revoked / payment_not_paid` | No credentials |
| Unknown or unallowlisted legacy subscription | `unknown` or quarantined `revoked` | No paid access |

The `(stripe_created_at, event_id)` watermark makes lifecycle application
deterministic under duplicate or out-of-order delivery. Never edit entitlement
state by hand to jump ahead of that watermark.

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
transaction. Its modes are:

```bash
npm run db:migrate -- --status
npm run db:migrate -- --validate
npm run db:migrate -- --dry-run
npm run db:migrate -- --baseline
npm run db:migrate
```

An existing non-empty schema without the ledger is not automatically assumed to
be current. `--status` reports that a baseline is required; `--baseline` checks
the known pre-hardening schema and records only migrations it can prove. Applying
refuses an unbaselined non-empty schema. The chain currently ends with
`20260714200000_remove_redundant_download_lead_key_unique.sql`: canonical lead
uniqueness is `(email, cta_source)` and `lead_key` remains a non-unique lookup
index. Runtime DDL is prohibited and checked by
`node scripts/assert-no-runtime-ddl.mjs`.

`npm run db:migrate -- --status` is the authoritative read-only inventory of the
complete checksummed chain: retain every applied/pending filename and checksum
before and after mutation. `scripts/verify-migration-baseline.mjs` is narrower.
It recognizes a known pre-20260713 catalog, verifies its conditional RLS state,
and reports only the baseline-era/activation-rotation guard it understands. It
does not enumerate every later hardening migration through the chain tip and
must never replace or contradict `--status` evidence.

## Stripe event ledger

### Required Stripe webhook subscriptions

Configure the production endpoint for exactly the implemented lifecycle events:

- Checkout completion: `checkout.session.completed`
- Refund lifecycle: `charge.refunded`, `charge.updated`, `refund.created`,
  `refund.updated`
- Dispute lifecycle: `charge.dispute.created`, `charge.dispute.updated`,
  `charge.dispute.closed`
- Allowlisted legacy subscriptions: `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`

Do not add an event merely because Stripe offers it. An unimplemented event is
durably recorded and then ignored; expanding behavior requires code, tests, and
this contract to change together.

### State machine and retry policy

```text
received ──claim──> processing ──success──> processed (terminal)
                        │        └────────> ignored (terminal)
                        ├─failure before attempt 8──> retryable ──due claim──┐
                        ├─failure at attempt 8──────> dead_letter (terminal)│
                        └─expired lease─────────────────────────────────────┘
```

Claims use `FOR UPDATE SKIP LOCKED`, a UUID claim token, an incremented attempt,
and a lease. The general worker defaults are batch 10, five-minute lease, and
eight attempts; the cron is fixed at batch 25 with a ten-minute lease. Backoff is
exponential from five seconds, jittered to 50-100%, capped at 15 minutes, and at
least one second. These bounds are code constants, not environment variables.
Poison events isolate to retry/dead-letter and cannot make `/api/auth/session` or
other customer reads process the queue.

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
edge so delivery receives a non-`2xx` and remains retryable, records the exact
UTC/event-ID window, then explicitly reconciles every delivery before other
writes reopen. Stripe's [event-destination operations](https://docs.stripe.com/workbench/event-destinations)
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
| Stripe retries | Batch/lease/attempt/backoff constants described above. Legacy allowlists are `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS` |
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
```

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

## Human-gated production cutover

Nothing in this section was executed by the documentation-remediation step.
Future operators must record operator, approver, UTC timestamp, target, exact
deployment/commit identity, redacted output, and abort decision for every gate.
No gate authorizes secrets or customer data to be copied into this repository.

1. **Review the release and prove a real fallback.** Pin `RELEASE_SHA` and an
   explicitly reviewed `FALLBACK_SHA`. Inspect API methods, `vercel.json`, the
   complete migration chain/checksums, manifests, and this runbook. The fallback
   must be runtime-distinct, not a docs-only commit difference:

   ```bash
   git diff --quiet "$FALLBACK_SHA" "$RELEASE_SHA" -- api vercel.json package.json
   git diff --name-only "$FALLBACK_SHA" "$RELEASE_SHA" -- api vercel.json package.json
   ```

   Require the first command to exit nonzero and review every listed runtime
   change. Apply the release's full checksummed chain to a disposable database,
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
   authorization, full and partial refund, dispute, and allowlisted legacy
   subscription lifecycle in Stripe test mode. Require zero dead letters. This
   Preview/Test target is the only place the cutover procedure proves Stripe
   test-mode lifecycle; never point test resources at a Production artifact or
   hostname.

3. **Install the permanent lead edge limit.** On Preview first, then Production,
   install a Vercel WAF rule for exact `POST /api/download-lead` by source IP no
   looser than 20 requests per 10 minutes, or the closest stricter supported
   window. Prove database-outage rejection on Preview; verify the identical rule
   match in Production without taking Production Postgres offline. Keep it after
   cutover; the otherwise-valid Blob fallback cannot consume the database limiter.

4. **Freeze Production configuration and license-hash continuity.** Confirm the
   Vercel plan supports the declared cron frequencies. Inventory the Production
   pooled URL, pool budget, `CRON_SECRET`, rate/lead/installer HMAC values, Stripe
   live signing secret and exact Product/Price/legacy allowlists, retention
   values, and license environment without printing values. Run the legacy
   subscription audit read-only with both allowlists empty, review every live
   Product and Price, configure exact IDs, and rerun read-only:

   ```bash
   node scripts/audit-legacy-subscriptions.mjs --read-only \
     --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING
   ```

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

   Inventory the existing live Stripe destination and exact required event list.
   Preserve its endpoint and signing-secret continuity for the staged artifact.
   If event selections must change, prepare the reviewed change now but apply it
   only after step 9's webhook deny is active; keep the destination enabled so
   resulting deliveries fail non-`2xx` and remain visible/retryable.

5. **Stage and qualify the exact Production-environment artifacts.** Finalize
   every Production environment value first, including the license-hash
   continuity value. From clean checkouts of the pinned release and qualified
   fallback, create Production-environment deployments with domains unassigned:

   ```bash
   vercel --prod --skip-domain
   vercel inspect <deployment-id-or-url> --wait
   vercel inspect <deployment-id-or-url> --logs
   ```

   Protect each generated deployment URL and record its commit, deployment ID and
   URL, Production environment, build identity/logs, source/config checksum,
   protection state, and absence of assigned production domains. Qualify the
   release bundle and bounded release GET/HEAD/unknown-platform behavior on that
   protected URL with authenticated `vercel curl --deployment <url>` requests;
   do not weaken protection or call Production database-write/live Checkout
   surfaces. The repository smoke script has no Deployment Protection credential
   option, so it runs only after promotion on the production domain; `vercel curl`
   must reproduce the same staged read matrix. See the primary
   [`vercel curl` contract](https://vercel.com/docs/cli/curl). Preview
   promotion is not this artifact: Vercel rebuilds Preview for Production values.
   A staged Production deployment created with `--prod --skip-domain` can later
   be attached without rebuilding via `vercel promote <deployment-id-or-url>`.
   See Vercel's primary [staged-deployment procedure](https://vercel.com/docs/cli/deploying-from-cli),
   [promotion semantics](https://vercel.com/docs/deployments/promoting-a-deployment),
   and [environment immutability](https://vercel.com/docs/environment-variables).
   Any source, build configuration, or environment change after staging
   invalidates the artifact and requires a new build plus the full qualification.
   Abort on a Preview target, attached domain, commit/build mismatch, missing
   protection, environment drift, failed inspection, or release parity failure.

6. **Take and verify a fresh database backup.** Use the approved direct
   Production URL and `pg_dump` into access-controlled storage. Record its
   checksum and run `pg_restore --list`, or the provider's equivalent restore
   verification. Do not put the URL or backup in the repository.

7. **Capture authoritative migration state read-only.** With an ignored env file
   containing the reviewed direct `SIDESTREAM_POSTGRES_URL_NON_POOLING`, run:

   ```bash
   SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --status
   SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --validate
   SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --dry-run
   ```

   The `--status` output is authoritative for every applied/pending migration and
   checksum through the chain tip. If it requires a baseline, independently
   compare the catalog and backup, then run
   `node scripts/verify-migration-baseline.mjs --json`. That narrower verifier
   must recognize a named pre-20260713/RLS profile; it does not list every later
   hardening migration and is not complete status evidence. Do not run mutating
   `--baseline` yet. Any unexplained drift or incomplete full-chain status blocks
   cutover.

8. **Implement and separately prove executable write maintenance.** The current
   `vercel.json` has no maintenance rule or operator bypass. Configure the rules
   in the Vercel Firewall dashboard because dashboard `bypass` actions are not
   available in `vercel.json`. Inventory every hostname that can reach the
   Production environment/database, including canonical, `www`, legacy, current
   generated deployment, and staged Production deployment URLs. Apply the matrix
   to every exact host (duplicate rules when the UI cannot express a safe set):

   | Priority/control | Environment, host, path, and method | Additional match | Action |
   | --- | --- | --- | --- |
   | 1. Operator bypass | Production; each inventoried host; exact `POST /api/download-lead`, `POST /api/license/verify`, or exact `GET` for each of `/api/internal/stripe-events/process`, `/api/internal/download-leads/replay`, `/api/internal/maintenance` | Exact approved source IP **and** `x-sidestream-maintenance-bypass` equal to a short-lived secret | Bypass remaining maintenance custom rules |
   | 2. Stripe reconciliation allow (initially disabled) | Production; only the configured Stripe endpoint host; exact `POST /api/stripe/webhook` | None; application signature verification remains mandatory | Bypass remaining maintenance custom rules only after the compatible artifact is live |
   | 3. Public release reads | Production; every inventoried host; exact `/api/releases/latest`; `GET`, `HEAD`, or `OPTIONS` only | None | Bypass remaining maintenance custom rules |
   | 4. Public download metadata | Production; every inventoried host; exact `/api/download`; `HEAD` only | None | Bypass remaining maintenance custom rules |
   | 5. API deny | Production; every inventoried host; every `/api/**` path and method | None | Deny |

   These are exact tuples, not prefix exceptions. In particular, tagged and
   untagged `GET /api/download` are denied because a successful tagged GET can
   schedule a referral write. Every Checkout, OAuth, billing, activation, claim,
   license, device, lead, webhook, and internal route not explicitly listed is
   denied. `scripts/smoke-release-endpoints.mjs` needs no bypass only because it
   performs manifest GETs and download HEADs from the public read allowlist.

   Use a dedicated WAF secret distinct from `CRON_SECRET`; never place its value
   in source, shell history, request evidence, or logs. On Preview and then on
   Production in an announced no-schema rehearsal (or as step 9's first phase),
   prove each dimension independently before any data mutation:
   missing/wrong bypass, wrong IP, host, path, or method is denied; the correct
   WAF bypass reaches application validation without mutation (valid empty JSON
   for lead or license returns application `400`, and missing cron authorization
   returns application `401`); release methods pass; download HEAD passes; tagged and
   untagged download GETs fail; every other API probe fails. Record redacted rule
   IDs/order/configuration and response status/timestamp for every host. The
   Stripe allow rule remains disabled in Production; prove its exact tuple on
   Preview with an invalid Stripe signature that reaches the application `400`
   without recording an event. Vercel documents the available match
   fields and ordered bypass behavior in its [WAF rule reference](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration)
   and [custom-rule guide](https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules).
   If the environment/host/path/method/IP/header scopes cannot all be implemented
   and separately tested, production mutation is blocked. If the Production
   matrix is deactivated after rehearsal, retain its reviewed configuration
   identity and re-prove that exact identity immediately after reactivation.

9. **Enter maintenance without disabling Stripe delivery.** Announce the window,
   globally disable Vercel Cron Jobs, activate the proven matrix with the Stripe
   reconciliation allow still disabled, and wait for old in-flight writes and
   function invocations to drain. Do not pause or disable the live Stripe event
   destination. The edge deny must instead return non-`2xx` for webhook attempts
   while old code and the migrated schema would be incompatible, preserving
   Stripe's retry path.

   With that deny proved active, apply any pre-reviewed live event-selection
   change needed to reach the exact required list. Do not rotate the signing
   secret away from the value embedded in the staged Production artifact.

   Record the endpoint ID, UTC start, boundary event ID immediately before the
   window, every lifecycle event/delivery ID observed during it, and later the UTC
   end/boundary ID; event IDs are evidence, not sortable clocks. Classify Checkout,
   refund, dispute, and allowlisted legacy-subscription families even when a
   family has zero events. Through the exact license bypass, use one existing real
   device ID and its existing token to call `POST /api/license/verify`; retain the
   `2xx`/active outcome and timestamp without logging either credential. Confirm
   all other writes and both tagged/untagged download GETs are denied before any
   schema change.

10. **Migrate, qualify, and promote as one closed-write gate.** Public writes and
    the Stripe webhook remain denied throughout this step.

    1. If and only if step 7 proved a baseline is required, run explicit baseline
       and immediately retain complete status:

       ```bash
       SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --baseline
       SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --status
       ```

    2. Apply every pending migration and retain complete filename/checksum status:

       ```bash
       SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate
       SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --status
       ```

    3. Apply the reviewed exact legacy-subscription backfill/quarantine, rerun it
       read-only, and retain Product/Price/count evidence:

       ```bash
       node scripts/audit-legacy-subscriptions.mjs --apply \
         --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
         --confirm APPLY-LEGACY-SUBSCRIPTIONS
       node scripts/audit-legacy-subscriptions.mjs --read-only \
         --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING
       ```

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

    5. From a secret-manager shell, read only the configured live Stripe Product
       and Price. Require `livemode=true`, active Product and Price, one-time USD
       999, and exact Product ownership; record only IDs/mode/outcomes. Do not call
       `GET /api/checkout/start`, activation status, or any other production
       maintenance smoke: Checkout start inserts an intent, while activation
       status can reconcile payment or issue credentials. Do not run a test-mode
       Checkout or a synthetic live charge against Production.

    6. Promote the already-built staged Production artifact without rebuilding:

       ```bash
       vercel promote <deployment-id-or-url>
       vercel inspect <deployment-id-or-url>
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

    7. Recheck authoritative migration status, entitlement states/watermarks,
       pool health, lead canary/fallback state, and release parity. Any schema
       drift, queued canary, missing fallback, artifact mismatch, or failed license
       canary leaves maintenance active and triggers the fallback/fix-forward gate.

11. **Reopen only Stripe webhook delivery and reconcile the exact window.** Keep
    every other write denied. Enable only matrix priority 2 for exact
    `POST /api/stripe/webhook` on the configured endpoint host; Stripe cannot send
    the operator header, so this is a separate narrowly scoped phase. Keep the
    destination enabled. In Stripe Workbench, close the recorded UTC/boundary-ID
    window and export or enumerate every endpoint delivery. Record IDs and counts
    for Checkout completion, refund, dispute, and allowlisted legacy-subscription
    families, explicitly recording zero where applicable.

    Individually Retry/Resend every `Failed` or `Pending` delivery in Workbench
    and require a `2xx` attempt. For every ID in the window, including already
    Delivered events, prove a matching `public.sidestream_stripe_events` ledger
    row with the expected type. Manually invoke
    `GET /api/internal/stripe-events/process` through both the WAF bypass and
    `CRON_SECRET` until all due work is terminal; require expected
    `processed`/`ignored` outcomes, entitlement watermarks, zero due
    received/retryable/expired-lease work, and zero `dead_letter` rows. A manual
    Stripe resend does not reset a local dead letter. This repository still has
    no local dead-letter reset/replay tool, so any dead letter blocks reopening.
    If the destination is discovered to have been disabled during any part of the
    window, do not assume events created then will auto-resend: enumerate those
    event IDs separately and resend/reconcile each with reviewed Stripe tooling.
    If Workbench pagination/retention, credentials, or other reviewed tooling
    cannot prove complete event-ID reconciliation, production remains blocked.

12. **Manually prove all jobs, then reopen once.** Keep project cron scheduling
    globally disabled and public writes denied. Sequentially, never concurrently:

    1. Record the final zero-due Stripe processor invocation from step 11.
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
    and Stripe reconciliation bypass rules, and operator bypass; retain the
    permanent lead rate limit. Revoke the WAF bypass secret and record its rule
    removal/disposition. Verify the next scheduled invocation of all three jobs,
    Stripe due/dead counts, fallback backlog, maintenance counts, pool use,
    Checkout/rate-limit signals, and release parity. If global cron enablement or
    WAF publication fails, keep maintenance active; do not claim cutover complete.

## Qualified fallback or fix-forward (no current application rollback)

No application rollback exists for this release until cutover step 1 qualifies
and step 5 stages a runtime-distinct fallback. If that gate is later satisfied,
fallback is application-forward, not a destructive schema reversal:

1. Re-enter the exact maintenance matrix before changing application traffic.
   Globally disable cron scheduling, keep the live Stripe destination enabled,
   deny its webhook at the edge so attempts receive non-`2xx`, record a new exact
   UTC/event-ID window, block every other write, and wait for in-flight work to
   drain. Never disable the destination as a drain mechanism.
2. Promote only the exact staged Production-environment fallback artifact already
   qualified against the full migrated chain. Verify its recorded runtime-distinct
   commit, deployment ID, build identity, Production environment, and protection
   evidence before `vercel promote`. Keep the migrated schema and checksummed
   ledger. Neither `c34ef25` nor `c93bc09` is eligible. If the fallback does not
   exist, production mutation should never have begun; if it is unavailable after
   mutation, leave maintenance active and fix forward through Preview/Test.
3. Do **not** change device-policy or any other environment value on an existing
   artifact, run down migrations, rewrite/delete the ledger, drop new objects,
   reverse a backfill/quarantine, or restore over later writes. Any source,
   configuration, or environment change requires a new staged build and full
   requalification. Refund, dispute, replay-receipt, redaction, and watermark
   history must survive.
4. Run only the bounded release GET/HEAD smoke, approved lead canary/disposition,
   and same-device/token continuity canary while other writes remain blocked.
   Then follow cutover steps 11-12 exactly: separately allow only the Stripe
   webhook, reconcile every Failed/Pending delivery and every event ID in the
   window to `2xx` plus a ledger row, require zero due/dead work, manually prove
   all three jobs, enable project scheduling once, remove maintenance rules, and
   revoke the bypass. Existing local `dead_letter` rows remain terminal because
   no reset/replay tool exists; do not claim one was replayed without separately
   implemented, reviewed, and tested recovery tooling.

# Sidestream API hardening operations runbook

This is the operator contract for the hardened Sidestream API. It documents the
reviewed implementation and the human gates required to release it. It is not
evidence that a production migration, Stripe configuration change, Vercel WAF
rule, deployment, or cutover has occurred.

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
| `/api/activation/status` | `POST` | `200` state payload: `pending`, `pending_payment`, `active`, `completed`, `not_found`, `device_mismatch`, `expired`, `transfer_required`, `transfer_limit_reached`, `device_replaced`, or `device_deactivated` | `400` malformed; `503` environment unavailable |
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
`docs/single-device-entitlements.md`. None of those reads processes the Stripe
event queue.

### Platform matrix

The release and download routes call the same manifest selector. A mismatch
between these surfaces is a release-blocking incident.

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

## Download-lead fallback and replay

`POST /api/download-lead` normalizes email/source, converges on one row per
`(email, cta_source)`, keeps first/last timestamps and submission count, and
supports `Idempotency-Key` up to 128 characters. Atomic Postgres rate limits are
5 per email and 20 per IP per 10 minutes. Only HMACs of limiter dimensions and
idempotency material are stored.

When Postgres is unavailable, the route writes a deterministic private Blob
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
| Scheduler | `CRON_SECRET`: one stable random value, 16-512 characters, sent as `Authorization: Bearer ...` to every internal route |
| Runtime database | Pooled URL precedence above; `POSTGRES_POOL_MAX` default 4, range 2-20; `POSTGRES_POOL_IDLE_TIMEOUT_MS` 10000, 1000-60000; `POSTGRES_CONNECTION_TIMEOUT_MS` 5000, 250-30000; `POSTGRES_QUERY_TIMEOUT_MS` and `POSTGRES_STATEMENT_TIMEOUT_MS` 10000, 250-60000; `POSTGRES_SSL=0` only for a known local target |
| Migration database | `SIDESTREAM_POSTGRES_URL_NON_POOLING` preferred; `POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS` defaults to 300000 and is bounded 1000-1800000; runner pool max is 1 |
| Test database | `SIDESTREAM_TEST_POSTGRES_URL` is mandatory for integration tests, must be disposable, and must not normalize to any runtime host/port/database target |
| Rate limiter | `SIDESTREAM_RATE_LIMIT_HASH_SECRET`, at least 32 characters and stable; no production fallback. Checkout is fixed at 8/intent and 20/IP per 15 minutes; lead capture is fixed at 5/email and 20/IP per 10 minutes |
| Checkout intent | Signed confirmation TTL 10 minutes; database intent TTL 24 hours; fixed code constants. Product/Price variables are `SIDESTREAM_PRO_PRODUCT_ID`, `SIDESTREAM_PRO_PRICE_ID`, and legacy `SIDESTREAM_UNLIMITED_PRICE_ID` |
| Stripe retries | Batch/lease/attempt/backoff constants described above. Legacy allowlists are `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS` |
| Lead fallback | `SIDESTREAM_LEAD_HASH_SECRET` at least 32 characters (may intentionally share the rate-limit secret), `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX`, plus Vercel Blob auth variables |
| License/device | Preserve `SIDESTREAM_LICENSE_HASH_SECRET`; `SIDESTREAM_DEVICE_POLICY_MODE` is `off`, `observe`, or `enforce`; `SIDESTREAM_TEST_API_HOSTS` strictly identifies Test hosts |
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
| Dead-letter Stripe events | Count `processing_status='dead_letter'` and newest transition | Critical on any new dead-letter. Preserve payload, fix root cause, then replay through reviewed tooling; never flip entitlement rows manually. |
| Oldest event age | Age of oldest due nonterminal event | Warning over 10 minutes, critical over 30 minutes; the processor runs every five minutes. |
| Event failures | `retryable + deadLetter` divided by claimed, plus `processing_failed` route outcomes | Warning above 5% with at least 5 claims in 15 minutes; critical above 20% or any route-level failure for 5 minutes. |
| Checkout volume | Confirmation GETs, confirmed POSTs, created/reused Sessions, `csrf_rejected`, dependency errors | Warning when create failures exceed 1% or 5 in 15 minutes. A GET without a matching confirmation POST is abandonment, not a Stripe failure. |
| Rate limit | `429 code=rate_limited` by scope and total eligible requests | Warning when checkout or lead 429s exceed 5% with at least 10 requests in 15 minutes; investigate abuse before raising limits. |
| Lead fallback backlog | Private Blob count and oldest age under the configured prefix | Warning if nonzero for 15 minutes after Postgres recovers or oldest exceeds 30 minutes; critical over 2 hours or growth across two replay intervals. |
| Unmapped Blob records | Replay `summary.unmapped` and path sample without lead contents | Critical on any new unmapped record. Quarantine/preserve it; do not auto-delete. |
| Maintenance | Missing run, `maintenance_failed`, `hasMore`, duration, and every deletion/redaction count | Critical on any failed run or no completed/locked run in 26 hours; warning when `hasMore` or a count reaches batch size for 3 runs, or a count exceeds 4x its rolling seven-day median. |
| DB pool saturation | Provider connections, pool waiters/acquisition timeouts, query/statement timeouts | Warning at 80% provider connections for 5 minutes or waiters for 1 minute; critical at 90% or any sustained acquisition timeout. Reduce concurrency/pool, do not switch to direct runtime URLs. |
| Release-platform mismatch | Compare manifest and download HEAD platform/version/SHA/filename/size for Mac and Windows aliases | Critical on any mismatch or an unknown platform that does not return `404`; stop promotion and restore the last internally consistent manifests/code. |

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

For a manual protected check, avoid shell history exposure: load
`CRON_SECRET` from the approved secret manager into the process environment and
send the header without printing the value. Prefer GET replay only when
delete-after-commit is intended; use manual POST with `disposition=preserve` for
diagnosis.

## Human-gated production cutover

No item below has been executed merely because this runbook exists. Record the
operator, timestamp, target, command output, and approval for each gate.

1. **Review the integrated diff.** Confirm only reviewed hardening commits are
   present; compare API methods, `vercel.json`, migration checksums, manifests,
   and this runbook. Stop on unexplained drift.
2. **Take and verify a database backup.** Use the approved direct production URL
   and `pg_dump` into access-controlled storage. Record a checksum and run
   `pg_restore --list` (or the equivalent provider restore verification). Do not
   put the URL or backup in the repository.
3. **Inspect migration state and baseline.** With an ignored env file containing
   the reviewed direct `SIDESTREAM_POSTGRES_URL_NON_POOLING`, run:

   ```bash
   SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --status
   SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --validate
   ```

   If status explicitly requires a baseline, independently compare the catalog
   and backup, then run the exact verifier from a secret-manager shell that
   exports the reviewed direct URL:

   ```bash
   node scripts/verify-migration-baseline.mjs --json
   SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate -- --baseline
   ```

   Re-run `--status`; never baseline to silence an unexplained mismatch. The
   verifier must recognize a named pre-20260713 profile and list the expected
   applied/pending filenames before `--baseline` is allowed.
4. **Apply pending migrations through the direct URL.** Ensure the migration
   process is using the non-pooling URL, then run
   `SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env npm run db:migrate`. Re-run
   `--status` and retain the applied filename/checksum evidence.
5. **Inventory and converge legacy subscriptions.** Keep both allowlists empty
   for the first read-only pass:

   ```bash
   node scripts/audit-legacy-subscriptions.mjs --read-only \
     --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING
   ```

   Review every Product and Price. Set the exact approved Product/Price IDs in
   the two allowlists, rerun read-only, then apply the eligible backfill and
   quarantine explicitly:

   ```bash
   node scripts/audit-legacy-subscriptions.mjs --apply \
     --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
     --confirm APPLY-LEGACY-SUBSCRIPTIONS
   ```

   Run read-only again and retain counts. Do not wildcard, infer, or copy an ID
   from the wrong Stripe mode.
6. **Configure secrets and bounded settings.** Confirm the selected Vercel plan
   supports the five- and ten-minute cron frequencies. Set one 16-512 character
   `CRON_SECRET`, a production pooled runtime URL, the reviewed pool budget,
   stable HMAC secrets, Product/Price allowlists, lifecycle settings, and bounded
   retention values. Keep the direct URL out of normal runtime configuration.
7. **Configure the Stripe endpoint.** Point it at `/api/stripe/webhook`, set the
   correct live signing secret, and subscribe to the exact event list above.
   Send signed test-mode events only to the test target first.
8. **Deploy to Preview/Test.** Use a distinct test database and Stripe mode;
   verify license-environment host restrictions. Do not promote yet.
9. **Run build and handler proof.** Run `npx vercel@latest build`, then
   `npm run verify:vercel-build`. Also run `npm run test:api`,
   `npm run test:postgres-integration`, `npm run typecheck`, `npm run build`,
   `node scripts/assert-no-runtime-ddl.mjs`, and
   `node scripts/validate-vercel-contract.mjs`. Exercise each internal route with
   missing, wrong, and correct auth without logging the secret.
10. **Configure the desired Vercel WAF rule for lead ingestion.** Match exact
    path `/api/download-lead` and method `POST`; apply a per-source-IP block/rate
    limit no looser than 20 requests per 10 minutes (or the closest stricter
    Vercel window). Exclude internal replay. Verify a Preview request receives an
    edge rejection before relying on Blob fallback under database failure.
11. **Promote the reviewed Preview build to production.** Record the deployment
    ID and keep the last known-good application deployment available.
12. **Run bounded release and API smoke tests.** Run
    `node scripts/smoke-release-endpoints.mjs --base-url "$DEPLOY_BASE_URL"` and
    test confirmation GET, confirmed test-mode Checkout, activation, authorization,
    lead capture, and protected cron auth. Use `HEAD`/range requests; do not pull
    full installers just to check metadata.
13. **Inspect convergence.** Check pending/retry/dead Stripe counts and oldest
    age, entitlement states/watermarks, lead fallback/replay summaries including
    unmapped records, maintenance output, database pool health, and release
    platform parity before declaring cutover complete.

## Forward-compatible rollback

Rollback is application-forward, not a destructive schema reversal:

1. Pause the three Vercel cron schedules or make their routes unavailable to the
   scheduler. Pause Stripe endpoint delivery when the webhook `waitUntil`
   background drain must also stop; Stripe and the local event ledger retain work
   for later replay.
2. Roll back application code/manifests to the last known-good deployment. Keep
   the migrated database and migration ledger in place; old code must tolerate
   additive columns/tables.
3. Set device policy to `observe` if enforcement is causing false denials. This
   does not resurrect explicitly revoked/replaced credentials.
4. Do **not** run down migrations, delete the ledger, drop new tables/columns,
   reverse a backfill, or restore over new production writes. Refund, dispute,
   quarantine, replay-receipt, and redaction history must survive rollback.
5. Continue read-only monitoring. Fix forward, redeploy Preview, re-run contract
   and smoke proof, then re-enable Stripe delivery and crons one at a time while
   watching oldest-event age, dead letters, fallback backlog, and pool use.

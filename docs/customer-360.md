# Sidestream Customer 360 contract

## Status and authority

Customer 360 is not deployed. Production is not migrated, its backfill has not
run, and no Production Customer 360 API or usage cron is authorized. This file
documents the repository contract and a human-gated Preview/Test-first rollout;
it is not evidence of live state and it contains no Production deployment,
migration, or backfill-apply procedure.

The website repository owns the Customer 360 database, Stripe money projection,
telemetry aggregate import, and private read API. FlowState may provide durable
association values such as `installIdHash`, but it does not select the database,
license namespace, profile, entitlement, or merge result. The FlowState plan is
run only after the website Preview/Test gates in this document pass.

## Domain boundaries

### Profiles, installs, and identity

- A live profile is a stable UUID in exactly one `production` or `test` license
  namespace. Namespace comes from trusted server deployment state, never request
  JSON, `buildChannel`, a header, or a query parameter.
- An anonymous install can create a sparse profile. Its membership key is a
  lowercase 64-character `installIdHash`; the raw install identifier is not
  stored. Contact, commerce, and usage fields may remain null indefinitely.
- Durable link types are `account_identity`, `stripe_customer`,
  `stripe_checkout_session`, `stripe_payment_intent`, `stripe_subscription`,
  `activation_record`, `install_identity_hash`, `support_code`, and
  `installer_receipt_hash`. Account and Stripe values attach only after the
  website reads verified server-side rows. Client-supplied install, support, and
  receipt values are association keys, not authentication.
- A profile can have several purchase links but only one verified account.
  Contact email and display name are materialized only from that verified
  account and never drive a merge.
- A merge stays inside one namespace and preserves the older profile under the
  immutable database total order `(created_at, id)`. The other UUID becomes an
  immutable tombstone, memberships and facts move to the survivor, and an
  append-only audit stores only a hash of the merge evidence. List and detail
  reads return live roots only.
- A unique identity value has one winner. Contradictory attachment evidence is
  not overwritten or auto-merged; it creates an immutable `pending_review`
  record with hashed evidence and exposes `pending_identity_review` on affected
  read models. Contradictory ownership within a canonical payment group clears
  that whole group's profile and sets sticky `identity_conflict` until an
  explicit deterministic merge and group-wide recomputation resolve it.

### Customer identity is not single-device enforcement

Customer 360 install membership and the single-device license policy are
deliberately separate. `installIdHash` is a pseudonymous CRM association key; it
is not the active device binding, credential, transfer counter, or authorization
proof. Customer 360 attachment, merge, commerce, usage, and query code does not
read or mutate active device rows, device credentials, transfer history, license
policy mode, or download authorization. The existing single-device contract
continues to enforce one active device per account independently in each
production/Test namespace.

The Gmail `installer-referral` request HMAC is also separate. It is a
campaign/day attribution value, not an installer receipt or install identity,
and must never attach profiles, merge customers, or enter backfill evidence.

## Commerce and entitlement separation

Customer 360 money is a read-only projection of Stripe events already verified
by the webhook boundary. All money values are nonnegative integer **minor
units**, and every total is partitioned by lowercase three-letter currency.
Amounts from different currencies must never be summed into one customer total.

For each payment group, a succeeded PaymentIntent's `amount_received` is the
canonical gross amount. A captured standalone Charge is canonical only when no
PaymentIntent exists. Until a settled instrument arrives, a paid Checkout or
Invoice may be a fallback. A paid InvoicePayment edge makes its related Invoice
the preferred fallback and suppresses only the matching Checkout fallback;
unrelated Checkouts remain countable. The settled instrument atomically replaces
the fallback instead of adding to it. InvoicePayment rows remain allocation
edges and do not turn a many-to-many invoice/instrument graph into identity
aliases.

Per currency, `grossPaidMinor` is settled customer money,
`offStripePaidMinor` is an included subset of gross rather than an addition or
deduction, and `netPaidMinor = max(grossPaidMinor - refundedMinor -
disputedMinor, 0)`. `paidTransactionCount` counts canonical paid purchases.
Zero-cost upgrades may affect upgrade timing and billing model without creating
paid money.

This ledger is money truth only. It never reads, writes, derives, or blesses
`sidestream_licenses` or device state. The nullable `entitlementStatus` field is
a separate snapshot and must not be inferred from `money`, `billingModel`, or an
upgrade timestamp. Entitlement enforcement remains blocked on the separately
documented `refund.failed` recovery, complete current dispute-status mapping,
bounded Stripe claim/reclaim behavior, and the other Production prerequisites in
`docs/api-hardening-runbook.md`. Customer 360 must not grant or revoke access.

## Usage source and aggregate semantics

### Current telemetry source contract

- `SIDESTREAM_TELEMETRY_POSTGRES_URL` selects a dedicated read-only Postgres
  source and must identify a different database from every website runtime URL.
  The source role gets `SELECT` only; the sync pool also sets transaction
  read-only, uses one connection, and applies 15-second query/statement limits.
  The current remote client disables certificate-chain verification, so it is
  not Production-approved; authenticated hostname/certificate verification and
  connected-target evidence are prerequisites for any future Production plan.
- The only source relation is `public.sidestream_telemetry_events`. The current
  accepted schema version is exactly `0.2.0`. Production accepts build channels
  `production` and `prod`; Test accepts only `test`. Rows require a lowercase
  hex64 install hash and non-null `occurred_at`.
- Only the schema-versioned scalar paths allowlisted in
  `api/_lib/customer-usage.ts` may participate in SQL aggregation. Raw
  `payload` and `data_points` objects never leave the telemetry query or enter
  the website database.
- App activity excludes installer-category and `installer_*` events. Platform
  is reduced to `macos`, `windows`, or `unknown`; app version is a bounded
  latest-value summary.

### Attempts, outcomes, and first timestamps

An attempt begins at the first accepted, non-speculative `download_requested`
event. Attempts deduplicate by install/session/download identity when present,
falling back to telemetry event identity. Speculative requests are excluded;
their terminal facts may be adopted only when linked to a real user download.

`firstDownloadAttemptAt` is the earliest accepted request, whether or not it
finishes. `firstDownloadSucceededAt` is the request time of the earliest attempt
whose final outcome is success, so it may be later or null while an attempt
exists. A finalization with `file_delivered=true` is success unless import
failure evidence is present; cancellation is cancelled; explicit download or
import failure is failure. Legacy completed/failed/cancelled/import events are
used only when the modern finalization is absent.

`downloadOutcomeNumerator` is successful attempts.
`downloadOutcomeDenominator` is terminal outcomes only: success + failure +
cancelled. Pending and unknown attempts are excluded from the denominator and
reported through data-quality flags, so this pair must not be labeled as all
requests or completion rate without that denominator definition.

### Cadence, rolling windows, and freshness

Vercel schedules the protected sync once daily at `05:27` UTC. A completed
namespace run is skipped if invoked again on the same UTC day; an advisory lock
prevents concurrent runs. The default source batch is 250 aggregate rows
(configurable from 25 to 1,000). The high-water key is
`(received_at, telemetry_event_id)`, and every run rereads a 48-hour overlap
(configurable from 24 to 168 hours) so late updates replace affected UTC
install-day buckets. Events whose source `received_at` falls behind the retained
overlap are not guaranteed to repair automatically and require reviewed replay
or backfill handling.

Each completed run rematerializes all live profiles, even if no new event was
found. `activeDays7` covers the current UTC day plus six prior days;
`activeDays30` covers the current UTC day plus 29 prior days. An active day has
at least one non-installer event. `downloadFrequency30d` is accepted download
attempts in that 30-day window divided by active days in the same window,
rounded to six decimal places; it is null when there are no active days. This
daily rematerialization is what makes old activity decay out of rolling windows.

`usage.syncedAt` is when the website aggregate was materialized.
`usage.sourceFreshnessAt` is the greatest source `received_at` captured by the
sync high-water mark, not an occurrence timestamp or proof that every historical
event exists. Source lag is the difference between those timestamps. A null
freshness value means no accepted source high-water has been observed. Operators
must review lag and define an acceptable non-Production threshold before rollout;
the code intentionally does not invent one.

## Private list and detail API

### Authentication and transport

The server-only routes are:

- `POST /api/internal/customers`
- `POST /api/internal/customers/{customerId}`

They require exactly one `Authorization: Bearer <SIDESTREAM_CRM_ADMIN_SECRET>`
credential. The secret is 16-512 printable non-space ASCII characters. Missing
or invalid configuration returns `503`; missing, wrong, combined, or duplicate
credentials return `401`. Any `Origin` header returns `403`, so these routes are
not browser/CORS APIs. Other methods return `405` with `Allow: POST`. Responses
are JSON with `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`,
`Vary: Authorization, Origin`, and `X-Content-Type-Options: nosniff`. Request
bodies are JSON objects capped at 16 KiB; unknown fields fail closed.

The list body requires `licenseNamespace` and accepts `limit`, `cursor`, and
`filters`. `limit` defaults to 50 and is bounded from 1 to 100. Filters are:

| Filter | Accepted value |
| --- | --- |
| `billingModel` | `one_time`, `subscription`, `comped`, or `mixed` |
| `entitlementStatus` | Bounded lowercase status token |
| `hasEmail` | Boolean |
| `activeSince` | ISO timestamp applied to `lastActivityAt` |
| `dataQualityFlag` | One documented quality flag below |

There is intentionally no search text, email substring, name substring, raw
identity, Stripe-ID, or behavioral search filter. The detail body accepts only
`licenseNamespace`; `{customerId}` must be a UUID. Namespace is required on both
routes so a caller cannot retrieve a same-ID record from another namespace.

### Cursors and consistency

List reads use a repeatable-read, read-only transaction and order by
`sort_activity_at`, profile creation time, then customer UUID, all descending.
The opaque keyset cursor is HMAC-SHA-256 signed with
`SIDESTREAM_CRM_ADMIN_SECRET` and binds namespace, limit, and every filter.
Tampering, reusing it with different filters/limit/namespace, or rotating the
secret returns `400 invalid_cursor`. `nextCursor` is null on the final page.

### Response envelopes

List success is `{"customers":[...],"nextCursor":string|null}`. Detail success
is `{"customer":{...}}`; a missing live root in the requested namespace returns
`404 customer_not_found`. List and detail use the same customer object.

Every customer field and nullability is listed here. Timestamps are UTC ISO
strings. Counts and money are decimal strings to avoid JavaScript integer loss.

| Field | Type and nullability | Contract |
| --- | --- | --- |
| `customerId` | UUID string, never null | Stable live profile root |
| `licenseNamespace` | `production` or `test`, never null | Trusted isolation boundary |
| `name` | string or null | Verified account display name |
| `email` | string or null | Verified account contact email |
| `profileLifecycle` | object, never null | Profile lifecycle group |
| `profileLifecycle.createdAt` | ISO string, never null | Immutable profile creation time |
| `profileLifecycle.updatedAt` | ISO string, never null | Latest profile materialization change |
| `profileLifecycle.firstSeenAt` | ISO string or null | Earliest known aggregate sighting |
| `profileLifecycle.lastActivityAt` | ISO string or null | Latest known aggregate activity |
| `installLifecycle` | object, never null | Coarse install membership group |
| `installLifecycle.installCount` | decimal string, never null | Live profile install memberships; `"0"` is valid |
| `installLifecycle.firstSeenAt` | ISO string or null | Earliest install membership sighting |
| `installLifecycle.lastSeenAt` | ISO string or null | Latest install membership sighting |
| `installLifecycle.platform` | string or null | Latest coarse platform summary |
| `installLifecycle.appVersion` | string or null | Latest bounded app-version summary |
| `billingModel` | model string or null | `one_time`, `subscription`, `comped`, or `mixed` |
| `entitlementStatus` | string or null | Separate entitlement snapshot; not derived from money |
| `firstPaidAt` | ISO string or null | Earliest verified paid time across currencies |
| `lastPaidAt` | ISO string or null | Latest verified paid time across currencies |
| `firstUpgradedAt` | ISO string or null | Earliest verified upgrade transition |
| `lastUpgradedAt` | ISO string or null | Latest verified upgrade transition |
| `commerceSyncedAt` | ISO string or null | Latest commerce materialization time |
| `money` | array, never null | Zero or more entries, sorted by currency |
| `money[].currency` | lowercase ISO currency string, never null | Partition key; entries must not be cross-summed |
| `money[].grossPaidMinor` | decimal string, never null | Canonical gross paid minor units |
| `money[].offStripePaidMinor` | decimal string, never null | Subset of gross paid outside Stripe |
| `money[].refundedMinor` | decimal string, never null | Canonical refunded minor units |
| `money[].disputedMinor` | decimal string, never null | Open/lost formal dispute minor units |
| `money[].netPaidMinor` | decimal string, never null | Gross less refund/dispute, floored at zero |
| `money[].paidTransactionCount` | decimal string, never null | Canonical paid purchase count |
| `money[].firstPaidAt` | ISO string or null | First paid time in this currency |
| `money[].lastPaidAt` | ISO string or null | Last paid time in this currency |
| `money[].materializedAt` | ISO string, never null | Currency total materialization time |
| `usage` | object, never null | Privacy-limited usage group |
| `usage.firstDownloadAttemptAt` | ISO string or null | Earliest accepted request time |
| `usage.firstDownloadSucceededAt` | ISO string or null | Earliest successful request time |
| `usage.downloadOutcomeNumerator` | decimal string or null | Successful terminal attempts |
| `usage.downloadOutcomeDenominator` | decimal string or null | Success + failure + cancelled attempts |
| `usage.lastUseAt` | ISO string or null | Latest non-installer app-use time |
| `usage.activeDays7` | decimal string or null | Active UTC days in rolling seven-day window |
| `usage.activeDays30` | decimal string or null | Active UTC days in rolling 30-day window |
| `usage.downloadFrequency30d` | decimal string or null | 30-day attempts per active day, six decimals |
| `usage.syncedAt` | ISO string or null | Website materialization time |
| `usage.sourceFreshnessAt` | ISO string or null | Source receive-time high-water |
| `dataQualityFlags` | string array, never null | Empty or the flags below |

The possible `dataQualityFlags` are `usage_not_synced`,
`missing_install_membership`, `usage_install_count_mismatch`,
`pending_download_outcomes`, `unknown_download_outcomes`,
`outcome_counts_inconsistent`, `attempt_counts_inconsistent`,
`pending_identity_review`, and `commerce_identity_conflict`.

Validation failures return `400` with a stable code such as
`invalid_request`, `invalid_namespace`, `invalid_limit`, `invalid_filter`,
`invalid_cursor`, or `invalid_customer_id`. An unexpected read failure returns
`500 customer_query_failed`. Error payloads do not expose database or source
details.

## Privacy exclusions and retention

Customer 360 may retain verified contact fields; coarse platform/app version;
aggregate lifecycle timestamps; aggregate attempt outcomes; canonical commerce;
durable normalized identity links; and hashed install/receipt identity. It must
not retain or expose search text, search query/term, source title or URL, raw
telemetry or generic payload containers, raw IP, user agent, hardware
fingerprints, device names/serials, request credentials, access/refresh tokens,
API keys, passwords, exact behavioral histories, or installer-referral HMACs.
The private read models additionally exclude identity link values,
`installIdHash`, Stripe object/event IDs, merged tombstones, and raw conflict
evidence.

The current repository has no Customer 360 deletion or aggregate-expiry job.
Profiles, identity links, install memberships, daily aggregate buckets, money
materializations, and totals therefore persist until a separately reviewed data
retention policy and deletion implementation exist. Merge audits and identity
review rows are intentionally immutable. Stripe queue payload redaction and the
90-day installer-referral request-row policy are separate retention domains and
do not delete Customer 360 canonical facts. Do not claim a shorter Customer 360
retention period until code enforces it.

Reviewed backfill input, checkpoint, and reports are restricted operator
artifacts, not repository assets or application logs. They may contain durable
identifiers even though reports use opaque component references. Store and
dispose of them under an approved access/retention decision before any rollout.

## Observability

The daily cron returns and logs `outcome`, `licenseNamespace`, `batches`,
`sourceRowsScanned`, `dailyBucketsWritten`, `profilesRefreshed`, and
`sourceFreshnessAt`. Its structured log event is
`sidestream_customer_usage_sync`; failure logs only `outcome=failed` and returns
`500 customer_usage_sync_failed`. `locked` is expected for a concurrent run and
`skipped` is expected after a completed run on the same UTC day.

Operators must inspect:

- the cron result and last completed run once daily;
- `usage.syncedAt` versus `usage.sourceFreshnessAt` for source lag;
- the nine data-quality flags on list/detail results;
- unresolved `pending_identity_review` and `commerce_identity_conflict` counts;
- backfill candidate/orphan/conflict totals and the complete checkpoint;
- protected route `401`, `403`, `400`, and `500` rates without logging bearer
  secrets, customer payloads, or raw source details.

An unexplained failed run, stale/null freshness, inconsistent outcome flag,
identity conflict, incomplete checkpoint, or unexpected API authorization error
blocks rollout progression. The reviewer must record the approved lag threshold
and alert destination before enabling the Preview/Test cron.

## Disposable test harness

`SIDESTREAM_TEST_POSTGRES_URL` must point at a disposable database and is rejected
if it shares a normalized runtime target or even the same host/port endpoint
with any configured runtime, Production, Preview, deployed-Test, generic, or
telemetry URL. Postgres suites use random schemas, run serially, drop them in
cleanup, scrub ambient runtime URL selectors, and block HTTP, HTTPS, fetch,
WebSocket, Unix sockets, and TCP destinations other than the approved test
Postgres endpoint.

Run the contract with only that disposable selector configured:

```bash
npm run test:customer-360
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres
npm run test:api
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:postgres-integration
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:single-device
npm run test:download-referral
npm run test:migrations
node scripts/assert-no-runtime-ddl.mjs
node scripts/validate-vercel-contract.mjs
npm run typecheck
npm run build
```

`test:customer-360-postgres` exercises core merge/identity, commerce,
once-daily usage sync and rolling decay, list/detail privacy/cursors, dry-run and
test-only backfill recovery, and the end-to-end merge/replay pipeline. The
complete pipeline proves Stripe/Vercel/network isolation and verifies that
Customer 360 leaves entitlement and single-device state unchanged.

## Dry-run backfill contract

Backfill is dry-run by default. It must consume a reviewed offline JSON file,
never query a historical source itself, never make network requests, never own
DDL, and never read emails, names, IPs, timestamps, behavior, search text,
campaign HMACs, or installer-referral data. Accepted durable fields are the nine
identity link types documented above plus an opaque UUID or lowercase hex64
`recordId`.

A reviewer may generate a privacy-safe plan without opening Postgres or writing
a checkpoint:

```bash
node scripts/backfill-customer-360.mjs --dry-run --namespace test --input /path/to/reviewed-input.json
node scripts/verify-customer-360-backfill.mjs --self-test
```

The report contains an input digest, opaque `componentRef` values, evidence
types, counts, and candidate/orphan/conflict status. Conflicting accounts and
existing owners receive zero writes. Orphans have no durable bridge and require
human disposition. Test application is append-only and idempotent, uses a
namespace merge lock, commits one bounded component batch atomically, rolls back
that whole batch on error, and writes a versioned input-bound checkpoint only
after commit. A commit can survive a following checkpoint-write failure, so
reruns must rely on idempotent inserts and reviewed checkpoint evidence. Older or
mismatched checkpoints fail closed.

Production apply is disabled in code. Even in Test, any apply mode requires a
separate human approval after reviewing the dry-run digest, every orphan and
conflict, target identity, migration state, checkpoint path, and rollback plan.
This document intentionally provides no apply command.

## Human-gated Preview/Test-first rollout

This is the only rollout sequence:

1. Review the exact commit, contract, migration chain, test evidence, privacy
   decision, retention gap, open entitlement blockers, and cross-repo interface;
   then merge through normal review. This step authorizes no deployment.
2. A human names and approves a non-Production Preview/Test database and a
   separate read-only telemetry source. Capture connected-target evidence and
   prove neither is Production and neither shares the disposable harness target.
3. Apply the checksummed migrations to that approved non-Production target only.
   Verify the ledger/checksums, RLS, private function grants, runtime-DDL
   prohibition, and a documented non-Production rollback/recreate path.
4. Configure Preview/Test secrets and schedule ownership: a stable
   `SIDESTREAM_CRM_ADMIN_SECRET`, separate
   `SIDESTREAM_TELEMETRY_POSTGRES_URL`, distinct
   `SIDESTREAM_TEST_POSTGRES_URL`, `CRON_SECRET`, trusted Test namespace/hosts,
   and existing website runtime database secrets. Record owners without putting
   values in commands, source, reports, or logs.
5. Deploy Preview/Test only. Confirm the immutable artifact/commit and protected
   host before invoking anything. Keep the usage cron disabled until its target,
   source role, lag threshold, and alert path are reviewed.
6. Run the offline backfill dry-run, verify its digest and privacy-safe report,
   and resolve every orphan/conflict decision. Any Test apply requires a new,
   separate human approval; dry-run approval is not apply approval. Verify a
   complete checkpoint and an idempotent no-op rerun afterward.
7. Verify both protected Customer APIs, no-store headers, namespace isolation,
   null-heavy and multi-currency responses, cursor tamper/filter binding, merged
   tombstone hiding, quality flags, daily sync summaries, source lag, rolling
   decay, and unchanged entitlement/single-device rows. Enable the Preview/Test
   cron only after these checks pass.
8. Only then run the separately reviewed FlowState plan against Preview/Test.
   Verify the existing activation/license behavior first, then verify optional
   `installIdHash` association without changing device or entitlement decisions.

For non-Production rollback, stop the Customer 360 cron, remove access to the
two admin routes, redeploy the last known Preview/Test artifact, and restore or
recreate the approved disposable/staging database from its pre-migration
snapshot. Migrations are append-only; do not improvise down SQL or delete audit
rows. Preserve failure evidence, backfill reports, and checkpoints for review,
but do not copy them into Production.

There is no Production rollback procedure here because no Production action is
authorized. A future Production plan requires a fresh human review after all
runbook blockers and Preview/Test gates are closed. Until then, Customer 360
remains not deployed and Production remains not migrated.

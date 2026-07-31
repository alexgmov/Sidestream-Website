# Sidestream Customer 360 contract

## Status and authority

Customer 360 route code is present in the canonical website deployment, but the
Production service is inactive. The protected admin and usage-sync
configuration are absent, and no operational Customer 360 claim is justified.
A read-only 2026-07-29 operator inspection of the live dashboard database found
all required tables and read functions plus materialized identity and commerce
rows, so the earlier "unmigrated and unbackfilled" description is no longer
supportable. That inspection did not prove backfill completeness or that the
Production website runtime selects the same database; it also found no usage
sync state or daily usage rows. Source presence, a successful build, database
rows, or an unauthenticated protected-route response is not evidence of
operational readiness or authenticated behavior.
This file documents the repository contract and a human-gated Preview/Test-first
rollout; it contains no Production deployment, migration, or backfill-apply
procedure.

The website repository owns the Customer 360 database, Stripe money projection,
telemetry aggregate import, and private read API. FlowState may provide durable
association values such as `installIdHash`, but it does not select the database,
write namespace, profile, entitlement, or merge result. Local or fixture-backed
FlowState implementation may proceed now against this audited contract. Live
upstream Preview/Test integration and QA wait for the separately approved
website migration, configuration, deployment, and verification gates below.

## Domain boundaries

### Profiles, installs, and identity

- A live profile is a stable UUID in exactly one `production` or `test` license
  namespace. Trusted server deployment state selects the namespace for writes,
  identity and merge behavior, telemetry import, device policy, and entitlement
  behavior; client `buildChannel`, headers, query parameters, and untrusted
  request JSON cannot override it.
- The protected admin read API is deliberately different: an authenticated
  server caller supplies `licenseNamespace` in the list or detail POST body to
  choose which authorized namespace to query. The API validates that value,
  scopes every read to it, and binds it into signed list cursors. This read
  selector neither changes trusted deployment state nor authorizes writes.
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

### FlowState association request and continuity contract

FlowState may add Customer 360 association values only as optional fields in the
JSON body of these existing `POST` requests. All three fields are accepted on
each route; no other FlowState route is an identity-association transport.

| Route | Optional JSON body fields |
| --- | --- |
| `POST /api/activation/start` | `installIdHash`, `supportCode`, `installerReceiptIdHash` |
| `POST /api/activation/status` | `installIdHash`, `supportCode`, `installerReceiptIdHash` |
| `POST /api/license/verify` | `installIdHash`, `supportCode`, `installerReceiptIdHash` |
| `POST /api/license/refresh` | `installIdHash`, `supportCode`, `installerReceiptIdHash` |

`installIdHash` and `installerReceiptIdHash` must each be exactly 64 lowercase
hexadecimal characters, matching `^[0-9a-f]{64}$`. `supportCode` must match
`^SIDE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$`. A missing or `undefined` field,
JSON `null`, or the empty string is treated as omitted for backward
compatibility. Any other supplied value, including a non-string, wrong case,
surrounding whitespace, or wrong length, returns `400
invalid_customer_identity`; the website does not normalize a malformed value
into the canonical form.

FlowState must reuse its existing stable telemetry `installIdHash` verbatim. It
must not hash it again or add a production/Test channel salt. Trusted website
routing and deployment state own production/Test namespace isolation; client
identity values and `buildChannel` do not select that namespace.

These identity values must never be placed in activation, claim, checkout,
restore, or account URLs, query strings, redirects, or browser form fields. The
website stores the association against the server-side activation record; its
upgrade and restore URLs contain only the activation key. Later verified
account, Checkout, license, verify, and refresh evidence follows that activation
record so it attaches to the same profile UUID. FlowState must not copy the
identity values across the browser boundary to preserve that continuity.

### Customer identity is not device-seat enforcement

Customer 360 install membership and the two-device license policy are
deliberately separate. `installIdHash` is a pseudonymous CRM association key; it
is not the active device binding, credential, transfer counter, or authorization
proof. Customer 360 attachment, merge, commerce, usage, and query code does not
read or mutate active device rows, device credentials, transfer history, license
policy mode, or download authorization. `SIDESTREAM_DEVICE_POLICY_MODE` defaults
to `observe`; only an explicit `enforce` value blocks non-definitive device
mismatches. Customer 360 neither enables nor changes that mode, and the current
device rollout remains observe/not-yet-cut-over rather than proven Production
enforcement. Explicitly revoked or replaced credentials and exact active-binding
download authorization remain separate device-contract decisions in every mode.

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

The active Sidestream offer is one-time. The commerce model remains open-ended:
if subscriptions are offered later, every settled renewal is a separate
canonical economic payment rather than a rewrite of the first purchase. A
profile with both one-time and subscription purchase history is `mixed`;
`comped` can legitimately have zero paid money. `billingModel=subscription`
describes purchase model/history, not whether a subscription is currently
active. The compact list/detail object has no `isSubscribed`, renewal,
cancellation, or current-subscription-state field, so consumers must not infer
any of those states from `billingModel`.

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
- Install-completion evidence is exactly `installer_install_completed`. App
  open/activity evidence is exactly `session_started`; installer events,
  heartbeats, download events, and other app events do not create an open or
  active day. Platform is reduced to `macos`, `windows`, or `unknown`, and the
  bounded latest platform/app-version summary is taken from session starts.

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
requests or completion rate without that denominator definition. A consumer may
calculate success rate only as `downloadOutcomeNumerator` divided by
`downloadOutcomeDenominator`; the rate is unavailable when the terminal-outcome
denominator is null or zero.

### Stored/derivable telemetry versus the compact API

The privacy-limited aggregate layer stores or derives this telemetry inventory:

- first and last app use, first and last accepted download attempt, and first
  and last successful download attempt;
- accepted attempt, terminal outcome, success, failure, cancelled, pending, and
  unknown counts;
- lifetime active days, rolling 7-day and 30-day active days, and accepted
  30-day attempts per active day;
- per-install UTC-day active-event counts and the usage install count across a
  profile's current memberships;
- latest coarse platform and bounded app version;
- daily-bucket refresh time, profile sync/materialization time, source
  receive-time freshness, and derivable source lag.

Daily rows retain the per-install/day values, source watermark, and refresh
time. Profile materialization combines them across current install memberships
and recomputes lifetime and rolling values. This inventory is not a raw event
export and does not weaken the privacy exclusions below.

The list/detail API is intentionally more compact. It exposes first attempt,
first success, terminal success numerator/denominator, last app use, rolling
active days, 30-day frequency, sync/freshness timestamps, install count,
platform, app version, and quality flags. It does not expose last-attempt or
last-success timestamps, total accepted attempts, individual
failure/cancelled/pending/unknown counts, lifetime active days, daily
active-event counts, the internal usage install count, or raw source lag. It
also does not expose current subscription status.

### Cadence, rolling windows, and freshness

The repository's Vercel configuration declares the protected sync once daily at
`05:27` UTC. A completed namespace run is skipped if invoked again on the same
UTC day; an advisory lock prevents concurrent runs. The default source batch is
250 aggregate rows
(configurable from 25 to 1,000). The high-water key is
`(received_at, telemetry_event_id)`, and every run rereads a 48-hour overlap
(configurable from 24 to 168 hours) so late updates replace affected UTC
install-day buckets. Events whose source `received_at` falls behind the retained
overlap are not guaranteed to repair automatically and require reviewed replay
or backfill handling.

Each completed run rematerializes all live profiles, even if no new event was
found. `activeDays7` covers the current UTC day plus six prior days;
`activeDays30` covers the current UTC day plus 29 prior days. An active day has
at least one exact `session_started` event. `downloadFrequency30d` is accepted
download attempts in that 30-day window divided by active days in the same
window, rounded to six decimal places; it is null when there are no active days.
This daily rematerialization is what makes old activity decay out of rolling
windows.

`usage.syncedAt` is when the website aggregate was materialized.
`usage.sourceFreshnessAt` is the greatest source `received_at` captured by the
sync high-water mark, not an occurrence timestamp or proof that every historical
event exists. Source lag is the difference between those timestamps. A null
freshness value means no accepted source high-water has been observed. Operators
must review lag and define an acceptable non-Production threshold before rollout;
the code intentionally does not invent one.

## Measurable acquisition and retention funnel

### Protected report boundary and window

The server-only report route is:

- `POST /api/internal/customers/funnel`

It uses the same `SIDESTREAM_CRM_ADMIN_SECRET`, POST-only, browser-origin
rejection, request-size, JSON, no-store, and error-shaping boundary as the
private list/detail API. It runs in a repeatable-read, read-only transaction.
The request body accepts only:

| Field | Contract |
| --- | --- |
| `licenseNamespace` | Required `production` or `test`; scopes every identity, install, usage, activation, and attribution read |
| `cohortStart` | Required valid UTC timestamp ending in `Z`; inclusive |
| `cohortEnd` | Required valid UTC timestamp ending in `Z`; exclusive and after the start |
| `journeyLimit` | Optional integer 1-100; defaults to 50 |

The cohort window cannot exceed 366 days. `dateWindow.cohortDefinition` is
`first_install_at`, `endExclusive` is true, and the observation contract is
events before `cohortEnd`.

### Exact metric definitions

| Metric | Exact definition |
| --- | --- |
| Install / cohort membership | `firstInstallAt` is the minimum `first_seen_at` across the live profile's current `sidestream_customer_installs` memberships. A profile is in the cohort only when `cohortStart <= firstInstallAt < cohortEnd`. |
| Telemetry-derived install evidence | `installer_install_completed`, `session_started`, or an accepted download attempt/success may contribute an exact lifecycle timestamp. A heartbeat is not install-completion or open evidence and must not advance an existing install lifecycle. |
| First open | Earliest `first_app_use_at` before the exclusive end, where `first_app_use_at` is populated only from an exact schema `0.2.0` `session_started` event. |
| Active/open day | UTC calendar day with at least one `session_started`. Installer events, heartbeats, download events, and other telemetry do not create an active/open day. |
| Download attempt | First accepted, non-speculative `download_requested`, deduplicated by install/session/download identity when present and telemetry event identity otherwise. Speculative requests count only when terminal facts are linked to a real user request. |
| Day-zero downloads | Accepted download attempts whose UTC activity date equals the first-open UTC date. A download attempt does not itself create an open day. |
| Activation | Earliest non-null `completed_at` on a `sidestream_activation_sessions` row reached through the profile's exact `activation_record` identity link. Pending or merely created activation rows do not count. |
| Return day | Distinct UTC active/open date after the first-open date and before `cohortEnd`. |
| One-and-done | `firstOpenAt` exists and no later open date was observed through the requested exclusive end. This is an observation-window result, not a lifetime prediction. |

The top-level and per-group activation percentage has:

- numerator: profiles with a completed linked activation;
- denominator: profiles with a first open;
- percentage: numerator divided by denominator, rounded to two decimal places,
  or null when the denominator is zero.

It is not activations divided by installs, clicks, downloads, attributed
profiles, or paid customers. `totals` always exposes profiles,
first-opened profiles, and completed activations so the ratio can be audited.

### Source precedence and experiment dimensions

Attribution is deterministic and deliberately narrow:

1. `verified_paid` has highest precedence. It requires an active, completed
   paid-acquisition Checkout joined to the exact entry/environment/experiment/
   cohort/assignment/token/attribution proof. That verified Checkout must link
   to the profile through an exact installer-receipt hash, verified Checkout
   Session reference, or claimed activation/account record. The source is
   `manychat`; medium, campaign, experiment, cohort, and first-attributed time
   come from the verified paid entry.
2. `verified_email` is considered only when a
   `cta_source=mobile-download-handoff` lead's normalized email exactly equals
   both the verified account email and the profile's verified contact email.
   Source, medium, campaign, and first-attributed time come from that lead.
3. Every other profile is `source=unknown` with
   `attributionConfidence=unattributed`.

Paid attribution wins over verified email even if the email lead was captured
earlier. Within paid candidates, the earliest exact paid entry wins with stable
entry/Checkout tie-breakers. Within freemium candidates, the earliest lead wins
with a stable lead-ID tie-breaker.

For repeat mobile handoffs, each UTM field preserves its earliest non-null value:
a later submission may fill a field that was previously null but cannot replace
an earlier non-null first touch. Experiment assignment is accepted only from a
valid server-signed assignment cookie captured into the lead context. Its exact
dimensions are `experiment=mc-mobile-paid-v1` and
`cohort=mc-control-v1` or `mc-paid-v1`; the earliest valid assignment is
preserved. Paid Checkout attribution carries the verified paid entry's
`mc-mobile-paid-v1` / `mc-paid-v1` dimensions. Browser-supplied experiment,
cohort, assignment hash, amount, price, country, Product, or environment values
are not selectors.

No attribution may be inferred from timing, IP, user agent, referrer, similar
email, campaign proximity, or any approximate identity. The Gmail
installer-referral HMAC remains request attribution only and is never a profile
link.

### Coverage, output, and privacy

Source-segmented retention covers only exact paid links and exact verified-email
matches. Every anonymous unlinked install remains unknown. This is an explicit
coverage boundary, not missing data that the report may guess away.
`attributionCoverage` therefore reports:

- numerator: `verified_paid + verified_email` cohort profiles;
- denominator: every profile in the first-install cohort;
- percentage: that ratio, or null for an empty cohort;
- paid-attributed, freemium-attributed, and unattributed profile counts.

Overall stickiness continues to use all install IDs and all exact open days.
Unknown installs remain in product-wide install/open/return denominators even
though they cannot support source-segmented comparison.

`groups` cover the complete cohort and are partitioned by source, medium,
campaign, experiment, cohort, and attribution confidence. Each group exposes
profile, first-open, completed-activation, and activation-percentage values.
`journeys` are ordered by exact first install time then customer UUID and expose
only the customer UUID, bounded attribution dimensions/confidence,
first-attributed/install/open/activation timestamps, day-zero attempt count,
later UTC open dates, and one-and-done status. The response includes
`journeyLimit`, `journeysReturned`, and `journeysTruncated`.

Email, `installIdHash`, installer receipt/assignment hashes, Stripe identifiers,
identity-link values, raw telemetry, and raw attribution proof do not cross the
report boundary.

### Historical correction requirement

The exact `session_started` activity rule supersedes the former broad
non-installer event rule. The normal usage sync rereads only its configured
24-168 hour overlap (48 hours by default), so it cannot automatically replace
every older broad daily bucket.

Before historical retention is trusted, an operator must run one separately
reviewed, human-approved full append/update rescan of the schema-versioned raw
telemetry history so every affected `sidestream_customer_usage_daily` row is
upserted under the exact install/open/active-day/download definitions. The
rescan must not delete, truncate, or rewrite raw telemetry, and it must not
delete canonical profiles, identity, commerce, audit, or entitlement/device
state. The repository currently provides no approved Production rescan command.
Preview/Test requires an approved target, authenticated read-only source,
secret-safe invocation mechanism, checkpoint/replay design, evidence, and
rollback decision. Production remains blocked behind every existing human-gated
migration, backfill, configuration, deployment, scheduling, and verification
rule in this document and `docs/api-hardening-runbook.md`.

## Private Customer 360 APIs

### Authentication and transport

The server-only routes are:

- `POST /api/internal/customers`
- `POST /api/internal/customers/{customerId}`
- `POST /api/internal/customers/funnel`

They require exactly one `Authorization: Bearer <SIDESTREAM_CRM_ADMIN_SECRET>`
credential. The secret is 16-512 printable non-space ASCII characters. Missing
or invalid configuration returns `503`; missing, wrong, combined, or duplicate
credentials return `401`. Any `Origin` header returns `403`, so these routes are
not browser/CORS APIs. Other methods return `405` with `Allow: POST`. Responses
are JSON with `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`,
`Vary: Authorization, Origin`, and `X-Content-Type-Options: nosniff`. Request
bodies are JSON objects capped at 16 KiB; unknown fields fail closed.

The list body requires `licenseNamespace` and accepts `limit`, `cursor`, and
`filters`. `limit` defaults to 50 and is bounded from 1 to 100. The funnel body
uses the separately documented cohort window and journey limit above. Filters
below apply only to the list route:

| Filter | Accepted value |
| --- | --- |
| `billingModel` | `one_time`, `subscription`, `comped`, or `mixed` |
| `entitlementStatus` | Bounded lowercase status token |
| `hasEmail` | Boolean |
| `activeSince` | ISO timestamp applied to `lastActivityAt` |
| `dataQualityFlag` | One documented quality flag below |

There is intentionally no search text, email substring, name substring, raw
identity, Stripe-ID, or behavioral search filter. The detail body accepts only
`licenseNamespace`; `{customerId}` must be a UUID. Namespace is required on all
three routes so a caller cannot retrieve or aggregate another namespace.

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
`404 customer_not_found`. List and detail use the same customer object. Funnel
success is the date window, activation percentage, attribution coverage,
totals, complete groups, bounded journeys, and journey truncation metadata
documented above; it does not use the compact customer object.

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
| `usage.lastUseAt` | ISO string or null | Latest exact `session_started` time |
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
`invalid_cursor`, `invalid_customer_id`, `unknown_request_key`,
`invalid_cohort_window`, or `invalid_journey_limit`. An unexpected list/detail
read failure returns `500 customer_query_failed`; an unexpected funnel read
failure returns `500 acquisition_funnel_query_failed`. Error payloads do not
expose database or source details.

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

The daily cron response returns `outcome`, `licenseNamespace`, `batches`,
`sourceRowsScanned`, `dailyBucketsWritten`, `profilesRefreshed`, and
`sourceFreshnessAt`. Its `sidestream_customer_usage_sync` structured log records
only `outcome`, `batches`, `sourceRowsScanned`, `dailyBucketsWritten`, and
`profilesRefreshed`; it does not log `licenseNamespace` or `sourceFreshnessAt`.
Failure logs only `outcome=failed` and returns `500` with
`customer_usage_sync_failed`. `locked` is expected for a concurrent run and
`skipped` is expected after a completed run on the same UTC day.

Operators must inspect:

- the cron result and last completed run once daily;
- `usage.syncedAt` versus `usage.sourceFreshnessAt` for source lag;
- the nine data-quality flags on list/detail results;
- funnel activation numerator/first-open denominator and attribution-coverage
  numerator/all-cohort denominator before comparing sources;
- unattributed profile share, which must remain explicit rather than being
  reassigned or excluded from overall stickiness;
- unresolved `pending_identity_review` and `commerce_identity_conflict` counts;
- backfill candidate/orphan/conflict totals and the complete checkpoint;
- protected route `401`, `403`, `400`, and `500` rates without logging bearer
  secrets, customer payloads, or raw source details.

An unexplained failed run, stale/null freshness, inconsistent outcome flag,
identity conflict, incomplete checkpoint, or unexpected API authorization error
blocks rollout progression. The reviewer must record the approved lag threshold
and alert destination before invoking usage sync or enabling any approved
non-Production scheduling path.

## Read-only readiness inspection

The repository provides a sanitized readiness report:

```bash
npm run customer-360:readiness
npm run customer-360:readiness -- --origin https://approved-preview-host
SIDESTREAM_TEST_POSTGRES_URL='<disposable-only>' npm run customer-360:readiness -- --test-database
```

By default, the command checks repository source and backfill-source presence
and validates the required non-Production selectors already in the process
environment. It does not load `.env` files, contact a live origin, or open a
database. A not-ready report exits zero so it can be used for observation. Add
`--require-ready` only when requested checks must return a nonzero exit for a
blocked result; invalid options return exit code 2.

The configuration result is deliberately a non-Production gate. It requires
the Test namespace and Preview/development/Test deployment selectors, validates
the admin, cron, telemetry, and disposable-Test database selectors without
printing their values, and fails closed on runtime/telemetry/Test database
collisions.

`--origin` accepts only a bare HTTPS origin with no credentials, path, query, or
fragment. It follows no redirects and sends no credential while probing
`POST /api/internal/customers` and
`GET /api/internal/customer-usage/sync`. Only an exact `401` response with JSON
`code=unauthorized` classifies a route as configured and protected. The exact
documented `503` unavailable code classifies it as protected but unavailable;
redirects, malformed bodies, different codes, and all other statuses fail
closed. A `401` is route-boundary evidence only, not proof of schema, migration
ledger, backfill, customer data, namespace isolation, or authenticated API
behavior.

`--test-database` is restricted to the disposable database selected by
`SIDESTREAM_TEST_POSTGRES_URL`; it does not inspect Production or a deployed
Test runtime. The existing target-separation guard rejects collisions with
runtime, Production, Preview, deployed-Test, generic, or telemetry endpoints.
The inspection begins a read-only transaction, checks the complete Customer 360
table/read-function set and complete checksummed repository migration ledger,
reads bounded profile/identity/install/pending-review counts, and always
attempts rollback. Any unresolved `pending_identity_review` result keeps
backfill readiness false.

Output is limited to selector presence/validity, booleans, bounded counts, and
HTTP status codes. It omits the supplied origin, environment values, connection
strings, exception messages, and response payloads. Neither this report, source
presence, a build, nor an exact protected-route `401` authorizes a migration,
backfill, scheduler, deployment, or Production cutover.

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
once-daily usage sync and rolling decay, list/detail privacy/cursors, the
first-install acquisition/retention funnel, dry-run and test-only backfill
recovery, and the end-to-end merge/replay pipeline. Funnel coverage proves the
exclusive window, exact UTC open/return days, accepted day-zero attempts,
completed-activation/first-open ratios, paid-over-email precedence, unknown
coverage, deterministic journey ordering, and privacy exclusions. The complete
pipeline proves Stripe/Vercel/network isolation and verifies that Customer 360
leaves entitlement and device-seat state unchanged.

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
4. Configure Preview/Test secrets and invocation ownership: a stable
   `SIDESTREAM_CRM_ADMIN_SECRET`, separate
   `SIDESTREAM_TELEMETRY_POSTGRES_URL`, distinct
   `SIDESTREAM_TEST_POSTGRES_URL`, `CRON_SECRET`, trusted Test namespace/hosts,
   and existing website runtime database secrets. Record owners without putting
   values in commands, source, reports, or logs.
5. Deploy Preview/Test only. Confirm the immutable artifact/commit and protected
   host before invoking anything. Vercel scheduling has one project-wide control
   for all four configured jobs, not a Customer 360-only toggle. Keep project-wide
   scheduling disabled unless all four jobs, their targets, secrets, side effects,
   failure handling, and alert paths receive separate non-Production approval.
   For usage-sync verification while it remains disabled, require either an
   approved secret-safe protected manual trigger or a separately approved
   non-Production scheduler; the repository currently supplies neither operator
   control, so the absence of one blocks this rollout stage.
6. Run the offline backfill dry-run, verify its digest and privacy-safe report,
   and resolve every orphan/conflict decision. Any Test apply requires a new,
   separate human approval; dry-run approval is not apply approval. Verify a
   complete checkpoint and an idempotent no-op rerun afterward.
7. Before trusting historical open/return results, separately approve and run
   the one-time full append/update telemetry rescan in Preview/Test. The review
   must name the exact non-Production target and authenticated read-only source,
   preserve raw telemetry, define checkpoint/replay and failure recovery, prove
   every historical daily bucket was reconsidered, and show an idempotent rerun.
   The repository currently supplies no approved invocation mechanism, so its
   absence blocks this stage. Dry-run identity-backfill approval is not rescan
   approval, and neither authorizes Production.
8. Verify all three protected Customer APIs, no-store headers, namespace isolation,
   null-heavy and multi-currency responses, cursor tamper/filter binding, merged
   tombstone hiding, quality flags, daily sync summaries, source lag, rolling
   decay, funnel ratios/coverage/unknown groups, and unchanged
   entitlement/device-seat rows. Then either approve the protected
   manual/separate scheduler path for usage sync, or separately review and
   approve project-wide scheduling for all four jobs; never claim that only the
   usage cron was enabled.
9. Only then run live upstream integration and QA from the separately reviewed
   FlowState plan against Preview/Test. Local or fixture-backed FlowState work
   may already exist; live verification must confirm existing activation/license
   behavior first, then optional `installIdHash` association without changing
   device or entitlement decisions.

For non-Production rollback, stop the approved usage-sync invocation path. If
project-wide Vercel scheduling was approved, disabling it affects all four jobs
and requires the corresponding operator decision; there is no usage-only switch.
Remove access to the two admin routes, redeploy the last known Preview/Test
artifact, and restore or recreate the approved disposable/staging database from
its pre-migration snapshot. Migrations are append-only; do not improvise down
SQL or delete audit rows. Preserve failure evidence, backfill reports, and
checkpoints for review, but do not copy them into Production.

There is no Production rollback procedure here because no Production action is
authorized. A future Production plan requires a fresh human review after all
runbook blockers and Preview/Test gates are closed. Until then, Customer 360
remains operationally inactive and its backfill completeness, runtime database
selection, protected API, and usage-sync behavior remain unverified.

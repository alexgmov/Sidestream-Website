# Sidestream Customer 360 contract

## Status and authority

The repository contains guarded, connected-target operator paths for Customer
360 migration status/apply, identity backfill, usage sync, and historical
rescan. Their presence remains capability rather than standing authority: every
external stage is human-approved, Preview/Test-first, and verified on the
requested surface.

The authorized 2026-08-01 Production qualification retained a protected Neon
backup, attested separate target and read-only telemetry sources, applied and
verified all 29 checksummed migrations, configured least-privilege runtime and
operator roles, completed both identity backfills with no-op reruns, and
processed `1,403,633` eligible telemetry rows into `2,673` UTC daily rows for
`802` installs through the version-2 historical
rescan. A normal guarded sync followed. Raw telemetry remained read-only and
canonical identity, commerce, entitlement, device, audit, and telemetry rows
were not deleted.

The Git-linked Production site then passed canonical SHA, signed-out Checkout,
authenticated list/detail/funnel, `401` unauthenticated boundary, `no-store`,
and privacy verification. FlowState 1.0.17 was signed, notarized, stapled,
published, installed from the public bytes, loaded from the canonical system CEP
root in real Premiere, and completed the one-time first-open claim. The local
Customers dashboard rendered live Production data through its loopback proxy.
This is the qualification baseline; future changes must repeat the applicable
human-gated stages below rather than treating this record as standing approval.

The acquisition-integrity migration and source contract documented below are a
later repository change. This documentation run performed only local source,
test, type, and build checks. It did not prove that
`20260803120000_add_acquisition_integrity.sql` is applied in live Neon or that
live Google, Stripe, Resend, Vercel, browser, or Premiere behavior matches the
local contract.

The website repository owns the Customer 360 database, Stripe money projection,
telemetry aggregate import, and private read API. FlowState may provide durable
association values such as `installIdHash`, but it does not select the database,
write namespace, profile, entitlement, or merge result. Local or fixture-backed
FlowState implementation may proceed now against this audited contract. Live
upstream Preview/Test integration and QA wait for the separately approved
website migration, configuration, deployment, and verification gates below.

## Domain boundaries

### Four identities that must stay separate

Anonymous acquisition continuity uses four deliberately different identities.
None is a substitute for another:

| Identity | Authority and lifetime | Explicit non-authority |
| --- | --- | --- |
| Browser acquisition session | A server-generated UUID plus bounded first touch in the signed, 30-day, `Secure`, `HttpOnly`, `SameSite=Lax`, host-only `__Host-sidestream-acquisition-v2` cookie. The UUID points to the private canonical acquisition root. The derived legacy-compatible claim token is never serialized. | It is not an account, email, install, device credential, payment, or entitlement. A visit alone creates no Customer 360 profile. |
| Installation evidence | The panel's existing lowercase hex64 `installIdHash` plus a separately generated lowercase hex64 `installerReceiptIdHash`, submitted only after local receipt verification. | Neither hash authenticates an account, grants a device seat, proves payment, or selects attribution. Raw IDs never cross this boundary. |
| Customer 360 profile | A server-created UUID in one trusted `production` or `test` namespace, connected to the browser session only by the one-time installation claim. It may remain sparse and email-free indefinitely. | The profile is not a login session, active device binding, license credential, or browser token. |
| Verified account/contact | A Google-authenticated server account and its verified email, optionally attached later through exact server-side identity evidence. | Email does not merge profiles and does not replace the anonymous first touch. It is acquisition evidence only under the lower-precedence exact verified-email rule below. |

The end-to-end path is:

```text
eligible page GET
  -> signed first-touch browser cookie (best effort)
  -> desktop /api/download GET
       -> same static platform package
       -> background session + first installer-request write
     or mobile computer handoff
       -> optional email, or no-email secure share link
       -> opaque seven-day handoff restores the same cookie on the computer
       -> same /api/download route and same static package
  -> panel verifies its local installer receipt
  -> POST /api/installation/claim with only two hashes
       -> panel receives a 15-minute browser URL plus opaque acknowledgment handle
  -> browser opens the 15-minute opaque nonce
  -> GET /api/installation/claim-complete combines nonce + signed cookie once
  -> panel polls POST /api/installation/claim-status with the handle
  -> sparse Customer 360 profile is created or reused
  -> later verified Google/account evidence may attach to that same profile
```

The cookie write is intentionally nonblocking. A missing or invalid
`SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET`, malformed/forged cookie, database
error, timeout, or background scheduling failure cannot block the page or a
validated installer redirect. Missing configuration does block association:
the claim-creation route returns `503 claim_unavailable`, protected Customer
360 reads return `503 customer_admin_unavailable`, and usage sync fails closed.
The browser-completion page deliberately returns the same minimal noindex body
when browser state is missing or forged and does not consume the one-time claim.

The claim request accepts exactly `installIdHash` and
`installerReceiptIdHash`; attribution, account, email, payment, entitlement,
and device fields are rejected. Its encrypted, signed nonce expires after 15
minutes and is the only claim URL parameter. The acknowledgment handle is
encrypted/signed server state and is sent only in the status POST body. Status
is exactly `pending`, `browser_opened`, `claim_completed`, `conflict`, `expired`,
or `terminal_unknown`; malformed/unknown handles never reveal a different
internal state. Exact replay to the same profile is idempotent. Reuse against
different evidence, conflicting identity ownership, contradictory profile
ownership, or a claim whose acquisition UUID/token do not agree is quarantined
with append-only hashed evidence; it is never guessed, overwritten, or silently
re-opened.

## Canonical acquisition integrity

### Root, first touch, and trust boundaries

`public.sidestream_acquisitions.id` is the canonical acquisition root. It is a
server-generated UUID scoped to exactly one `production` or `test` license
namespace. The root owns immutable first-observed source, medium, campaign,
creative, entry channel, time, coarse external-referrer category, optional
signed experiment, and attribution confidence. Delivery evidence may only grow;
the first touch cannot be edited. A contradictory replay writes a hashed
conflict and makes quarantine sticky instead of choosing a winner.

The browser and server-owned delivery boundaries are:

```text
ordinary eligible entry
  -> signed __Host-sidestream-acquisition-v2 cookie
  -> canonical entryChannel=website
  -> exact bounded UTM, coarse external referrer, or
     source=website_direct_or_unknown

trusted delivery integration selected in server code
  -> encrypted + signed seven-day envelope
  -> canonical entryChannel=manychat_email or facebook_lead_form
  -> fixed source/campaign/referrer category from the allowlist
  -> /api/acquisition/entry restores a signed browser cookie

Upgrade
  -> GET /api/checkout/start resolves the canonical UUID
  -> signed-out browser -> Google -> same UUID restored from the short-lived
     HttpOnly OAuth acquisition cookie
  -> signed-in Free account -> locked Checkout intent -> Stripe
  -> verified fulfillment -> entitlement + acquisition stages in one transaction
```

`website`, `manychat_email`, and `facebook_lead_form` are immutable values on
the root. Browser query/body input can create only the bounded ordinary website
first touch; it cannot select either trusted delivery channel. The two delivery
channels are selected by server library code and their source/campaign mapping
must survive encryption, signature, expiry, and exact-key validation.

`website_direct_or_unknown` has one exact meaning: Sidestream observed a
website entry, no external origin was available, the external-referrer category
is null, and confidence is `exact_sidestream_entry`. It is truthful unknown
external origin. It must never be used to conceal missing Sidestream-owned joins
between account, intent, Stripe, installation, profile, or report data. Those
are `missing_internal_linkage`; older records that predate deterministic proof
are `historical_unlinked`.

The only allowlisted delivery evidence on the root is `website_entry`,
`signed_email_handoff`, `secure_share_handoff`, `installer_redirect`,
`authenticated_account`, `checkout_intent`, `stripe_checkout_session`, and
`verified_installation_claim`. It is bounded, append-only, and is not a generic
payload store.

### Ten-stage ledger and counting grains

`public.sidestream_acquisition_stages` is append-only. The server hashes the
trusted namespace, stage, and stable server-owned reference into a 64-character
deduplication key. Exact retries converge on the unique namespace/stage/key;
the same key presented for another root quarantines both owners and records only
hashed conflict evidence.

| Stage | Counting grain | Stable fact represented |
| --- | --- | --- |
| `landing_observed` | `acquisition` | One canonical first entry |
| `email_handoff_created` | `delivery_handoff` | One server-owned delivery envelope |
| `installer_requested` | `installer_request` | One accepted platform installer request |
| `installation_claimed` | `installation` | One verified install identity claim |
| `authentication_completed` | `authentication` | One exact Google account/acquisition completion |
| `checkout_started` | `checkout_intent` | One locked Checkout intent |
| `checkout_completed` | `checkout_session` | One verified completed Stripe Session |
| `payment_settled` | `payment` | One verified PaymentIntent, or exact zero-total Session fallback |
| `refunded` | `refund` | One exact Stripe refund ID with positive refunded money |
| `disputed` | `dispute` | One exact Stripe dispute ID |

Stage time cannot predate the root's first observation. Refund/dispute rows are
immutable lifecycle facts, not a mutable current-state flag. Current paid,
refunded, disputed, inquiry, and net-money status continues to come from the
canonical commerce materialization. A dispute stage may therefore remain after
Stripe reports a later win, while current disputed money becomes zero under the
commerce rules.

### Mandatory Checkout and Stripe agreement

The paid sequence remains exactly Upgrade -> Google authentication -> Stripe,
owned end to end by `GET /api/checkout/start`. Acquisition is resolved before
Google redirect or intent insertion. A valid signed cookie wins; a valid
server-owned handoff is next; otherwise the server creates a new truthful
`website_direct_or_unknown` root. Google start exposes acquisition storage
failure only as its generic temporary-unavailability HTML. Checkout exposes the
separate machine-readable `503 acquisition_unavailable` response.

Every new `sidestream_checkout_intents` insert requires `acquisition_id`.
Historical rows deliberately remain nullable. Checkout creation copies the UUID
into `sidestream_acquisition_id` metadata. Fulfillment requires exact agreement
between the locked intent and:

- Checkout Session metadata;
- Invoice metadata when the Session has an Invoice; and
- PaymentIntent metadata when the Session has a PaymentIntent.

The Session must also pass the existing exact intent, account, activation,
offer, Product, Price, currency, subtotal/discount/tax/shipping/total,
customer, PaymentIntent, and Charge checks. A complete verified zero-total
Session may have no PaymentIntent with `payment_status=paid` or
`no_payment_required`; only then does the Session become the settlement
reference. The exception never weakens acquisition or offer agreement.

A mismatch fails closed. Browser completion returns `409` with a bounded reason,
does not redirect to a success page, and does not commit an entitlement or the
`checkout_completed`/`payment_settled` stages. A signed webhook event that
returns a non-fulfilled bounded mismatch is terminally recorded as an `ignored`
`checkout_<reason>` outcome; thrown provider/database failures follow the
existing retry/dead-letter path. Operators must treat acquisition mismatch,
missing linkage, owner conflict, or stage conflict as an integrity alert, not as
a successful purchase and not as permission for a manual row edit.

### Reporting cohorts, lookup, pagination, and alerts

`POST /api/internal/customers/funnel` has an independent `cohortBasis` selector:

- `first_install` uses the live profile's earliest install membership time.
- `first_purchase` uses the live profile's earliest verified paid time across
  currency totals and includes accounts that purchased before installation.

Both use the same inclusive `cohortStart`, exclusive `cohortEnd`, and later
exclusive completed-UTC-day `observationEnd`. The selector changes cohort
membership; it does not silently reuse the other basis. Journey pagination is
keyset order `(cohortAt, customerId)`, limit 1-100, and a signed opaque
`journeyCursor` binds namespace, basis, limit, and all three time boundaries.
Changing any bound invalidates the cursor. `nextJourneyCursor=null` is the final
page. Source totals are explicitly capped at 100 groups and report
`sourcesTruncated`; no caller may interpret a truncated page as comprehensive.

Stage counts use distinct stage deduplication keys in
`[cohortStart, observationEnd)`. Integrity alerts separately count roots whose
first observation is in `[cohortStart, cohortEnd)` and state is
`missing_internal_linkage`, `historical_unlinked`, or `quarantined`. Alert on
any new missing internal linkage or quarantine; track historical-unlinked as an
explicit migration debt rather than folding it into external unknown origin.

`POST /api/internal/customers/lookup` accepts only an exact Stripe reference
matching `cus_`, `cs_`, `pi_`, or `ch_` plus the required namespace. It resolves
only stored identity/commerce aliases, returns `404 customer_not_found` for no
owner and `409 conflicting_lookup_ownership` for ambiguous/conflicting
ownership, and returns the privacy-safe customer, acquisition-stage summary,
and payment status. The supplied Stripe ID is never echoed. Prefix search,
email/name search, and inferred joins are prohibited.

A paid customer is one distinct live cohort profile with verified
`first_paid_at < observationEnd` and current materialized `net_paid_minor > 0`
in at least one currency. Refunds and formal open/lost disputes reduce net paid;
zero net removes current paid-customer status without erasing the immutable
first-purchase landmark or refund/dispute ledger stages. `paidCustomerPercentage`
is therefore distinct people, not transactions, revenue, entitlement, or
attribution coverage.

### Historical correction and privacy

Migration `20260803120000_add_acquisition_integrity.sql` does not invent roots
for old Checkout intents. A historical link may be added only when existing
server-owned evidence proves the exact relationship, such as an exact signed
cookie/claim, verified account or activation link, exact Checkout/Stripe alias,
verified installer receipt, or reviewed server campaign/delivery record. Email
similarity, timestamps, names, UTM resemblance, or probabilistic matching are
not proof. When deterministic evidence is absent, preserve the null and report
`historical_unlinked`. The repository has no acquisition-history mutation tool;
any future backfill requires a separate reviewed append-only, idempotent,
checkpointed operator with conflict preservation and a no-op rerun.

Acquisition roots, stages, conflicts, lookup responses, funnel groups, and
journeys must not retain or expose raw email, IP, user agent, cookie, browser
token, install/receipt hash, identity-link value, Stripe payload, telemetry
payload, or Stripe `cus_`/`cs_`/`pi_`/`ch_` identifier. The canonical UUID and
deduplication/conflict hashes are private server/database facts; public URLs and
installer packages contain neither.

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

## Anonymous browser, download, and mobile handoff contract

The first eligible non-speculative page `GET` creates the browser cookie once.
A valid existing cookie wins over later query parameters, so a return visit
cannot overwrite first touch. The source taxonomy is bounded, not open text:
missing source becomes `direct`; source and medium normalize to lowercase and
must match `[a-z0-9][a-z0-9._-]{0,63}`; campaign and content preserve case and
must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Recognized named sources include
`instagram`, `facebook`, `linkedin`, `reddit`, `youtube`, `google`, `manychat`,
and `manychat-instagram`; another source is accepted only inside the same
bounded grammar. Duplicate fields or any invalid value collapse the whole
browser attribution to `direct` with null optional fields rather than storing a
partial or attacker-shaped value.

The paid mobile experiment remains a separate signed assignment. Only the
server-issued `mc-mobile-paid-v1` assignment may set cohort `paid` or
`freemium` in the anonymous acquisition cookie; query/body values cannot select
experiment, cohort, assignment, environment, Product, Price, amount, payment,
or entitlement. The assignment is sticky for 30 days. Stored first-touch and
signed-experiment values are immutable once non-null; contradictory evidence
quarantines the session.

`GET /api/download` verifies the cookie or issues a fresh direct/UTM first
touch, selects Mac or Windows only through the existing release manifest, sends
the short-lived Blob redirect, and then best-effort records the anonymous
session and first installer request. Scanner-like requests are not recorded.
`HEAD`, `304`, invalid platform, manifest failure, or Blob failure do not create
an installer-request fact. Recording failure is logged without a token, email,
or raw identity and cannot change the already-sent installer response.

On mobile, email is optional continuity rather than identity authority. The
existing email path stores a bounded `mobile-download-handoff` lead and sends
separate signed Mac and Windows links when anonymous continuity is configured;
otherwise its established delivery path may safely fall back to direct static
installer links without claiming continuity. The no-email path posts only
`{"handoffOnly":true}` and returns one share/copy link. Both use an encrypted,
signed, seven-day envelope containing the acquisition cookie and optional
platform; the public URL contains exactly one opaque `handoff` parameter and no
email, UTM, install hash, receipt hash, or profile ID. The computer `GET`
accepts no additional parameter, restores the signed cookie, and redirects to
the same canonical installer route. Forged, expired, duplicated, noncanonical,
or identity-augmented handoffs return `404`.

Installer packages remain static. Every acquisition source, mobile path, and
email choice resolves to the same manifest-selected pathname, SHA-256, size,
and public filename for a platform. No package contains an
`acquisition_request_id`, browser token, email, campaign, or personalized
payload. The panel creates install/receipt evidence only after installation.

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
| `cohortBasis` | Optional `first_install` or `first_purchase`; defaults to `first_install` and independently selects the cohort landmark |
| `cohortStart` | Required valid UTC timestamp ending in `Z`; inclusive |
| `cohortEnd` | Required valid UTC timestamp ending in `Z`; exclusive and after the start |
| `observationEnd` | Required UTC day boundary at `00:00:00Z`; exclusive, at or after `cohortEnd`, and used only for completed observation days |
| `journeyLimit` | Optional integer 1-100; defaults to 50 |
| `journeyCursor` | Optional opaque signed cursor returned by the previous page; bound to namespace, cohort basis, limit, and all window fields |

The selected cohort window cannot exceed 366 days, and the complete span
from `cohortStart` through `observationEnd` cannot exceed 730 days.
`dateWindow.cohortDefinition` is `first_install_at` or `first_purchase_at` as
selected. `endExclusive` applies to `cohortEnd`, and
`observationEndExclusive` applies to the completed UTC-day observation
boundary. Cohort selection never expands when an analyst moves
`observationEnd` later.

### Exact metric definitions

| Metric | Exact definition |
| --- | --- |
| First-install cohort membership | When `cohortBasis=first_install`, `firstInstallAt` is the minimum `first_seen_at` across the live profile's current install memberships; membership requires `cohortStart <= firstInstallAt < cohortEnd`. |
| First-purchase cohort membership | When `cohortBasis=first_purchase`, `firstPurchaseAt` is the minimum verified `first_paid_at` across the live profile's money totals; membership requires `cohortStart <= firstPurchaseAt < cohortEnd`, even if no installation exists yet. |
| Telemetry-derived install evidence | `installer_install_completed`, `session_started`, or an accepted download attempt/success may contribute an exact lifecycle timestamp. A heartbeat is not install-completion or open evidence and must not advance an existing install lifecycle. |
| First open | Earliest `first_app_use_at` before `observationEnd`, where `first_app_use_at` is populated only from an exact schema `0.2.0` `session_started` event. |
| Active/open day | UTC calendar day with at least one `session_started`. Installer events, heartbeats, download events, and other telemetry do not create an active/open day. |
| Download attempt | First accepted, non-speculative `download_requested`, deduplicated by install/session/download identity when present and telemetry event identity otherwise. Speculative requests count only when terminal facts are linked to a real user request. |
| Day-zero downloads | Accepted download attempts whose UTC activity date equals the first-open UTC date. A download attempt does not itself create an open day. |
| Activation | Earliest non-null `completed_at` before `observationEnd` on a `sidestream_activation_sessions` row reached through the profile's exact `activation_record` identity link. Pending or merely created activation rows do not count. The metric numerator includes only profiles that also have a first open. |
| Paid customer | A distinct cohort profile with at least one currency total whose verified `first_paid_at` is before `observationEnd` and whose current materialized `net_paid_minor` remains positive after refunds and disputes. This counts customers, not transactions, revenue, entitlements, or paid-attribution matches. |
| Return eligibility | A first-opened profile with at least one complete later UTC calendar day available before `observationEnd`. If first open occurs on the last completed day before the boundary, the profile is immature and excluded from return and one-and-done denominators. |
| Return day | Distinct UTC active/open date after the first-open date and before `observationEnd`. |
| One-and-done | A return-eligible profile with no later open date before `observationEnd`. An unopened or immature profile is never one-and-done. This is an observation-window result, not a lifetime prediction. |

The top-level and every per-group result expose these complete percentage
objects:

| Object | Numerator | Denominator |
| --- | --- | --- |
| `firstOpenPercentage` | First-opened profiles | All cohort profiles |
| `activationPercentage` | First-opened profiles with a completed linked activation before `observationEnd` | First-opened profiles |
| `paidCustomerPercentage` | Distinct cohort profiles with verified payment before `observationEnd` and current positive net paid | All cohort profiles |
| `returnPercentage` | Return-eligible profiles with at least one later open day | Return-eligible profiles |
| `oneAndDonePercentage` | Return-eligible profiles with no later open day | Return-eligible profiles |

Each object contains explicit decimal-string `numerator` and `denominator`
values plus a percentage rounded to two decimal places, or null when the
denominator is zero. Completed activation numerators are defined as a subset of
first-opened profiles, so activation percentage cannot exceed 100 percent. It
is not activations divided by installs, clicks, downloads, attributed profiles,
or paid customers. `totals` also exposes profiles, first-opened profiles,
completed activations, paid customers, return-eligible profiles, returned profiles, and
one-and-done profiles so every ratio can be audited.

### Source precedence and experiment dimensions

Attribution is deterministic and deliberately narrow:

1. `verified_paid` has highest precedence. It requires an active, completed
   paid-acquisition Checkout joined to the exact entry/environment/experiment/
   cohort/assignment/token/attribution proof. That verified Checkout must link
   to the profile through an exact installer-receipt hash, verified Checkout
   Session reference, or claimed activation/account record. The source is
   `manychat`; medium, campaign, experiment, cohort, and first-attributed time
   come from the verified paid entry.
2. `exact_anonymous_claim` is next. It requires a non-marker anonymous
   acquisition session whose one-time browser-to-install claim is complete,
   whose first installer request exists, and whose claimed profile is in the
   cohort. Source, medium, campaign, experiment, cohort, first visit, installer
   request, and platform come only from that immutable server session. The
   first visit must be at or before first install.
3. `verified_email` is considered only when a
   `cta_source=mobile-download-handoff` lead's normalized email exactly equals
   both the verified account email and the profile's verified contact email.
   Source, medium, campaign, and first-attributed time come from that lead.
4. A canonical acquisition root joined through an exact account, activation,
   Checkout Session identity link, or non-conflicting commerce alias is next.
   Its immutable root source/channel/confidence and integrity state are used
   only when `first_observed_at <= cohortAt`.
5. Every other profile is `source=unknown` with
   `attributionConfidence=unattributed`.

Paid attribution wins over anonymous claim and verified email even when either
was captured earlier; exact anonymous claim wins over verified email. Within
paid candidates, the earliest exact paid entry wins with stable entry/Checkout
tie-breakers. Within anonymous candidates, the earliest first visit wins with a
stable acquisition-session ID tie-breaker. Within freemium candidates, the
earliest lead wins with a stable lead-ID tie-breaker.

All candidate classes are acquisition first touches only when their
`first_attributed_at`/`first_captured_at` is at or before the profile's selected
exact `cohortAt`. A paid entry first captured after the selected landmark is
ineligible even when its exact identity linkage is otherwise valid. The canonical
verified-email lead must also have `last_captured_at <= cohortAt`: because
that row does not retain per-field capture timestamps, a row revisited after
the selected cohort landmark is conservatively excluded instead of allowing
later-filled attribution fields to rewrite acquisition source, campaign, or
experiment dimensions.

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

Installer packages remain static and are never personalized with an
`acquisition_request_id` or another browser attribution token. The panel may
send a locally generated installer receipt hash only after receipt verification
passes; that hash is association evidence, not an acquisition source by itself.
An anonymous session becomes source attribution only after the exact one-time
claim joins its browser token digest to that verified install/receipt evidence.
Anonymous installs without an exact server-side paid, anonymous-claim, or
verified-email link remain unknown.

### Coverage, output, and privacy

Source-segmented retention covers exact paid links, exact anonymous claims,
exact verified-email matches, and exact canonical acquisition roots. Every
unlinked cohort profile remains unknown. This is an explicit coverage boundary,
not missing data that the report may guess away.
`attributionCoverage` therefore reports:

- numerator: every cohort profile whose confidence is not `unattributed`;
- denominator: every profile in the selected cohort;
- percentage: that ratio, or null for an empty cohort;
- paid-attributed, anonymous-attributed, freemium-attributed, and unattributed
  profile counts. The three named class counts cover the legacy exact paid,
  anonymous-claim, and verified-email classes; canonical-root confidence is
  included in total attributed coverage but is not mislabeled as one of those
  three. The parallel `coverage` object exposes the same total attributed and
  unknown ratios plus one selected-cohort-denominator ratio for each of those
  three named classes.

Overall stickiness continues to use all install IDs and all exact open days.
Unknown installs remain in product-wide install/open/return denominators even
though they cannot support source-segmented comparison.

`groups` cover the complete cohort and are partitioned by source, medium,
campaign, experiment, cohort, attribution confidence, and integrity state.
Each group exposes profile, first-open, completed-activation, paid-customer,
return-eligible, returned, and one-and-done counts plus all five
numerator/denominator/percentage objects defined above. `sourceTotals` rolls up
at most 100 sources and exposes cap/truncation metadata. `journeys` are ordered
by selected `cohortAt` then customer UUID and expose only the customer UUID,
bounded attribution dimensions/confidence/integrity, cohort/install/purchase/
open/activation timestamps, first anonymous installer-request timestamp and
platform when present, paid-customer boolean, day-zero attempt count, later UTC
open dates, return eligibility, returned status, and one-and-done status. The
response includes `journeyLimit`, `journeysReturned`, `journeysTruncated`, and a
signed `nextJourneyCursor` or null.

Email, `installIdHash`, installer receipt/assignment hashes, Stripe identifiers,
identity-link values, raw telemetry, and raw attribution proof do not cross the
report boundary.

### Historical correction requirement

The exact `session_started` activity rule supersedes the former broad
non-installer event rule. The normal usage sync rereads only its configured
24-168 hour overlap (48 hours by default), so it cannot automatically replace
every older broad daily bucket or reconstruct older accepted-download outcomes.

Before historical usage or retention is trusted, an operator must run one
separately reviewed, human-approved full append/update rescan of the
schema-versioned raw telemetry history so every valid historical source event
is reconsidered and every affected `sidestream_customer_usage_daily` row is
upserted under the exact install/open/active-day/download definitions. Historical
install identities must first be materialized through the separately reviewed
identity backfill; rescan itself writes only usage aggregates for known installs. The
rescan must not delete, truncate, or rewrite raw telemetry, and it must not
delete canonical profiles, identity, commerce, audit, or entitlement/device
state.

The repository now contains narrow operator entry points. Their dry-run modes
perform no network or database access:

```bash
node scripts/sync-customer-usage.mjs --dry-run --target test
node scripts/rescan-customer-usage.mjs --dry-run --target test
node scripts/sync-customer-usage.mjs --dry-run --target production
node scripts/rescan-customer-usage.mjs --dry-run --target production
```

Before apply, run connected status with the same named target/source selectors.
Status performs no writes and returns operation-bound target and source
fingerprints only after the selected database name, port, namespace, and
source/target separation have been attested:

```bash
node scripts/sync-customer-usage.mjs --status --target test
node scripts/rescan-customer-usage.mjs --status --target test
node scripts/sync-customer-usage.mjs --status --target production
node scripts/rescan-customer-usage.mjs --status --target production
```

The exact Test apply forms are:

```bash
node scripts/sync-customer-usage.mjs --apply --target test --batch-size 250
node scripts/rescan-customer-usage.mjs --apply --target test \
  --checkpoint /restricted/path/customer-usage-rescan.json
```

They accept the target only from `SIDESTREAM_TEST_POSTGRES_URL` and the source
only from `SIDESTREAM_TELEMETRY_POSTGRES_URL`; the disposable-target collision
guard remains active. The exact Production apply forms exist behind a separate
human gate; their presence is not authorization:

```bash
node scripts/sync-customer-usage.mjs --apply --target production \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_USAGE \
  --confirm-target pg-<reviewed-fingerprint>
node scripts/rescan-customer-usage.mjs --apply --target production \
  --checkpoint /restricted/path/customer-usage-rescan.json \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_USAGE \
  --confirm-target pg-<reviewed-fingerprint>
```

Production target selection is only through
`SIDESTREAM_POSTGRES_URL_NON_POOLING`; the source remains
`SIDESTREAM_TELEMETRY_POSTGRES_URL`. Both tools reject a source/target
fingerprint collision, reject remote TLS weakening modes, remove the URL's
`sslmode` option, enable certificate verification for remote Postgres, use one
connection per database, and never print a connection string. Each
`pg-<fingerprint>` binds the connected hostname, port, database name, selected
namespace, and operation. Copy only the target fingerprint from the matching
status operation into `--confirm-target`; a fingerprint for another operation
cannot authorize this one.

The sync and rescan share code-enforced invariants: raw telemetry is read-only;
target writes are append/update only; historical rescan writes are limited to
usage aggregates; SQL deletes and canonical acquisition rewrites are forbidden;
and profile identity, commerce, payment, entitlement, device, audit, and raw
telemetry domains are protected. Rescan writes a mode-`0600`, versioned
source/target-bound checkpoint by atomic rename after every committed batch.
A database commit may survive a following checkpoint-write failure, so resume
depends on idempotent upserts. Mismatched checkpoints fail closed. A deliberate
from-zero replay additionally requires `--replay --confirm-replay
REPLAY_SESSION_STARTED_AGGREGATES`; replay is idempotent and never deletes.

No apply command may run until the target, source, secret launcher, source-lag
threshold, checkpoint path, replay/failure plan, and rollback have separate
human approval. Production remains blocked behind the other Production
blockers in `docs/api-hardening-runbook.md` plus every
human-gated configuration, deployment, scheduling, and verification rule below.

## Private Customer 360 APIs

### Authentication and transport

The server-only routes are:

- `POST /api/internal/customers`
- `POST /api/internal/customers/{customerId}`
- `POST /api/internal/customers/lookup`
- `POST /api/internal/customer-summary`
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
identity, or behavioral search filter. Detail and summary bodies accept only
`licenseNamespace`; `{customerId}` must be a UUID. Lookup accepts only
`licenseNamespace` and one exact `stripeReference` beginning `cus_`, `cs_`,
`pi_`, or `ch_`; it never echoes the value. Namespace is required on all five
routes, and summary additionally requires it to match the deployment/database
namespace.

### Cursors and consistency

List reads use a repeatable-read, read-only transaction and order by
`sort_activity_at`, profile creation time, then customer UUID, all descending.
The opaque keyset cursor is HMAC-SHA-256 signed with
`SIDESTREAM_CRM_ADMIN_SECRET` and binds namespace, limit, and every filter.
Tampering, reusing it with different filters/limit/namespace, or rotating the
secret returns `400 invalid_cursor`. `nextCursor` is null on the final page.

Funnel journey reads use the separate ascending `(cohortAt, customerId)`
keyset. `journeyCursor` is HMAC-SHA-256 signed with the same admin secret and
binds namespace, `cohortBasis`, journey limit, cohort start/end, and observation
end. Tampering or changing any selector returns `400 invalid_journey_cursor`;
`nextJourneyCursor` is null on the final page.

### Response envelopes

List success is `{"customers":[...],"nextCursor":string|null}`. Detail and
exact-lookup success are `{"customer":{...}}`; a missing live root or exact
lookup owner in the requested namespace returns `404 customer_not_found`.
Ambiguous/conflicting exact Stripe ownership returns `409
conflicting_lookup_ownership`. Lookup adds the privacy-safe acquisition
stage/payment summary documented above and never echoes the supplied Stripe
reference. Funnel success is the date window, percentages, attribution
coverage, totals, complete groups, bounded source totals, ten stage counts,
integrity alerts, bounded journeys, and signed pagination metadata documented
above; it does not use the compact customer object.

Summary success is
`{"licenseNamespace":"production|test","totals":{"unlimitedAccessUsers":"…","paidUsers":"…","paidUnlimitedAccessUsers":"…","successfulPayments":"…"}}`.
All counts are decimal strings. `unlimitedAccessUsers` counts distinct accounts
with at least one exact `sidestream_pro` or compatible `sidestream_unlimited`
license whose compatibility-safe effective entitlement is currently `active`.
`paidUsers` counts distinct exact-plan accounts with at least one fulfilled
positive-payment PaymentIntent, whether or not access remains active;
`paidUnlimitedAccessUsers` is the overlap. `successfulPayments` is the all-time
count of live Stripe PaymentIntents whose current status is `succeeded`, matching
Stripe's Transactions > Succeeded total. A completed zero-total Checkout can
grant Unlimited access without a PaymentIntent, so it contributes to access but
not payment. Access and unique paid-user totals come from the deployment's
authoritative license database; the transaction total comes directly from the
same deployment's Stripe account. None comes from the nullable Customer 360
entitlement snapshot or cohort funnel.

Every customer field and nullability is listed here. Timestamps are UTC ISO
strings. Counts and money are decimal strings to avoid JavaScript integer loss.

| Field | Type and nullability | Contract |
| --- | --- | --- |
| `customerId` | UUID string, never null | Stable live profile root |
| `licenseNamespace` | `production` or `test`, never null | Trusted isolation boundary |
| `name` | string or null | Verified account display name |
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
`invalid_cursor`, `invalid_customer_id`, `invalid_stripe_reference`,
`unknown_request_key`, `invalid_cohort_basis`, `invalid_cohort_window`,
`invalid_journey_cursor`, or `invalid_journey_limit`. An unexpected list/detail
read failure returns `500 customer_query_failed`; unexpected exact lookup
returns `500 customer_lookup_failed`; unexpected funnel read returns `500
acquisition_funnel_query_failed`. Error payloads do not expose database or
source details.

## Privacy exclusions and retention

Customer 360 may retain verified contact fields; coarse platform/app version;
aggregate lifecycle timestamps; aggregate attempt outcomes; canonical commerce;
durable normalized identity links; and hashed install/receipt identity. It must
not retain or expose search text, search query/term, source title or URL, raw
telemetry or generic payload containers, raw IP, user agent, hardware
fingerprints, device names/serials, request credentials, access/refresh tokens,
API keys, passwords, exact behavioral histories, or installer-referral HMACs.
The private read models additionally exclude identity link values,
`installIdHash`, `installerReceiptIdHash`, browser/cookie values, Stripe
object/event IDs and payloads, telemetry payloads, merged tombstones,
deduplication keys, and raw conflict evidence. Exact Stripe lookup consumes the
operator-supplied identifier only as a server-side equality selector and never
returns it.

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
- funnel first-open/all-cohort, activation/first-open,
  returned/return-eligible, one-and-done/return-eligible, and
  attribution-coverage/all-cohort numerator/denominator pairs before comparing
  sources;
- unattributed profile share, which must remain explicit rather than being
  reassigned or excluded from overall stickiness;
- funnel `integrityAlerts` for any new `missing_internal_linkage` or
  `quarantined` root, the explicit `historical_unlinked` backlog, and all ten
  stage counts/grains; alert if a new Checkout or settled payment lacks its
  required root/stages or if stage ownership conflicts appear;
- `ignored` Stripe queue outcomes containing acquisition/linkage/owner/stage
  mismatch; these are failed fulfillment evidence, not successful terminality;
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
npm run test:acquisition-journey-matrix
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:acquisition-journey-matrix-postgres
npm run test:api
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:postgres-integration
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:single-device
npm run verify:checkout-contract
npm run test:entitlement
npm run test:download-referral
npm run test:migrations
node scripts/assert-no-runtime-ddl.mjs
node scripts/validate-vercel-contract.mjs
npm run typecheck
npm run build
```

The disposable acquisition matrix covers every supported entry, handoff,
download, claim, Google, Checkout reuse/rotation/concurrency, regional offer,
positive/zero payment, Stripe replay, refund/dispute, lookup, pagination,
integrity alert, and deterministic-history case exactly once. It is source and
disposable-database evidence only. It does not prove live Google, Stripe, Neon,
Resend, Vercel, browser, or Premiere behavior; each requested live surface must
be exercised and observed separately.

`test:customer-360-postgres` exercises core merge/identity, commerce,
once-daily usage sync and rolling decay, list/detail privacy/cursors, the
first-install and first-purchase acquisition/retention funnel, exact Stripe
lookup, signed journey pagination, canonical stage/integrity reporting,
dry-run and test-only backfill
recovery, and the end-to-end merge/replay pipeline. Funnel coverage proves the
exclusive first-install window stays separate from the completed UTC-day
observation boundary, exact UTC open/return days, mature return eligibility,
accepted day-zero attempts, completed-activation/first-open subset ratios,
pre-install-only paid/anonymous/email first touches, paid-over-anonymous-over-email
precedence, anonymous browser-to-install claim continuity, unknown coverage,
deterministic journey ordering, and privacy exclusions. The complete
pipeline proves Stripe/Vercel/network isolation and verifies that Customer 360
leaves entitlement and device-seat state unchanged.

## Guarded migration contract

Local migration validation and dry-run never connect:

```bash
npm run db:migrate -- --validate
npm run db:migrate -- --dry-run
```

The acquisition-dependent tail must remain in this exact order:

1. `20260729120000_add_regional_checkout_offer_snapshots.sql`
2. `20260731120000_add_anonymous_acquisition_sessions.sql`
3. `20260803120000_add_acquisition_integrity.sql`

The last migration creates the private root/stage/conflict tables and adds the
Checkout-intent foreign key/insert guard. It intentionally preserves null
`acquisition_id` on historical intents. Do not deploy acquisition-aware runtime
before complete connected status proves all repository migrations applied with
matching checksums; never reorder, squash, edit, or mark the new migration
applied by hand.

Connected Test status/apply use only `SIDESTREAM_TEST_POSTGRES_URL`:

```bash
npm run db:migrate -- --status --target test
npm run db:migrate -- --target test
```

Connected Production status uses only
`SIDESTREAM_POSTGRES_URL_NON_POOLING`. It writes nothing and prints separate
operation-bound fingerprints for status, apply, and the exceptional baseline
path:

```bash
npm run db:migrate -- --status --target production
```

If status reports an empty database or an existing valid ledger, do not run
baseline. If and only if status reports a recognized non-empty legacy schema
without a ledger and that state receives separate review, use the printed
baseline fingerprint:

```bash
npm run db:migrate -- --baseline --target production \
  --confirm-operation BASELINE_PRODUCTION_POSTGRES_MIGRATIONS \
  --confirm-target pg-<baseline-target-fingerprint>
```

After status/baseline evidence and a separate Production mutation approval,
apply the pending checksummed chain with the printed apply fingerprint:

```bash
npm run db:migrate -- --target production \
  --confirm-operation APPLY_PRODUCTION_POSTGRES_MIGRATIONS \
  --confirm-target pg-<apply-target-fingerprint>
```

Connected modes require authenticated URLs, reject weak remote TLS, attest the
selected database name, port, and namespace after connecting, use one
connection plus the global advisory lock, and never print a URL. Each pending
SQL file and its SHA-256 ledger row commit atomically. Re-run connected status
afterward and stop on any pending file, checksum drift, unexpected baseline
shape, wrong namespace, or target mismatch. Runtime handlers never run DDL, and
these command shapes do not claim that a migration was applied.

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

Connected status is read-only and returns the operation-bound target
fingerprint after database-name, port, and namespace attestation:

```bash
node scripts/backfill-customer-360.mjs --status --namespace test
node scripts/backfill-customer-360.mjs --status --namespace production
```

After a separate approval of the dry-run digest, every orphan/conflict,
migration state, target fingerprint, restricted checkpoint path, and rollback
plan, the exact apply shapes are:

```bash
node scripts/backfill-customer-360.mjs --apply --namespace test \
  --input /restricted/path/reviewed-input.json \
  --checkpoint /restricted/path/customer-360-backfill.json \
  --batch-size 100

node scripts/backfill-customer-360.mjs --apply --namespace production \
  --input /restricted/path/reviewed-input.json \
  --checkpoint /restricted/path/customer-360-backfill.json \
  --batch-size 100 \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_360_BACKFILL \
  --confirm-target pg-<reviewed-fingerprint>
```

Test uses only `SIDESTREAM_TEST_POSTGRES_URL`; Production uses only
`SIDESTREAM_POSTGRES_URL_NON_POOLING`. The versioned mode-`0600` checkpoint is
atomically replaced after each committed batch and binds the operation,
namespace, connected target fingerprint, input digest, and processed plan
prefix. Apply is append-only, batch-atomic, resumable, and idempotent. Conflicts
write nothing; rerun the same reviewed input/checkpoint to recover from a commit
that survives a checkpoint-write failure. No apply is implied by these command
shapes.

## Required Vercel configuration names

Values belong only in the approved secret/configuration manager. Never put them
in this document, source, command arguments, handoffs, logs, URLs, or browser
storage.

| Scope | Required variable names |
| --- | --- |
| Anonymous browser/download/claim continuity | `SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET`; the existing pooled runtime selector `SIDESTREAM_POSTGRES_URL`; trusted `SIDESTREAM_LICENSE_NAMESPACE` |
| Upgrade, Google, and Stripe | `SIDESTREAM_BASE_URL`; `GOOGLE_CLIENT_ID`; `GOOGLE_CLIENT_SECRET`; `GOOGLE_REDIRECT_URI`; `STRIPE_SECRET_KEY`; `STRIPE_WEBHOOK_SECRET`; `SIDESTREAM_PRO_PRODUCT_ID`; `SIDESTREAM_PRO_PRICE_ID`; `SIDESTREAM_UNLIMITED_PRICE_ID`; `SIDESTREAM_PRO_INDIA_PRICE_ID`; `SIDESTREAM_PRO_BRAZIL_PRICE_ID`; `SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID`; trusted deployment selectors `VERCEL_ENV`, `SIDESTREAM_PRODUCTION_API_HOSTS`, and `SIDESTREAM_TEST_API_HOSTS` |
| Protected Customer 360 reads and daily sync | `SIDESTREAM_CRM_ADMIN_SECRET`; `CRON_SECRET`; separately selected read-only `SIDESTREAM_TELEMETRY_POSTGRES_URL` |
| Human-only migration/sync/rescan tools | `SIDESTREAM_POSTGRES_URL_NON_POOLING`; `SIDESTREAM_TELEMETRY_POSTGRES_URL` (and `SIDESTREAM_TEST_POSTGRES_URL` for an approved Test target only) |
| Signed `/mc` experiment metadata | `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` when the paid/freemium experiment is enabled; absent/invalid configuration keeps `/mc` on its existing safe fallback and adds no signed experiment dimension |
| Optional email-later path | Existing `RESEND_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `SIDESTREAM_LEAD_HASH_SECRET`, and `SIDESTREAM_RATE_LIMIT_HASH_SECRET`, plus optional `SIDESTREAM_DOWNLOAD_EMAIL_FROM` and `SIDESTREAM_DOWNLOAD_EMAIL_REPLY_TO` overrides; Vercel-managed Blob access may instead use its existing `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`, and the no-email secure share path does not require a recipient |

Production must fail closed if unconfigured. Without the anonymous secret,
middleware and installer delivery continue without acquisition persistence and
claim creation returns `503`. Without the admin secret, protected Customer 360
reads return `503`. Without `CRON_SECRET` or the telemetry selector, usage sync
cannot run. A direct-only runtime Postgres configuration is rejected in
Production; the non-pooling selector is operator-only. No browser value may
select any of these settings.

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
   `SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET`,
   `SIDESTREAM_CRM_ADMIN_SECRET`, separate
   `SIDESTREAM_TELEMETRY_POSTGRES_URL`, distinct
   `SIDESTREAM_TEST_POSTGRES_URL`, `CRON_SECRET`, trusted Test namespace/hosts,
   optional `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET`, and existing
   website runtime database/Blob/email secrets. Record owners without putting
   values in commands, source, reports, or logs.
5. Deploy Preview/Test only. Confirm the immutable artifact/commit and protected
   host before invoking anything. Vercel scheduling has one project-wide control
   for all four configured jobs, not a Customer 360-only toggle. Keep project-wide
   scheduling disabled unless all four jobs, their targets, secrets, side effects,
   failure handling, and alert paths receive separate non-Production approval.
   Verify usage while scheduling remains disabled with the approved
   `scripts/sync-customer-usage.mjs --apply --target test` operator path and its
   secret-safe environment launcher. Do not manually forge a cron request.
6. Run the offline backfill dry-run, verify its digest and privacy-safe report,
   and resolve every orphan/conflict decision. Any Test apply requires a new,
   separate human approval; dry-run approval is not apply approval. Verify a
   complete checkpoint and an idempotent no-op rerun afterward.
7. Before trusting historical open/return results, separately approve and run
   the one-time full append/update telemetry rescan in Preview/Test. The review
   must name the exact non-Production target and authenticated read-only source,
   preserve raw telemetry, define checkpoint/replay and failure recovery, prove
   every historical daily bucket was reconsidered, and show an idempotent rerun.
   Use only `scripts/rescan-customer-usage.mjs --apply --target test` with the
   restricted checkpoint described above. Dry-run identity-backfill approval is
   not rescan approval, and neither authorizes Production.
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

After every Preview/Test gate passes, the exact remaining Production sequence
still requires a new human authorization for each external stage:

1. Review the guarded migration/backfill/sync/rescan tooling and close the
   remaining Production blockers in `docs/api-hardening-runbook.md`; then freeze the reviewed
   website commit, FlowState commit, migration chain, manifests, environment
   inventory, alert owners, source-lag threshold, and rollback artifacts. A
   local gate or dry-run is not this approval.
2. Capture a restorable Production database snapshot and authenticated
   connected-target evidence. Run complete checksummed migration status, apply
   the pending chain through
   `20260803120000_add_acquisition_integrity.sql`, and re-run complete
   status/checksum, RLS, grant, and no-runtime-DDL verification. Stop on any
   unexpected existing object, checksum, role, or target.
3. In Vercel, set the required names above for Production without exposing
   values. Keep project-wide cron scheduling disabled. Prove pooled runtime,
   direct operator target, and read-only telemetry source are three reviewed
   roles/selections and that source and target fingerprints differ.
4. Release the clean, pushed `origin/main` commit through the Git-linked Vercel
   Production deployment only. Do not use a feature/Orchestra branch or direct
   CLI promotion. Wait for canonical `https://sidestream.tv/version.json` to
   report the exact pushed SHA and recheck the ordinary
   Upgrade -> Google authentication -> Stripe redirect before proceeding. A
   Vercel Ready build, Preview URL, or local build is not Production proof.
5. With scheduling still disabled, run the real-product smoke checklist below,
   then human-authorize the guarded full Production rescan using the exact
   target fingerprint and restricted checkpoint. Preserve every checkpoint and
   summary, require `complete=true`, review source freshness and quarantine
   counts, and run an explicitly confirmed idempotent from-zero replay only if
   the approved evidence plan requires it.
6. Run one guarded Production usage sync, verify protected list/detail/funnel
   reads, all numerator/denominator and coverage semantics, freshness, unknown
   groups, privacy exclusions, and unchanged entitlement/device rows. Stop if
   historical totals are trusted before the rescan is complete.
7. Separately approve either a protected external scheduler for usage sync or
   Vercel's project-wide cron switch. The Vercel switch enables all four declared
   jobs, so Stripe processing, lead replay, maintenance, and usage sync must each
   have reviewed credentials, targets, alerts, and failure handling.
8. Only after website schema, canonical runtime, claim flow, and monitoring are
   proven may FlowState publish a separately signed/notarized release that calls
   the claim endpoints. Verify its release manifest and actual installer bytes;
   acquisition never changes or personalizes those bytes. Observe the first
   bounded cohort before widening any release rollout.

### Failure-stop and rollback rules

Stop immediately on a target/source collision; TLS or hostname/certificate
failure; stale source beyond the approved threshold; migration/checksum/RLS
drift; checkpoint mismatch or write failure; unexpected delete or protected
domain mutation; claim conflict/quarantine growth; privacy-field leakage;
package hash/size drift; canonical SHA mismatch; protected route without the
expected `401`/authenticated behavior; scheduler ambiguity; nonzero unexpected
entitlement/device diff; incomplete rescan; or any funnel numerator larger than
its documented denominator. Also stop on any new Checkout intent without an
acquisition UUID; Session/Invoice/PaymentIntent acquisition mismatch;
`missing_internal_linkage` or acquisition owner/stage conflict; unexpected
`terminal_unknown` claim growth; invalid lookup ambiguity; signed-cursor drift;
or stage/counting-grain mismatch. Preserve the evidence and do not advance to
the next stage.

Rollback is stop-first and no-delete. Disable the approved usage invocation; if
the Vercel project-wide cron switch was enabled, disable it only under the
four-job operator decision. Remove/rotate the anonymous and Customer 360 access
secrets to return the new surfaces to fail-closed behavior, restore the last
known website commit through the canonical `origin/main` Git deployment path,
and halt/roll back the FlowState release manifest to the last verified static
installer. Do not run down SQL, delete acquisition sessions/conflicts,
truncate/rewrite telemetry, delete or update acquisition stages/conflicts,
rewrite canonical first touch, fabricate historical roots, delete
profiles/identity/commerce/audit rows, or discard checkpoints. Do not roll code
back to a schema-incompatible artifact after the insert guard exists. A database
snapshot restore is a separately authorized last resort and must account for
all concurrent website writes, not only this feature.

### Real-product smoke checklist

Use a designated test campaign and test account; never expose a real customer's
email, cookie, token, install hash, receipt hash, or profile ID in screenshots or
logs.

1. Open canonical Production from a bounded direct/UTM source in a real phone
   and desktop browser. Confirm the response sets the host-only HttpOnly
   acquisition cookie once and a later tagged visit cannot overwrite it.
2. On mobile, exercise the no-email secure share path and, separately, the
   optional email-later path. Open the opaque link on a real computer; confirm
   it contains only `handoff`, rejects appended identity/query fields, restores
   continuity, and selects the expected platform.
3. Compare public release metadata, download `HEAD`, and the downloaded file's
   platform, filename, size, and SHA-256. Direct, tagged, shared, and emailed
   paths must return the same static package bytes.
4. Install and open the actual signed/notarized FlowState product. Confirm the
   panel verifies the local receipt, requests a claim with only the two hashes,
   receives only the browser URL, acknowledgment handle, and expiry; observes
   `pending` -> `browser_opened` -> `claim_completed`; shows the generic
   connected page; and resumes in Premiere without email or Google
   authentication. Exercise expired/conflict Test cases without exposing the
   nonce or handle.
5. Through the protected report, verify one exact anonymous journey from first
   visit through installer request, install, exact `session_started` first open,
   and any accepted day-zero attempt. Confirm confidence is
   `exact_anonymous_claim`, unknown profiles remain included, and no private
   hash/token/email crosses the response.
6. Optionally authenticate the same installation later with Google. Confirm the
   verified account attaches to the existing profile rather than creating a
   second journey, while payment, entitlement, device binding, and transfer
   history remain byte-for-byte/logically unchanged.
7. Re-run ordinary Upgrade -> Google authentication -> Stripe Checkout plus an
   existing active-account restore/transfer check. Anonymous acquisition must
   not change either server-owned path. With designated Test Stripe objects,
   verify the intent, Session, optional Invoice, and optional PaymentIntent carry
   the same acquisition UUID; verify exact `cus_`, `cs_`, `pi_`, and `ch_`
   operator lookup resolves without echoing the identifier; and compare the
   first-install and first-purchase funnel selectors across signed cursor pages.
   Verify refund/dispute current money state, immutable lifecycle stages,
   integrity alerts, source freshness, cron summaries, and canonical SHA before
   ending the smoke.

For non-Production rollback, the same stop-first rule applies: stop the approved
usage invocation, account for the four-job scheduler switch, remove protected
route access, redeploy the last known Preview/Test artifact, and restore or
recreate only the approved staging database from its snapshot. Preserve failure
evidence, backfill reports, and checkpoints, but do not copy them into
Production.

The Production sequence and rollback above remain the required gate for future
material changes, not standing authorization. The 2026-08-01 qualification
executed and observed the migration, backfill, rescan, sync, configuration,
scheduling, deployment, protected API, release, loaded-Premiere, and real claim
surfaces described in the status record above. Preserve its stop-first,
no-delete rollback rules and re-establish canonical proof whenever any of those
inputs changes.

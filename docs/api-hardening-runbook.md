# Sidestream API hardening operations runbook

This is the operator reference for the hardened Sidestream API. It documents the
reviewed implementation, current contracts, guarded Customer 360
migration/backfill/sync/rescan invocation shapes, and unresolved release
blockers. The guarded commands require Preview/Test-first evidence and a
separate human authorization for each external stage. This document is not
evidence that a Production migration, Stripe configuration change, Vercel WAF rule,
deployment, secret change, cron change, traffic change, query, or cutover has
occurred. The documentation-remediation worker that wrote this revision ran
local checks only; it did not call live Stripe or Vercel endpoints or read or
mutate Production data. Disposable tests and a local build do not prove live
Google, Stripe, Neon, Resend, Vercel, browser, or Premiere behavior.

This document records API, HTTP, data-model, telemetry, and operational facts,
plus the capabilities that a separately reviewed Production plan needs.
`docs/single-device-entitlements.md` remains limited to device-domain
behavior, privacy, and conceptual support decisions. Neither document authorizes
Production staging or mutation. Do not reconstruct retired procedures from Git
history or tickets.

## Contract at a glance

- Public reads and redirects remain server-owned. Runtime handlers never run
  schema DDL.
- All runtime database users share the pool in `api/_lib/postgres.ts` and use a
  pooled URL in production. Migration and backfill tools use a reviewed direct
  URL.
- Upgrade uses one server-owned sequence: Upgrade button, Google authentication,
  Stripe payment. `GET /api/checkout/start` creates or reuses the Stripe Checkout
  Session after authentication.
- Every new Checkout intent requires one immutable canonical acquisition UUID.
  OAuth preserves it, Stripe metadata must agree with it, fulfillment fails
  closed on any mismatch, and stage/conflict reporting never guesses a link.
- Stripe webhook requests durably record an event and acknowledge it. A claimed,
  leased queue reconciles entitlements; account and activation reads never drain
  webhook backlog.
- Download leads converge on one Postgres identity. Private Blob is a bounded
  fallback, not a second source of truth, and replay is explicit and observable.
- Four `CRON_SECRET`-protected jobs process Stripe events, replay fallback leads,
  run retention maintenance, and materialize Customer 360 usage once daily.
- Anonymous acquisition keeps signed browser UUID/cookie, verified install/receipt
  hashes, sparse Customer 360 profile, and later verified account/contact
  separate. Tracking is nonblocking, installer bytes remain static, and missing
  configuration fails association and protected reads closed.
- Authenticated paid claim finalization binds only the POST's exact current
  install/native-receipt pair. Compatible paid and telemetry profiles converge
  deterministically before one immutable binding, stage set, commerce owner,
  exact lookup owner, and funnel root are accepted.
- The repository does not currently contain a production maintenance rule,
  operator WAF bypass, per-job cron kill switch, Stripe dead-letter reset/replay
  tool, qualified runtime-distinct rollback artifact, failed-refund recovery
  transition, complete current-dispute-status mapping, a claim-side total-attempt
  cap, authenticated-transport support in the remaining legacy/device/reporting
  tools, or historical lifecycle repair tool.
  Every one remains an explicit Production blocker, never an existing
  capability.

## Acquisition integrity operator contract

The paid path is fixed and prominent because no alternate client-owned sequence
is valid:

```text
Upgrade
  -> GET /api/checkout/start resolves canonical acquisition UUID
  -> Google authentication when signed out
  -> short-lived HttpOnly OAuth acquisition cookie restores the same UUID
  -> locked Checkout intent requires acquisition_id
  -> Stripe Session (+ Invoice/PaymentIntent when present) agrees on UUID
  -> fulfillment commits entitlement and ledger stages together
```

The private root is `public.sidestream_acquisitions.id`. First source, medium,
campaign, creative, entry channel, observation time, coarse referrer category,
experiment, and confidence are immutable. Delivery evidence is append-only.
`website_direct_or_unknown` means an exact `website` entry with no available
external origin; it is never a fallback for broken internal joins. Browser
input cannot select trusted channels. Only an encrypted/signed server-owned
delivery envelope can create immutable `manychat_email` or
`facebook_lead_form` entry channels.

The append-only stage/grain pairs are:

| Stage | Grain |
| --- | --- |
| `landing_observed` | `acquisition` |
| `email_handoff_created` | `delivery_handoff` |
| `installer_requested` | `installer_request` |
| `installation_claimed` | `installation` |
| `authentication_completed` | `authentication` |
| `checkout_started` | `checkout_intent` |
| `checkout_completed` | `checkout_session` |
| `payment_settled` | `payment` |
| `refunded` | `refund` |
| `disputed` | `dispute` |

Each key is a server-derived digest of namespace, stage, and stable server
reference. Retries converge. Reuse by another root records hashed conflict
evidence and quarantines both roots; no operator may reassign or delete the
stage. Refund/dispute stages are immutable observed facts. Current paid,
refunded, disputed, inquiry, and net-paid state comes from commerce truth, so a
later dispute win can clear current disputed money without erasing the event.

Every new Checkout intent has `acquisition_id`; migration intentionally leaves
historical rows null. Checkout Session metadata, Invoice metadata when present,
and PaymentIntent metadata when present must each contain the same
`sidestream_acquisition_id`. The existing exact account, activation, offer,
Product, Price, currency, subtotal, discount, tax, shipping, total, customer,
PaymentIntent, and Charge checks remain mandatory. A verified zero-total
Session may omit PaymentIntent only for exact `paid` or `no_payment_required`
settlement and does not waive the UUID agreement.

On mismatch, `/api/checkout/complete` returns `409`, no success redirect occurs,
and the entitlement plus `checkout_completed`/`payment_settled` writes do not
commit. The signed webhook queue records a returned non-fulfilled mismatch as
terminal `ignored` with a bounded `checkout_<reason>` outcome; thrown transient
provider/database failures use the existing retry/dead-letter path. Alert on
every acquisition/linkage/owner/stage mismatch outcome. Queue terminality does
not make it a fulfilled purchase.

Operator reporting uses two independent cohort selectors: `first_install` and
`first_purchase`. Journey pagination is ascending `(cohortAt, customerId)` with
a signed cursor bound to namespace, basis, limit, cohort window, and observation
boundary. Source rollups cap at 100 and expose truncation. Exact `cus_`, `cs_`,
`pi_`, or `ch_` lookup resolves only stored aliases, never echoes the Stripe
identifier, returns `404` for no owner, and `409` for ambiguous/conflicting
ownership. Monitor `missing_internal_linkage`, `historical_unlinked`, and
`quarantined` separately; never relabel them as external unknown origin.

Acquisition storage, logs, lookup, and funnel output exclude raw email, IP, user
agent, cookie/browser token, install/receipt hash, identity-link value, Stripe
or telemetry payload, and Stripe object identifier. Deduplication keys and raw
conflict evidence are also excluded from operator responses. Installer packages
and public URLs remain static and carry no acquisition UUID or personalized
payload.

Historical linkage is deterministic-only. Exact signed cookie/claim, account or
activation link, Checkout/Stripe alias, verified installer receipt, or reviewed
server delivery record may prove a relation. Similar email, time, name, UTM, IP,
user agent, or campaign proximity may not. No acquisition-history backfill tool
exists. Preserve unproved historical nulls as `historical_unlinked`; any future
operator must be separately reviewed, append-only, idempotent, checkpointed,
conflict-preserving, and prove a no-op rerun.

For the exact paid handoff, `installation_claimed_recorded` is not sufficient
by itself. Success also requires one append-only
`sidestream_paid_telemetry_profile_bindings` row for the POST's current
install/receipt row IDs and one live Customer 360 profile shared by that
install's telemetry, acquisition, commerce payment-key group, exact lookup, and
funnel journey. Google callback and already-signed-in Checkout paths persist
the same acquisition/account-scoped `authentication_completed` stage. Missing,
stale, refunded, disputed, cross-namespace, ambiguous, or contradictory facts
fail closed; no operator may substitute profile history or a nearby identity.

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
| `/api/send-download-links` | `POST` / `GET` | Email POST sends signed Mac/Windows handoffs when anonymous continuity is configured and otherwise preserves its direct static-link fallback; `{"handoffOnly":true}` POST returns one no-email secure URL; GET accepts exactly one valid `handoff`, restores the acquisition cookie, and redirects to the canonical platform download | `400`/`413`/`415` request failures, `429` email rate limit, `502` provider failure, `503` storage/configuration failure; forged/expired/duplicated/augmented handoff is `404` |
| `/api/acquisition/entry` | `GET` | Accepts exactly one encrypted/signed server delivery `handoff`, persists its canonical root/stages, restores the signed acquisition cookie, and redirects to `/` | Unsupported method, missing/extra query, forged/expired envelope, or storage failure returns indistinguishable private `404` |
| `/api/auth/google/start` | `GET` | Resolves acquisition first, sets bounded OAuth state/next/acquisition cookies, and `302` redirects to Google | Acquisition and ordinary configuration failures render the same generic temporary-unavailability HTML; unsafe `next` values collapse to `/account.html` |
| `/api/auth/google/callback` | `GET` | Creates the server session and `303` redirects to the allowlisted next path | `400` invalid state/code, `500` exchange/account/session failure |
| `/api/auth/session` | `GET` | Always `200`: `{"authenticated":false}` or authenticated `user`, `license`, and `billing.hasCustomer` | Dependency failure is a server `500`; this read never processes Stripe events |
| `/api/auth/logout` | `POST` | `200 {"ok":true}` after clearing the session | Dependency failure is a server `500` |
| `/api/checkout/start` | `GET` | Resolves the mandatory acquisition UUID; signed-out users receive `302` to Google authentication; signed-in Free accounts receive `303` to Stripe Checkout; an active owner redirects to account/claim | `503 acquisition_unavailable`; `409 checkout_unavailable`, `intent_expired`, `activation_unavailable`, or `activation_window_too_short`; `429 rate_limited`; unhandled DB/Stripe failure is `500` |
| `/api/checkout/complete` | `GET` | Verifies the exact attached Session/Price/Product, reconciles payment, then `303` to thank-you | `400` missing session, `409` payment not ready or exact contract mismatch |
| `/api/billing/portal` | `POST` | Authenticated `200 {"url":"..."}` for a Stripe Customer Portal Session | `401` unauthenticated, `400` no linked Stripe customer, Stripe failure is a server `500` |
| `/api/billing/receipt` | `POST` | Authenticated `200 {"url":"..."}` for the latest owned charge receipt | `401` unauthenticated, `403` customer mismatch, `404` no purchase/receipt URL, Stripe failure is a server `500` |
| `/api/stripe/webhook` | `POST` | `200 {"received":true}` after durable insert; duplicate acknowledgment also includes `"duplicate":true` | `400` missing/invalid signature; an unhandled durable-storage failure is a server `500` and must be retried by Stripe |
| `/api/activation/start` | `POST` | `200` with `activationKey`, 24-hour `expiresAt`, `upgradeUrl`, and `restoreUrl` | `400 invalid_request` for missing device; an unexpected dependency failure is a server `500` |
| `/api/activation/status` | `POST` | `200` state payload: `pending`, `pending_payment`, `active`, `completed`, `not_found`, `device_mismatch`, `expired`, `transfer_required`, `transfer_limit_reached`, `device_replaced`, or `device_deactivated` | A parsed non-null JSON value missing valid `activationKey` or `deviceId` returns `400 invalid_request`; valid JSON `null`, malformed JSON, and body-read failures currently escape as an unshaped platform `5xx`, not `400`; `503` environment unavailable |
| `/api/activation/claim` | `GET` / `POST` | GET authenticates and routes Free accounts to Checkout; active owners receive the restore/transfer decision; same-origin CSRF-valid POST restores/reconnects/transfers | `400` invalid/transfer intent; `401` sign-in required; `403` inactive or CSRF; `409` unavailable, binding changed, or claim conflict; `503` environment unavailable |
| `/api/activation/paid-claim` | `GET` / `POST` | Exact `paid-acquisition-mc-v1` activation source authenticates through Google; active owners use the same CSRF-bound reconnect/confirmed-transfer engine; inactive owners receive support-only noindex HTML | No Checkout fallback; nonmatching/expired/conflicting activation is unavailable; existing claim CSRF, device, transfer-limit, and environment failures remain unchanged |
| `/api/installation/claim` | `POST` | Accepts exactly lowercase hex64 `installIdHash` and `installerReceiptIdHash` after panel-side receipt verification; returns a 15-minute opaque `browserUrl`, opaque `acknowledgmentHandle`, and `expiresAt` | `400 invalid_request` / `invalid_customer_identity`; `503 claim_unavailable` when namespace, secret, schema, or database association is unavailable |
| `/api/installation/claim-complete` | `GET` | Uses only one opaque `nonce` plus the signed acquisition cookie, consumes the exact claim once, and returns minimal private noindex HTML | `400` invalid nonce, `409` conflict, `410` expired, `503` unavailable; missing/forged browser state returns the same minimal `200` without consuming the claim |
| `/api/installation/claim-status` | `POST` | Accepts only `acknowledgmentHandle`; returns `pending`, `browser_opened`, `claim_completed`, `conflict`, `expired`, or `terminal_unknown` with private no-store headers | `400 terminal_unknown` for invalid body/handle; `503 terminal_unknown` when environment or secret is unavailable; never reveals nonce, hashes, profile, or internal error detail |
| `/api/license/verify` | `POST` | `200` current credential result | `400 invalid_request`; `401 invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`; `403 license_inactive`; `503` retryable environment failure |
| `/api/license/refresh` | `POST` | `200` atomically rotated access/refresh pair; predecessor replay is deterministic for two minutes | Same stable `400`/`401`/`403`/`503` classes as verify |
| `/api/license/authorize-download` | `POST` | Exactly `200 {"active":true}` for the active device | `401` revoked/replaced/deactivated device; `403` inactive; `503 {"code":"authorization_unavailable"}` is retryable |
| `/api/account/device` | `GET` | `200 {"active":boolean,"device":object|null}` with coarse device data | `401` unauthenticated; `503` unavailable |
| `/api/license/deactivate` | `POST` | `200 {"active":false,"deactivated":boolean}` for intent `deactivate_active_device` | `400 invalid_intent`, `401 authentication_required`, `403 same_origin_required`, or retryable `503 deactivation_unavailable` |
| `/api/internal/stripe-events/process` | `GET` | `200 {"ok":true,"claimed":n,"processed":n,"ignored":n,"retryable":n,"deadLetter":n}` | `401 unauthorized`, `503 processor_unavailable`, `500 processing_failed` |
| `/api/internal/download-leads/replay` | `GET` / `POST` | `200 {"ok":true,"summary":{...},"nextCursor":string|null,"hasMore":boolean}` | `400` invalid controls/JSON, `401 unauthorized`, `415` non-JSON POST, `503 replay_unavailable`, `blob_unavailable`, or `invalid_blob_page`; per-record failures stay in the summary |
| `/api/internal/maintenance` | `GET` | `200 {"ok":true,"outcome":"completed"|"locked","durationMs":n,"batchSize":n,"hasMore":boolean,"counts":{...}}` | `401 unauthorized`, `503 maintenance_unavailable`, `500 maintenance_failed` |
| `/api/internal/customer-usage/sync` | `GET` | Once-daily protected aggregate summary with namespace, batches, source rows, daily buckets, refreshed profiles, and source freshness | `401 unauthorized`, `503 customer_usage_unavailable`, `500 customer_usage_sync_failed`; concurrent/daily duplicate invocation reports a non-error locked/skipped outcome |
| `/api/internal/customers`, `/api/internal/customers/{customerId}`, `/api/internal/customers/lookup`, `/api/internal/customer-summary`, `/api/internal/customers/funnel` | `POST` | `SIDESTREAM_CRM_ADMIN_SECRET`-protected, no-browser, no-store compact reads, exact Stripe-reference lookup, license-backed summary, and first-install/first-purchase funnel report | `400` bounded validation, `401` unauthorized, `404` absent detail/lookup, `409` lookup integrity conflict, `503 customer_admin_unavailable`, shaped `500` read failure |

Browser/account behavior and device support facts are expanded in
`docs/single-device-entitlements.md`. Its former Production cutover prose is
removed, and the API runbook records blockers rather than an executable
replacement. None of those reads processes the Stripe event queue.

### Anonymous acquisition and one-time installation claim

The exact privacy, identity, attribution, and rollout contract is
`docs/customer-360.md`. Operationally, `SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET`
signs/encrypts the 30-day browser cookie, seven-day computer handoff, and
15-minute installation claim/acknowledgment envelopes. The v2 browser cookie
contains the canonical acquisition UUID and immutable bounded first touch; its
derived legacy-compatible claim token is never serialized. URLs expose only
`handoff` or `nonce`, never UTM fields, email, install/receipt hashes, profile
IDs, payment, device, or entitlement evidence.

The browser cookie write and post-redirect acquisition persistence are best
effort. Missing/weak secret, invalid cookie, database failure, or scheduling
failure cannot block a valid page or static installer response. The claim and
Customer 360 surfaces do fail closed when unconfigured. Exact same-profile
claim replay is idempotent; contradictory evidence is quarantined with an
append-only digest. The panel may poll only with the opaque acknowledgment
handle and receives the six bounded states listed above. No acquisition path
changes manifest selection or package pathname/SHA/size.

### Dedicated paid onboarding claim boundary

Activation source changes only the browser recovery UX:

- raw source exactly `paid-acquisition-mc-v1` selects
  `/api/activation/paid-claim`, which rechecks the stored source;
- an active owner receives the existing reconnect or explicit
  device-transfer decision under the same CSRF and transfer-limit checks;
- an inactive owner receives the noindex support-only page, never Checkout; and
- every omitted, whitespace/case variant, or other source stays on ordinary
  `/api/activation/claim`, where a Free account continues to the server-owned
  `/api/checkout/start` and then directly to Stripe.

Source is not payment, entitlement, environment, or device authority. This
server-support route does not enable the unlinked, default-off `/mc` experiment
and requires no new migration. The future canonical-surface smoke procedure is
in `docs/paid-acquisition-runbook.md`; it explicitly forbids visiting `/mc`,
changing environment values, sending email, publishing artifacts, or completing
payment. No live smoke was performed by this documentation gate.

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

### Upgrade payment flow

1. The user clicks Upgrade.
2. Google authentication establishes the Sidestream account session.
3. The browser opens Stripe Checkout for payment.

`GET /api/checkout/start` owns this sequence. It preserves an optional bounded
activation key through the OAuth return, applies limits of 8 requests per account
and 20 per IP in a 15-minute window, creates a 24-hour database intent, and invokes
the locked worker. The worker creates or reuses one Stripe Session with a stable
idempotency key and persists the exact Session/Price/Product.

- Checkout uses `mode=payment`, one card line item with quantity one, invoice
   creation, promotion codes, and the copy `One-time payment. No subscription.`
- The success URL keeps Stripe's literal `{CHECKOUT_SESSION_ID}` placeholder and
   returns through `/api/checkout/complete`. Completion re-fetches Stripe truth;
   the browser URL is never payment proof.
- The signed webhook remains the primary durable path. Completion and the
   device-validated activation fallback converge on the same locked,
   watermark-protected reconciliation helper.

Persisted intent state is constrained to `pending`, `open`, `completed`,
`cancelled`, `expired`, or `failed`. Stripe cancellation returns to the signed-in
account page. A caller cannot supply its own Stripe or activation tuple.

New one-time purchases select `SIDESTREAM_PRO_PRODUCT_ID` (default
`prod_UpwXh6oO1OmPyQ`), then use this runtime-compatible Price precedence:
validated `SIDESTREAM_PRO_PRICE_ID`, code default Price ID (currently empty), and
compatible `SIDESTREAM_UNLIMITED_PRICE_ID` hints; the expanded Product's active
matching `default_price`; the exact `sidestream_pro_once_1999` lookup-key match;
then any other active matching Product Price. A stale, deleted, or incompatible
hint falls through, while provider/network failures still fail closed. Only
after every discovery branch misses does runtime use its idempotent create
fallback. Every compatible Price must belong to the selected Product and have
the active one-time USD 1999-cent shape. Runtime
discovery is not cutover approval. A future separately reviewed plan would need
an approved exact Product/Price manifest and provider-attested proof that the
actual deployed runtime selector resolves to those exact IDs before any mutation
and again before any promotion.

### Activation compatibility

Activation is device-bound and lasts 24 hours. A Checkout activation must retain
at least 31 minutes, persists Stripe expiry, and gets a 10-minute post-payment
claim grace. Current clients (1.0.14 and later) receive a seven-day access token
plus a rotating 365-day refresh credential; status replays the credential family
for only 10 minutes, then returns `completed`. Legacy clients through 1.0.13
cannot persist refresh credentials, so they receive a rolling 365-day access
token and status remains `active` for the activation's 24-hour life. Compatibility
uses the persisted activation version, never a request user agent.

Production permits up to two active devices per account. Test is a separate restricted
namespace and not a second seat. A same-device reconnect is free; a confirmed
move revokes only the reviewed previous device, with no rolling or lifetime
move limit. See `docs/single-device-entitlements.md` for support actions and privacy
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
still accept and terminalize another lifecycle event. After a future deny is
proved active and every old in-flight invocation/write has drained, the tool
must run a final canonical full scan or exact manifest-derived delta. It must
cover every refund/dispute lifecycle ID through the deny boundary, including
every pre-drain ID and every transition-window ID accepted or observed after the
provisional scan. Retain the final exact-ID manifest/checksum and
`HISTORICAL_LIFECYCLE_DENY_WATERMARK`, repair affected terminal
`processed`/`ignored` history through the reviewed idempotent reconciler, prove
canonical entitlement state plus each resulting entitlement watermark, and
prove an immediate second run is a no-op. A terminal queue status is transport
evidence, not canonical lifecycle evidence. The gate may instead close only with
the same final post-deny evidence proving no affected history. Any missing ID,
unstable snapshot, watermark regression, late through-boundary ID, or canonical
mismatch blocks migration, promotion, fallback, and reopening.

Manual updates to event status, `terminal_at`, payload, entitlement state,
credentials, or watermarks are forbidden. This documentation-only change does
not invent the required tool, and a bounded maintenance-window enumeration is
not a substitute for either phase of this gate.

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

The guarded Customer 360 migration/backfill operators accept only
`SIDESTREAM_TEST_POSTGRES_URL` for Test or
`SIDESTREAM_POSTGRES_URL_NON_POOLING` for Production; generic and runtime
selectors are rejected. A production runtime with only a direct URL fails
closed. Do not give direct migration credentials to a browser, CEP build, or
normal serverless runtime.

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

Database-backed `--status`, `--baseline`, and apply use exact named selectors:
`SIDESTREAM_TEST_POSTGRES_URL` for Test and
`SIDESTREAM_POSTGRES_URL_NON_POOLING` for Production. They reject weak remote
TLS, use one connection, attest the selected database name, port, and namespace
after connecting, and emit only operation-bound `pg-...` fingerprints. Status
writes nothing and is the only source for the apply/baseline target
fingerprints:

```bash
npm run db:migrate -- --status --target test
npm run db:migrate -- --target test

npm run db:migrate -- --status --target production
npm run db:migrate -- --target production \
  --confirm-operation APPLY_PRODUCTION_POSTGRES_MIGRATIONS \
  --confirm-target pg-<apply-target-fingerprint>
```

Baseline is not routine apply. Use it only when connected status reports a
recognized non-empty legacy schema without a ledger and a separate review
approves that exact state:

```bash
npm run db:migrate -- --baseline --target production \
  --confirm-operation BASELINE_PRODUCTION_POSTGRES_MIGRATIONS \
  --confirm-target pg-<baseline-target-fingerprint>
```

The Production command shapes are guarded capabilities, not standing
authorization. This code-only run did not execute them.

An existing non-empty schema without the ledger is not automatically assumed to
be current. `--status` reports that a baseline is required; `--baseline` checks
the known pre-hardening schema and records only migrations it can prove. Applying
refuses an unbaselined non-empty schema. The chain currently ends with
`20260803120000_add_acquisition_integrity.sql`. Its acquisition-dependent tail
must stay ordered as regional Checkout snapshots
(`20260729120000_add_regional_checkout_offer_snapshots.sql`), anonymous
acquisition sessions (`20260731120000_add_anonymous_acquisition_sessions.sql`),
then acquisition integrity (`20260803120000_add_acquisition_integrity.sql`). The
last migration creates private root/stage/conflict tables and adds the
Checkout-intent foreign key plus new-insert guard while deliberately preserving
historical nulls. Stop if connected status does not prove all three with the
repository checksums before acquisition-aware runtime deployment. Never reorder,
squash, edit, baseline, or mark the last migration applied by hand. The earlier
`20260714200000_remove_redundant_download_lead_key_unique.sql` keeps canonical
lead uniqueness on `(email, cta_source)` and `lead_key` as a non-unique lookup
index. Runtime DDL is prohibited and checked by
`node scripts/assert-no-runtime-ddl.mjs`.

`npm run db:migrate -- --status --target test|production` is the authoritative read-only applied/pending
filename inventory for the complete checksummed chain. When a ledger exists it
loads every ledger checksum and fails on any local mismatch, but `printStatuses`
emits only `<status>: <filename>`; it does not print retainable checksum values.
`--validate` checks only local ordering/checksums and `--dry-run` lists local
files; both exit before database selection. Retain connected status before and
after mutation and preserve the reviewed local migration SHA-256 evidence.
`scripts/verify-migration-baseline.mjs` is narrower.
It recognizes a known pre-20260713 catalog, verifies its conditional RLS state,
and reports only the baseline-era/activation-rotation guard it understands. It
neither loads `SIDESTREAM_DB_ENV_FILE` nor enumerates every later hardening
migration, so it must never replace or contradict complete status/checksum
evidence.

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

Any future maintenance or fallback plan must keep the live Stripe event
destination enabled. Stripe documents that events created while a destination
is disabled are not automatically resent. The required conceptual ordering is
to deny webhook acceptance at the edge, retain the exact UTC/event-ID window,
and reconcile every delivery before other writes reopen. A live automatic retry
path lasts only up to three days. Dashboard/Workbench manual Resend is available
only up to 15 days after event creation, and `stripe events resend` only up to 30
days. These are recovery ceilings, not authorization for an open-ended
maintenance window. A future plan must bound the closed-write window to two
hours, page the incident owner if reconciliation remains unresolved 24 hours
after its earliest event, and abort by 48 hours after that event, preserving at
least a 24-hour margin before automatic retry eligibility can expire. The
webhook would stay open for reconciliation while all other writes remain
blocked. This is an ordering invariant, not an executable sequence. Stripe's
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
| Scheduler | `CRON_SECRET`: one stable random value, 16-512 printable non-space ASCII characters (`U+0021`-`U+007E`), sent as `Authorization: Bearer ...` to every scheduled internal route. Customer 360 read routes use `SIDESTREAM_CRM_ADMIN_SECRET` instead. Generate 32 random bytes as a 64-character hexadecimal token in the approved secret manager; spaces, tabs, newlines, and non-ASCII are outside the shared cron contract because lead replay rejects them even though the other three scheduled validators do not enforce this character class. |
| Runtime database | Pooled URL precedence above; `POSTGRES_POOL_MAX` default 4, range 2-20; `POSTGRES_POOL_IDLE_TIMEOUT_MS` 10000, 1000-60000; `POSTGRES_CONNECTION_TIMEOUT_MS` 5000, 250-30000; `POSTGRES_QUERY_TIMEOUT_MS` and `POSTGRES_STATEMENT_TIMEOUT_MS` 10000, 250-60000; `POSTGRES_SSL=0` only for a known local target |
| Migration database | `SIDESTREAM_POSTGRES_URL_NON_POOLING` preferred; `POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS` defaults to 300000 and is bounded 1000-1800000; runner pool max is 1 |
| Test database | `SIDESTREAM_TEST_POSTGRES_URL` is mandatory for integration tests, must be disposable, and must not normalize to any runtime host/port/database target |
| Anonymous acquisition | `SIDESTREAM_ANONYMOUS_ACQUISITION_SECRET` is stable server-only secret material for cookie, handoff, and claim continuity; `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` is separately required only for signed `/mc` experiment dimensions. Missing/invalid values never become browser-selected fallbacks. Optional email-later uses existing `RESEND_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `SIDESTREAM_LEAD_HASH_SECRET`, and `SIDESTREAM_RATE_LIMIT_HASH_SECRET` (or Vercel-managed `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID` for Blob access); no-email secure sharing remains available without a recipient. |
| Upgrade / Google / Stripe names | `SIDESTREAM_BASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SIDESTREAM_PRO_PRODUCT_ID`, `SIDESTREAM_PRO_PRICE_ID`, `SIDESTREAM_UNLIMITED_PRICE_ID`, `SIDESTREAM_PRO_INDIA_PRICE_ID`, `SIDESTREAM_PRO_BRAZIL_PRICE_ID`, `SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID`, `VERCEL_ENV`, `SIDESTREAM_PRODUCTION_API_HOSTS`, `SIDESTREAM_TEST_API_HOSTS`. Values remain only in the approved secret/configuration manager. |
| Customer 360 | `SIDESTREAM_CRM_ADMIN_SECRET` protects non-browser reads and cursor signing; `SIDESTREAM_TELEMETRY_POSTGRES_URL` selects a separate read-only telemetry source; `SIDESTREAM_LICENSE_NAMESPACE` is trusted server state. Human-only guarded usage operations select Production target through `SIDESTREAM_POSTGRES_URL_NON_POOLING` or Test through `SIDESTREAM_TEST_POSTGRES_URL`. Never expose values. |
| Rate limiter | `SIDESTREAM_RATE_LIMIT_HASH_SECRET`, at least 32 characters and stable; no production fallback. Checkout is fixed at 8/intent and 20/IP per 15 minutes; lead capture is fixed at 5/email and 20/IP per 10 minutes |
| Checkout intent | Database intent TTL 24 hours; fixed code constant. Product/Price variables are `SIDESTREAM_PRO_PRODUCT_ID`, `SIDESTREAM_PRO_PRICE_ID`, and legacy `SIDESTREAM_UNLIMITED_PRICE_ID` |
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
| Checkout volume | Authentication redirects, created/reused Sessions, rate limits, and dependency errors | Warning when create failures exceed 1% or 5 in 15 minutes. |
| Rate limit | `429 code=rate_limited` by scope and total eligible requests | Warning when checkout or lead 429s exceed 5% with at least 10 requests in 15 minutes; investigate abuse before raising limits. |
| Lead fallback backlog | Private Blob count and oldest age under the configured prefix | Warning if nonzero for 15 minutes after Postgres recovers or oldest exceeds 30 minutes; critical over 2 hours or growth across two replay intervals. |
| Unmapped Blob records | Replay `summary.unmapped` and path sample without lead contents | Critical on any new unmapped record. Quarantine/preserve it; do not auto-delete. |
| Maintenance | Missing run, `maintenance_failed`, `hasMore`, duration, and every deletion/redaction count | Critical on any failed run or no completed/locked run in 26 hours; warning when `hasMore` or a count reaches batch size for 3 runs, or a count exceeds 4x its rolling seven-day median. |
| Acquisition integrity | Canonical roots by integrity state; all ten stage counts/grains; Checkout/Stripe acquisition mismatch outcomes; claim status distribution; exact lookup conflicts; attributed/unknown coverage | Critical on new `missing_internal_linkage`, quarantine, owner/stage conflict, Checkout acquisition mismatch, unexpected `terminal_unknown`, lookup ambiguity, missing required stage, or privacy leakage. Track `historical_unlinked` separately. Tracking failure must not be counted as installer or fulfillment success. |
| Customer usage/funnel | Last sync outcome, source freshness/lag, rescan checkpoint completeness, attributed/unknown coverage, and each exposed numerator/denominator | Stop on stale/null freshness beyond the approved threshold, incomplete/mismatched checkpoint, unknown coverage disappearance, or any numerator above its defined denominator. Do not trust historical retention before rescan `complete=true`. |
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
| `27 5 * * *` | `GET /api/internal/customer-usage/sync` | Once per namespace/UTC day, 250-row default source batches, advisory locked |

Vercel exposes a project-level **Disable Cron Jobs** control. It does not expose
an operator control that pauses or resumes these four declared schedules one at
a time; changing one schedule requires configuration plus a new deployment. The
repository also has no per-job kill switch. A reviewed scheduler plan needs either a
reviewed project-wide pause/invoke/re-enable sequence or separately reviewed
per-job kill switches. The repository also has no approved maintenance WAF
bypass or secret-safe launcher for manually forging these protected HTTP cron
routes. The guarded direct Customer 360 sync/rescan operators below are the
approved command shapes for separately authorized manual runs; they do not
authorize or invoke any other cron job. See Vercel's primary [cron management contract](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

Any future protected invocation capability must validate `CRON_SECRET` as
16-512 printable non-space ASCII characters, keep it out of shell history and
diagnostic output, authenticate the operator bypass, and constrain its route and
method scope. Scheduled/manual GET lead replay is delete-after-commit; a future
maintenance bypass must not permit the manual replay POST surface.

### Guarded Customer 360 sync and historical rescan

`scripts/sync-customer-usage.mjs` and
`scripts/rescan-customer-usage.mjs` are separate operator paths; they do not
forge the cron route. Dry-run performs no network or database access. Apply uses
only named environment selectors, one connection per database, remote
certificate verification, source/target fingerprint collision rejection, and a
bounded source-freshness check. Remote URLs that request weakened TLS are
rejected, and URLs/secrets are never printed.

```bash
node scripts/sync-customer-usage.mjs --dry-run --target test
node scripts/rescan-customer-usage.mjs --dry-run --target test
node scripts/sync-customer-usage.mjs --status --target test
node scripts/rescan-customer-usage.mjs --status --target test
node scripts/sync-customer-usage.mjs --apply --target test --batch-size 250
node scripts/rescan-customer-usage.mjs --apply --target test \
  --checkpoint /restricted/path/customer-usage-rescan.json

node scripts/sync-customer-usage.mjs --apply --target production \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_USAGE \
  --confirm-target pg-<reviewed-fingerprint>
node scripts/rescan-customer-usage.mjs --apply --target production \
  --checkpoint /restricted/path/customer-usage-rescan.json \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_USAGE \
  --confirm-target pg-<reviewed-fingerprint>
```

The Production forms are capabilities, not authorization. Test target is only
`SIDESTREAM_TEST_POSTGRES_URL`; Production target is only
`SIDESTREAM_POSTGRES_URL_NON_POOLING`; source is only
`SIDESTREAM_TELEMETRY_POSTGRES_URL`. Run matching Production `--status` first;
it returns read-only source and target fingerprints after connection and
collision checks. Each fingerprint binds hostname, port, database, namespace,
and operation, so only the matching target fingerprint belongs in
`--confirm-target`. Raw telemetry is read-only, target writes
are append/update-only usage aggregates, and deletes plus canonical acquisition,
profile/identity, commerce/payment, entitlement/device, audit, and raw-telemetry
mutation are forbidden. Rescan checkpoints are mode `0600`, atomically replaced
after each committed batch, and bound to version/source/target. Deliberate
from-zero replay also requires `--replay --confirm-replay
REPLAY_SESSION_STARTED_AGGREGATES`. `docs/customer-360.md` owns the remaining
human migration/configuration/rescan/scheduler/deploy/release order, rollback,
failure stops, and real-product smoke checklist. No such external operation was
performed by this documentation change.

### Guarded Customer 360 identity backfill

The identity backfill reads only a reviewed offline JSON file. Dry-run opens no
database and writes no checkpoint; connected status writes nothing and emits an
operation-bound target fingerprint:

```bash
node scripts/backfill-customer-360.mjs --dry-run --namespace test \
  --input /restricted/path/reviewed-input.json
node scripts/backfill-customer-360.mjs --status --namespace test
node scripts/backfill-customer-360.mjs --status --namespace production
```

After separate approval of the input digest, orphan/conflict disposition,
target, migration state, checkpoint path, and rollback plan, use only these
apply shapes:

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

Test accepts only `SIDESTREAM_TEST_POSTGRES_URL`; Production accepts only
`SIDESTREAM_POSTGRES_URL_NON_POOLING`. The mode-`0600` checkpoint is atomically
replaced after committed batches and binds operation, namespace, connected
target, input digest, and processed prefix. Writes are append-only,
batch-atomic, resumable, conflict-preserving, and idempotent; a conflict writes
nothing. Email, names, IP, timing, behavior, search text, and campaign HMACs are
discarded before planning, hashing, reporting, checkpointing, or database
access. These exact forms are capabilities, not evidence that a backfill ran.

### Guarded single paid-telemetry journey repair

`scripts/reconcile-paid-telemetry-handoff.mjs` inspects or repairs only one
canonical acquisition UUID in one trusted namespace. Dry-run is the default,
connects read-only, and rolls back. It accepts only
`SIDESTREAM_TEST_POSTGRES_URL` for Test or
`SIDESTREAM_POSTGRES_URL_NON_POOLING` for Production, rejects pooled URLs,
weak remote TLS, and target/runtime/source collisions, and prints no selected
UUID, provider reference, email, activation/device value, install/receipt hash,
or connection string.

```bash
npm run reconcile:paid-telemetry-handoff -- --dry-run \
  --acquisition <canonical-uuid> --namespace production \
  --target-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING

npm run reconcile:paid-telemetry-handoff -- --apply \
  --acquisition <same-canonical-uuid> --namespace production \
  --target-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
  --confirm-operation RECONCILE_ONE_PAID_TELEMETRY_HANDOFF \
  --confirm-namespace production --confirm-target pg-... \
  --confirm-journey journey-...
```

Apply requires a separately reviewed current dry-run, revalidates all exact
eligibility under one serializable transaction plus namespace/journey advisory
locks, and may repair only missing authentication/current-install stages and
evidence, exact claim/activation linkage, a matching Checkout/claim transition
from `unclaimed` to `claimed`, deterministic merge/audit, immutable binding,
and merge-triggered commerce refresh. An identical confirmed replay is a no-op.

The inspector's first two boundaries recognize the original direct-account
install-profile split and the narrower pending verified-account-review
topology. With multiple paid
attempts, it derives the current path from the active activation and exact
verified receipt rather than newest/oldest row order. The pending bridge is
eligible only when one verified-server `account_identity` review from
`activation_claim` joins the activation profile to the exact authenticated
account owner; Stripe reviews do not select an owner. Checkout and claim state
must match as `unclaimed/unclaimed` or `claimed/claimed`. A second eligible path
or owner, mixed state, or any later stage/merge/binding conflict aborts and
rolls back every write, including claim state. Entitlement is checked but never
rewritten.

Disposable evidence for the second boundary is
`npm run replay:paid-telemetry-handoff -- --expect-pending-review-repaired`.
It covers privacy-bounded dry-run/apply, runtime convergence, claim repair,
stable replay, and common commerce/lookup/funnel ownership. The earlier
read-only Production dry-run against deployed `aa5a604` rejected the live
pending-review shape without mutation; that fail-closed result neither
authorizes apply nor proves the revised code is deployed or the live journey is
now eligible. This command shape is capability, not authorization or evidence
of a Production repair.

The third boundary is disposable-proved with
`npm run replay:paid-telemetry-handoff -- --expect-reviewed-path-repaired`.
It retains a fully valid direct historical path beside the reviewed path, then
uses exactly one verified-server pending `account_identity` review from
`activation_claim` to select the reviewed activation from the canonical
acquisition and trusted namespace. It uses no timestamp/order rule, Stripe
review, email, hash, provider reference, receipt/activation input, or additional
operator selector. With no reviewed path the earlier direct/simple behavior
remains. Duplicate reviewed paths/owners, pre-binding direct+review overlap,
candidate/existing-root mismatch, or any other ambiguity fails before mutation;
the selected row must still pass every existing locked eligibility check.
First apply converges to `already_repaired`, exact-binding replay is a no-op,
and entitlement remains additive/read-only.

The earlier read-only Production dry-run on deployed `a4be35d` rejected this
dual-path shape without mutation. It is not evidence this revision is deployed,
current Production is eligible, apply is approved, or the live journey is
qualified.

The fourth boundary is disposable-proved with
`npm run replay:paid-telemetry-handoff -- --expect-legacy-entitlement-repaired`.
It preserves the selected reviewed path's exact legacy entitlement tuple:
Product and Price are both null and `amount_paid` is exactly zero, while the
verified paid amount is strictly positive. The normal exact Product/Price/amount
snapshot remains accepted. The legacy alternative still requires every
canonical Checkout Session/payment, core Product/Price/currency,
account/entitlement/activation, exact-plan, zero-refund, reviewed
install/receipt, lifecycle, commerce, stage-owner, namespace, and binding
invariant. Partial/mismatched tuples, nonpositive payment, provider mismatch,
refund, and account conflict refuse.

A null claim normalized email is accepted only when claim account, entitlement,
and activation plus account-to-verified-Checkout email ownership are exact; any
non-null claim email must match. Dry-run reports `repair_ready`, apply converges
atomically to `already_repaired`, replay is a no-op, and neither the entitlement
snapshot nor omitted claim email is backfilled. Deployed `812cf96` rejected the
exact shape read-only without mutation. That is historical fail-closed evidence,
not proof of deployment, apply authorization, current Production eligibility,
or live qualification.

The fifth boundary is disposable-proved with
`npm run replay:paid-telemetry-handoff -- --expect-unowned-commerce-repaired`.
Only one verified exact-Checkout payment fact on one canonical key may recover
from null owner and zero gross/net, and only behind matching paid currency,
Checkout/payment-intent evidence, a strictly positive completed paid snapshot,
exact account/entitlement/activation/reviewed install/receipt ownership, zero
entitlement refund, and clear conflict/refund/dispute/inquiry/lifecycle state.
After deterministic merge, the serializable transaction conditionally updates
only that locked fact to the verified paid amount and completion timing,
confirms its survivor owner, preserves provider identifiers/provenance and
legacy placeholders, refreshes existing totals, and requires one positive
attached owner on rediscovery. Every nearby mismatch and refresh failure rolls
back; replay is a no-op. Deployed `6118a87` rejected the pre-state read-only
without mutation. That historical result does not prove deployment, authorize
apply, establish current Production eligibility, or qualify a live journey.

The sixth boundary is disposable-proved with
`npm run replay:paid-telemetry-handoff -- --expect-missing-current-customer-repaired`.
It requires the exact completed active Checkout intent and claimed account on
the selected path to share one bounded current `cus_` value. Zero identity
links, zero exact Customer reviews, and zero commerce aliases for that value are
the only recoverable pre-state; exactly one `stripe_customer` link on the
deterministic live survivor is the only repaired state. A competing value link,
owner, review, alias, invalid/mismatched value, changed locked row, or any prior
path/lifecycle/identity/commerce/binding conflict refuses.

Split profiles merge before the link is inserted. If stages, claims, merge,
binding, and positive commerce already converge, apply uses a customer-link-only
branch and does not write any of them again. It never infers by email, calls
Stripe, creates a commerce alias/provider event, attaches historical installs,
or changes older Customer links. Post-discovery and exact Customer lookup must
resolve the survivor; replay is a no-op. Deployed `19c242d` repaired exact
Checkout Session/PaymentIntent commerce ownership but omitted this exact legacy
Customer lookup. That is not authorization for a Production query, mutation,
provider call, deployment, or push.

The seventh Meta-paid boundary is read-only funnel selection. A single
immutable binding whose full server tuple already passed the binding trigger
must make its exact Checkout/acquisition dimensions outrank historical receipt,
Checkout Session, activation, and broad account edges for the same live
profile. Zero bindings keep the existing deterministic
first-touch/entry/Checkout fallback. More than one exact binding fails the
profile to unknown; newest timestamps, email, Stripe Customer, account-wide
install history, and arbitrary row order are forbidden selectors.

Both focused funnel suites and every paid-telemetry replay must pass. The
first-purchase regression and paid-handoff fixture must each report
Meta/social/`sidestream_direct_offer_test`, `exact_paid_checkout`, `intact`,
`paidCustomer=true`, attributed `1/1`, exact paid `1/1`, and unknown `0/1`,
with older candidates unchanged. Deployed `5a4cf55` returned the same correct
coverage numbers but the wrong ManyChat/`historical_unlinked` dimensions. It is
historical read-only evidence, not proof of this source, a Production query,
deployment, or authorization.

### Production device support and backfill

The device-domain behavior and privacy/support facts live in
`docs/single-device-entitlements.md`. No executable Production device-support or
backfill procedure exists. The current device audit and management tools load
inherited `SIDESTREAM_ENV_FILE`, `SIDESTREAM_DB_ENV_FILE`, and Postgres variables
before their explicit selector and open remote Postgres with certificate
verification disabled. They therefore cannot safely prove a Production target.
Do not run
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

### Acquisition verification, release, and rollback stops

Run local source gates first:

```bash
npm run test:customer-360
npm run test:acquisition-journey-matrix
npm run verify:checkout-contract
npm run test:entitlement
npm run db:migrate -- --validate
node scripts/validate-vercel-contract.mjs
npm run typecheck
npm run build
git diff --check
```

When schema/query/concurrency behavior changes, separately use only an approved
disposable selector:

```bash
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:acquisition-journey-matrix-postgres
```

These checks prove repository and disposable-database behavior only. They do
not prove live Google, Stripe, Neon, Resend, Vercel, browser, or Premiere
behavior. A separately authorized live qualification must observe each relevant
surface, including Google round trip, exact Stripe metadata chain, connected
migration ledger/roles, email delivery when in scope, canonical browser cookie,
claim acknowledgment transitions, protected lookup/funnel pagination, actual
installer bytes, and loaded Premiere behavior.

Production source is only a clean, pushed `origin/main` commit. Before push,
run `npm run verify:production-source`, `npm run test:entitlement`, and
`npm run build`; then push only `main:main` and wait for the Git-linked Vercel
Production deployment. Do not deploy or promote a feature, Orchestra, detached,
or local worktree branch and do not use a direct Vercel CLI Production deploy in
an agent session. A Ready or Preview deployment is not proof. Canonical
`https://sidestream.tv/version.json` must report the pushed SHA, and the live
`/api/checkout/start` path must still prove Upgrade -> Google authentication ->
Stripe before completion is reported.

For the audited one-journey repair, the remaining order is strict: human review
of the integration snapshot; merge onto current `main`; canonical Git-linked
main-only deployment; live `/version.json` verification of the pushed SHA;
read-only one-journey dry-run; separately confirmed apply of only that journey;
then exact Customer 360 lookup and funnel verification of its commerce, stages,
immutable current install/receipt binding, and post-claim usage. Reuse the
existing purchase; do not create a new Checkout or payment for repair proof.
No stage in that ladder was executed by this documentation change.

Stop before migration, deployment, traffic, or the next rollout stage on any:

- target/namespace/TLS/checksum/RLS/grant mismatch or acquisition migration not
  last in the complete applied chain;
- new intent without `acquisition_id`, Session/Invoice/PaymentIntent UUID
  mismatch, fulfillment `ignored checkout_<reason>`, owner/stage conflict, or
  missing required stage;
- new `missing_internal_linkage`/quarantine, unexpected `terminal_unknown` claim
  growth, lookup ambiguity, cursor/filter mismatch, source truncation mistaken
  for completeness, or privacy leakage;
- refund/dispute current-state inconsistency, canonical SHA mismatch, installer
  hash/size drift, or unproved live provider/product behavior.

Rollback is stop-first, main-only, and no-delete. Stop the approved traffic/job
surface; preserve logs, queue rows, stage/conflict evidence, checkpoints, and
connected status; and restore only a schema-compatible last-known-good commit
through `origin/main` plus Git-linked Production. Never run down SQL, rewrite an
immutable first touch, update/delete stage or conflict rows, fabricate
historical acquisitions, manually attach Stripe/Customer 360 owners, or treat a
snapshot restore as feature-only. Removing/rotating access secrets to make new
surfaces fail closed and restoring a database snapshot both require separate
human authorization and impact analysis for concurrent website writes.

## Full-service Production cutover status: blocked

The full Sidestream service cutover remains blocked by the non-Customer-360
release issues below. The guarded migration, identity-backfill, usage-sync, and
historical-rescan command shapes above are executable capabilities only after
the Preview/Test-first evidence and separate human approvals in
`docs/customer-360.md`; they do not authorize traffic, promotion, billing,
entitlement, WAF, scheduler, or release changes. No Production action was
performed by this documentation change.

The existing blockers remain open: unresolved refund/dispute policy and tested
customer recovery, Stripe dead-letter recovery, a total crash/reclaim attempt
cap, safe device support/backfill,
historical lifecycle repair, license-secret continuity, a runtime-distinct
qualified fallback, reviewed WAF maintenance controls, and safe cron control.

The removed recipe also failed independent review because its provider output
did not expose the claimed deployment metadata or actual selectors, its mutable
tooling was not attested, raw env files could execute Node startup options before
validation, its fallback consumed an artifact it never produced, and its file
and signature checks did not establish trustworthy bytes. A future separately
reviewed plan requires all of these capabilities, none of which this runbook
claims currently exists:

- A pinned and integrity-attested launcher that byte-validates every secret
  input before Node, including NUL bytes and unknown, duplicate, empty, or
  malformed entries; starts from an empty environment; and never puts secrets
  in argv. This must cover every database, Stripe, provider, and support input,
  not only one selector file.
- Pinned provider tooling or an owner-authenticated provider API that proves the
  actual runtime selector overrides, including explicit empty values, plus
  metadata, project/team, target, commit/build, aliases, and protection state
  for the exact immutable artifact. Self-authored request metadata is not
  provider attestation.
- Cryptographic signature verification over the same opened bytes under an
  approved trust policy, with TOCTOU-safe file handling. Reopening the same path
  later or checking only that a signature field is present is insufficient.
- A tested idempotent historical lifecycle repair tool. Every future main and fallback
  path must produce and freeze the provisional historical scan after
  pre-drain but before boundary/deny activation, then consume that exact
  manifest, checksum, and watermark in the post-deny full/delta reconciliation
  before migration, promotion, fallback, or reopening. The repository does not
  currently contain this tool.

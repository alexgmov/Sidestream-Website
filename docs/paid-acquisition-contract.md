# Paid acquisition and onboarding contract

> **Contract status:** design and integration boundary only. This document is
> not deployment authorization. It authorizes no Production deployment,
> migration, Stripe configuration change, email send, artifact publication,
> entitlement mutation, backfill, or traffic promotion.

This contract freezes the additive website/FlowState boundary for the
ManyChat mobile paid-acquisition experiment. Normative terms such as **must**,
**must not**, and **only** are release requirements.

## Fixed Meta ad destinations

The parallel Meta creative test does not use the ManyChat 50/50 assignment.
It has two exact, unlinked, noindex paths:

- `GET /meta-default` always redirects to the existing canonical/default site.
- `GET /meta-paid` always enters the paid landing through the same signed,
  server-owned Checkout boundary as the paid ManyChat cohort.

Both paths use server-owned attribution: `source=meta`, `medium=social`,
`campaign=sidestream_direct_offer_test`, and
`experiment=meta-direct-links-v1`. Their exact variant dimensions are
`cohort=freemium, content=default` and `cohort=paid, content=paid`.
Browser query parameters cannot select or relabel the variant. A valid
acquisition cookie already carrying the same Meta variant remains stable;
entering the other exact Meta path creates a new canonical acquisition UUID,
so a later Checkout belongs to the most recent explicit Meta ad click while
the older root remains immutable. `/meta-paid` fails closed if signing is
unavailable and must never silently render the default experience.

The Meta paths are private-by-distribution only. No canonical page, sitemap,
or crawler asset links to them, but possession of either URL is sufficient to
request it. They are not authentication or authorization boundaries.

## Invariants

- `/mc` is the only randomized ManyChat experiment entry path. Only an eligible mobile top-level
  document request whose decoded pathname is exactly `/mc` may be assigned.
- No canonical page or public HTML links to `/mc`. Assignment remains
  default-off when
  `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` is missing or invalid; adding
  server support for paid onboarding does not enable or promote the route.
- `/m` is not edited, wrapped, intercepted, or reimplemented. It keeps its
  current temporary redirect to
  `https://sidestream.tv/?utm_source=manychat`.
- Outside the two exact Meta paths, the canonical root, direct/root visitors,
  desktop behavior, organic/search
  traffic, account routes, API requests, installers, download routes, existing
  Checkout flows, email flows, activation flows, manifests, and every path
  other than `/mc` retain their current behavior.
- An ineligible or uncertain `/mc` request follows the unchanged `/m`
  destination and ManyChat attribution. It does not enter an experiment
  cohort, create experiment records, or receive a cohort cookie.
- Eligible mobile `/mc` traffic uses one sticky first-party 50/50 assignment.
  Half of the assignment bucket space is `mc-control-v1`; half is
  `mc-paid-v1`.
- `mc-control-v1` reproduces `/m`'s current canonical destination and
  attribution. It creates no paid Checkout, onboarding, email, artifact,
  activation, or entitlement state.
- Paid behavior is additive and namespaced. Existing rows, routes, manifests,
  emails, Checkout intents, activation sessions, accounts, and entitlement
  meanings must not be repurposed.
- New experiment domain state must be namespaced and absent unless an eligible
  mobile `/mc` visitor enters `mc-paid-v1`. The minimal signed cohort cookie is
  router state, not paid domain state; its control value exists only to satisfy
  stickiness and cannot reach a paid surface.
- Payment is server truth. A paid landing view, button click, Checkout Session,
  paid-installer email, email-provider acceptance, installer request,
  installer download, installation, or local flag is never proof of payment.
- The paid installer contains no permanent paid state. It is safe to copy and
  cannot grant access without fresh server verification.
- Automatic claim requires the normalized verified Google email to equal the
  normalized verified Checkout email byte for byte.

## Routing and eligibility

### Exact request matrix

| Request | Experiment action | Result |
| --- | --- | --- |
| `GET /mc`, top-level document, eligible phone | Assign or validate sticky cohort | `mc-control-v1` redirects to the `/m` destination; `mc-paid-v1` internally renders the paid landing |
| `GET /mc`, desktop, tablet, bot, prefetch, or unknown/conflicting device evidence | None | Same canonical destination and ManyChat attribution as `/m` |
| `HEAD /mc` | None | Same redirect location as the ineligible/control response, with no cookie, body, event, or state |
| Non-`GET`/`HEAD` `/mc` | None | Existing method behavior; never assign |
| `/mc/`, encoded lookalikes, case variants, or any other path | None | Existing behavior; never normalize into eligibility |
| `/m` and `/m/` | None | Existing behavior, unchanged |
| `/`, account, API, installer, search/organic, and direct artifact requests | None | Existing behavior, unchanged |

The paid landing is an internal static render target for the paid `/mc`
decision, not a public experiment entry URL. Its source artifact may have a
repository filename, but that filename is not a public route contract. A direct
request for the artifact must not create a cohort or paid state. The landing
must be `noindex, nofollow`, declare the canonical root, and make no Checkout
request until an explicit user action.

### Conservative phone rule

Eligibility is evaluated server-side before static routing. It must be a pure,
covered function of method, exact decoded path, navigation headers, and bounded
User-Agent evidence. It must not use screen width, client JavaScript, IP
geolocation, Accept-Language, an account, or a payment identifier.

Evaluate in this order:

1. Require `GET`, exact path `/mc`, `Sec-Fetch-Dest: document`, and no
   `Purpose`, `Sec-Purpose`, or `X-Moz` prefetch/prerender value. A missing or
   conflicting navigation header is unknown.
2. Classify as bot if the User-Agent is empty or contains, case-insensitively,
   `bot`, `crawler`, `spider`, `slurp`, `headless`, `lighthouse`, `preview`,
   `facebookexternalhit`, `facebot`, `whatsapp`, `telegrambot`, `discordbot`,
   `googleinspectiontool`, or `curl`. Bots are ineligible.
3. Classify as tablet if the User-Agent contains `ipad`, `tablet`, `kindle`,
   `silk`, `playbook`, or contains `android` without `mobile`. Tablets are
   ineligible. iPadOS desktop-mode ambiguity is unknown and therefore
   ineligible.
4. Classify as phone only for one of these case-insensitive signatures:
   `iphone`, `ipod`, `windows phone`, or both `android` and `mobile`.
5. If `Sec-CH-UA-Mobile` is present, only `?1` may agree with a phone. `?0`, an
   invalid value, or conflict with the User-Agent makes the request unknown.
   Client hints alone cannot establish eligibility.
6. Every unrecognized, missing, malformed, or conflicting case is unknown.

Desktop, unknown, bot, and tablet all fail safe to the unchanged control path.
They are not included in 50/50 counts.

### Sticky 50/50 assignment

On the first eligible phone request with no valid assignment cookie, the server
generates a cryptographically random 128-bit nonce. It computes
`HMAC-SHA-256(server_secret, "mc-mobile-paid-v1:" + nonce)`, interprets the
first unsigned 64 bits as a big-endian integer, and takes modulo `10000`.

- Buckets `0000` through `4999` are `mc-control-v1`.
- Buckets `5000` through `9999` are `mc-paid-v1`.

This is an exact 50/50 partition of the bucket space. Realized traffic may have
normal sampling variance. Neither refreshes nor changes to campaign parameters
may recalculate a valid assignment.

The assignment is stored only in
`__Host-sidestream-mc-mobile-paid-v1`, a signed opaque cookie with `Secure`,
`HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, and `Max-Age=2592000`
(30 days). Its complete encoded value is at most 192 ASCII characters and
contains only version, nonce, cohort, issued-at time, and signature. It contains
no email, Stripe ID, Google ID, activation key, installer receipt, IP, user
agent, or campaign value. Invalid, expired, or incorrectly signed values are
ignored.

`SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` is the only assignment signing
key. It is server-only, contains at least 32 random bytes, and is different in
Test and Production. Missing, short, or cross-environment configuration makes
all `/mc` traffic ineligible; it must never fall back to an unsigned cookie or a
client-selected cohort.

The routing cookie is the only experiment state allowed for an eligible
`mc-control-v1` visitor; it is required solely to prevent re-bucketing. No
control visitor gets a database domain row, Checkout state, paid token,
artifact receipt, email job, activation association, or entitlement. All paid
domain state described below must be namespaced and absent unless an eligible
mobile `/mc` visitor is assigned `mc-paid-v1`.

### Bounded ManyChat and UTM propagation

The server, not the browser landing, owns normalized attribution. Output
`utm_source` is always the literal `manychat`; an incoming `utm_source` cannot
override it. Only these single-valued query fields may survive:

| Field | Accepted value | Maximum |
| --- | --- | --- |
| `utm_source` | Output fixed to `manychat` | 8 ASCII characters |
| `utm_medium` | Exact lowercase enum `dm` or `social` | 6 ASCII characters |
| `utm_campaign` | `[A-Za-z0-9][A-Za-z0-9._-]*` | 64 ASCII characters |
| `utm_content` | `[A-Za-z0-9][A-Za-z0-9._-]*` | 64 ASCII characters |
| `utm_id` | `[A-Za-z0-9][A-Za-z0-9._-]*` | 64 ASCII characters |

Strict percent decoding happens before validation. Repeated, empty, invalid, or
over-length values are dropped field by field. `utm_term` and all other query
fields are dropped. Email, names, phone numbers, account IDs, Stripe IDs,
activation values, tokens, and arbitrary redirect targets must never propagate.
Surviving fields use the table order above.

With no valid optional UTM values, ineligible and control traffic redirects
exactly to `https://sidestream.tv/?utm_source=manychat`. With valid optional
values, those values are appended to that same canonical root. The paid landing
receives the same normalized attribution only as bounded server context; it
must not read or retain the unvalidated original query.

## Paid flow and payment truth

### State sequence

1. An eligible `mc-paid-v1` request renders the paid landing at `/mc`.
2. An explicit Buy action submits a same-origin request with the signed paid
   entry token. Merely rendering or prefetching cannot create Checkout.
3. The website creates or idempotently resumes one server-owned Stripe Checkout
   Session in `mode=payment`, quantity `1`, for the exact configured Sidestream
   Unlimited Product and Price. The displayed global offer is USD 1999 minor units;
   the server must fail closed if Stripe line-item truth differs.
4. Completion and webhooks re-fetch Stripe objects server-side. Fulfillment
   requires the exact environment, Session, Product, Price, quantity, currency,
   total, PaymentIntent, and `payment_status=paid`. Client query parameters and
   success redirects are not evidence.
5. Only after verified payment does the server accept an idempotent
   paid-installer email job addressed to the verified Checkout email.
6. The verified paid-acquisition browser is sent to the dedicated noindex
   phone-first thank-you page. It tells the buyer to switch to their Premiere
   computer and find the separate Sidestream setup email; it does not offer the
   standard public installer.
7. The recipient obtains generic platform installer links plus a short-lived,
   opaque paid-onboarding receipt. Provider acceptance is delivery-attempt
   evidence only.
8. FlowState starts or resumes activation, then the dedicated paid claim asks
   Google to show its account chooser before OAuth completes. Automatic claim
   occurs only after the verified-email match and current payment/lifecycle
   checks.
9. FlowState polls. Only `active` plus a fresh server-issued credential family
   grants paid behavior. It persists the existing short-lived license
   credentials, never a permanent cohort-paid flag.

Checkout is one-time only. Existing account, anonymous, activation-bearing, and
legacy Checkout flows remain unchanged. The experiment uses namespaced adapter
state that may reference their immutable identifiers; it must not change their
meaning or overwrite their rows.

### Namespaced website endpoints

These are new paid-only surfaces. They do not replace or intercept an existing
API request.

| Route | Exact input | Success | Stable failures |
| --- | --- | --- | --- |
| `POST /api/paid-acquisition/checkout` | JSON at most 4096 bytes: `{"schemaVersion":1,"entryToken":"...","idempotencyKey":"..."}`; token 1-256 base64url/signature characters, key UUID 36 characters | `200 {"url":"<https URL>","reused":boolean}`; URL at most 2048 characters | `400 invalid_request`, `403 ineligible_entry`, `409 checkout_conflict`, `429 rate_limited`, `503 temporarily_unavailable` |
| `GET /api/paid-acquisition/artifact` | Exactly one `receipt` of 43 base64url characters and one `platform` enum | `302` to a signed artifact URL expiring within 5 minutes | `400 invalid_request`, `403 payment_inactive`, `403 refunded`, `403 disputed`, `404 artifact_not_found`, `410 receipt_expired`, `429 rate_limited`, `503 temporarily_unavailable` |
| `GET /api/paid-acquisition/claim` | Opaque receipt in an HTTP-only signed flow cookie; Google OAuth is server-owned | no-store HTML/redirect into Google or a committed claim | claim outcomes in the table below |
| `GET, POST /api/activation/paid-claim` | Existing activation key plus server session; activation row source must be exact `paid-acquisition-mc-v1` | no-store Google redirect, support-only inactive page, or existing CSRF-bound reconnect/confirmed transfer | existing activation claim failures; no Checkout fallback |

The paid landing receives a server-rendered entry token only after a valid
`mc-paid-v1` routing decision. The token expires after 10 minutes, is bound to
contract version, environment, assignment-cookie signature, cohort, exact
entry path, and normalized UTM hash, and is accepted only from the same origin.
It contains no email or provider identifier. A replay with the same
`idempotencyKey` converges on the original Checkout result; a different payload
under that key is `409 checkout_conflict`.

The Checkout request accepts no client email, amount, currency, Product, Price,
quantity, success URL, cancel URL, environment, or cohort field. Those values
are server configuration or verified routing context. All endpoint responses
are `Cache-Control: no-store`; unsupported methods return `405` with an exact
`Allow` header and create no state.

### Dedicated activation-claim split

The dedicated paid claim is a UX branch inside the existing activation engine,
not another purchase or entitlement authority:

```text
activation source
├─ exact paid-acquisition-mc-v1 → /api/activation/paid-claim
│  ├─ active entitlement → existing reconnect or confirmed-transfer decision
│  └─ inactive entitlement → support-only page; no Checkout or purchase action
└─ omitted or any other exact value → /api/activation/claim
   ├─ active entitlement → existing reconnect or confirmed-transfer decision
   └─ Free account → /api/checkout/start → Stripe Checkout
```

The lower ordinary branch is unchanged. After Google authentication, a Free
account still reaches the server-owned `/api/checkout/start` route and is
redirected directly to Stripe using the current Product/Price and locked intent.
It must not receive the paid support-only page. Conversely, the exact paid
branch must never fall through to Checkout when the signed-in account has no
active entitlement.

### Verified email and normalization

The **verified Checkout email** is the email returned by a server-side Stripe
retrieval of a paid Checkout Session's `customer_details.email` after all
payment checks pass. An email supplied by the landing, query string, metadata,
or client request is not verified Checkout email.

The **verified Google email** comes only from a server-validated Google OAuth
identity whose issuer, audience, signature, nonce/state, expiry, and
`email_verified=true` have passed. Raw authorization codes, access tokens, ID
tokens, refresh tokens, and complete Google payloads must not be stored in the
experiment tables, client storage, logs, or telemetry.

Both emails use the same normalization function:

1. require a syntactically valid address with exactly one domain separator;
2. trim leading/trailing ASCII whitespace;
3. normalize Unicode to NFC;
4. convert the domain to lowercase ASCII IDNA form;
5. lowercase the local part without changing any other character; and
6. reject if the result is empty, contains control characters, or exceeds 254
   UTF-8 bytes.

Do not remove Gmail dots, remove `+tag` suffixes, infer aliases, or merge
different provider addresses. Automatic claim requires exact UTF-8 byte
equality after this normalization. Only the server performs and compares it.

On mismatch, show a privacy-safe explanation naming neither stored address in
telemetry or API errors. The user may retry Google with the Checkout address or
enter support recovery. Mismatch never transfers the purchase, creates a
second entitlement, or silently changes either account email.

### Paid-installer email

Email fulfillment is an outbox operation keyed by
`(environment, verified_checkout_session_id, "paid-installer-v1")`.
Concurrent completion callbacks, webhooks, browser retries, and worker retries
must converge on one logical job. Provider-message IDs may be stored server-side
but never sent to FlowState or analytics.

The outbox state enum is `pending`, `sending`, `accepted`, `retryable`, or
`dead_letter`; each value is at most 11 ASCII characters. A lease has a maximum
of 5 minutes. A retry uses the same idempotency key. `accepted` is terminal for
automatic sends and means only that the provider accepted the message.
`dead_letter` requires reviewed recovery; it is not payment failure.

The message goes only to the verified Checkout email. It contains no raw Stripe
identifier, Google identifier, activation key, license token, refresh token, or
claim of already-active access. It explains that sign-in must use the same
email and that payment may later be refunded or disputed.

### Paid-onboarding artifact

Paid artifact selection is an additive, server-only manifest namespace. Allowed
platform values are `macos-universal` and `windows-x64`, with maximum lengths
of 15 and 11 ASCII characters respectively. Missing or unrecognized platform
returns `404 artifact_not_found`; it never falls back to the wrong platform.

A selected manifest has exactly these public fields:

| Field | Type and bound |
| --- | --- |
| `schemaVersion` | integer literal `1` |
| `platform` | enum `macos-universal`, `windows-x64` |
| `version` | 1-32 ASCII characters, `[0-9A-Za-z._-]+` |
| `filename` | 1-120 safe ASCII characters, no slash or backslash |
| `sizeBytes` | integer `1..1073741824` |
| `sha256` | 64 lowercase hexadecimal characters |

Private Blob paths, storage tokens, receipt tokens, cohort cookies, customer
email, and payment identifiers are not manifest fields. The download route
verifies current receipt and payment lifecycle, then redirects to a short-lived
signed artifact URL. That verified redirect records one canonical
`installer_requested` stage at the installer-request grain plus
`installer_redirect` evidence, after the response so attribution failure cannot
delay delivery. The Blob signer is an internal helper; there is no standalone
anonymous `/api/paid-download` HTTP route. The paid manifest must select a
FlowState `paid-onboarding` artifact. It must not select the normal public
installer because standard builds do not load the blocking authentication
experience. The paid route and manifest are still not entitlement authority;
Google authentication and server-side license state remain authoritative after
installation.

The opaque onboarding receipt is 32 random bytes encoded as 43 base64url
characters, expires after 7 days, and is stored only as SHA-256. It is
single-purpose and may be redeemed idempotently for the same environment and
purchase. A copied, expired, used, or offline receipt cannot prove payment.

## FlowState ownership boundary

The website owns routing, eligibility, cohort integrity, Stripe truth, verified
emails, Google OAuth, email outbox, receipt validation, artifact selection,
claim decisions, entitlement issuance, lifecycle changes, and environment
selection. FlowState owns its device identifier, installer-receipt hashing,
activation UI, bounded polling, secure credential storage, and enforcement of
server responses.

FlowState must not classify `/mc` eligibility, choose or override a cohort,
create Stripe Checkout, compare emails, infer payment from an installer, mint
entitlements, select Test versus Production, or log a customer email.

### Additive activation input

The paid FlowState build uses the existing activation routes. It sends the
existing fields with these exact bounds:

| Route and field | Contract |
| --- | --- |
| `POST /api/activation/start` `deviceId` | required opaque string, 1-240 characters |
| `appVersion` | optional, 1-80 characters |
| `buildChannel` | optional, 1-80 characters |
| `source` | exact `paid-acquisition-mc-v1` |
| `installerReceiptIdHash` | optional lowercase SHA-256, exactly 64 hex characters |
| `POST /api/activation/status` `activationKey` | required opaque string, 1-160 characters |
| `deviceId` | same stable value, 1-240 characters |
| `platform` | enum `macos`, `windows`, `unknown`; maximum 7 characters |
| `installerReceiptIdHash` | same optional 64-character lowercase SHA-256 |

`installerReceiptIdHash` is association/recovery context only. It is not an
authorization credential or payment proof. Existing `installIdHash` and
`supportCode` fields retain their documented meanings. Existing clients omit
the paid source/receipt and observe no behavior change.

Only a raw `source` value exactly equal to `paid-acquisition-mc-v1` selects the
dedicated `/api/activation/paid-claim` `restoreUrl`; whitespace, case variants,
and every other value retain the ordinary `/api/activation/claim` URL. The
dedicated route rechecks the stored source on GET and POST. Source selects UX
only: it cannot activate a license, prove payment, bypass account ownership, or
weaken the existing two-active-device policy.

The paid artifact redirect also sets a signed HTTP-only browser receipt. That
per-Checkout receipt and FlowState's locally verified installer receipt are
different identifiers and must never be compared or substituted. The dedicated
claim GET remains read-only. Only after the authenticated, same-origin,
CSRF-protected reconnect or confirmed-transfer POST succeeds may the server use
the browser receipt to bind the paid Checkout to the exact paid-source activation.
Canonical `installation_claimed` and `verified_installation_claim` evidence are
then written only when Customer 360 resolves exactly one install identity and one
local installer-receipt identity on that activation. Missing, expired, ambiguous,
or conflicting attribution evidence fails linkage closed without reversing an
otherwise valid entitlement recovery.

After the existing safe Google OAuth flow, an active Unlimited account with no active
device or the same device receives the existing one-time same-origin,
CSRF-bound reconnect POST. A different device fills the second available slot;
when both slots are occupied, it receives the existing explicit
deactivation/transfer confirmation. A
signed-in account without an active entitlement receives a noindex page titled
“We’re not seeing your purchase.” with its signed-in email, the existing
Sidestream support destination, and the exact instruction “If you already
upgraded, contact Sidestream support.” It contains no Checkout, Upgrade, or
purchase action. GET is read-only in every state.

The start response remains the existing shape:

| Field | Contract |
| --- | --- |
| `activationKey` | opaque secret, 1-160 characters; never log or place in telemetry |
| `expiresAt` | UTC RFC 3339 timestamp; existing activation lifetime is 24 hours |
| `upgradeUrl` | absolute HTTPS URL, maximum 2048 characters |
| `restoreUrl` | absolute HTTPS URL, maximum 2048 characters |

FlowState polls no faster than every 5 seconds, applies exponential backoff to
at most 60 seconds after transient failure, stops at `expiresAt`, and resumes
after restart using the same activation key and device ID. Refresh, focus,
visibility, and network recovery may trigger an immediate poll but must not
create a new activation while the current one is valid.

### Poll and claim outcomes

Paid-specific UI labels use kebab case (`payment-pending`, `email-mismatch`,
`already-claimed`, `expired-activation`, `refunded`, `disputed`,
`transient-failure`). JSON codes use snake case as listed below.

| Outcome | HTTP / JSON contract | FlowState and browser recovery |
| --- | --- | --- |
| Waiting for Google | poll `200 {"status":"pending"}` | Continue polling; offer the server `restoreUrl` |
| payment-pending | poll `200 {"status":"pending_payment"}` or claim `409 payment_pending` | Keep activation and poll; do not email, install paid state, or grant access |
| email-mismatch | poll `200 {"status":"email_mismatch"}` or claim `409 email_mismatch` | Retry Google with the verified Checkout email or start support recovery; never reveal the other address |
| expired-activation | poll `200 {"status":"expired"}` or claim `410 activation_expired` | Stop polling; after fresh payment verification, create a new activation without another purchase |
| already-claimed | poll `200 {"status":"already_claimed"}` or claim `409 already_claimed` | Same account/device retry returns the existing active result; otherwise use existing Restore Purchase/device-transfer decisions |
| refunded | poll/claim `403 refunded` | Clear paid credentials after server verification; show purchase-support recovery |
| disputed | poll/claim `403 disputed` | Suspend paid use, retain non-secret recovery context, and recheck server state |
| transient-failure | `503 temporarily_unavailable`, optional integer `Retry-After: 1..300` | Retain activation and credentials, back off, and retry; never downgrade permanently from a transport failure |
| active | poll `200 {"status":"active", ...credentialFamily}` | Store the existing short-lived device-bound credentials securely and stop onboarding polling |
| completed | poll `200 {"status":"completed"}` | Credentials were already issued; verify/refresh existing credentials or use recovery, never create another entitlement |
| invalid input | `400 invalid_request` or `400 invalid_customer_identity` | Correct local input; do not retry unchanged |
| wrong environment | `503 license_environment_unavailable` | Stop cross-environment work; never fall back to another host/database |

Every error body is bounded to `code` (1-64 lowercase ASCII
`[a-z0-9_]+`) and a generic `error` message of at most 160 UTF-8 characters.
It contains no email, payment identifier, provider payload, token, database
detail, or stack trace.

## Claim, lifecycle, and recovery rules

### Idempotent claim and entitlement issuance

The atomic claim key is `(environment, canonical_payment_id)`. There may be at
most one experiment claim row and one canonical entitlement effect for that
key. The server locks the payment/claim record, re-verifies payment and both
emails, and then calls the existing entitlement primitive. A lost response or
duplicate callback returns the previously committed result.

The experiment may reference the existing account, license, activation, and
canonical payment IDs in namespaced join rows. It must not rewrite historical
rows, change plan keys, create a second license for one payment, bypass
device-seat decisions, or mark an activation complete before credentials are
successfully issued.

Same verified email plus same account/device is an idempotent success. Same
payment with another activation is `already_claimed` and enters the existing
Restore Purchase or confirmed device-transfer path. A different verified
Google email is `email_mismatch`; support review is required to change durable
ownership.

### Refund and dispute truth

Stripe lifecycle is processed server-side through signed webhooks and
server-retrieved canonical objects with an event-created-at plus event-ID
watermark. Stale events cannot resurrect a newer terminal state.

- A partial refund keeps entitlement `active` with reason `partial_refund`.
- A successful full refund sets entitlement `revoked` with reason
  `full_refund`; `refunded` is returned thereafter.
- A failed or pending refund does not pretend money was returned. It remains a
  retryable lifecycle case and must be reconciled from Stripe before changing
  access.
- An open dispute sets entitlement `suspended`; `disputed` is returned.
- A won/withdrawn dispute may return to `active` only if no full refund,
  irreversible loss, or newer suspension/revocation exists.
- A lost dispute sets irreversible `revoked` with reason `dispute_lost`.
- Unknown current Stripe refund/dispute statuses fail conservatively to
  `suspended` plus operator alerting; they are not mapped optimistically.

Downloaded installers remain usable as free installers after revocation but
cannot authorize Unlimited. FlowState observes revocation through existing
verify/refresh behavior, clears unusable paid credentials, preserves ordinary
free behavior, and offers support. Refund or dispute handling must not delete
the account, purchase ledger, audit evidence, or unrelated entitlements.

### Recovery outcomes

- **Mismatch recovery:** retry Google; if exact match is impossible, open
  support review. Never auto-merge addresses.
- **Payment-pending recovery:** retain the activation until expiry and reconcile
  Stripe with bounded backoff. Do not create a second Checkout Session unless
  the original is terminal/expired and the server proves no payment.
- **Expired activation recovery:** re-verify the canonical payment and issue a
  fresh activation/receipt. No repurchase is required.
- **Already-claimed recovery:** return the existing active result for the same
  account/device; otherwise use the existing restore/confirmed-transfer
  decision. Never duplicate the entitlement.
- **Refunded recovery:** access remains revoked unless canonical Stripe truth
  changes through a separately supported lifecycle transition.
- **Disputed recovery:** access remains suspended while open; a later canonical
  won/withdrawn transition may restore it under the rules above.
- **Transient recovery:** keep non-expired activation and valid credentials,
  retry with backoff, and surface a retry action. A `5xx`, timeout, email delay,
  or provider outage is never a permanent denial or success.
- **Dead-letter recovery:** preserve the event/job and idempotency key, alert an
  operator, and use a reviewed replay path. Never edit claim, payment, or
  entitlement rows by hand.

## Namespaced server records

Implementations may choose SQL details, but the logical paid record must expose
only these contract fields. Column and API aliases must not broaden the data.

| Field | Type, enum, or maximum |
| --- | --- |
| `contract_version` | integer literal `1` |
| `environment` | enum `test`, `production` |
| `experiment_id` | literal `mc-mobile-paid-v1` |
| `cohort` | literal `mc-paid-v1` for persisted paid records |
| `assignment_id_hash` | 64 lowercase hex; HMAC-derived, never raw nonce |
| `entry_token_hash` | 64 lowercase hex; null after expiry is allowed |
| `utm_medium` | nullable enum `dm`, `social` |
| `utm_campaign` | nullable, maximum 64 safe ASCII characters |
| `utm_content` | nullable, maximum 64 safe ASCII characters |
| `utm_id` | nullable, maximum 64 safe ASCII characters |
| `checkout_intent_ref` | server-only UUID, 36 characters |
| `canonical_payment_ref` | server-only provider ID, maximum 255 ASCII characters; never client-visible |
| `checkout_email_normalized` | encrypted/server-private, maximum 254 UTF-8 bytes; never telemetry |
| `installer_receipt_hash` | 64 lowercase hex |
| `email_job_state` | enum `pending`, `sending`, `accepted`, `retryable`, `dead_letter` |
| `claim_state` | enum `unclaimed`, `payment_pending`, `email_mismatch`, `claimed`, `expired`, `refunded`, `disputed` |
| `account_ref` | nullable server-only UUID, 36 characters |
| `activation_ref` | nullable server-only UUID, 36 characters |
| `entitlement_ref` | nullable server-only UUID, 36 characters |
| `created_at`, `updated_at`, `expires_at` | UTC timestamps with database precision |

Tables, indexes, cookies, outbox keys, Blob prefixes, telemetry names, and
configuration keys introduced for this flow must start with
`sidestream_paid_acquisition_`, `paid-acquisition-`, or the exact cookie prefix
defined above. No existing database column may be overloaded as cohort,
campaign, receipt, claim, or email-job state.

## Privacy-safe experiment events

Experiment events measure stage transitions, not durable identity. Allowed
event names are:

`mc_entry_eligible`, `mc_landing_viewed`, `mc_checkout_started`,
`mc_checkout_paid`, `mc_installer_email_accepted`,
`mc_installer_downloaded`, `mc_activation_started`,
`mc_activation_claimed`, `mc_entitlement_issued`,
`mc_refund_recorded`, and `mc_dispute_recorded`.

Each event contains only:

| Field | Type and maximum |
| --- | --- |
| `schema_version` | integer literal `1` |
| `event_id` | server-generated UUID, 36 characters |
| `occurred_at` | UTC RFC 3339 timestamp |
| `environment` | enum `test`, `production` |
| `experiment_id` | literal `mc-mobile-paid-v1` |
| `cohort` | enum `mc-control-v1`, `mc-paid-v1` |
| `event_name` | enum above, maximum 28 ASCII characters |
| `outcome` | enum `success`, `pending`, `rejected`, `retryable`, `revoked`; maximum 9 characters |
| `anonymous_day_hash` | 64 lowercase hex from a daily rotating server HMAC |
| `utm_medium` | nullable enum `dm`, `social` |
| `utm_campaign`, `utm_content`, `utm_id` | nullable validated values, each maximum 64 ASCII characters |
| `platform` | nullable enum `macos`, `windows`, `unknown` |

Control events are limited to `mc_entry_eligible` and may be aggregated without
creating a paid domain record. Do not emit a paid stage from a button click
alone when its named server transition has not occurred.

Events and client logs must exclude customer email, names, phone numbers, IP
addresses, raw User-Agent, cookies, assignment nonce, Stripe IDs or payloads,
raw payment data, Product/Price metadata, Google subject or tokens, provider
message IDs, installer receipt/token, activation key, access/refresh token,
device ID/hash, account/license/entitlement IDs, database errors, and free-form
query values. Server operational logs use bounded pseudonymous references and
redacted error classes only.

## Test and Production separation

`environment` is selected only from trusted deployment, exact host, Stripe
mode/account, and database configuration. No cookie, request header, query
parameter, landing JavaScript, FlowState `buildChannel`, or payload may select
it.

| Boundary | Test | Production |
| --- | --- | --- |
| Host | exact allowlisted Preview/Test host | exact canonical Production host |
| Stripe | Stripe test mode and Test Product/Price | live mode and separately verified live Product/Price |
| Database | dedicated disposable or approved Test database | Production database |
| Email | sink/allowlisted recipient; visibly Test-labelled | real verified Checkout email only after release authorization |
| Artifact | Test namespace and non-Production receipt | Production namespace and Production receipt |
| Entitlement | `test` license namespace | `production` license namespace |
| Events | `environment=test` | `environment=production` |

Any conflict, missing binding, shared database target, cross-mode Stripe object,
cross-environment receipt, host mismatch, or ambiguous deployment state fails
closed with `503 environment_unavailable`. Test proof must assert that no
Production Stripe object, database row, email recipient, artifact receipt,
entitlement, or telemetry event changed.

## Additive implementation and release gates

Implementation must:

- add the sole routing decision at exact `/mc`;
- leave `/m` and its configuration/tests byte-for-byte behaviorally unchanged;
- preserve canonical `/`, mobile free handoff, desktop downloads, account,
  organic/search, existing Checkout, installer, email, activation, download,
  manifest, and entitlement behavior;
- isolate new modules, data, configuration, events, email template/outbox,
  artifact manifests, and tests under the paid-acquisition namespace;
- require disposable Test fixtures for assignment boundaries, refresh
  stickiness, ineligible fallbacks, Checkout idempotency, email idempotency,
  exact email match/mismatch, polling, expiration, already-claimed behavior,
  refunds, disputes, transient failures, and cross-environment rejection; and
- prove the actual Test surface, including both cohorts and FlowState polling,
  without treating a build, redirect config, email-provider acceptance,
  installer download, or health response as end-to-end success.

Before any separately authorized Production release, an independent review must
confirm the current Stripe refund/dispute status mapping, lifecycle replay and
dead-letter recovery, environment binding, artifact integrity, email
deliverability, database migrations, telemetry exclusions, and exact
Production alias. This contract itself grants no such authorization.

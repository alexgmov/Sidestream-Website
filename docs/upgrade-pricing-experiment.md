# Authenticated Upgrade pricing experiments

This document is the durable contract for the ended `upgrade-pricing-v1` test
and the active Production `upgrade-pricing-v2` annual test. It separates source behavior,
Stripe Test qualification, Production rollout, provider delivery, and observed
reporting so that a fixture, Preview, accepted email request, or open Checkout
page is never reported as a completed purchase or live result.

## v2 annual experiment

`upgrade-pricing-v2` is a new account-level experiment. It does not rename,
reuse, or reinterpret the v1 monthly cohort.

| ID | Billing | Initial charge | Customer-facing contract |
| --- | --- | ---: | --- |
| `control_one_time` | Stripe `mode=payment` | `$19.99` once | Existing global one-time Unlimited offer |
| `annual_same_price` | Stripe `mode=subscription` | `$19.99` per year | Renews yearly until canceled; email reminder before renewal; cancel in Account; access continues through the paid year |

The hypothesis is that annual billing at the same initial price may improve
long-run realized revenue without reducing activated paid accounts. The primary
early comparison is entitlement activations per exposed account and realized
net revenue per exposed account. Annual renewal value is not observed until a
second annual Invoice settles; it must not be projected as realized revenue or
described as improved LTV before that anniversary.

The v2 contract is deliberately narrow:

- only the canonical global USD `$19.99` offer is eligible;
- regional offers remain on their existing one-time Checkout outside v2;
- any account with a permanent v1 assignment remains in v1 and is excluded;
- new v2 assignments use assignment/snapshot version `2` and the stable
  `annual_same_price` variant;
- the annual Price must be active, on the existing Unlimited Product, exactly
  USD `1999`, `interval=year`, `interval_count=1`, and `usage_type=licensed`;
- missing configuration, invalid provider truth, unsupported currency, or
  assignment failure falls back to one-time without entering v2 exposure or
  analysis denominators.

Source defaults are `enabled=false` and rollout `0`. V2 uses the separate
`SIDESTREAM_UPGRADE_PRICING_V2_ENABLED`,
`SIDESTREAM_UPGRADE_PRICING_V2_ROLLOUT_BPS`, and
`SIDESTREAM_UPGRADE_PRICING_V2_SECRET` settings so stale v1 environment values
cannot start the new test. A missing v2 rollout also stays at `0`. After
qualification, increase from `0` to a small canary and inspect integrity before
using `5000` for a 50/50 assignment of future eligible accounts. Existing
assignments never change when rollout values change.

Production completed those gates on 2026-08-27 and now runs rollout `5000` for
future eligible accounts. Qualification included exact Test and live annual
Prices, a paid initial Test Invoice and paid yearly renewal under Stripe Test
Clocks, cancel-at-period-end behavior, failed renewal and successful recovery,
Billing Portal session creation, an owned-mailbox reminder with provider status
`delivered`, and a signed-in live Checkout canary that was canceled without
payment. The first protected Production report contained one annual assignment
and exposure with zero integrity defects. Source defaults and any environment
missing the explicit Production settings remain disabled at rollout `0`.

The annual Checkout disclosure is part of the locked offer contract:

> $19.99 per year. Renews automatically each year until canceled. We'll email
> you 30 days before renewal, before you're billed again. Cancel anytime from
> your Sidestream account;
> access continues through your paid year.

Do not shorten this to a bare price or hide renewal/cancellation terms below the
primary action. The annual branch must show the billing cadence, automatic
renewal, advance email, cancellation path, and paid-through access together.

### Annual renewal reminder

`20260825140000_add_annual_upgrade_pricing_experiment.sql` extends the immutable
experiment constraints and creates the private
`sidestream_annual_renewal_reminders` ledger. The protected six-hour GET job
stays inert unless the literal
`SIDESTREAM_ANNUAL_RENEWAL_REMINDERS_ENABLED=true` is set after migration and
provider qualification. It stages only v2 annual subscriptions that are
`active` or `trialing`, are not scheduled to cancel, and renew 7-30 days ahead.
The wider window lets an outage
recover while normal operation sends near the promised 30-day point.

Each `(Stripe Subscription, renewal time)` has one durable identity. The worker
uses short leases, bounded batches, retry scheduling, a maximum-attempt dead
letter, and the same stable Resend idempotency key on every retry. If the
subscription is canceled, rescheduled, no longer annual, or no longer active,
the unsent row is canceled instead of emailed. Provider acceptance is recorded
as `accepted`; actual mailbox delivery remains a separate rollout gate.

The reminder names the `$19.99` amount and renewal date and states that
canceling before that date prevents another charge while preserving access
through the already-paid year. It links to the authenticated Sidestream Account
page and contains no provider or database identifiers.

### v2 analysis contract

The protected report defaults to `upgrade-pricing-v2`; request v1 explicitly
for the ended monthly history:

```sh
npm run report:upgrade-pricing -- \
  --operator alex.ops \
  --namespace test \
  --experiment upgrade-pricing-v2 \
  --from 2026-08-25T00:00:00Z \
  --through 2026-09-25T00:00:00Z \
  --as-of 2026-09-25T00:00:00Z
```

Compare the exact assignment and exposure denominators first, then:

- entitlement activation rate and 24-hour/seven-day mature non-conversion;
- realized gross, refunds/credits, net, and net revenue per exposed account;
- active annual subscriptions, cancel-at-period-end, failed Invoices, recovery,
  disputes, and refunds;
- second successful annual Invoices only after the renewal anniversary;
- reminder `accepted` evidence separately from confirmed provider delivery.

V2 reporting admits only intents with a durable v2 assignment. Disabled,
unsupported-currency, and provider/configuration fallbacks remain observable in
their intent snapshots but cannot enter the v2 exposure, conversion, or revenue
denominators. Historical v1 reporting remains unchanged.

MRR for the annual variant is the exact annual amount divided by 12 and remains
a normalized metric, not cash collected that month. Relative lift must always
include both numerator and denominator; low-volume differences are descriptive,
not statistically conclusive.

### v2 activation gates

Keep v2 disabled until all of these are current evidence:

1. The complete migration chain is applied and checksummed on the attested
   Production database after disposable-Postgres validation.
2. Exact Test and live annual Prices exist and pass Product, amount, currency,
   interval, active-state, and namespace checks.
3. Required Checkout, subscription, Invoice, refund, and dispute webhook events
   reach the deployed handler with healthy queue/retry/dead-letter state.
4. Stripe Test proves annual Checkout copy, payment, entitlement, activation,
   cancellation, renewal, failure/recovery, and Portal behavior.
5. A real reminder reaches an owned test mailbox with the promised content;
   Resend API acceptance alone is insufficient.
6. Rollout `0` proves the one-time control, then a small canary proves assignment
   balance, report integrity, and no unexpected 5xx before `5000`.
7. The clean pushed `main` SHA is the canonical Production `version.json` SHA.

## Historical v1 monthly experiment

The v1 50/50 experiment ended on 2026-08-21 with one-time retained as the
default offer. Existing assignments, open Checkout Sessions, subscriptions,
entitlements, acquisition roots, and financial history remain supported and
unchanged. The remainder of this document preserves the v1 contract.

## Hypothesis and invariants

The hypothesis is that a lower monthly entry price increases activated paid
accounts and realized revenue per exposed Free account relative to the current
one-time offer. The experiment changes billing shape only. Both variants grant
the same `sidestream_pro` plan with `unlimited_downloads`.

The installed control remains unchanged:

`Upgrade -> GET /api/checkout/start -> Google authentication -> Stripe Checkout -> entitlement -> panel refresh/reverification`

These invariants are not experimental:

- `GET /api/checkout/start` owns authentication, trusted-country selection,
  intent creation/reuse, and the Stripe redirect. A browser cannot select the
  variant, billing model, country, amount, currency, Product, Price, or
  experiment metadata.
- An active paid owner routes to Account or Restore and cannot open a new paid
  Checkout. The same account advisory lock serializes Checkout eligibility
  with one-time, experiment-subscription, and allowlisted legacy entitlement
  grants.
- Existing one-time buyers, historical intents, open Sessions, acquisition
  roots, activation binding, device rows, mobile handoffs, and paid-acquisition
  Checkout retain their existing contracts.
- Existing Premiere clients, including exact v1.0.11, continue through the
  legacy host and the same server-owned API. No experiment client parameter or
  plugin release exists.
- Stripe and database namespaces must agree. Provider IDs, customer identities,
  activation keys, cookies, IP addresses, emails, payment secrets, and device
  identifiers never appear in assignment or exposure rows or report output.

## Eligibility, assignment, and exposure

Only an authenticated Free account without an active canonical paid entitlement
is eligible. Assignment occurs while the authenticated Checkout intent is
created, after Google authentication has completed. Assignment is persisted at
the account grain and is permanent across retries, devices, countries, client
versions, browser sessions, rollout changes, and kill-switch changes.

The variants are:

| ID | Billing | Offer |
| --- | --- | --- |
| `control_one_time` | Stripe `mode=payment` | The current trusted-country one-time offer, unchanged |
| `monthly_half` | Stripe `mode=subscription` | The exact recurring amount stored beside that trusted-country offer in the canonical pricing contract |

`SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_SECRET` is a server-only secret of at
least 32 bytes. HMAC-SHA-256 over the experiment ID and canonical account UUID
selects one of 10,000 buckets. The database uniqueness constraint resolves
concurrent assignment attempts and the immutable trigger prevents reassignment
or deletion. The configured rollout basis points are the share assigned to
`monthly_half`; the remainder is assigned to `control_one_time`.

Configuration failures, missing or invalid Price truth, unsupported currencies,
and assignment failures fall back to the current one-time Checkout with a
bounded decision reason. They do not create a monthly exposure. A disabled kill
switch also uses the one-time path without creating a new assignment. Existing
assignments remain readable and are never rewritten.

Exposure is append-only and is recorded once per immutable intent only after a
Stripe Checkout Session is successfully created or safely reused. An Upgrade
click, a started Google login, or an unconfirmed intent is not an exposure.

## Monthly price contract and Stripe contract

The input is the exact current server-owned offer selected for the new intent.
Its one-time and recurring amounts must match the same canonical catalog entry;
the runtime does not infer a recurring price from one-time arithmetic. The
database and Stripe identifier `monthly_half` remains a stable legacy variant
name and must not be renamed when the approved recurring amount changes.

| Currency | Current one-time offer | Current recurring offer | Lookup key |
| --- | ---: | ---: | --- |
| USD | `$19.99` (`1999`) | `$4.99` (`499`) | `sidestream_pro_monthly_usd_499` |
| INR | `₹499` (`49900`) | `₹299` (`29900`) | `sidestream_pro_monthly_inr_29900` |
| BRL | `R$25` (`2500`) | `R$12.99` (`1299`) | `sidestream_pro_monthly_brl_1299` |
| KRW | `₩24,900` (`24900`) | `₩12,900` (`12900`) | `sidestream_pro_monthly_krw_12900` |

Unsupported currencies or a one-time amount that no longer matches the catalog
fall back to control. A price change requires an explicit recurring amount and
a new immutable amount-specific Stripe lookup key for future intents. Existing
open intents retain their stored Product, Price, currency, amount, and billing
mode; existing paid subscriptions retain their original recurring Price.

All monthly Prices use the existing Sidestream Unlimited Product, quantity one,
`interval=month`, `interval_count=1`, and `usage_type=licensed`. Price
validation requires the exact currency-specific lookup key, active state,
Product, currency, amount, recurring terms, and Stripe live/test namespace.
Only global USD may use guarded exact-key discovery/creation. Regional monthly
Price IDs are explicit server environment configuration and fail closed.

Recurring Checkout enables Stripe's customer-entered promotion-code field.
Coupon duration remains provider-owned: `once` discounts the first Invoice,
`repeating` discounts its configured number of months, and `forever` discounts
every renewal. Activation retry reuses an open Session only when Stripe confirms
that it has the promotion-code capability; older open Sessions are expired and
replaced through the existing attempt-bound idempotency contract. Control keeps
its existing promotion, invoice, PaymentIntent, customer-creation, and customer
copy parameters unchanged.

## Immutable intent and provider verification

`20260812120000_add_upgrade_pricing_experiment.sql` adds:

- `sidestream_upgrade_pricing_assignments`, one immutable row per experiment
  and authenticated account;
- complete nullable experiment snapshot columns on
  `sidestream_checkout_intents`, preserving all historical rows;
- `sidestream_upgrade_pricing_exposures`, append-only Session-open evidence;
- foreign keys, complete-or-null checks, reporting indexes, immutability and
  exact-exposure triggers, RLS, and public-role revocation.

An experiment intent snapshots experiment, decision, assignment, bucket,
rollout, assigned time, variant, billing model, country, currency, amount,
Product, Price, account, acquisition, intent, and optional activation session.
The database prevents later edits.

Subscription fulfillment is first-class and separate from the historical
legacy subscription allowlist. It verifies the exact completed Session,
subscription, initial or event Invoice, Customer ownership, Product, Price,
quantity, currency, list amount, Checkout discount, Invoice line and aggregate
discounts, actual settlement amount, monthly interval, live/test namespace,
immutable metadata, assignment, account, acquisition, intent, and activation
attachment before writing entitlement. A zero-total first Invoice grants access
only when Stripe reports paid Invoice truth and its current Invoice Payments
ledger is exactly empty; partial, once-only, repeating, and forever discounts
remain independently reconciled on every later Invoice. The browser or today's
catalog is never provider truth for an old intent. All provider metadata keys
use the stable `sidestream_upgrade_*` namespace and are at most Stripe's
40-character key limit; the longer database column names remain internal schema
truth.

## Lifecycle and conservative access policy

Required Stripe webhook event types are:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- the existing one-time refund, charge-refund, and dispute events

Event IDs are idempotent and lifecycle writes use a provider-created-time plus
event-ID watermark so duplicates and older reordered events cannot overwrite
newer state. The existing queue retry and dead-letter controls remain in force.

The conservative policy is:

- `active`, or `trialing` with an exact paid latest Invoice, grants active
  access;
- `cancel_at_period_end` remains active only through the paid period end;
- `past_due`, `incomplete`, and a failed Invoice suspend immediately and revoke
  issued credentials; there is no unpaid grace period;
- a later exact paid Invoice restores active access;
- `unpaid`, `incomplete_expired`, `canceled`, `paused`, or subscription deletion
  revokes access and credentials;
- successful second and third Invoices remain distinct retention facts;
- Portal management remains available on subscription rows;
- rollback or kill-switch changes never delete financial/acquisition history,
  revoke a valid paid entitlement, or strand an existing subscriber.

One-time `refund.failed` and terminal dispute blockers remain unchanged. This
experiment does not claim to resolve or weaken those separate lifecycle rules.

## Observed report and metric definitions

`POST /api/internal/upgrade-pricing-report` is a POST-only, no-CORS, no-store
admin route protected by the shared `SIDESTREAM_CRM_ADMIN_SECRET` guard. The
read-only transaction is repeatable-read, namespace-bound, time-bounded, and
paginated with a secret-bound cursor. The CLI accepts only a privacy-safe
operator ID and a local `127.0.0.1` API:

```sh
npm run report:upgrade-pricing -- \
  --operator alex.ops \
  --namespace test \
  --experiment upgrade-pricing-v1 \
  --from 2026-08-01T00:00:00Z \
  --through 2026-08-13T00:00:00Z \
  --as-of 2026-08-13T00:00:00Z
```

The FlowState analytics dashboard proxies this protected report from its local
loopback server. The browser never receives the admin secret. Start it with the
Website report origin and secret configured in the server process, then verify
the dashboard listener, `/api/health`, `/api/overview/timeseries`, the protected
upgrade-pricing proxy, and the rendered Upgrade Experiment view separately.

Counts are unique accounts unless stated otherwise:

- eligible assigned: persisted authenticated assignments;
- exposed: append-only exact opened-Session evidence;
- sessions started/reused: unique persisted Checkout Sessions; repeated browser
  reuse calls are not durably counted;
- completed one-time purchase: exact one-time license and positive settled
  amount;
- first subscription payment: first exact paid Invoice;
- entitlement activation: exact experiment entitlement/license grant, including
  an entitlement later canceled or refunded;
- activation rate: entitlement-activated unique accounts divided by exposed
  unique accounts in the same variant and segment;
- pending: exposed accounts without a completed one-time payment or first paid
  subscription Invoice;
- mature non-converters: pending exposure at least 24 hours or seven days old;
- active subscribers, cancel-at-period-end, cancellations before payment two,
  second/third successful Invoices, failed Invoices, and later recovery are
  provider-event facts;
- realized gross, refunds/credits, net, realized revenue per exposed account,
  and MRR are integer minor units grouped by currency. Currencies are never
  summed into fake money;
- relative activation and revenue lift always include exact numerators and
  denominators;
- client version is shown only from exact activation-session lineage; v1.0.11
  is not inferred from time, browser, or account identity;
- assignment, snapshot, exposure, acquisition, activation, event-currency,
  event-order, and price integrity defects are reported separately.

Observed money is not LTV. Optional modeled LTV is labeled
`modeled_not_observed` and requires explicit horizon, monthly churn/survival,
percentage fees, fixed fees by currency, and refund assumptions. It never
changes observed totals.

## Test and Production rollout

Use this sequence and keep each proof distinct:

1. Apply the complete migration chain to disposable Postgres and run migration,
   checkout, abuse, lifecycle, acquisition, Customer 360, report, API,
   typecheck, and build gates.
2. Apply the migration to a dedicated empty Stripe Test/Postgres QA target.
   Configure the experiment secret, enabled state, and exact Test Price IDs.
   The enabled value is the literal boolean string `true`; values such as `1`
   fail closed to the observable one-time fallback.
3. At rollout `0`, prove control, then use deterministic disposable Test
   accounts to prove monthly Session creation, Test payment, webhook processing,
   entitlement, activation binding, renewal/failure/recovery, Portal, and
   cancellation. Render known report rows in the FlowState dashboard.
4. Re-attest the Production Neon project, branch, endpoint, database, namespace,
   current migration ledger, and a fresh recovery snapshot. Apply migrations
   with the guarded migration operator; runtime DDL is forbidden.
5. Verify all Test and live recurring Prices and webhook selections. Configure
   Production enabled with rollout `0` before publishing code.
6. Publish only a clean, reviewed, fast-forward `main:main` commit. Wait for the
   Git-linked Vercel Production deployment and require live `version.json` to
   equal the pushed SHA.
7. Verify signed-out Upgrade-to-Google, Account/Restore, APIs, event queue,
   report freshness, no unexpected 5xx, and safe live pre-payment Checkout
   shape. Never submit a live qualification payment.
8. Redeploy the same Git source after changing rollout from `0` to a small
   canary, inspect assignment/exposure balance and integrity, then set `5000`
   for the requested 50/50 assignment of future unassigned accounts.

## Kill switch, rollback, and support

Set `SIDESTREAM_UPGRADE_PRICING_V2_ENABLED=false` to send only future unassigned
accounts to the current one-time fallback. Existing v1/v2 assignments, open
Sessions, paid subscriptions, entitlements, acquisition roots, and financial
history remain. If code rollback is necessary, keep webhook processing, annual
reminders, and Portal support for existing experiment subscriptions until the
forward-compatible lifecycle code is restored.

The old v1 enabled/rollout settings are not read by v2. V1 cannot assign a new
account because only its persisted historical rows are loaded. Starting v2
requires the separate v2 settings plus a deployment that contains this contract;
changing stale v1 environment values cannot restart or repurpose the old test.

Stripe API `2025-03-31.basil` and later move invoice and invoice-line ancestry
under typed `parent` objects and replace the Invoice `paid` boolean with the
Invoice Payments ledger. Subscription fulfillment accepts that current shape
and the historical top-level shape. Current settlement requires one exact
Invoice Payment and expanded successful PaymentIntent with matching namespace,
Invoice, Customer, currency, requested/paid/received amount, and status; it
also requires the exact parent type, subscription, Price, Product, quantity,
amount, and locked metadata.

Support should first determine whether the customer has an active one-time or
subscription entitlement and whether an exact activation session is attached.
Do not ask a customer to pay again. Existing panels refresh through their normal
poll/focus/reopen path; a Premiere restart is not a billing fix. Exact v1.0.11
Production qualification uses the immutable signed artifact and legacy host,
not an edited manifest. Stripe Test purchase qualification is a separate Test
panel/QA-target proof because immutable v1.0.11 cannot be repointed to Test.

## Evidence record

For every rollout, record without secrets:

- reviewed commits and clean file scope;
- migration filename, SHA-256, ledger state, target fingerprint, and recovery
  snapshot time;
- Test and Production Product/Price fingerprints including namespace, lookup
  key, currency, amount, interval, active state, and quantity;
- enabled/rollout state and secret fingerprints only;
- disposable Postgres and command results;
- Test Session, event, entitlement, activation, Portal, and cancellation safe
  references;
- immutable v1.0.11 artifact/manifest/app hashes, loaded CEP root, timestamped
  screenshots, canonical/legacy URL, and restored CEP verification;
- protected report window and known aggregate rows plus a rendered dashboard
  screenshot;
- pushed main SHA, Git-linked Production deployment, matching live
  `version.json`, live pre-payment shapes, queue health, and rollback/kill-switch
  verification;
- separately listed human-only credentials, CAPTCHA, admin-password, or live
  financial actions that were not performed.

# Authenticated Upgrade pricing experiment

This document is the durable contract for `upgrade-pricing-v1`. It separates
source behavior, Stripe Test qualification, Production rollout, and observed
reporting so that a fixture, Preview, or open Checkout page is never reported
as a completed purchase or live rollout.

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

Set `SIDESTREAM_UPGRADE_PRICING_EXPERIMENT_ENABLED=false` to send only future
unassigned accounts to the current one-time fallback. Existing assignments,
open Sessions, paid subscriptions, entitlements, acquisition roots, and
financial history remain. If code rollback is necessary, keep webhook
processing and Portal support for existing experiment subscriptions until the
forward-compatible lifecycle code is restored.

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

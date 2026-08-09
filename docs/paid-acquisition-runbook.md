# Paid-acquisition website runbook

> **Status:** documentation and verification planning only. This runbook
> authorizes no Production action. The implementation contract remains
> `docs/paid-acquisition-contract.md`.

## Scope and preserved behavior

The Meta creative comparison uses deterministic server-owned links, not the
ManyChat 50/50 router:

```text
https://sidestream.tv/meta-default
https://sidestream.tv/meta-paid
```

Keep both paths unlinked and noindex. `/meta-default` must always redirect to
the existing canonical/default site. `/meta-paid` must always render the paid
landing and must return `503` rather than silently showing the control if its
signing boundary is unavailable. Verify that Checkout and payment retain the
canonical `source=meta`, `campaign=sidestream_direct_offer_test`,
`experiment=meta-direct-links-v1`, and exact `freemium/default` or `paid/paid`
dimensions. Reopening the same variant must preserve its acquisition UUID;
switching variants must issue a new UUID. Do not add query parameters that
allow a browser or ad platform to choose the variant. These URLs are
private-by-distribution, not access-controlled after sharing.

`/mc` is the only randomized ManyChat experiment entry. Only an eligible mobile `GET /mc`
top-level document navigation may be assigned. Eligibility is conservative:
desktop, tablet, bot, scanner, prefetch/prerender, missing or conflicting
device evidence, `HEAD`, non-`GET`, `/mc/`, encoded lookalikes, and case
variants are never assigned.

An eligible request receives one signed, first-party, 30-day sticky assignment:

- buckets `0000..4999` are `mc-control-v1`;
- buckets `5000..9999` are `mc-paid-v1`; and
- refreshes and campaign-query changes reuse the valid assignment.

Control, ineligible, uncertain, and configuration-failure traffic safely falls
back to the same canonical destination and bounded ManyChat attribution as
`/m`. No paid database, Checkout, email, artifact, activation, or entitlement
state is created for that fallback. `/m` itself remains unchanged.

This is an additive boundary. The canonical root and free mobile handoff,
account and Google OAuth, existing Checkout, activation, Restore Purchase,
installer/download, release/update manifest, legacy-client, organic/search,
and direct-artifact workflows remain preserved. The paid path must not
intercept, replace, or reinterpret those workflows.

## Default-off configuration

The assignment boundary is fail-safe and default-off:

- `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` must contain at least 32
  random bytes. If it is absent, short, or invalid, every `/mc` request follows
  the unchanged control fallback and no cohort cookie is created.
- `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED` sends only when its exact value
  is `1`. Unset, `0`, and every other value keep provider delivery off. A
  verified completion may still leave a namespaced outbox row pending.
- `SIDESTREAM_PAID_ACQUISITION_RECEIPT_SECRET` must be a separate server-only
  value of at least 32 bytes before Test receipt/artifact/claim work.
- Test and Production assignment and receipt secrets must be different.

Test environment selection is server-owned. A valid Test request requires all
of these bindings to agree:

| Boundary | Required Test binding |
| --- | --- |
| Deployment | `VERCEL_ENV=preview`, `development`, or `test` |
| Namespace | `SIDESTREAM_LICENSE_NAMESPACE=test` |
| Host | exact hostname in `SIDESTREAM_TEST_API_HOSTS`, with no Production host overlap |
| Database | dedicated `SIDESTREAM_TEST_POSTGRES_URL`, different from every Production runtime target |
| Stripe | `STRIPE_SECRET_KEY` in test mode plus reviewed Test `SIDESTREAM_PRO_PRODUCT_ID`; `SIDESTREAM_PRO_PRICE_ID` is an optional validated hint for USD 1999 |
| Google OAuth | Test client and exact Test-origin `GOOGLE_REDIRECT_URI` |
| Email | `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=0` until an allowlisted Test recipient and Resend gate are approved |
| Artifacts | Test-only `SIDESTREAM_RELEASE_MANIFEST_PATH` and `SIDESTREAM_WINDOWS_RELEASE_MANIFEST_PATH` after reviewed artifacts are published; paid delivery derives from these same canonical stable manifests |

Any missing, ambiguous, shared, cross-mode, or cross-environment binding must
fail closed. The committed canonical manifests are release pointers, not
storage evidence. Paid delivery projects its version, filename, pathname, byte
size, and digest from the same platform manifest as `/api/download`, so it
cannot retain an older independent pointer. Verify the selected pathname, byte
size, digest, and live receipt-gated response before claiming either platform
artifact is available.

## Deterministic fixture verification

Install the lockfile dependencies, then run the fixture-only proof:

```bash
npm ci
npm run test:paid-acquisition-e2e
node scripts/verify-paid-acquisition-e2e-fixtures.mjs
```

`npm run test:paid-acquisition-e2e` runs four deterministic suites through the
real routing, paid Checkout/completion, email, artifact, claim, and entitlement
branching with in-memory fixture providers and database state. The stricter
verifier scrubs Stripe, Resend, Blob, Neon/Postgres, Vercel, and Google/OAuth
selectors before rerunning the harness.

Run the focused dedicated-claim proof as well:

```bash
node --experimental-strip-types --test tests/paid-onboarding-claim.test.mjs
```

It proves that only the exact raw `paid-acquisition-mc-v1` source selects
`/api/activation/paid-claim`, the route rechecks the stored source, requests
Google's account chooser, keeps the inactive branch noindex and support-only,
and leaves active owners on the existing same-origin CSRF and device
reconnect/transfer policy. The ordinary route keeps its original default:
after authentication, a Free account continues through `/api/checkout/start`
directly to Stripe.

For a website acceptance pass, also run:

```bash
npm run test:migrations
node --test tests/paid-experiment-routing.test.mjs tests/paid-landing.test.mjs
node --experimental-strip-types --test \
  tests/paid-acquisition-integration.test.mjs \
  tests/paid-acquisition-checkout.test.mjs \
  tests/paid-installer-email.test.mjs \
  tests/paid-release-manifest.test.mjs
npm run test:entitlement
npm run typecheck
npm run build
git diff --check
```

These commands are deterministic contract integration evidence. They do not
prove a deployed Test or Production surface, a Stripe payment, Resend delivery,
Google OAuth, a migrated database, a published artifact, an installation, or a
loaded Premiere panel.

## Manual Production smoke after a separately authorized deployment

This is a post-deployment verification checklist, not deployment or testing
authorization. Run it only after the intended commit is integrated onto current
`origin/main`, a human separately authorizes `npm run deploy:production`, and
the canonical `https://sidestream.tv` alias is proven to serve that exact
commit. Do not use a Ready build or feature URL as Production evidence.

Keep `/mc` unlinked and default-off throughout this server-support smoke. Do not
request `/mc`; do not add or change
`SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET`; do not enable paid email; and
do not apply a migration, publish an artifact, or complete a payment.

1. From the canonical root HTML, confirm there is no anchor whose `href` targets
   `/mc`. Inspect source or the rendered root; do not navigate to `/mc`.
2. Without following the redirect, request canonical
   `/api/checkout/start` while signed out. Confirm the actual response is a
   Google-authentication redirect, proving the canonical alias executes the
   server route.
3. With an approved disposable Free account and an ordinary activation whose
   source is omitted or not exact, complete Google authentication. Confirm the
   browser sequence is `/api/activation/claim` →
   `/api/checkout/start?activation=...` → Stripe Checkout. Stop on the Stripe
   page without paying. The support-only page must not appear.
4. With an approved disposable Free account and an activation created by the
   server from exact source `paid-acquisition-mc-v1`, complete Google
   authentication through the returned `/api/activation/paid-claim` URL.
   Confirm the noindex page title is “We’re not seeing your purchase.”, the
   signed-in email is escaped, the instruction says “If you already upgraded,
   contact Sidestream support.”, and the only action is
   `mailto:alex@alexg.mov`. Confirm there is no Upgrade, Buy, Checkout, form, or
   purchase link and no redirect to Stripe.
5. With a separately approved already-active Unlimited account and exact paid source,
   confirm GET shows the existing same-device reconnect or different-device
   confirmed-transfer decision. GET must not bind or move a device. Submit the
   CSRF-protected POST only if device mutation is separately authorized; if
   submitted, verify the two-seat replacement decision and final loaded-panel state.
6. Record the exact Production commit, canonical response evidence, account
   class used for each branch, and whether any state-changing POST was
   authorized. Redact activation keys, cookies, email addresses, account IDs,
   device identifiers, and provider values.

If any exact-source request reaches Checkout, any ordinary Free-account request
reaches the support-only page, the root links to `/mc`, or the canonical alias
does not serve the intended commit, stop. Do not compensate with an environment
change, migration, alternate deployment URL, or manual data edit.

## Exact Test-only release procedure

The following sequence is the only allowed pre-Production live validation path
for the paid experiment. It is a human-gated checklist, not authorization from
this document.

1. Run the deterministic fixture and build commands above from a clean
   integration commit. Record the commit and passing output.
2. Select one approved non-Production host. Prove its trusted host,
   `VERCEL_ENV`, `SIDESTREAM_LICENSE_NAMESPACE=test`, Stripe test mode, and
   dedicated Test database identity. Stop if any value is missing, conflicts,
   or matches Production.
3. Keep the assignment secret absent and email delivery disabled. Locally run
   `npm run db:migrate -- --validate` and `npm run db:migrate -- --dry-run`;
   these validate only local migration files and do not prove database state.
4. Obtain separate human approval for the Test deployment, authenticated
   Test-database status, and migration application. Apply the complete
   checksummed chain, including
   `20260727010000_add_paid_acquisition_experiment.sql`, only with reviewed
   target-authenticating tooling. This runbook supplies no remote apply command.
5. Obtain separate artifact-publication approval. Publish and independently
   verify Test-only macOS and Windows artifacts, then bind reviewed Test
   manifests. A manifest file, hash, `HEAD`, or signed URL is not installation
   proof.
6. Configure distinct Test assignment/receipt secrets, Stripe test Product and
   Price, and Test Google OAuth. Keep
   `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=0` for the first surface check.
7. Deploy only to the approved Test host. With clean browser profiles and real
   phone navigation, observe both sticky 50/50 cohorts. Verify that eligible
   `GET /mc` is assignable; desktop, bot/scanner, prefetch, `HEAD`, bad cookie,
   missing-secret, and malformed-path cases fall back safely.
8. Recheck `/m`, `/`, the free mobile handoff, account, existing Checkout,
   activation, restore, installer, release, and legacy-client surfaces. Stop
   on any behavioral drift.
9. After separate payment approval, complete a real Stripe **test-mode**
   payment and verify the server-retrieved regional Product/Price/quantity/currency
   truth, idempotent completion, pending/delayed/replayed fulfillment, and
   refund/dispute/expiration/already-claimed outcomes.
10. After separate email approval, restrict Resend to an allowlisted Test
    recipient, set the email switch to `1`, and verify inbox delivery. Provider
    acceptance alone is not delivery.
11. Complete Google OAuth with the verified Checkout email and separately test
    mismatch recovery. Verify activation polling and server-issued
    credentials; never infer paid access from the cohort, email, receipt, or
    installer.
12. Install the reviewed Test artifact on macOS and Windows, then verify the
    loaded Test build inside Premiere on both platforms. Capture evidence from
    the loaded panel and downstream server state.
13. Review reporting and privacy exclusions below. Leave Production unchanged.
    Any Production proposal requires a separate plan, independent review, and
    explicit authorization.

## Rollback

Rollback is the default-off switch, not a database rewind:

1. On the approved Test target, remove
   `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` and set
   `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=0`; then use the separately
   authorized Test deployment process.
2. Verify eligible and ineligible `/mc` requests now follow the `/m` canonical
   destination and create no assignment cookie or paid state. Recheck `/m`
   independently.
3. Do not delete or reinterpret assignment cookies, paid rows, outbox jobs,
   claims, events, migrations, or audit history. Without the assignment secret,
   an existing cookie cannot reopen the paid route.
4. Preserve the root/free/account/Checkout/activation/restore/installer/
   release/legacy workflows and investigate any drift before re-enabling Test.

This rollback authorizes no Production environment-variable change or
deployment.

## Reporting and privacy limits

Paid-acquisition reporting is funnel-stage evidence, not durable identity.
Only eligible mobile `/mc` traffic belongs in the 50/50 assignment denominator;
realized cohort counts may vary normally. Control visitors can contribute only
the bounded eligibility event. Daily anonymous hashes count anonymous
visitor-days, not identified people.

Keep these claims separate:

- landing view is not a Checkout start;
- Checkout start is not a paid Session;
- server-verified payment is not Resend acceptance or inbox delivery;
- email acceptance is not an artifact request or completed download;
- download is not macOS or Windows installation;
- installation is not activation, entitlement issuance, or loaded Premiere
  behavior; and
- activation is not durable retention, revenue attribution, or ROAS.

Attribution is bounded to `utm_source=manychat` plus validated
`utm_medium`, `utm_campaign`, `utm_content`, and `utm_id`. Campaign reporting
cannot identify a person across days or prove that ManyChat caused a payment.
There is no live paid-acquisition reporting command established by this run.

The cohort cookie contains only version, random nonce, cohort, issued-at time,
and signature. Experiment events must exclude email, name, phone, raw IP, raw
User-Agent, cookies/nonces, Stripe or Google identifiers and payloads, payment
data, provider message IDs, receipt/token values, activation/license tokens,
device identifiers/hashes, account/license/entitlement IDs, database errors,
and free-form query values. Verified emails and provider references remain
server-private, namespaced operational state; they are not analytics fields.

## Remaining human release gates

All of these remain open:

- authenticated Test migration application;
- Test artifact publication and integrity verification;
- a real Stripe test-mode payment;
- Resend inbox delivery to an allowlisted recipient;
- a real Google OAuth round trip and email-match/mismatch recovery;
- macOS installation;
- Windows installation; and
- loaded Premiere verification on both platforms.

This documentation run did not deploy, apply migrations, publish artifacts,
make payments, send email, change Production, or prove loaded Premiere
behavior.

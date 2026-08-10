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
| Artifacts | Test-only `SIDESTREAM_PAID_RELEASE_MANIFEST_PATH` and `SIDESTREAM_PAID_WINDOWS_RELEASE_MANIFEST_PATH` after reviewed artifacts are published |

Any missing, ambiguous, shared, cross-mode, or cross-environment binding must
fail closed. The committed paid manifests are release pointers, not storage
evidence; verify the selected pathname, byte size, digest, and live
receipt-gated response before claiming either platform artifact is available.

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
node --experimental-strip-types --test \
  tests/paid-onboarding-claim.test.mjs \
  tests/paid-acquisition-integration.test.mjs \
  tests/customer-360/query-api.test.mjs
npm run verify:checkout-contract
```

The combined gate proves that only the exact raw `paid-acquisition-mc-v1` source selects
`/api/activation/paid-claim`, the route rechecks the stored source, requests
Google's account chooser, keeps the inactive branch noindex and support-only,
leaves active owners on the existing same-origin CSRF and device
reconnect/transfer policy, emits only a bounded outcome for exact paid linkage,
and prioritizes the exact Checkout acquisition in Customer 360. The ordinary
route keeps its original default:
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

## Paid activation linkage outcome triage

The exact paid-claim POST logs
`[sidestream paid activation] attribution linkage` with one `outcome` field.
Never add or copy activation keys, receipt values/hashes, install identities,
emails, account/license identifiers, Stripe references, tokens, or database
errors into the log. Ordinary activation claims must not emit this diagnostic.

| Outcome | Operator interpretation |
| --- | --- |
| `missing_browser_paid_receipt` | The exact paid claim had no signed browser paid receipt. Reproduce from the receipt-gated handoff; do not substitute the local installer receipt. |
| `receipt_activation_no_match` | The receipt did not match an active, unexpired paid activation in the selected environment. |
| `activation_source_mismatch` | The activation source was not exact `paid-acquisition-mc-v1`; investigate source propagation without forcing linkage. |
| `claim_binding_conflict` | Existing claim binding disagrees; preserve both histories and investigate. |
| `installation_identity_not_unique_or_missing` | The POST omitted the exact current install/receipt pair, or those exact values did not resolve one install membership and one locally verified native-receipt identity. |
| `acquisition_identity_missing` | Claim binding succeeded but its canonical acquisition identity is unavailable. |
| `acquisition_ownership_conflict` | The acquisition belongs to a different Customer 360 profile; fail closed and do not merge manually. |
| `installation_claimed_recorded` | `installation_claimed` and `verified_installation_claim` committed for the paid-claim POST's exact current install/receipt pair after deterministic profile convergence. |
| `linkage_unavailable` | The additive linkage attempt failed unexpectedly; entitlement reconnect/transfer still stands. |

`installation_claimed_recorded` is required, but it is not sufficient handoff
proof on its own. Confirm one immutable paid-telemetry binding for the POST's
exact current install/receipt row IDs and confirm that install's telemetry owns
the same live Customer 360 profile as the acquisition, commerce, exact lookup,
and funnel journey. A positive outcome on a historical install while the
current telemetry install remains on another live profile is failure. No other
outcome may be presented as Customer 360 install proof.

For Customer 360 lookup by `cs_`, `pi_`, or `ch_`, first require exactly one
non-conflicted owner. The acquisition in the response then prefers the exact
requested Checkout Session, or the Checkout Session alias sharing the requested
PaymentIntent/Charge payment key. Broader account, activation, or profile-linked
acquisitions are fallback candidates ordered by `first_observed_at` and UUID.
The lookup does not rewrite attribution. If ownership is missing, ambiguous, or
conflicted, stop; do not pick the oldest or newest profile manually.

## Guarded one-journey paid-telemetry repair

This operator exists only for the reproduced split-profile handoff. It never
selects by email, Stripe reference, browser/native receipt, install hash,
activation key, device value, or time range. Its only journey selector is the
canonical acquisition UUID; trusted namespace and an exact named direct
database selector remain separate server/operator facts.

Run a fresh dry-run first. It connects read-only and rolls back:

```bash
npm run reconcile:paid-telemetry-handoff -- --dry-run \
  --acquisition <canonical-uuid> --namespace test \
  --target-url-env SIDESTREAM_TEST_POSTGRES_URL

npm run reconcile:paid-telemetry-handoff -- --dry-run \
  --acquisition <canonical-uuid> --namespace production \
  --target-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING
```

The exact Test and Production selectors are fixed as shown. The selected URL
must be direct/non-pooled; remote connections require authenticated TLS, and
runtime/source/target collisions fail closed. Output omits the acquisition UUID
and all provider/identity material. Retain only its bounded eligibility reason,
counts, and the `pg-...` target plus `journey-...` immutable fingerprints.

Apply requires a separate human review of that current dry-run and every exact
confirmation:

```bash
npm run reconcile:paid-telemetry-handoff -- --apply \
  --acquisition <same-canonical-uuid> --namespace production \
  --target-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
  --confirm-operation RECONCILE_ONE_PAID_TELEMETRY_HANDOFF \
  --confirm-namespace production \
  --confirm-target pg-<reviewed-fingerprint> \
  --confirm-journey journey-<reviewed-fingerprint>
```

Apply uses one serializable transaction and namespace/journey advisory locks.
It revalidates the canonical root, Checkout, payment/refund/dispute truth,
claim, account, entitlement, activation, exact identity rows, current stage
owners, binding, acquisition conflicts, and complete commerce payment-key
group. Any stale, missing, ambiguous, refunded, disputed, or contradictory fact
aborts. The permitted repair is limited to missing authentication/current-
install stages and evidence, exact claim/activation linkage, an exact matching
Checkout/claim transition from `unclaimed` to `claimed`, deterministic profile
merge/audit, immutable exact binding, and merge-triggered commerce refresh.
Replaying the same confirmed journey is a no-op.

Disposable proof is:

```bash
npm run replay:paid-telemetry-handoff
npm run replay:paid-telemetry-handoff -- --expect-pending-review-repaired
npm run replay:paid-telemetry-handoff -- --expect-reviewed-path-repaired
npm run replay:paid-telemetry-handoff -- --expect-legacy-entitlement-repaired
npm run replay:paid-telemetry-handoff -- --expect-unowned-commerce-repaired
npm run replay:paid-telemetry-handoff -- --expect-missing-current-customer-repaired
```

All six forms require the approved disposable `SIDESTREAM_TEST_POSTGRES_URL`, use
real migration, identity, usage, commerce, exact lookup, and funnel code, and
print privacy-safe summaries. The default replay proves the simple
install-profile split: one live/one merged profile, eight expected stages
exactly once, one binding, one merge audit, one commerce owner, preserved
search/download usage, exact paid funnel attribution, and fail-closed negative
fixtures.

The pending-review replay preserves multiple historical Checkout/paid and
activation-claim attempts, then selects the current path only from its active
activation plus exact verified receipt. The current telemetry profile has no
direct account/Stripe link; exactly one verified-server `account_identity`
review from `activation_claim` must resolve it to the exact account owner.
Stripe review rows are never selectors. It proves `repair_ready`, a
rollback-contained operator apply, runtime convergence, matching
`unclaimed/unclaimed` to `claimed/claimed` repair, runtime/operator replay,
stable journey fingerprint, and common commerce/lookup/funnel ownership. A
second eligible activation path, second reviewed owner, mismatched claim states,
or any stale eligibility fact fails closed and rolls back the whole transaction.
All six summaries omit fixture UUIDs, hashes, email, Stripe references,
tokens, and connection strings. No form inspects or repairs a deployed database.

The third replay keeps two independently valid active paths: one direct
historical path and one disjoint path owning exactly one verified-server
`account_identity` review from `activation_claim` to the unique exact-account
owner. Discovery starts only from the canonical acquisition and trusted
namespace and selects the reviewed activation without timestamps, row order,
newest/oldest rules, Stripe reviews, email, hashes, provider references,
receipt/activation input, or a new operator selector. It proves `repair_ready`,
first-apply `already_repaired`, and count-for-count no-op replay. No reviewed
path retains the earlier direct/simple behavior; duplicate reviewed paths or
owners, pre-binding direct+review overlap, root mismatch, or any downstream
eligibility conflict refuses before mutation. The exact immutable binding is
the only post-repair replay disambiguator.

The read-only Production dry-run on deployed `a4be35d` rejected this dual-path
shape without mutation. Preserve that as fail-closed historical evidence only:
it does not show the selector correction is deployed, authorize apply, prove
current eligibility, or qualify the live journey.

The fourth replay starts from that exact reviewed path but preserves the
historical entitlement placeholders: both Product and Price are null and
`amount_paid` is exactly zero, while the verified paid row retains a strictly
positive amount and exact canonical Checkout Session, payment, core
Product/Price, currency, account, activation, plan, zero-refund,
install/receipt, lifecycle, commerce, stage-owner, and binding evidence. Its
claim normalized email is null only behind exact claim account, entitlement,
activation, and account-to-verified-Checkout email ownership. Any partial
snapshot, nonzero mismatch, zero/nonpositive payment, provider mismatch,
refund, conflicting account, or non-null mismatched claim email refuses before
mutation.

The replay proves read-only `repair_ready`, atomic apply to
`already_repaired`, and a count-for-count no-op replay. It also proves the
entitlement Product/Price/amount and omitted claim email remain unchanged;
selection does not backfill them. Deployed `812cf96` rejected this exact shape
in a read-only Production dry-run without mutation. Preserve that as historical
fail-closed evidence only: it does not prove this revision is deployed,
authorize apply, establish current Production eligibility, or qualify the live
journey.

The fifth replay starts from the fourth path plus exactly one verified
Checkout payment fact on one payment key with null owner and zero gross/net.
Its currency, exact Checkout identity evidence, and canonical payment-intent
evidence must match the already positive paid snapshot. Apply merges first,
then conditionally updates only that locked fact to the verified paid amount,
attaches/confirms the survivor, sets paid and upgrade timing from paid
completion, preserves provider identifiers/provenance and legacy entitlement
placeholders, refreshes totals, and requires positive attached rediscovery.
The replay proves no-op idempotence plus atomic refusal for a second key/fact,
wrong source/currency/evidence, nonzero or owner mismatch, conflict, refund,
dispute, inquiry, missing positive paid truth, and failed totals refresh.
Deployed `6118a87` rejected this exact pre-state read-only without mutation;
preserve that only as fail-closed history, not deployment, authorization,
current Production eligibility, or live qualification.

The sixth replay starts from the deployed post-repair topology: one live
survivor, one merge audit, one authentication stage, one installation stage,
one immutable binding, and positive attached commerce already exist, but the
exact current Stripe Customer link is absent. The locked completed Checkout
intent and claimed authenticated account must share the same bounded `cus_`
value, with no identity link of any type, matching identity review, or commerce
alias owning it. Apply inserts only one `stripe_customer` link on the proven
survivor; it does not repeat merge, stages, claim mutation, commerce recovery,
totals refresh, or binding, and it preserves an older unrelated Customer link.
Post-discovery plus exact Customer lookup must converge to `already_repaired`;
replay is a count-for-count no-op. Invalid/mismatched values, a different or
second owner, conflicting review/alias/path, changed locked state, and every
earlier lifecycle/identity/commerce/binding refusal fail closed.

Deployed `19c242d` repaired exact Checkout Session and PaymentIntent commerce
ownership but left this exact legacy Customer lookup absent. Preserve that as
scope evidence only. This runbook does not authorize a Production query, apply,
provider call, deployment, push, migration, or FlowState change.

The seventh boundary is a read-only funnel gate, not another repair mode. For
one live profile, exactly one immutable binding must make its Checkout's
canonical Meta dimensions outrank historical receipt, Checkout Session,
activation, and broad account edges. With no binding, preserve the existing
first-touch/entry/Checkout fallback. With multiple exact bindings, require
unknown rather than selecting by timestamp, email, Stripe Customer,
account-wide install history, or row order. Run both focused acquisition-funnel
suites and all six replay forms. The first-purchase regression and paid-handoff
fixture must each show Meta/social/`sidestream_direct_offer_test`,
`exact_paid_checkout`, `intact`, `paidCustomer=true`, attributed `1/1`, exact
paid `1/1`, and unknown `0/1`, while the historical candidate remains stored.

Deployed `5a4cf55` had those numerically correct coverage counts but selected
ManyChat/`historical_unlinked`, so it did not pass this dimensional gate. This
runbook entry records the source boundary only and authorizes no Production
query, repair, provider call, deployment, push, migration, or FlowState change.

The earlier read-only Production dry-run on deployed commit `aa5a604` rejected
the actual pending-review topology as ineligible and wrote nothing. Record that
as proof the old simple-split operator failed closed, not as a successful repair
or qualification. Do not retry Production from this documentation: the revised
snapshot still requires integration, canonical deployment proof, a fresh
read-only dry-run, and separate apply approval.

### Post-audit rollout ladder (do not execute from this documentation step)

1. A human reviews the complete integration snapshot, including migration,
   implementation, fixture, privacy, operator, and documentation evidence.
2. Merge the accepted snapshot onto current `main`; do not publish the
   Orchestra/worktree branch.
3. Run the required main release gates, push only `main:main`, and let the
   Git-linked canonical Production deployment publish that exact clean commit.
4. Verify `https://sidestream.tv/version.json` reports the pushed full SHA. A
   Ready build, Preview URL, or branch deployment is not evidence.
5. Run one read-only Production dry-run for the reviewed acquisition UUID and
   review its current eligibility, target fingerprint, and journey fingerprint.
6. Obtain separate approval, then apply only that same acquisition with every
   exact confirmation copied from the fresh dry-run.
7. Without a new Checkout or payment, query exact Customer 360 Stripe lookup
   and funnel output and verify one live root owns commerce, all expected
   stages, the immutable current install/receipt binding, and post-claim
   search/download telemetry with no missing linkage or ownership conflict.

Stop between stages on any mismatch. This ladder has not been run here and is
not standing authorization for deployment, migration, Production repair, or
live qualification.

## Manual Production smoke after a separately authorized deployment

This is a post-deployment verification checklist, not deployment or testing
authorization. Run it only after the intended commit is integrated onto current
`main`, pushed as `main:main`, published by the Git-linked Production
deployment, and proven on canonical `https://sidestream.tv` with its exact
`/version.json` SHA. Agent sessions must not use the owner-only emergency Vercel
CLI deployment. Do not use a Ready build or feature URL as Production evidence.

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

## Guarded fresh Meta-paid Production reset and handoff

This is the only supported way to prepare the fixed Alex QA identity for one
fresh live Meta-paid qualification. It is a narrow, destructive Production
operator, not a general customer-deletion tool. Running it requires separate
human authorization for the exact live attempt. Repository fixtures and local
tests prove only fail-closed code behavior; they do not prove the live target,
a completed reset, a clean machine, or readiness to start Checkout.

The stop/go sequence is fixed:

```text
attest deployed non-main branch + direct endpoint
                    |
       sanitized reset dry-run
                    |
     verified child recovery branch
                    |
 exact confirmed apply -> zero-state dry-run
                    |
 Production-only local backup/reset
                    |
 rotate to a clean browser profile
                    |
 /meta-paid -> Checkout -> paid install -> authentication
                    |
 post-auth preflight: STOP or GO / download-may-begin
                    |
        one in-panel media download
                    |
 exact-install raw telemetry follow-up: STOP or GO
```

Stop at the first missing or mismatched gate. Do not open `/meta-paid` or begin
Checkout until the live database zero-state, local reset, and browser-rotation
gates pass. The receipt-gated installer is needed for installation and the
post-auth check; “download” in the preflight decision means the first media
download inside the panel, which must not begin before `GO` with instruction
`download-may-begin`.

### Production target and report contract

`npm run fresh-paid:reset` is dry-run by default and operates only as
`fresh-meta-paid-production`. The operator accepts an explicit deployed Neon
branch name, branch ID, and direct endpoint ID. The branch must be non-`main`.
Authenticated project branch/endpoint inventory, the direct connection host,
connected database, connected role, and `production` namespace must all agree
with the fixed code-owned Production target. Omitted selectors, pooled URLs,
an unexpected endpoint, database or role drift, and connected-target
fingerprint drift fail closed.

Record only the reviewed branch name/ID, direct endpoint ID, connected-target
fingerprint, recovery fingerprint, row counts, financial-object counts, and
safe SHA-256 fingerprints. Never copy a connection URL, secret, customer
address, account/payment/Checkout identifier, receipt/install hash, or raw
recovery branch ID into the report. The raw recovery branch ID is obtained
separately from authenticated Neon tooling and kept only for the apply command.

The fixed Alex-only closure begins from the code-owned allowlisted QA email set;
display name alone is never a selector. It then follows only server-owned links
through:

- accounts, sessions, license tokens, entitlements, activations, devices, and
  transfers;
- core and paid Checkout rows, paid entries/events/outbox/claims, canonical
  acquisitions, stages, conflicts, and anonymous claimed sessions;
- exact paid telemetry bindings, live or merged Customer 360 profiles,
  installs, identity links/reviews, and merge audits;
- commerce materializations, aliases, invoice-payment edges, money totals, and
  customer usage rows.

Any foreign account, provider-customer, Checkout, payment, subscription,
activation, binding, entry, acquisition, or overlapping Meta-event window
aborts before deletion. Apply may delete only matching provider Customer
identity objects. Existing invoices, payment intents, charges, refunds, and
disputes are inventoried and re-read unchanged. Provider webhook history,
unrelated profiles/accounts, global usage-sync state, download leads, installer
analytics, and every unrelated customer or financial record are preservation
invariants. A changed invariant rolls back the database transaction or fails
the operation.

### Exact remote reset procedure

Prepare the live secret only in the operator environment and confirm the
authenticated Neon CLI is scoped to the expected project. Substitute only the
reviewed safe branch selectors below; do not paste secrets or connection URLs
into command history or evidence.

1. Independently obtain and review `<deployed-name>`, `<br-id>`, and the direct
   `<ep-id>`. Run the sanitized reset dry-run:

   ```bash
   npm run fresh-paid:reset -- \
     --branch-name '<deployed-name>' \
     --branch-id '<br-id>' \
     --endpoint-id '<ep-id>'
   ```

   Retain the returned `<website-target-sha256>` and bounded counts only. Stop
   on unexpected scope, ownership refusal, target drift, or a non-sanitized
   value.

2. Dry-run the recovery operation against the same selectors, then explicitly
   create one recoverable child branch:

   ```bash
   npm run fresh-paid:reset -- \
     --operation prepare-fresh-meta-paid-recovery \
     --branch-name '<deployed-name>' \
     --branch-id '<br-id>' \
     --endpoint-id '<ep-id>'

   npm run fresh-paid:reset -- \
     --apply \
     --operation prepare-fresh-meta-paid-recovery \
     --branch-name '<deployed-name>' \
     --branch-id '<br-id>' \
     --endpoint-id '<ep-id>' \
     --confirm CREATE-RECOVERABLE-NEON-CHILD
   ```

   Confirm authenticated Neon inventory shows exactly one ready child whose
   parent is `<br-id>`. Obtain its raw `<recovery-br-id>` from that inventory;
   the sanitized command report intentionally exposes only a fingerprint.

3. Apply once with every exact confirmation. The recovery ID must be repeated
   byte-for-byte as its own confirmation:

   ```bash
   npm run fresh-paid:reset -- \
     --apply \
     --operation fresh-meta-paid-production \
     --branch-name '<deployed-name>' \
     --branch-id '<br-id>' \
     --endpoint-id '<ep-id>' \
     --connected-target-fingerprint '<website-target-sha256>' \
     --confirm-namespace production \
     --confirm-identity alex-garrett-fixed-qa \
     --recovery-branch-id '<recovery-br-id>' \
     --confirm-recovery-branch '<recovery-br-id>' \
     --confirm DELETE-FRESH-META-PAID-ALEX-ONLY
   ```

   Apply performs its own second inventory and reports `clean=true` only when
   every closure count and the matching provider Customer count are zero.

4. Re-run the step 1 dry-run against the unchanged selectors. Require the same
   connected-target fingerprint, every target count equal to zero, a zero
   matching Customer count, and unchanged preservation fingerprints. This is
   the idempotent zero-state proof. Any nonzero count or changed fingerprint is
   `STOP`; do not repeat apply speculatively and do not begin Checkout.

### Production-only local reset and browser rotation

The server reset does not clean Premiere, CEP, installer receipt, or browser
state. First save Premiere projects and run the local dry-run. Add a repeated
`--preserve-path` for every project or media location outside the default
Downloads and Documents/Adobe paths:

```bash
npm run fresh-paid:reset-local -- \
  --operation fresh-meta-paid-production-local \
  --preserve-path '<additional-project-or-media-path>'
```

Review the inventory, then run the same preserve arguments with exact apply
confirmation:

```bash
npm run fresh-paid:reset-local -- \
  --apply \
  --operation fresh-meta-paid-production-local \
  --confirm RESET-PRODUCTION-CEP-STATE \
  --preserve-path '<additional-project-or-media-path>'
```

Apply asks Premiere to quit normally and waits for Premiere plus Production CEP
processes to stop. If either remains, nothing moves. It moves only Production
system/user/legacy CEP extensions, Production CEP caches, Production
device/license/paid-onboarding state, telemetry state/queue, and the system
`/Library/Application Support/Sidestream/installer-receipt.json` into a
timestamped mode-`0700` recovery backup. It never deletes them. On a partial
failure it rolls moved paths back. Test extensions/device state, Downloads,
Premiere projects, explicit preserve paths, and unrelated CEP extensions must
have identical before/after fingerprints.

After both resets pass, close every browser window or profile that has prior
Sidestream session/acquisition state and rotate to a new clean browser profile.
Do not clear or rotate that new profile after `/meta-paid` has created the fresh
root: it must carry the same browser continuity through Checkout and
authentication. If an old Sidestream cookie/session remains, or the new profile
is lost mid-journey, stop and restart from a separately reviewed zero-state
attempt rather than splicing evidence.

### Single post-auth STOP/GO gate and telemetry follow-up

Open `/meta-paid` only after the preceding live gates pass. Complete the one
authorized Checkout, retrieve and install its receipt-gated paid-onboarding
artifact, load the Production panel in Premiere, and complete Google
authentication. Before the first in-panel media download, run exactly one
read-only post-auth preflight against the same attested Website target and
fingerprint:

```bash
npm run fresh-paid:preflight -- \
  --branch-name '<deployed-name>' \
  --branch-id '<br-id>' \
  --endpoint-id '<ep-id>' \
  --connected-target-fingerprint '<website-target-sha256>'
```

The preflight silently reads the current verified paid-onboarding Production
package, system installer receipt, and local telemetry identity. It returns
`GO` only when exactly one claimed paid claim and activation, one
`authentication_completed` stage, one `installation_claimed` stage, one
immutable current install/receipt binding, one telemetry/install profile owner,
one exact receipt owner, and exact server-owned `meta` / `social` /
`sidestream_direct_offer_test` dimensions agree. Reports contain only counts,
the connected-target fingerprint, and a local-identity fingerprint. `STOP`, an
error, any count other than one, target drift, or an instruction other than
`download-may-begin` means do not download.

After `GO`, perform exactly one in-panel media download. Then rerun the command
with `--raw-telemetry-follow-up`, the separately attested read-only telemetry
target selectors, its connected-target fingerprint, and the secret telemetry
URL supplied only through `SIDESTREAM_FRESH_PAID_TELEMETRY_POSTGRES_URL`:

```bash
npm run fresh-paid:preflight -- \
  --raw-telemetry-follow-up \
  --branch-name '<deployed-name>' \
  --branch-id '<br-id>' \
  --endpoint-id '<ep-id>' \
  --connected-target-fingerprint '<website-target-sha256>' \
  --telemetry-project-id '<telemetry-project-id>' \
  --telemetry-branch-name '<telemetry-branch-name>' \
  --telemetry-branch-id '<telemetry-br-id>' \
  --telemetry-endpoint-id '<telemetry-ep-id>' \
  --telemetry-database '<telemetry-database>' \
  --telemetry-role '<telemetry-read-role>' \
  --telemetry-connected-target-fingerprint '<telemetry-target-sha256>'
```

The follow-up is `GO` only when raw Production telemetry contains at least one
event with the same exact local install/receipt identity and at least one
`download_completed` for that install. It does not accept account-level,
pre-reset, or another-install activity. Preserve the sanitized evidence and
stop on any mismatch.

## Final live Meta-paid release qualification

Run this only after the guarded reset, zero-state, local reset, and clean-browser
gates above have passed and the separately authorized live providers, payment,
recipient, artifacts, and Premiere machine are ready. Repository and fixture
gates are prerequisites, not substitutes. Start fresh and keep one evidence
record keyed by the same canonical acquisition and install identity; do not
combine earlier screenshots, provider records, or installations from different
journeys.

1. Open the exact `/meta-paid` destination in a clean browser and record the new
   canonical acquisition UUID plus its server-owned Meta paid dimensions. Do not
   reuse a prior acquisition or the default variant.
2. Complete the authorized payment and prove the recipient received the setup
   email. Follow that lineage's receipt-gated link and verify the selected
   artifact is the paid-onboarding artifact. Stripe completion, Resend
   acceptance, a manifest, redirect, or download alone is not this proof.
3. Install that artifact and load its panel inside Premiere. Capture the loaded
   runtime state showing exact `onboardingChannel=paid-onboarding`; an installer
   package, process, source tree, or panel build outside Premiere is insufficient.
4. Complete authenticated Google restore from that panel with the authorized
   account and observe the final active loaded-panel result. A redirect URL or
   OAuth start is not authentication proof. Run the single post-auth preflight
   above now; do not start an in-panel download unless it returns `GO` and
   `download-may-begin`.
5. Query Customer 360 by the exact Checkout/payment reference and confirm its
   exact-priority acquisition is the fresh Meta-paid root. On that same lineage,
   require `installation_claimed=1` and `verified_installation_claim`. The
   operational outcome must be `installation_claimed_recorded`; then verify the
   immutable exact current install/receipt binding and telemetry-owning live
   profile agree. Any other outcome or a positive stage on a historical/split
   profile fails this gate.
6. After post-auth `GO`, complete one in-panel media download and run the raw
   telemetry follow-up above. Require `GO` / `follow-up-complete` for the same
   exact install/receipt identity and a completed download. Pre-claim telemetry,
   another install, or account-level activity does not prove continuity.

Record timestamps and redacted identifiers sufficient to join all six
observations. Stop on any broken join. This Orchestra documentation/integration
step ran no live provider, payment, email, artifact, installer, Premiere,
Customer 360, telemetry, deployment, migration, or Production gate.

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

Final release qualification also remains open until one fresh Meta-paid lineage
passes the six-step gate above, including the receipt-gated paid-onboarding
artifact, loaded Premiere `onboardingChannel=paid-onboarding`, authenticated
Google restore, Customer 360 `installation_claimed=1` with
`verified_installation_claim`, and later telemetry on the same install identity.

This documentation run did not deploy, apply migrations, publish artifacts,
make payments, send email, change Production, or prove loaded Premiere
behavior.

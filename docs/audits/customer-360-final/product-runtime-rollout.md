# Customer 360 final audit: product runtime and rollout

**Audit date:** 2026-07-19  
**Website candidate:** `f955febb170890917e2ff98aadc9bb1ff64d2e6c`  
**Compared with offline implementation base:** `602f377b35c80ffd8f36d38dbb6777b662a19151`  
**Compared with `origin/main`:** merge base `456f6899c8d15d68442aab54dea6810558f44d0d`; current `origin/main` `5bf0eb24a7f5c91fdc540edd9dc508dd0b2b0af5`  
**Adjacent FlowState checkout inspected:** `41ea27c` on `codex/release-1.0.14` (dirty; not modified)  
**Decision:** **BLOCKED. Do not run the live payment-rail exercise, migrate a provider database, or promote this candidate.**

## Scope and method

This was a secret-safe, read-only systems audit. It covered:

- `README.md`, `docs/customer-360-preview-test-plan.md`, `package.json`,
  `vercel.json`, the exact branch diff and commit sequence, every newly added
  verifier, and every newly added test;
- purchase, Checkout completion, delayed/duplicate/out-of-order webhook events,
  FREEDEV promotion, receipt, portal, refund success/failure, dispute open and
  terminal states, restore, transfer, deactivation, anonymous-to-account
  association, and Customer 360 reads;
- immutable deployment provenance, Vercel protection, branch-scoped environment
  metadata, project cron registration, production route behavior, build logs,
  alert metadata, old-host routing, OAuth/cookie origins, rollback compatibility,
  test registry coverage, and skipped Postgres gates;
- the FlowState Customer 360 association contract in the adjacent checkout,
  without editing that repository.

Provider inspection used only resource names, scopes, deployment identifiers,
HTTP status/headers, and sanitized error codes. No environment value, customer
record, payment object, database row, secret, or protected response body was
read or recorded. No provider state was changed.

### Candidate diff evidence

- `602f377..f955feb` contains 25 changed files, 7,340 insertions, and 258
  deletions. `origin/main...f955feb` contains 42 changed files, 8,974 insertions,
  and 403 deletions; the larger comparison also includes unrelated website
  download/mobile assets, which were inspected for rollout scope but not treated
  as Customer 360 remediation.
- The post-offline-base verifier additions are
  `scripts/verify-customer-360-preview-deployment.mjs` and
  `scripts/verify-customer-360-preview-environment.mjs`.
- The post-offline-base test additions are
  `tests/customer-360/preview-deployment.test.mjs`,
  `tests/customer-360/preview-environment.test.mjs`,
  `tests/customer-360/retention-ops.test.mjs`,
  `tests/customer-360/telemetry-tls.test.mjs`,
  `tests/stripe-dead-letter-recovery.test.mjs`, and
  `tests/stripe-event-claim-cap.test.mjs`. Each was read directly; their registry
  inclusion and aggregate execution are addressed in PRR-09 and PASS-01.

### Severity definitions

- **P0:** a current production outage, security boundary failure, or condition
  that makes the requested real rail unsafe to start.
- **P1:** release blocker requiring code, configuration, isolation, or external
  acceptance evidence before Preview execution.
- **P2:** correctness/documentation drift that can mislead rollout but is not an
  immediate live outage by itself.
- **P3:** low-risk hygiene debt.
- **PASS:** directly observed evidence satisfied the stated property. A PASS is
  narrow and does not override a blocker elsewhere.

## Executive findings

| ID | Class | Observation | Immediate consequence |
| --- | --- | --- | --- |
| PRR-01 | P0 | Production canonical origin and configured application/OAuth origin disagree. | Canonical Checkout POSTs are rejected and Google OAuth state/session cookies cross hosts and are lost. |
| PRR-02 | P0 | All four registered production cron routes return their unavailable response; production has no `CRON_SECRET` entry. | Queued Stripe lifecycle work, including refund/dispute entitlement reconciliation, is not processing. |
| PRR-03 | P1 | The candidate auto-deployed before E01 and inherited generic/shared Preview selectors while required branch/Test selectors are absent. | The deployed Preview is neither the isolated Test runtime nor safe evidence for Customer 360. |
| PRR-04 | P1 | Vercel SSO protection makes the deployment verifier fail before protected API checks. | The advertised immutable-host verification path cannot run against the actual candidate. |
| PRR-05 | P1 | The plan requires project-wide cron off, but the same project currently schedules four production jobs. | Following V01 literally would disable production processing; Preview cannot be safely exercised in this project. |
| PRR-06 | P1 | The requested real payment-rail test is not split into paid and zero-dollar rails, and several rails have no executable live acceptance proof. | FREEDEV can look green while receipt, PaymentIntent, refund, dispute, and portal behavior remain untested. |
| PRR-07 | P1 | Provider builds are Ready while emitting TypeScript diagnostics; the build verifier checks only output presence. | A green deployment/output check is not proof of a clean server build. |
| PRR-08 | P1 | Alert metadata has no named product destination and did not surface the observable cron outage. | The queue can remain broken without an actionable owner notification. |
| PRR-09 | P1 | Seven Customer 360 Postgres suites and the broader Postgres/single-device suites were not run. | Database behavior, migrations, RLS, queue recovery, and concurrency remain external release gates. |
| PRR-10 | P1 | FlowState is dirty and has no reviewed clean SHA paired with the website candidate. | P01 and live association QA cannot pass. |
| PRR-11 | P1 | FREEDEV retains a live-mode escape hatch and may create an unrestricted coupon. | Operator error can create a 100% live promotion outside the intended product. |
| PRR-12 | P2 | README/test-plan deployment statements and the FlowState pinned website SHA are stale. | A reviewer can make rollout decisions from false provenance. |
| PRR-13 | P3 | The provider build reported one low-severity dependency vulnerability. | It is not a current release blocker, but it needs a scoped dependency audit. |

## Detailed findings

### PRR-01 — P0: canonical Checkout and OAuth are broken by the old-host base URL

**Evidence**

- `api/_lib/account.ts:324-334` gives `SIDESTREAM_BASE_URL` precedence over the
  request host. `api/checkout/create.ts:38-48` compares the browser Origin with
  that configured base and rejects a mismatch as `csrf_rejected`.
- `api/_lib/account.ts:363-375` derives and validates the Google callback against
  the OAuth request origin. `api/_lib/account.ts:396-415` writes state/next
  cookies; `api/_lib/account.ts:5883-5900` does not support a `Domain` attribute,
  so those cookies are host-only. `api/_lib/account.ts:5954-5965` prefers
  `x-forwarded-host` when reconstructing the OAuth request origin.
- A read-only no-follow request to
  `https://sidestream.tv/api/auth/google/start?next=%2Faccount.html` returned
  `302` with a Google callback of
  `https://sidestream-xi.vercel.app/api/auth/google/callback`, while setting
  `sidestream_oauth_state` and `sidestream_oauth_next` on `sidestream.tv`.
- The same request on `sidestream-xi.vercel.app` kept the callback and host-only
  cookies on that old host. Non-API browser routes then redirect that host to
  canonical per `vercel.json:55-60`.
- The same origin validator protects JSON account mutations at
  `api/_lib/account.ts:337-350`, so this affects restore, transfer, and
  deactivation as well as Checkout.

**Concrete failure sequence**

1. A customer opens `sidestream.tv` and starts Google sign-in.
2. State cookies are stored only for `sidestream.tv`, but Google is instructed
   to call the old project host.
3. The callback request lacks the state cookie and cannot complete safely.
4. Starting on the old host avoids that first mismatch, but the resulting
   host-only session is lost when the browser is redirected to canonical.
5. Independently, a canonical Checkout or account mutation sends
   `Origin: https://sidestream.tv`; server-side `getBaseUrl()` resolves the old
   host, so the POST is rejected before the product rail runs.

**Recommended remediation**

Treat this as an immediate production configuration incident. Set Production
`SIDESTREAM_BASE_URL=https://sidestream.tv` and
`GOOGLE_REDIRECT_URI=https://sidestream.tv/api/auth/google/callback`, confirm the
exact callback in the Google client, redeploy, and prove canonical start,
callback, session, Checkout POST, restore, transfer, and deactivation. Redirect
old-host browser/auth entry requests to canonical before writing cookies; retain
only explicitly required non-browser API compatibility. Do not start the real
payment exercise until this passes.

### PRR-02 — P0: registered production workers are unavailable

**Evidence**

- `vercel crons list` for the linked `sidestream` project showed all four jobs
  registered: Stripe events every five minutes, download-lead replay every ten
  minutes, maintenance at 04:13, and Customer usage sync at 05:27.
- Secret-safe Production environment metadata had no `CRON_SECRET` entry.
- Safe unauthenticated GETs to the four live scheduled routes returned `503` with
  the route-specific sanitized codes `processor_unavailable`,
  `replay_unavailable`, `maintenance_unavailable`, and
  `customer_usage_sync_unavailable`.
- The implementations fail closed when the secret is absent:
  `api/internal/stripe-events/process.ts:18-20,50`,
  `api/internal/download-leads/replay.ts:326-329`,
  `api/internal/maintenance.ts:26-28,60`, and
  `api/internal/customer-usage/sync.ts:22-24,54`.
- The webhook architecture records work for the processor; the acceptance plan
  explicitly expects queued retry and lifecycle processing at
  `docs/customer-360-preview-test-plan.md:280-281,287`.

**Concrete failure sequence**

1. Stripe delivers a paid, refund, or dispute event and the webhook records it.
2. Vercel invokes the registered processor schedule.
3. The route cannot load its required secret and returns `503` before claiming
   work.
4. Refund/dispute canonical-state reconciliation and related entitlement changes
   remain queued; replay, maintenance, and usage sync are also stopped.
5. Duplicate or out-of-order correctness in local fixtures cannot compensate for
   a worker that never enters the claim path.

**Recommended remediation**

Open an incident gate before changing configuration: prove the connected
Production database/schema and deployment compatibility, inspect queue age and
terminal/dead-letter counts with an approved read-only query, and identify the
last successful run. Then add or rotate a strong `CRON_SECRET`, redeploy, verify
Vercel authorization semantics on each route, drain/reconcile the bounded
backlog, replay affected historical Stripe objects where needed, and install an
alert on age/failure. Do not merely add the secret without target and schema
proof, because that could release accumulated work into an incompatible runtime.

### PRR-03 — P1: the candidate auto-deployed into an unisolated Preview

**Evidence**

- Vercel metadata identifies deployment `dpl_DKQahSpKxaZ1hhx4dkBHsQd2t5Fy`,
  immutable host `sidestream-bzd25qzss-alex-3685s-projects.vercel.app`, branch
  `orch/customer360-offline-implementation-v2-20260717`, and exact commit
  `f955febb170890917e2ff98aadc9bb1ff64d2e6c`. It was built automatically and is
  Ready.
- `docs/customer-360-preview-test-plan.md:69-85,269-273` makes isolation E01 a
  prerequisite to deployment V01 and says the current Vercel Preview is
  Blocked.
- Secret-safe Vercel metadata shows generic Preview entries for Stripe, Google,
  database/storage, and base URL. Several selectors are shared as one
  Preview+Production entry, including `STRIPE_WEBHOOK_SECRET`,
  `GOOGLE_CLIENT_SECRET`, `SIDESTREAM_POSTGRES_*`, and storage/Supabase values.
- The candidate branch lacks required branch/Test metadata for
  `SIDESTREAM_TEST_POSTGRES_URL`, `SIDESTREAM_TEST_API_HOSTS`,
  `SIDESTREAM_TELEMETRY_POSTGRES_URL`, `SIDESTREAM_CRM_ADMIN_SECRET`,
  `CRON_SECRET`, `SIDESTREAM_LICENSE_HASH_SECRET`, and exact Pro Product/Price
  selectors. Rate-limit and lead hash secrets are scoped only to Production and
  Preview branch `codex/release-1.0.14`, not this candidate branch.
- `api/_lib/license-environment.ts:56-58,70-126` correctly fails closed unless an
  exact Test host and distinct Test database are configured. Other generic
  account/Checkout paths do not turn this auto-deployment into an isolated Test
  environment.
- The environment verifier covers databases, telemetry, Stripe mode/webhook,
  Google, base URL, CRM, and cron at
  `scripts/verify-customer-360-preview-environment.mjs:45-196`, but omits the
  exact Test API hosts, license/hash secrets, rate/lead hash secrets, Product and
  Price selectors, and Preview protection access.

**Concrete failure sequence**

1. The audit branch is pushed before E01 resources and selectors exist.
2. Git integration auto-deploys it into the existing project.
3. Vercel injects generic Preview values and omits branch-scoped values that are
   bound to a different branch.
4. SSO-authorized team traffic can reach a partially configured runtime whose
   account/database selectors are not the approved isolated Test target.
5. A green build or a partial environment check is mistaken for E01 proof.

**Recommended remediation**

Revoke this candidate as acceptance evidence. Disable Git auto-deploy for audit
branches or create a dedicated non-Production Vercel project before the next
candidate. Provision unique Test database, telemetry, Stripe, webhook, Google,
CRM, cron, hashing, Product/Price, and hostname selectors; extend the verifier to
cover every runtime selector and branch scope; then deploy only after an E01
snapshot passes.

### PRR-04 — P1: Vercel SSO protection is incompatible with the deployment verifier

**Evidence**

- Both the immutable candidate host and its branch alias returned `302` to
  `vercel.com/sso-api` with Vercel protection headers/cookie rather than a `200`
  application response.
- `scripts/verify-customer-360-preview-deployment.mjs:301-323` always sends the
  first request as unauthenticated `HEAD`, with `redirect: "manual"` and
  `credentials: "omit"`, and requires status `200` plus Vercel evidence.
- The verifier accepts Customer 360 admin and cron secrets later, but implements
  no Vercel protection bypass header/token or browser session mechanism.

**Concrete failure sequence**

1. A reviewer runs the documented verifier against the immutable candidate.
2. Vercel returns its SSO redirect on the initial host-evidence request.
3. The verifier stops at `deployment.host_evidence` before testing admin auth,
   origin, namespace, or usage sync.
4. No set of application secrets can make the advertised command pass.

**Recommended remediation**

Choose and document one auditable mechanism: a narrowly scoped Vercel protection
bypass token supported by the verifier, a separate allowlisted test deployment,
or a dedicated non-Production project without team SSO on this host. Keep the
token out of logs and require exact immutable host/commit verification. Add a
test fixture for the protection redirect and the approved bypass path.

### PRR-05 — P1: Preview's project-wide cron rule conflicts with production

**Evidence**

- `docs/customer-360-preview-test-plan.md:81-82,254-261,273,451-452` requires all
  four project-wide jobs disabled throughout Preview acceptance.
- Read-only project metadata shows those exact four jobs are registered on the
  same Vercel project that owns `sidestream.tv`.
- `vercel.json:8-24` declares the four schedules at project configuration scope;
  it does not provide a branch-specific schedule boundary.

**Concrete failure sequence**

1. An operator follows V01 and disables project cron for Preview safety.
2. The action also disables the production schedules for Stripe, replay,
   maintenance, and usage sync.
3. Production queue processing stops (and is already unavailable for PRR-02).
4. Alternatively, leaving cron enabled violates V01 and risks scheduling a
   partially isolated Preview if routing changes.

**Recommended remediation**

Move Preview to a separate Vercel project/scheduler or add reviewed per-job,
per-environment kill switches with default-deny Test routing. Rewrite V01 around
that real isolation boundary. Never disable the current project's schedules as a
Preview acceptance action.

### PRR-06 — P1: the real rail matrix can produce a false green result

**Evidence**

- Checkout is a one-time, card-only Payment-mode session with promotion codes and
  invoice creation at `api/_lib/account.ts:1212-1233`.
- Zero-dollar promotion completion deliberately permits
  `payment_status=no_payment_required`, `amount_total=0`, and no PaymentIntent at
  `api/_lib/account.ts:3386-3405`, then records the active reason
  `checkout_no_payment_required` at `api/_lib/account.ts:3867-3871`.
- Receipt requires a PaymentIntent/latest Charge and nonempty `receipt_url` at
  `api/billing/receipt.ts:24-27,54-96`; a FREEDEV checkout therefore cannot prove
  the paid receipt rail.
- The account refund action is an email handoff, not an API rail
  (`account.html:340-353`). Refund and dispute lifecycle tests must be driven by
  controlled Stripe test objects and the queue worker.
- The plan groups purchase/restore at I02 and commerce/refund/dispute at C01/C02
  (`docs/customer-360-preview-test-plan.md:277-280`), but it does not prescribe
  two separately evidenced checkouts or route-by-route receipt/portal outcomes.
- The deployment verifier begins with admin Customer 360 reads and usage sync;
  it does not execute Google OAuth, Checkout start/create/complete, webhook,
  receipt, portal, restore, transfer, or deactivation.

**Concrete failure sequence**

1. The operator uses FREEDEV for the single "real" sandbox checkout.
2. Checkout completes without a PaymentIntent or Charge and grants the comped
   entitlement correctly.
3. Receipt necessarily returns not found, and no paid refund/dispute object
   exists; portal behavior is also not demonstrated.
4. Local webhook fixtures pass, so the combined matrix is marked green despite
   never testing the real paid rail.

**Recommended remediation**

Require two isolated Stripe sandbox journeys after PRR-01 through PRR-05 pass:

1. A nonzero `$9.99` card Checkout using a Stripe test card. Prove Session,
   PaymentIntent, Charge, invoice, completion, webhook delay/duplicate/out-of-
   order handling, receipt URL, portal, partial refund, full refund, failed
   refund behavior, dispute open states, and terminal dispute states against the
   same Test customer lineage.
2. A separate FREEDEV zero-dollar Checkout. Prove `no_payment_required`, no
   PaymentIntent/receipt expectation, comped commerce, active entitlement, and
   Customer 360 projection without conflating it with the paid rail.

For both, prove anonymous install association, Google account association,
restore, transfer, deactivation, license verify/refresh, and Customer 360 reads.
Record sanitized provider object IDs/digests and expected route statuses. Never
use live-mode Stripe data for this gate.

### PRR-07 — P1: provider build diagnostics are ignored by the build gate

**Evidence**

- The candidate immutable deployment is Ready and its log proves branch, commit,
  static assets, and serverless functions, but the provider build log contains
  multiple `error TS...` diagnostics while compiling API functions, including
  account, Customer query, Stripe events, Checkout, and license authorization.
- The current repository TypeScript check at the exact candidate commit exits
  successfully, so the mismatch is specific to the provider function compiler
  context rather than proof that the diagnostics are harmless.
- `scripts/verify-vercel-build.mjs:19-48` checks only output `config.json`, eight
  function directories, and two bundled manifests. It does not consume the build
  log or reject TypeScript diagnostics.

**Concrete failure sequence**

1. Vercel emits function-level TypeScript errors but continues bundling.
2. The deployment is marked Ready.
3. `verify:vercel-build` sees the required directories/manifests and prints PASS.
4. Release review treats artifact presence as clean compilation and misses
   provider-specific type drift in critical API functions.

**Recommended remediation**

Reproduce the Vercel function compiler locally/CI with the same Node and builder
configuration, make its diagnostics fatal, and archive a clean provider build
log tied to deployment ID and commit. Extend the build gate to reject provider
TypeScript errors, not only missing output. Retain the existing output-presence
checks as a separate assertion.

### PRR-08 — P1: observability is not capable of owning the current outage

**Evidence**

- `vercel alerts rules ls` returned only `ar_default`. Its metadata has
  `notifications: []` and a generic error/critical filter; no named product owner
  or destination was present.
- Generic resolved error-anomaly groups existed, but there was no rule or
  destination specific to Stripe queue age/failure, replay, maintenance, usage
  freshness, or repeated cron `503`.
- The acceptance plan requires outcome/count/lag, auth/error rate, read budget,
  owner, destination, and injected alert proof at
  `docs/customer-360-preview-test-plan.md:288,453-457`.

**Concrete failure sequence**

1. Cron routes repeatedly return `503` or queued rows age without processing.
2. A generic anomaly may be recorded, but no Customer 360/payment owner receives
   an actionable notification with a sanitized route/outcome.
3. Refund/dispute lag persists until manual inspection.

**Recommended remediation**

Create named alerts with an explicit owner and tested destination for worker
unavailability, oldest pending/leased/dead-letter age, failed claim counts,
webhook-to-reconciliation lag, replay failures, maintenance failure, and usage
freshness/read budget. Inject each failure in isolated Test and retain the
notification evidence without payloads or customer identifiers.

### PRR-09 — P1: database-backed gates remain unexecuted

**Evidence**

- `scripts/run-customer-360-tests.mjs:12-33` explicitly classifies ten
  non-Postgres and seven Postgres Customer 360 suites.
- `scripts/run-api-tests.mjs:23-57` rejects unclassified Customer 360/Postgres
  tests, then deliberately excludes all Postgres-only suites from `test:api`.
- `SIDESTREAM_TEST_POSTGRES_URL` was absent in this audit environment. Therefore
  `test:customer-360-postgres`, `test:postgres-integration`, and
  `test:single-device` were not run. This is an explicit Blocked gate, not a
  hidden test skip.
- The plan itself requires an approved disposable URL for those commands at
  `docs/customer-360-preview-test-plan.md:246-257` and connected target/migration
  proof at D01/D02 (`:271-272`).

**Concrete failure sequence**

1. Non-database suites pass and report no skipped tests.
2. A reviewer assumes that includes migrations, RLS/grants, SQL concurrency,
   identity merge, usage sync, and queue persistence.
3. The seven intentionally excluded suites never connect to a disposable target,
   leaving those behaviors unproved.

**Recommended remediation**

Provision a human-approved disposable Postgres URL, snapshot/recreate owner, and
authenticated target proof; run all three documented Postgres commands and the
checksummed migration/RLS/grant gates. Archive actual TAP totals and target
fingerprints. Do not substitute the current Production or generic Preview URL.

### PRR-10 — P1: FlowState provenance is not releasable

**Evidence**

- The adjacent FlowState checkout is on `codex/release-1.0.14` at `41ea27c`, but
  `git status --short` reports modifications to `README.md`, `css/main.css`,
  `docs/product-capabilities.md`, `js/app.js`, and
  `scripts/test-download-clickthrough.mjs`.
- P01 requires clean website and FlowState SHAs, reviewed diffs, and matching
  artifact provenance at `docs/customer-360-preview-test-plan.md:269`.
- FlowState `docs/customer-360-integration.md:5-7` pins website commit
  `e6ae2c...`, not this candidate `f955feb...`.

**Concrete failure sequence**

1. Integration QA is run from the dirty FlowState checkout.
2. Its behavior cannot be attributed to `41ea27c` or reconstructed from a clean
   commit.
3. The contract document points reviewers to an older website implementation.
4. A passing UI exercise cannot satisfy P01 or establish rollback compatibility.

**Recommended remediation**

Resolve and review the FlowState changes, commit or discard them outside this
audit, select a clean candidate SHA, update its website contract pin after
website remediation lands, and rebuild the Test bundle. Record the exact paired
SHAs and rerun the integration suite and live Preview QA from clean worktrees.

### PRR-11 — P1: FREEDEV has an unsafe live escape hatch

**Evidence**

- `scripts/ensure-freedev-promo.mjs:15-26` accepts `--allow-live`, explicitly
  permitting mutation under an `sk_live_` key.
- The script creates a 100%-off once coupon and promotion at
  `scripts/ensure-freedev-promo.mjs:51-94`.
- If exact Price/Product discovery fails, lines `86-92` intentionally create the
  coupon without a product restriction. `isFreedevCoupon()` at `:157-163` does
  not require `applies_to` or the sandbox purpose metadata.

**Concrete failure sequence**

1. An operator points the helper at a live key and supplies `--allow-live`.
2. Product lookup fails or targets a stale selector.
3. The helper creates/reuses a valid 100%-off coupon without a product boundary.
4. The promotion can comp unrelated live Checkout products while still passing
   the helper's validity check.

**Recommended remediation**

Remove live mode entirely from this development helper. Require an `sk_test_`
key, exact expected test account fingerprint, exact active Price and Product,
and a coupon restricted to that Product; fail closed if any lookup is missing.
Make reuse validate purpose metadata, account mode, and `applies_to`.

### PRR-12 — P2: provenance documentation is stale

**Evidence**

- `README.md:20,185-208,675-677,756` describes Customer 360 as not deployed and
  says no deployment occurred/current Preview remains rejected. The preview plan
  keeps provider evidence Blocked at
  `docs/customer-360-preview-test-plan.md:269-273,300-311`. Provider metadata,
  however, proves the exact candidate commit auto-deployed as Ready under
  immutable deployment `dpl_DKQahSpKxaZ1hhx4dkBHsQd2t5Fy`.
- `docs/customer-360-preview-test-plan.md:300-311` still has every manual row as
  placeholder Blocked evidence. That status is directionally correct, but it
  omits the unauthorized/automatic deployment that must be revoked from evidence.
- FlowState's contract pin is stale as described in PRR-10.

**Concrete failure sequence**

1. A reviewer reads "not deployed" and assumes no provider exposure occurred.
2. They do not inspect or revoke the SSO-protected auto-deployment and its shared
   Preview environment.
3. Later evidence is attached to the wrong SHA or mutable alias.

**Recommended remediation**

After the P0/P1 fixes land, update README and the Preview plan with the actual
auto-deployment history, revocation status, chosen isolated project, immutable
deployment ID/host, and exact paired website/FlowState SHAs. Keep "implemented",
"auto-deployed", "accepted in Preview", and "Production" as separate states.

### PRR-13 — P3: low dependency advisory remains

**Evidence**

- The Vercel build log reported one low-severity npm vulnerability. The current
  build gate at `scripts/verify-vercel-build.mjs:19-48` does not inspect dependency
  advisory output.

**Concrete failure sequence**

1. The warning remains buried in provider logs while output verification passes.
2. It can drift upward or remain unowned across releases.

**Recommended remediation**

Run a scoped, non-mutating dependency audit, identify the exact package and
runtime reachability, then update only if justified by impact and compatibility.
Do not run an unreviewed broad dependency rewrite as part of the P0 incident.

## Functional rail reconciliation

| Rail | Class | What is proved | What is not safe/proved | Recommended remediation or external gate |
| --- | --- | --- | --- | --- |
| Purchase | P0 | Local code creates one-time card Checkout with a single Price. | Canonical POST is rejected by origin mismatch; Test Price/Product isolation is absent. | Fix PRR-01/03, then execute nonzero sandbox Checkout. |
| Completion | P1 | Local fixtures cover completion and zero-dollar canonicalization. | No live isolated paid completion evidence or exact immutable-host execution. | Prove paid and FREEDEV completion separately. |
| Webhook delay | P0 | Local queue/retry behavior is tested. | Production processor is unavailable. | Restore/observe worker, then test bounded delayed delivery in Test. |
| Duplicate/out-of-order webhook | P0 | Local API tests cover idempotent negative lifecycle sequences. | Live queue cannot process; no isolated Stripe object evidence exists. | Execute controlled Test event ordering after worker recovery. |
| FREEDEV promotion | P1 | Zero-dollar `no_payment_required` completion is supported. | Live escape hatch and unrestricted fallback are unsafe. | Remove live mode/product fallback and run a separate Test checkout. |
| Receipt | P0 | Paid Charge receipt extraction exists. | OAuth is broken; FREEDEV has no receipt; no paid isolated receipt was proved. | Prove canonical sign-in and nonzero Charge `receipt_url`. |
| Portal | P0 | Route requires an associated Stripe customer. | OAuth/session is broken and provider portal configuration was not proved. | Prove canonical session, linked Test customer, return URL, and portal config. |
| Refund success/failure | P0 | Local lifecycle logic and fixtures exist; UI hands requests to email. | Production processor is unavailable; no canonical Test object sequence exists. | Recover worker, then drive partial/full/failed refund scenarios in Stripe Test. |
| Dispute open/terminal | P0 | Local mapping covers open and terminal states. | Production processor is unavailable; no alert or isolated provider evidence exists. | Drive all documented statuses in Test and prove entitlement plus Customer 360 money projections independently. |
| Restore | P0 | Route and local regression coverage exist. | Canonical same-origin/account session is broken. | Fix origin/OAuth and run signed-in restore against the same Test root. |
| Transfer | P0 | Route and local regression coverage exist. | Canonical same-origin/account session is broken. | Prove transfer, device revocation, and retained customer lineage. |
| Deactivate | P0 | Route and local regression coverage exist. | Canonical same-origin/account session is broken. | Prove canonical mutation and credential revocation. |
| Anonymous-to-account association | P1 | Cross-repo transport/privacy contract passes locally. | No clean paired FlowState SHA or live isolated host exists. | Pair clean SHAs and run I01/I02/F01 against isolated Test. |
| Customer 360 reads | P1 | Query/API suites and verifier fixtures pass locally. | Preview SSO blocks verifier; DB/env isolation is absent; Postgres suites are blocked. | Complete E01/D01/D02, add SSO bypass, run list/detail/cursor/privacy checks. |

## PASS observations

### PASS-01 — exact-candidate local non-Postgres coverage

**Evidence**

- `npm run test:customer-360` passed all ten classified non-Postgres suites at
  exact candidate `f955feb`.
- `npm run test:api` passed **300 tests, 0 failed, 0 skipped** at that same clean
  commit, including the newly registered Preview deployment/environment,
  retention, telemetry TLS, Stripe claim-cap, and dead-letter tests.
- Registry completeness is enforced by
  `scripts/run-customer-360-tests.mjs:38-56` and
  `scripts/run-api-tests.mjs:23-49`.

**Concrete sequence**

1. The runners enumerate files and reject unclassified Customer 360/Postgres
   tests.
2. The non-Postgres Customer 360 set and broader API suite execute at the exact
   candidate.
3. TAP reports no test skip or failure.

**Recommended remediation**

Preserve this PASS as local evidence, but do not promote it to database,
provider, OAuth, cron, or live payment evidence. Pair it with PRR-09's external
Postgres gate and the remediated provider gates.

### PASS-02 — FlowState association transport and privacy contract matches

**Evidence**

- FlowState `docs/customer-360-integration.md:58-106` limits association to the
  four intended license routes and three optional hashed/support fields, and
  requires `verificationStatus="passed"` before receipt association.
- FlowState `js/app.js:1789-1838` strips caller-supplied association fields and
  rebuilds the supported payload only on those routes.
- FlowState `js/logger.js:4185-4217` requires canonical hash/support forms and a
  locally passed receipt verification.
- `npm run test:customer-360-integration` passed anonymous continuity, telemetry
  privacy, proxy/cache/dashboard, and production browser-bundle checks in the
  inspected checkout.

**Concrete sequence**

1. The panel has locally verified optional association facts.
2. The proxy removes any caller injection and reconstructs only the allowed
   fields on the four association routes.
3. The website receives no raw install ID or unverified receipt association.

**Recommended remediation**

Keep the contract unchanged unless a reviewed cross-repo change is necessary.
Resolve PRR-10, pin clean paired SHAs, rebuild, and repeat the same suite plus
live Test QA.

### PASS-03 — old-host browser redirects preserve API compatibility boundary

**Evidence**

- `vercel.json:45-60` redirects only paths that do not begin with `api/` from the
  old hosts to `https://sidestream.tv`.
- Safe requests showed old-host `/` and `/account.html` returning permanent
  canonical redirects, while an old-host API session request reached the API
  method boundary rather than being redirected.

**Concrete sequence**

1. A legacy browser page request canonicalizes.
2. A legacy activation/license API client remains on the API host and can retain
   backward compatibility.

**Recommended remediation**

Preserve the non-browser API exception, but fix PRR-01 by canonicalizing browser
auth entry before cookies are set and documenting which old-host API routes are
still supported.

### PASS-04 — immutable candidate provenance is discoverable

**Evidence**

- Vercel inspect/build metadata ties deployment
  `dpl_DKQahSpKxaZ1hhx4dkBHsQd2t5Fy` and immutable host
  `sidestream-bzd25qzss-alex-3685s-projects.vercel.app` to branch
  `orch/customer360-offline-implementation-v2-20260717` and exact commit
  `f955febb170890917e2ff98aadc9bb1ff64d2e6c`.
- The output includes the expected static assets and serverless functions.

**Concrete sequence**

1. Inspect the immutable deployment rather than a mutable alias.
2. Match its Git branch and commit to the audited candidate.
3. Match emitted assets/functions to build output.

**Recommended remediation**

Retain the deployment ID as evidence of the unsafe auto-deploy, not as V01 PASS.
A replacement candidate still needs E01 isolation, clean provider compilation,
SSO-compatible verification, and an artifact digest/attestation.

## Rollout and rollback verdict

The code has meaningful local coverage and a conservative Test license selector,
but the current live and provider state defeats the rollout assumptions. Two
conditions are already production-impacting: canonical OAuth/Checkout origin
split and unavailable cron workers. The candidate also auto-deployed into the
wrong Preview boundary, cannot be checked by its deployment verifier, and has no
clean paired FlowState SHA or database-backed acceptance evidence.

The smallest safe order is:

1. Incident-remediate and verify PRR-01 and PRR-02 on Production without running
   Customer 360 migrations or the payment test.
2. Add actionable worker/queue alerts and reconcile the bounded production
   backlog.
3. Remediate PRR-03 through PRR-07 and PRR-11 in code/configuration; create a
   separate isolated Preview project/scheduler boundary.
4. Run the complete disposable Postgres gate and prove D01/D02.
5. Produce clean paired website/FlowState SHAs and immutable build provenance.
6. Execute the two-journey paid/FREEDEV matrix, then failure injection and the
   non-Production rollback/recreate drill.
7. Only after every P01-RB1 row has timestamped PASS evidence should a separate
   Production plan be commissioned.

Rollback compatibility is **Blocked**, not failed: the plan's recreate-first
strategy is sound (`docs/customer-360-preview-test-plan.md:424-438`), but no
isolated snapshot, restore owner, clean last-known Preview artifact, or distinct
database currently exists. The auto-deployed candidate must not be called the
rollback target, and project-wide cron must not be disabled to simulate Preview.

## Audit command evidence ledger

The following read-only commands/surfaces informed this report:

- `git status --short`, `git rev-parse`, `git merge-base`, `git log`, and
  `git diff --stat/--name-status` for exact website and FlowState provenance;
- `npm run test:customer-360`, `npm run test:api`,
  `npm run test:customer-360-integration`, and candidate `tsc --noEmit`;
- secret-safe `vercel project inspect`, `vercel env ls`, `vercel inspect
  --logs`, `vercel crons list`, and `vercel alerts ...` metadata;
- no-follow unauthenticated HTTP checks to canonical/old/immutable hosts and the
  four cron routes.

No Product code, test, provider setting, database, Stripe object, Google client,
FlowState file, deployment, cron, or alert was modified during this audit.

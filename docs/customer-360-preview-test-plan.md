# Customer 360 Preview/Test acceptance and rollback plan

## Authority, scope, and current decision

This is the canonical execution matrix for Customer 360 Preview/Test acceptance.
The durable data, identity, API, and privacy contract remains
[`customer-360.md`](customer-360.md). This plan authorizes only a separately
provisioned, human-approved non-Production Preview deployment and the Test
license namespace. It is not a Production procedure, a deployment record, or
permission to migrate, backfill, query, or change Production.

**Current decision as of 2026-07-17: Blocked.** The inspected Vercel Preview
environment is rejected because its database, Stripe, Google, and base URL
values match Production. No secret values are reproduced here. Provisioning and
approving an isolated Preview target is a human-owned gate. Until that happens,
do not deploy the Customer 360 candidate, contact protected Preview routes,
apply migrations, invoke usage sync, apply backfill, or run live FlowState QA.
The supplied current-state evidence did not include an exact UTC observation
time; capture a fresh verifier run instead of inventing or backdating one.

Passing this plan means only that the named Customer 360 candidate satisfied the
recorded Preview/Test gates. It does not authorize Production, enable device
enforcement, close existing entitlement blockers, or prove a release safe.

## Evidence and status rules

Use one restricted evidence bundle outside the repository for a single candidate
commit and immutable Preview deployment. The bundle must contain a manifest with
the commit SHA, artifact/deployment ID, immutable hostname, reviewer, isolated
provider resource IDs or secret-safe fingerprints, and every referenced file or
screenshot. Do not capture environment values, database URLs, bearer tokens,
OAuth secrets, Stripe secrets, raw customer rows, raw identity links, telemetry
payloads, or backfill input.

Every observation uses one of these exact statuses:

- **Pass**: the reviewer observed the expected result against the recorded
  candidate and attached evidence.
- **Fail**: the reviewer observed a result that violates the contract. Stop and
  follow the non-Production rollback/recreate section.
- **Blocked**: a prerequisite, authority, target, tool, or evidence item is
  missing. Do not execute dependent rows.

Use `Pass/Fail/Blocked` exactly in the evidence log. Record timestamps as complete
UTC ISO 8601 values such as `2026-07-17T19:42:11Z`; local times and date-only
entries are invalid. A command passing on a developer machine is not evidence
that the Preview target, deployment, migration, scheduler, or provider state
passed.

## Hard stop conditions

Stop immediately, mark the active row Fail or Blocked, and do not run dependent
steps when any of the following is true:

- the candidate commit, deployed artifact, or immutable hostname cannot be
  proved, the candidate worktree is dirty, or the reviewed file scope differs
  from the deployed scope;
- any Preview database alias resolves to Production, Preview Stripe is not an
  isolated test-mode account/key, the Google client or secret is shared with
  Production, the Preview base URL equals Production, or CRM, cron, webhook, or
  telemetry configuration is shared across the boundary;
- a human has not named the isolated Preview runtime database, read-only
  telemetry source, Stripe test account, Google client, base URL, secret owners,
  and rollback owner;
- there is no pre-migration snapshot/recreate proof, authenticated connected
  target proof, migration checksum proof, or live RLS/grant proof;
- migration state has unexplained files, order drift, checksum drift, runtime
  DDL, overly broad grants, or an unreviewed baseline;
- Vercel project-wide cron is enabled. This plan keeps all four project jobs
  disabled and uses only the separately confirmed one-time usage-sync verifier;
- the hostname is mutable/ambiguous, redirects to another host, resolves to a
  Production alias, does not return Vercel deployment evidence, or does not map
  to the reviewed commit/artifact;
- a protected API leaks a credential, identity value, provider ID, raw payload,
  search/content value, or cacheable response; accepts browser Origin; crosses
  namespace; or violates auth, cursor, filter, pagination, schema, or nullability;
- anonymous-to-account, purchase, restore, or merge continuity produces a
  second live root, crosses namespaces, changes entitlement/device state, or
  silently overwrites a conflict/pending-review decision;
- commerce double-counts a fallback and instrument, sums currencies, treats
  billing history as current subscription state, grants entitlement, or mishandles
  refunds/disputes;
- usage sync exceeds the approved read budget, has unexplained failure or lag,
  cannot prove daily idempotency/decay/overlap behavior, or changes raw telemetry;
- backfill input digest changes, an orphan/conflict lacks disposition, a batch or
  checkpoint is incomplete, a rerun is not idempotent, or any Production apply
  is proposed;
- FlowState contacts a non-approved origin, exposes the bearer credential,
  accepts a non-passed installer receipt, is reachable beyond loopback, eagerly
  loads Customers, silently falls back to fixtures, or violates the privacy list;
- a required regression, alert, failure-injection, rollback/recreate, or evidence
  row is not Pass.

## Supported automated commands

These are repository-supported commands, not substitutions for manual evidence.
Run them from clean checkouts at the exact candidate commits and attach redacted
stdout/stderr plus exit status to the evidence bundle.

### Website repository: local and fixture gates

```bash
git rev-parse HEAD
git status --porcelain=v1
git diff --check
npm run test:customer-360
npm run test:api
npm run test:download-referral
npm run test:migrations
node scripts/assert-no-runtime-ddl.mjs
npm run verify:vercel-contract
npm run typecheck
npm run build
npm run db:migrate -- --validate
npm run db:migrate -- --dry-run
node scripts/verify-customer-360-backfill.mjs --self-test
```

The clean-tree gate passes only when `git status --porcelain=v1` prints nothing.
Local migration validation/dry-run opens no database and cannot prove connected
target, ledger, RLS, grants, or remote transport. No Production status, baseline,
migration, or backfill command is authorized by this plan.

### Website repository: secret-safe isolation preflight

After a human provisions restricted Preview and Production environment snapshots,
run the offline comparison. Paths are selectors; values stay in the restricted
files and the verifier prints only Pass/Fail variable names and database target
fingerprints.

```bash
npm run verify:customer-360-preview-environment -- \
  --preview-env-file /absolute/restricted/path/preview.env \
  --production-env-file /absolute/restricted/path/production.env
```

Exit 0 is necessary but not sufficient. The command does not contact Vercel,
Postgres, Stripe, or Google and cannot prove provider ownership, connected target,
database grants, deployment identity, or live route behavior.

### Website repository: bounded Preview deployment verification

Only after environment, provider, migration, snapshot, host, and artifact rows
are Pass, run read-only verification against the exact immutable Preview host.
Keep the secret in the process environment, never after `--`.

```bash
SIDESTREAM_CRM_ADMIN_SECRET='<approved Preview secret in process environment>' \
  npm run verify:customer-360-preview-deployment -- \
  --origin https://<immutable-preview-host> \
  --expected-deployment-host <immutable-preview-host>
```

The verifier refuses Production/local/IP/credential-bearing/ambiguous targets,
proves a matching Vercel response before sending the credential, and runs a fixed
read-only auth, Origin, no-store, namespace, list-shape, and route-presence suite.
It does not prove commit metadata, database state, detail behavior, provider
configuration, scheduling, commerce, backfill, or FlowState integration.

After every prior usage row is Pass, one reviewer may invoke exactly one Test
usage sync. Project-wide cron remains disabled. The confirmation is bound to the
immutable host and both secrets remain process environment values.

```bash
SIDESTREAM_CRM_ADMIN_SECRET='<approved Preview secret in process environment>' \
CRON_SECRET='<approved Preview cron secret in process environment>' \
  npm run verify:customer-360-preview-deployment -- \
  --origin https://<immutable-preview-host> \
  --expected-deployment-host <immutable-preview-host> \
  --mode usage-sync \
  --confirm RUN_CUSTOMER_360_USAGE_SYNC_ONCE:<immutable-preview-host>
```

An earlier verifier failure prevents the write. Do not repeat the command to
make a failure disappear; record the failure, investigate, and obtain a new
review decision. Do not enable project-wide cron for this acceptance plan.

### FlowState repository: local/fixture gates

Run from the separately reviewed FlowState candidate root:

```bash
git rev-parse HEAD
git status --porcelain=v1
git diff --check
npm run test:customer-360-integration
npm run test:license-entitlement
npm run test:telemetry-classification
npm run test:speculative-downloads
npm run test:updater
npm run check
```

Run the dashboard-specific bundle and tests from `FlowState/analytics/`:

```bash
npm run build
npm test
```

These FlowState commands are fixture/local gates. They do not prove a live
Customer API, Preview deployment, migration, backfill, scheduler, or Production
state.

## Ordered acceptance matrix

Rows are dependency ordered. A blocked or failed row blocks every dependent row.

| ID | Gate and required proof | Expected result | Stop or rollback trigger |
| --- | --- | --- | --- |
| P01 | Candidate provenance and clean-tree scope | Website and FlowState SHAs, reviewed diffs, clean status, automated output, immutable artifact ID, and deployment-to-SHA evidence all agree. | Dirty tree, unreviewed files, mutable alias only, artifact/commit mismatch, or missing build provenance. |
| E01 | Preview/Production isolation | Offline verifier passes; provider evidence shows a unique Preview runtime database, unique telemetry source, Stripe test mode, unique webhook/Google/CRM/cron secrets, unique Google callback, and unique HTTPS base URL. | Any collision, malformed/missing value, live Stripe key, provider ambiguity, or shared owner/resource. Current Vercel Preview is Blocked here. |
| D01 | Database snapshot and authenticated target proof | Reviewer records provider project/branch/database identifiers or fingerprints, authenticated hostname/certificate evidence, runtime versus telemetry role, pre-migration snapshot ID, restore/recreate owner, and successful isolated restore drill. | Target cannot be distinguished from Production/disposable test, TLS identity is unauthenticated, snapshot is absent/unrestorable, or telemetry role is not read-only. |
| D02 | Checksummed migrations, RLS, and grants | Local validation passes; approved non-Production apply produces exact ledger filenames/checksums; live catalog shows all expected tables/functions/indexes, RLS enabled, and no direct `anon`/`authenticated` access. Runtime role has only required access and no runtime DDL. | Pending/unexpected file, checksum drift, unexplained baseline, RLS disabled, broad schema/table/function grant, runtime DDL, or partial migration. Restore/recreate from D01. |
| V01 | Vercel Preview artifact and scheduling | Immutable Preview hostname maps to P01 artifact and E01 environment. Vercel project-wide cron is disabled for all four declared jobs. No scheduled invocation occurred. | Alias/redirect ambiguity, wrong commit/environment, Production host, or any project-wide cron enablement. Revoke access and redeploy last known Preview artifact. |
| A01 | Protected admin API transport and auth | Missing, wrong, duplicate, and combined bearer credentials return `401`; missing server config returns `503`; any Origin returns `403`; unsupported methods return `405`; JSON/no-store/nosniff/Vary headers match contract; no secret appears anywhere. | Credential accepted incorrectly, browser/CORS access, cacheable response, redirect, body/header leak, or unstable error. |
| A02 | Namespace, filters, cursor, pagination, nullability, and privacy | List/detail require explicit `test`; `production` results never appear; allowed filters work; unknown/search/identity filters fail; cursors bind namespace/limit/all filters and reject tamper/reuse; pages are stable with terminal null cursor; detail/list shapes match; null-heavy rows render; all excluded fields remain absent. | Cross-namespace row, unbound/decodable cursor, duplicate/missing page row, schema/nullability mismatch, raw identity/provider/telemetry/content field, or merged tombstone returned. |
| I01 | Anonymous install and association keys | A new valid Test `installIdHash` creates one sparse profile. Canonical support code and only a locally verified `verificationStatus="passed"` receipt hash associate to that same root through supported JSON bodies. Missing/null/empty values omit cleanly; malformed/caller-injected values fail/are stripped. | Raw install ID stored, identity placed in URL/browser state, receipt without passed verification sent, association used as authentication/entitlement, or a second profile created. |
| I02 | Sign-in, purchase, restore, and merge continuity | Starting from I01, Google sign-in, sandbox purchase, activation/license verify/refresh, signed-in restore, and eligible merge retain one live Test customer root. Tombstone stays hidden; contact comes only from verified account; entitlement/device rows change only through their existing flows. | Duplicate live roots, email-driven merge, namespace crossing, unverified Stripe attachment, lost activation continuity, unexpected device/entitlement mutation, or tombstone exposure. |
| I03 | Conflict and pending-review behavior | Contradictory unique identity creates immutable `pending_review` with hashed evidence and visible quality flag; no overwrite/automatic merge occurs. Payment-group ownership conflict quarantines the whole group until explicit deterministic resolution/recompute. | Silent winner replacement, partial evidence, leaked raw evidence, cleared sticky conflict without explicit recomputation, money assigned across owners, or cross-namespace merge. |
| C01 | One-time, subscription, comped, mixed, and multi-currency commerce | Sandbox fixtures/events produce each billing history model; settled instruments replace fallbacks; renewals remain distinct; comped may be zero; at least two currencies remain separate minor-unit rows; `offStripePaidMinor` stays a subset; no commerce field grants entitlement or implies current subscription. | Double count, float parsing, cross-currency sum, fallback retained after instrument, model/current-state confusion, or commerce-driven entitlement change. |
| C02 | Refund/dispute and negative commerce cases | Partial/full refunds and supported open/lost dispute states reduce net exactly once and floor at zero. Won/reversed/closed states release disputed amount as defined. Duplicate/out-of-order events are idempotent. Unpaid Checkout, open/canceled InvoicePayment, uncaptured charge, wrong product, unrelated Checkout, and conflicting ownership do not inflate money. | Negative/duplicated totals, wrong event routing, unsupported status silently accepted, invalid product included, refund/dispute changes entitlement, or identity conflict ignored. |
| U01 | Once-daily aggregate, lag, decay, retry, and idempotency | Before the one-time sync, reviewer approves source/row/read-byte/query-duration budgets and lag threshold. One Test run reports bounded counts/freshness. Same-day retry is `skipped`, concurrent injection is `locked`, repeated source rows replace rather than add, 48-hour overlap repairs late rows, rolling 7/30-day values decay on rematerialization, and failed batches retry without duplicates. | Budget exceeded, source write, unexplained stale/null freshness, count inconsistency, duplicate bucket/profile values, retry drift, wrong denominator, or non-decaying window. |
| B01 | Offline backfill dry-run | Reviewed input is offline and privacy-limited. Dry-run opens no database/writes no checkpoint and records input digest, candidate/orphan/conflict totals, component refs, and reviewer dispositions. Production apply remains impossible. | Network/database access during dry-run, digest change, forbidden input, raw evidence leak, unresolved orphan/conflict, or any Production selector/apply proposal. |
| B02 | Test-only backfill recovery, if separately authorized | A new human approval names the isolated Test target, digest, checkpoint, batch size, and rollback owner. Batches are atomic/append-only; injected failure rolls back a batch; post-commit checkpoint failure resumes safely; mismatched checkpoint fails closed; complete rerun is idempotent/no-op. | Dry-run approval reused as apply approval, wrong target/digest, partial batch, incomplete/mismatched checkpoint, non-idempotent rerun, audit deletion, or improvised down SQL. Restore/recreate, never apply Production. |
| F01 | FlowState Test origin, receipt, proxy, cache, UI, and privacy | Server-only origin is the exact V01 HTTPS origin; `/test` maps only to Test; credential is absent from CEP/browser/bundle/logs; proxy is loopback-only; non-loopback Host/Origin fails before egress; Customers loads only when selected; 25-row cursor pages work; exact-key 15-minute cache and manual refresh behave; refresh failure preserves page; receipt gating and exclusions hold. | Production/wrong origin, public/LAN/tunnel bind, browser secret, eager/background fetch, fixture fallback during configured failure, cache cross-key bleed, malformed receipt sent, or excluded data exposed. |
| R01 | Existing website and FlowState regression | Account/session, activation start/status/claim, license verify/refresh, transfer/deactivation, download authorization, Checkout completion, webhook queue/retry, maintenance, installer Mac/Windows downloads, update manifest, public root/redirect/assets/SEO, FlowState downloads, telemetry, and updater retain documented behavior. | Any existing route, public page, installer, release manifest, entitlement, device, webhook, or download regression. |
| O01 | Observability, alerts, and failure injection | Evidence captures structured usage outcome/counts, lag, quality/conflict counts, auth/error rates without payloads/secrets, read budget, and owner/alert destination. Inject wrong auth/Origin/cursor, upstream timeout/invalid schema, sync lock/failure/retry, Stripe duplicate/out-of-order negative cases, and backfill checkpoint failure; alerts fire and sanitized behavior matches. | Missing owner/alert, secret/customer payload in log, expected failure not detected, unsafe automatic retry/fallback, stale page discarded, or no retained failure evidence. |
| RB1 | Non-Production rollback/recreate drill | With project-wide cron already disabled, revoke Preview admin/cron access, stop any approved invocation, redeploy last known Preview artifact, restore/recreate only the isolated database from D01, restart FlowState to clear cache, and prove Production untouched. Preserve evidence/checkpoints; use no down SQL and delete no audit rows. | Production access/change, inability to restore/recreate, deleted audit evidence, improvised reverse migration, or unbounded outage/egress. |

## Manual evidence table

Copy this table into the restricted run evidence and add rows as needed. Do not
pre-fill a Pass. A reviewer must choose exactly `Pass`, `Fail`, or `Blocked` and
record the actual observation time in UTC. A missing timestamp, evidence
reference, candidate SHA, immutable host, or reviewer makes the row Blocked.

| Matrix ID | Status (Pass/Fail/Blocked) | UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`) | Website SHA / FlowState SHA | Immutable Preview host or local fixture | Secret-safe evidence reference | Reviewer / notes |
| --- | --- | --- | --- | --- | --- | --- |
| P01 | Blocked | `<capture actual UTC>` | `<sha> / <sha>` | `<host or local>` | `<bundle path/id>` | Awaiting execution |
| E01 | Blocked | `<capture actual UTC>` | `<sha> / n/a` | `<host>` | `<preflight output + provider proof>` | Current Vercel Preview is rejected; isolated provisioning is human-owned |
| D01-D02 | Blocked | `<capture actual UTC>` | `<sha> / n/a` | `<database fingerprint>` | `<snapshot, target, ledger, RLS/grant proof>` | Awaiting isolated target |
| V01-A02 | Blocked | `<capture actual UTC>` | `<sha> / n/a` | `<immutable host>` | `<deployment/verifier/manual API evidence>` | Depends on E01-D02 |
| I01-I03 | Blocked | `<capture actual UTC>` | `<sha> / <sha>` | `<immutable host>` | `<privacy-safe lineage/conflict evidence>` | Depends on API gates |
| C01-C02 | Blocked | `<capture actual UTC>` | `<sha> / n/a` | `<Stripe test account fingerprint>` | `<currency/event/totals evidence>` | Sandbox only |
| U01 | Blocked | `<capture actual UTC>` | `<sha> / n/a` | `<immutable host>` | `<budget, one-time sync, lag/decay evidence>` | Project-wide cron stays disabled |
| B01-B02 | Blocked | `<capture actual UTC>` | `<sha> / n/a` | `<offline / isolated DB>` | `<digest/report/checkpoint evidence>` | B02 requires separate approval; no Production apply |
| F01 | Blocked | `<capture actual UTC>` | `<sha> / <sha>` | `<loopback + immutable host>` | `<proxy/UI/cache/privacy evidence>` | Live FlowState QA is last integration gate |
| R01-O01 | Blocked | `<capture actual UTC>` | `<sha> / <sha>` | `<host or local>` | `<regression, alert, injection evidence>` | Awaiting execution |
| RB1 | Blocked | `<capture actual UTC>` | `<sha> / <sha>` | `<isolated Preview resources>` | `<revocation/redeploy/restore evidence>` | Required before hard exit |

## Detailed manual assertions

### Database and deployment

1. Record the isolated provider project/branch/database identity using a
   provider-issued ID or verifier fingerprint, not a URL. Prove the connected
   identity after authentication, including hostname/certificate verification.
2. Record the runtime role and the separate telemetry role. Prove telemetry is
   read-only and cannot write the source relation. Prove runtime cannot perform
   DDL and browser-facing `anon`/`authenticated` roles cannot read server tables
   or execute private functions.
3. Capture a pre-migration snapshot/recreate point and restore it into another
   isolated non-Production resource before applying the candidate migration.
4. Compare every migration ledger filename and checksum to the clean candidate.
   Capture live catalog/RLS/function grants after apply. Local validation alone
   is not enough.
5. Compare the immutable Vercel deployment metadata to P01. Capture the project
   scheduling control showing all four jobs disabled. A configured cron in
   `vercel.json` is not proof that scheduling ran or is enabled.

### API, identity, and continuity

1. Exercise list and detail with null-heavy anonymous, verified, merged,
   conflicted, multi-currency, and usage-not-synced profiles. Check every field
   and nullability against `customer-360.md`.
2. Page with `limit=1` and another bounded limit. Change each filter, limit, and
   namespace while reusing a cursor and require `invalid_cursor`. Tamper with the
   opaque cursor and require the same. Confirm terminal `nextCursor: null` and no
   duplicate/skipped customer across stable pages.
3. Confirm list/detail and FlowState responses omit identity link values,
   `installIdHash`, support/receipt values, Stripe object/event IDs, merged
   tombstones, raw conflict evidence, raw telemetry, search text/title/URL,
   credentials, IP/user-agent/device data, and exact behavioral history.
4. Start with one anonymous install. Record only the profile UUID and secret-safe
   evidence reference. Add optional association values through activation start,
   activation status, license verify, and license refresh JSON bodies. Never put
   them in browser URLs, redirects, query strings, or screenshots.
5. Complete sign-in, sandbox purchase, restore, and eligible merge one step at a
   time. After each step, prove one live root and unchanged Customer 360/device
   separation. Inject contradictory identity only in synthetic Test data and
   prove pending review/quarantine without auto-merge.

### Commerce and usage

1. Use Stripe test mode only. Record provider object references as restricted
   evidence, not in repository docs or general logs. Replay duplicate and
   out-of-order events through the existing verified webhook/queue boundary.
2. For each billing history model and currency, reconcile canonical instruments,
   fallbacks, counts, gross, off-Stripe subset, refunds, disputes, net, first/last
   paid times, and materialization time. Never collapse currencies into one KPI.
3. Before the one-time sync, approve expected source rows, aggregate rows, maximum
   bytes/read, query duration, and acceptable source lag. The code intentionally
   does not invent an operational lag threshold.
4. Capture the one-time sync summary and structured log separately. Verify the
   response may include namespace/freshness while the log omits them, as defined
   by the contract. Exercise `locked`, `skipped`, bounded failure/retry, overlap
   replacement, and time-based rolling decay without enabling project-wide cron.

### Backfill, FlowState, and regressions

1. Review backfill input fields and digest offline. Resolve every orphan/conflict
   in the report. Do not infer identity from email, name, behavior, time, IP,
   referral HMAC, or raw telemetry.
2. If B02 is separately approved, inject a transaction failure and a
   post-commit/pre-checkpoint-write failure. Prove whole-batch rollback,
   checkpoint recovery, and an idempotent complete rerun. Never improvise down
   migrations or use Production apply.
3. Run FlowState fixture tests first. For live QA, configure only the approved
   Preview origin and server-side credential, remove fixture mode, bind to
   loopback, open `/test`, and select Customers. Dashboard load and other tabs
   must make no Customer request; expanding a list row makes no detail request.
4. Prove same-key cache reuse, single-flight concurrent miss, independent cache
   keys by profile/filter/page/detail, exact-key manual refresh, old-page retention
   on refresh failure, and process-restart cache clearing. Manual refresh must
   not claim to run upstream usage sync.
5. Exercise account, activation, refresh rotation/replay, transfer/deactivation,
   download authorization, Checkout, webhook leasing/retry/dead-letter behavior,
   maintenance, installer downloads, update manifest, canonical public site,
   redirects/assets/SEO, FlowState download flow, telemetry redaction, and updater.

## Observability and failure response

Before U01, name the operator and alert destination for failed/missing daily run,
lag beyond the approved threshold, data-quality flags, pending identity review,
commerce conflict, unexpected protected-route `401`/`403`/`400`/`500`, read-budget
overrun, and backfill/checkpoint failure. Logs and alerts use counts, stable
outcomes, deployment IDs, and secret-safe references only.

Failure injection must demonstrate that wrong auth/Origin/cursors are rejected;
upstream timeout, redirect, oversized/invalid body, and invalid schema return
sanitized errors without fixture fallback; a failed FlowState refresh preserves
the visible page; sync lock/skip/failure states are distinguishable; duplicate or
out-of-order Stripe events do not duplicate money; and backfill failure leaves a
recoverable batch/checkpoint boundary. Preserve the first failure evidence. Do
not rerun until its disposition and rollback decision are recorded.

## Non-Production rollback and recreate

1. Keep Vercel project-wide cron disabled. If a one-time usage sync is active,
   let the bounded request finish or terminate it through the approved provider
   control; do not create a new scheduler.
2. Revoke/rotate Preview CRM and cron access, remove the FlowState Preview
   credential, and stop the local proxy. Confirm the credential was not exposed.
3. Redeploy the last known Preview artifact to the isolated Preview environment,
   or remove protected-route access entirely if no safe artifact exists.
4. Restore or recreate only the approved isolated database from D01. Migrations
   are append-only: do not write down SQL, delete ledger/audit/review rows, or
   edit migration history. Re-prove connected identity, checksum state, RLS, and
   grants before any retest.
5. Restart the FlowState analytics process to clear the local cache. Preserve
   restricted failure evidence, input digest, report, and checkpoints for review;
   do not copy any of them into Production.
6. Prove Production provider resources, deployment, database, Stripe/Google
   configuration, public routes, and cron state were untouched.

There is intentionally no Production rollback procedure because this plan
authorizes no Production action.

## Hard exit criteria

Preview/Test acceptance is complete only when all of the following are true:

- every applicable P01 through RB1 row is Pass, none is Fail or Blocked, and each
  has an exact UTC timestamp, reviewer, candidate SHA, target, and evidence link;
- the fresh isolation preflight and provider proof show fully distinct Preview
  database, telemetry, Stripe test, Google, base URL, and secrets;
- commit/artifact/immutable-host provenance is exact and both worktrees are clean;
- snapshot restore/recreate, authenticated target, checksummed ledger, RLS, and
  least-privilege grants are proved against the isolated target;
- project-wide cron stayed disabled and the only usage mutation was the one
  separately confirmed Test invocation after all prerequisites passed;
- API, identity/merge/conflict, commerce, usage, backfill, FlowState, regression,
  observability, failure-injection, and rollback/recreate evidence all match this
  plan and `customer-360.md`;
- the approved lag and read budgets were not exceeded, all conflicts/orphans and
  unexpected errors have recorded dispositions, and no privacy exclusion failed;
- the reviewer signs a statement that only the recorded non-Production Preview
  target was exercised and that no Production procedure or approval is implied.

If any item is missing, the hard exit is Blocked. Even a complete Pass does not
authorize Production migration, deployment, backfill, scheduling, enforcement,
or release. Those require a new plan and fresh human approval after all existing
Production blockers are closed.

# Customer 360 final audit: payment, queue, and recovery

Date: 2026-07-19

Audit step: `audit-payment-queue-recovery`

Audited head: `f955feb`

Release baseline: `codex/c360-offline-base-20260717` at `602f377b35c80ffd8f36d38dbb6777b662a19151`

## Scope

This is a hostile, read-only review of the complete Customer 360 branch against the release baseline. It covers:

- Checkout fulfillment and one-time entitlement transitions in `api/_lib/account.ts` and `api/_lib/entitlement.ts`.
- Durable Stripe ingestion, claiming, retries, dead-lettering, and reconciliation in `api/_lib/stripe-events.ts`, `api/stripe/webhook.ts`, and `api/internal/stripe-events/process.ts`.
- Exact-event attempt-9 recovery in `scripts/recover-stripe-dead-letter.mjs` and `db/migrations/20260717230000_add_stripe_event_recovery_audit.sql`.
- Payment lifecycle, queue, and recovery tests as claims to attack rather than proof of correctness.
- The exact branch diff, `README.md`, and `docs/api-hardening-runbook.md`.
- Current official Stripe semantics for refunds, disputes, webhook duplication/ordering/retries, and endpoint API-version behavior.

No runtime code, tests, database rows, Stripe configuration, provider state, secrets, or customer/payment data were changed or reproduced during this audit.

## Verdict

**NO-GO for Production.**

| Classification | Count | Release meaning |
| --- | ---: | --- |
| P0 | 0 | No demonstrated immediate mass compromise or irreversible broad loss. |
| P1 | 4 | Release-blocking entitlement or lifecycle correctness gaps. |
| P2 | 5 | Must be fixed or explicitly gated before Production recovery/rollout. |
| P3 | 1 | Bounded operational correctness/documentation defect. |
| PASS | 11 | Adversarial checks with no actionable defect beyond cited caveats. |

The targeted tests are green, but that is not a release signal: one test explicitly codifies the unsafe same-second event-ID ordering described in P1-01, and the recovery lost-response test does not exercise concurrent live invocations.

## Evidence and method

### Repository evidence

- `git merge-base HEAD codex/c360-offline-base-20260717` resolves exactly to `602f377b35c80ffd8f36d38dbb6777b662a19151`.
- `git diff --stat codex/c360-offline-base-20260717...HEAD` reports 25 changed files, 7,340 insertions, and 258 deletions.
- Review started from `README.md`, `docs/api-hardening-runbook.md`, and the exact three-dot diff, then followed only the payment/queue/recovery routes and tests.
- Targeted claim check: `node --experimental-strip-types --test tests/entitlement-lifecycle.test.mjs tests/stripe-event-claim-cap.test.mjs tests/stripe-dead-letter-recovery.test.mjs` completed with 26 passing tests and 0 failures.
- Direct watermark probe showed that current watermark `{createdAtMs: 1700000000000, eventId: "evt_z"}` rejects distinct event `{createdAtMs: 1700000000000, eventId: "evt_a"}` because the implementation treats lexical event-ID order as causal order.

### Current official Stripe semantics checked

- A Refund currently has five statuses: `pending`, `requires_action`, `succeeded`, `failed`, and `canceled`. `refund.failed` is emitted when a refund transitions to `failed`; a canceled refund is also a failure outcome. Multiple partial refunds against one charge are supported. Sources: [Refund object](https://docs.stripe.com/api/refunds/object), [Refunds and failed refunds](https://docs.stripe.com/refunds).
- A Dispute currently has eight statuses: `warning_needs_response`, `warning_under_review`, `warning_closed`, `needs_response`, `under_review`, `won`, `lost`, and `prevented`. Source: [Dispute object](https://docs.stripe.com/api/disputes/object).
- Stripe does not guarantee webhook event order. Duplicate deliveries can reuse one Event ID, and in some cases separate Event objects can describe the same underlying object. Live automatic retries continue for up to three days with exponential backoff; sandbox retries occur three times over a few hours. Source: [Receive Stripe events in a webhook endpoint](https://docs.stripe.com/webhooks).
- An Event's `api_version` is fixed when the event is created. Stripe recommends versioning webhook endpoints deliberately and matching the endpoint/API upgrade to the SDK migration. Sources: [Event object](https://docs.stripe.com/api/events/object), [Upgrade webhook endpoints](https://docs.stripe.com/webhooks/versioning).
- `no_payment_required` is a documented Checkout payment status. The implementation adds the important local constraint that a no-PaymentIntent purchase must also have `amount_total = 0`. Source: [Checkout Session object](https://docs.stripe.com/api/checkout/sessions/object).

## Findings

### P0 — none demonstrated

No reviewed path exposed a demonstrated unauthenticated bulk mutation, arbitrary Production selector, raw secret disclosure, or immediate mass entitlement compromise. This does not reduce the release-blocking impact of the P1 findings below.

### P1-01 — Equal-second watermarks use event IDs as causal clocks and can permanently discard the real terminal state

**Observation:** P1. The watermark compares `created` first, then accepts an equal timestamp only when the incoming Event ID is lexicographically greater. Stripe event IDs are identifiers, not sortable causal clocks, while Stripe `event.created` has only second-level resolution.

**Evidence:**

- `api/_lib/entitlement.ts:388-404` implements the timestamp-plus-lexical-ID comparison.
- `api/_lib/account.ts:3630-3666` fetches canonical Stripe facts before acquiring the database advisory lock and row lock.
- `api/_lib/account.ts:3873-3903` applies the transition only after the watermark accepts it.
- `tests/entitlement-lifecycle.test.mjs:265-270` explicitly expects `evt_z` to win an equal timestamp over `evt_a`.
- `docs/api-hardening-runbook.md:241-244` correctly says event IDs are not sortable clocks, contradicting the implementation/test contract.

**Concrete failure sequence:**

1. A dispute-open event and a later dispute-won/prevented event are both created in the same second.
2. The open event's lexically larger ID is processed first and suspends the entitlement.
3. The later closed event retrieves canonical closed state, but its lexically smaller ID fails the watermark.
4. The queue marks the event as handled without changing the entitlement. No future Stripe retry can repair it because duplicate insertion conflicts on Event ID.

The reverse ordering can be worse: a pre-lock snapshot that proves paid/closed can be applied after a same-second full-refund/open-dispute transition if its Event ID sorts later, reviving access from stale evidence.

**Recommended remediation:** Stop using Event IDs as an ordering key. Serialize/fence canonical reconciliation per payment identity before reading provider state, then converge from a fresh canonical snapshot under that fence. Use the ledger Event ID only for idempotency. Add barrier-controlled concurrent tests with two distinct same-second events, opposite lexical IDs, both delivery orders, and state changes between provider read and database lock.

### P1-02 — Ordinary reactivation does not re-prove Product, Price, plan, or current account ownership

**Observation:** P1. Full-refund recovery performs strong Checkout/Product/Price/customer proof, but ordinary `charge.updated`, `refund.failed`, and closed-dispute transitions can reactivate an existing row using only PaymentIntent/Charge/customer identity. The upsert's Product/Price comparison is tautological because lifecycle processing copies those values from the same existing row, and the update unconditionally writes the current Pro plan key.

**Evidence:**

- `api/_lib/account.ts:3536-3625` maps the lifecycle object and recognizes `refund.failed` only after retrieving its canonical `failed` status.
- `api/_lib/account.ts:3741-3775` selects a candidate license and checks only PaymentIntent/customer/Charge identity for the normal lifecycle path.
- `api/_lib/account.ts:3777-3809` performs the stronger Checkout/Product/Price/current-customer verification only for full-refund recovery.
- `api/_lib/account.ts:3696-3701` passes Product/Price values copied from the existing row.
- `api/_lib/account.ts:3853-3864` compares those copied values back to that row.
- `api/_lib/account.ts:3979-4038` can set the entitlement active and overwrite `plan_key` with the current Pro plan.

**Concrete failure sequence:**

1. A legacy import, partial migration, prior bug, or operator mistake leaves a suspended/revoked license with the correct PaymentIntent/Charge/customer but null, stale, or wrong Product/Price/plan metadata. Account-to-Stripe-customer ownership may also have moved.
2. A recognized `charge.updated`, `refund.failed`, `charge.dispute.closed`, or prevented-dispute reconciliation arrives.
3. Identity passes; Product/Price values are copied from the row and compared to themselves.
4. Paid/closed canonical facts reactivate the row and label it as the current Pro plan without proving the configured Product/Price or current owning account.

**Recommended remediation:** Require a fresh exact Checkout/Product/Price/quantity/plan and current account-customer proof before every inactive-to-active transition, not only full-refund recovery. Never rewrite `plan_key` without that proof. Add tests for wrong/null Product, wrong/null Price, wrong plan, moved account customer, and a PaymentIntent/Charge that otherwise matches.

### P1-03 — Recognized lifecycle proof failures become terminal `ignored` events instead of retry/dead-letter evidence

**Observation:** P1. The durable worker treats every recognized lifecycle result with `fulfilled: false` as a successful terminal `ignored` outcome. This conflates a legitimate stale no-op with ambiguous identity, missing row, canonical mismatch, transient provider visibility, and other failed safety proofs.

**Evidence:**

- `api/_lib/stripe-events.ts:537-565` routes recognized lifecycle types.
- `api/_lib/stripe-events.ts:553-557` maps any false fulfillment result to terminal `ignored`.
- `api/_lib/stripe-events.ts:588-614` makes terminal outcomes non-retryable.
- `api/_lib/stripe-events.ts:100-124` deduplicates future webhook delivery on Event ID.
- `api/stripe/webhook.ts:54-89` acknowledges after durable insertion, so later provider retries cannot create a second work item.

**Concrete failure sequence:**

1. A valid full refund or open dispute arrives while the local license row is temporarily missing, duplicated, partially migrated, or not yet visible to the candidate lookup.
2. Lifecycle reconciliation returns `fulfilled: false` rather than throwing.
3. The worker marks the event terminal `ignored`; Stripe has already received success and any duplicate delivery conflicts on the existing ledger ID.
4. The entitlement remains active and the event never reaches retry, dead letter, recovery audit, or an operator-visible poison path.

**Recommended remediation:** Return structured outcomes. Reserve terminal no-op for a proved stale/already-converged event. Treat missing, ambiguous, identity-mismatch, and canonical-proof failures as retryable errors, then dead-letter and alert at the bounded cap. Add tests that repair a missing/ambiguous row between attempts and tests that prove permanent mismatches dead-letter rather than disappear.

### P1-04 — The attempt-9 CLI lacks a database-resident Production identity gate

**Observation:** P1. The recovery CLI blocks obvious Production use, but target identity is inferred from caller-provided environment names, URL equality against the currently visible runtime aliases, a test-key string prefix, and a scan of mutable/current queue payloads. It does not obtain an immutable database-resident environment/instance attestation before touching account and entitlement tables.

**Evidence:**

- `scripts/recover-stripe-dead-letter.mjs:97-203` intentionally exposes one exact event ID and no bulk/Production flags.
- `scripts/recover-stripe-dead-letter.mjs:205-233` selects the database and compares it with environment-provided endpoints.
- `scripts/recover-stripe-dead-letter.mjs:410-430` checks schema and current queue contents before authorization.
- `scripts/recover-stripe-dead-letter.mjs:620-643` requires a test-mode payload and namespace, but the payload is mutable ledger data rather than target identity.
- `db/migrations/20260703120000_add_sidestream_accounts_billing.sql:112-122` stores mutable JSON payload/raw data without a target-environment marker.

**Concrete failure sequence:**

1. A Production database is reachable through an alias or URL absent from the process's comparison variables after retention/redaction has removed live queue evidence.
2. An operator mislabels that URL as the test recovery target and supplies a test key.
3. A test-mode attempt-8 row exists in that database from historical misconfiguration, import, or manual repair.
4. All process-local checks pass, and the CLI can mutate unscoped account/license state in the Production database despite having no explicit Production flag.

**Recommended remediation:** Add an immutable, migration-seeded database environment/instance identity and require an authenticated `test` attestation inside the same recovery transaction. Bind the recovery request to that identity. Refuse empty/unknown identity and any Production instance regardless of URL aliases or queue contents. Add isolated-Postgres tests for alternate URLs, empty/redacted queues, mixed-mode history, and a Production marker.

### P2-01 — Two concurrent attempt-9 invocations can both resume and process the same claim

**Observation:** P2. When an audit row already exists and the event is `processing` with `claim_token = recovery_audit.id`, the CLI returns the claimed event as `resumed`. A second live process can observe the same state and receive the same work; there is no exclusive runner nonce, liveness lease, or fencing token for the recovery execution.

**Evidence:**

- `scripts/recover-stripe-dead-letter.mjs:453-469` returns the same claimed row for an existing matching audit.
- `scripts/recover-stripe-dead-letter.mjs:472-559` makes the first authorization atomic but does not grant exclusive post-commit ownership.
- `scripts/recover-stripe-dead-letter.mjs:566-582` processes after the authorization transaction commits.
- `tests/stripe-dead-letter-recovery.test.mjs:270-307` models lost-response resume sequentially; it does not run two real concurrent invocations.

**Concrete failure sequence:**

1. Invocation A atomically authorizes attempt 9 and commits, then pauses before processing.
2. Invocation B sees the matching processing row/audit and receives `action: resumed`.
3. A resumes. Both processes call the real queue processor for the same claim token.
4. Final queue compare-and-set limits terminal-state corruption, but provider reads, reconciliation code, and any non-idempotent future side effect can execute twice. The promised one exact audited attempt is therefore not enforced.

**Recommended remediation:** Separate crash recovery from active ownership. Acquire a unique runner nonce and fenced lease with compare-and-set; an unexpired different owner returns `busy`, while expiry/reclaim increments or records a recovery lease epoch. Add a two-process integration test proving the reconciliation callback count is exactly one, plus crash-before-response and reclaim-after-expiry cases.

### P2-02 — Queue/recovery payloads are not cryptographically or relationally bound to ingress facts

**Observation:** P2. Processing checks payload ID/type/basic `created`, but does not compare `payload.created` to stored `stripe_created_at`, bind the JSON to an immutable ingress digest, or verify that the retained raw envelope still matches. Recovery hashes the snapshot at authorization time, so it faithfully audits an already-tampered snapshot.

**Evidence:**

- `api/_lib/stripe-events.ts:659-679` performs only basic payload shape checks.
- `api/_lib/stripe-events.ts:100-124` stores payload, raw payload, and `stripe_created_at` without an immutable digest.
- `scripts/recover-stripe-dead-letter.mjs:251-343` computes report/request digests from the current stored snapshot.
- `scripts/recover-stripe-dead-letter.mjs:620-643` repeats basic ID/type/created/livemode checks without binding `created` to the queue column.
- `db/migrations/20260717230000_add_stripe_event_recovery_audit.sql:81-100` makes the recovery audit immutable, but not the source event payload.

**Concrete failure sequence:**

1. A compromised privileged process or unsafe manual update changes a dead-letter payload's `created` value while retaining the same Event ID, type, and test namespace.
2. Normal or attempt-9 validation accepts it; recovery hashes the modified data as if it were original evidence.
3. Entitlement/customer-commerce reconciliation can write a future watermark that suppresses legitimate later events, while the immutable audit proves only which modified snapshot was used.

**Recommended remediation:** At signature-verified ingress, store an immutable SHA-256 digest over the exact raw body (or canonical provider Event) plus explicit Event ID/type/created/livemode/API version columns. Enforce payload-to-column equality and block source mutation with database constraints/triggers. Bind recovery authorization to those ingress facts. Add one-field tamper tests for ID, type, created, livemode, namespace, raw payload, and digest.

### P2-03 — Webhook endpoint API-version drift is neither attested nor observable

**Observation:** P2. Synchronous Stripe retrieval uses the SDK-pinned API version, but queued event snapshots are accepted without checking or recording an allowed `event.api_version` contract. Tests use a fixture version string that does not match the installed Stripe SDK's generated API-version family. The runbook still treats live endpoint/version inspection as an external gate.

**Evidence:**

- `api/_lib/account.ts:1450-1460` pins direct Stripe requests to `Stripe.API_VERSION`.
- `api/_lib/stripe-events.ts:659-679` does not validate `event.api_version`.
- `tests/stripe-events.test.mjs:1856-1867` and `tests/stripe-event-claim-cap.test.mjs:160-170` hard-code `2026-06-30.basil` fixtures.
- `package.json:47` declares `stripe: ^22.3.0`; `package-lock.json:2919-2933` locks 22.3.0, whose generated API-version family is `2026-06-24.dahlia`.

**Concrete failure sequence:**

1. A webhook endpoint remains on an older or incompatible API version while the application/SDK is upgraded.
2. Signed snapshots with changed enum/object shape enter the durable queue successfully.
3. Snapshot-based customer-commerce logic and routing consume fields under untested semantics; unsupported cases may become poison, ignored, or misprojected while direct retrieval uses a different version.
4. Tests remain green because their invented fixture version is never enforced.

**Recommended remediation:** Make provider-side endpoint inspection a hard rollout attestation: exact URL, enabled events, livemode, and API version. Persist and metric `event.api_version`; define supported versions and dead-letter/alert unsupported versions before projection. Generate fixtures from the pinned SDK contract and add an intentionally old-version compatibility/rejection test.

### P2-04 — Recovery can execute against dependencies from a different checkout than the audited lockfile

**Observation:** P2. If the fresh worktree has no local dependencies, the CLI follows the worktree `.git` pointer and symlinks `node_modules` from another checkout. It does not verify that those modules match this worktree's lockfile.

**Evidence:**

- `scripts/recover-stripe-dead-letter.mjs:734-815` implements the fallback and symlink behavior.
- `package-lock.json:2919-2933` pins Stripe 22.3.0.
- In this audit worktree, the fallback checkout exposed Stripe 22.3.1 while the audited lockfile pins 22.3.0.

**Concrete failure sequence:**

1. A clean recovery worktree lacks `node_modules`, while the original checkout has a newer, older, or locally altered Stripe/PG/runtime dependency tree.
2. The loader silently imports that other tree.
3. Dry-run evidence was produced under one dependency set, but the one allowed attempt executes under another; the audit digest does not bind dependency versions.

**Recommended remediation:** Require `npm ci` in the exact recovery worktree. Remove the sibling-checkout fallback, or fail closed unless every imported package version/integrity matches this lockfile and record that digest in the recovery request. Add a mismatched-module fixture that must fail before database authorization.

### P2-05 — Canonical provider state is read outside the entitlement transaction/fence

**Observation:** P2. Lifecycle processing retrieves the Event and canonical Charge/PaymentIntent/dispute/refund facts before it opens the advisory-lock transaction. The database lock serializes writes but not the evidence reads that justify those writes.

**Evidence:**

- `api/_lib/account.ts:3562-3659` retrieves lifecycle identity and canonical payment facts.
- `api/_lib/account.ts:3661-3666` opens the transaction and advisory/row lock only afterward.
- `api/_lib/account.ts:3686-3709` applies the earlier snapshot inside the later transaction.

**Concrete failure sequence:**

1. Worker A reads a paid/closed canonical snapshot and pauses.
2. Stripe moves the payment to full refund or the dispute to open/lost; worker B obtains newer facts and changes local state.
3. A later acquires the database lock and evaluates its stale proof. A strictly newer watermark usually protects the row, but equal-second events fall into P1-01, and a missing/ignored newer event falls into P1-03.
4. The write lock therefore does not guarantee the canonical facts were current at the serialization point.

**Recommended remediation:** Acquire a per-payment reconciliation fence before the final canonical read, then re-read provider state immediately before the transaction write and record the proof timestamp/version. Keep the database critical section bounded by using a two-phase fence if needed. Add barrier-controlled tests where provider state changes between the first read and the database lock.

### P3-01 — A configured batch of N can mutate up to 2N queue rows

**Observation:** P3. The claim query independently selects up to N exhausted leases to dead-letter and up to N claimable rows to process. This is safe for entitlement side effects, but operational batch-size/latency expectations are inaccurate because one call can update twice the advertised row count.

**Evidence:**

- `api/_lib/stripe-events.ts:138-321` contains separate `LIMIT` candidate sets for exhausted and claimable rows.
- `api/internal/stripe-events/process.ts:24-27` invokes the worker with batch size 25, which can mean 25 dead-letter updates plus 25 processing claims.

**Concrete failure sequence:**

1. The ledger has 25 expired final-attempt leases and 25 pending claimable events.
2. One nominal batch-25 call terminalizes the first 25 and claims the second 25.
3. Monitoring/capacity calculations that equate batch size with total row mutations undercount work by up to 2x.

**Recommended remediation:** Use one shared total-row budget across exhausted and claimable candidates, or rename/document separate terminalization and processing limits and report both counts. Add a 25-plus-25 cap test against the real query.

## PASS observations

### PASS-01 — Refund status and `refund.failed` handling match current Stripe semantics

**Observation:** PASS. The implementation retrieves the canonical Refund for `refund.failed` and requires canonical status `failed` (`api/_lib/account.ts:3562-3625`). Customer-commerce projection assigns money only to successful refunds and zero to failed/canceled outcomes (`api/_lib/customer-commerce.ts:346-380`). Pending and requires-action refunds do not revoke access merely because a refund object exists. The remaining ordering/race caveat is P1-01/P2-05.

**Concrete attack checked:** Forge a signed-shape `refund.failed` whose provider Refund is still pending/succeeded/canceled. Canonical status validation prevents it from being treated as a failed refund recovery.

**Recommended remediation:** None beyond the shared lifecycle remediation; retain explicit fixtures for all five current statuses.

### PASS-02 — Partial, full, and multiple successful refunds converge from Charge aggregates

**Observation:** PASS. Canonical payment facts use the Charge's aggregate refunded amount and currency rather than trusting the triggering Refund amount (`api/_lib/account.ts:3434-3524`, `api/_lib/entitlement.ts:406-508`). Only aggregate full refund revokes; partial refunds preserve paid proof. Multiple partial refunds that reach the total become full-refund revocation.

**Concrete attack checked:** Deliver individual partial refunds out of order, including multiple refunds whose sum crosses the full amount. Canonical Charge totals, not delivery order or a single Refund amount, decide full refund.

**Recommended remediation:** None specific; add a real isolated-Postgres concurrency case when repairing P1-01.

### PASS-03 — Refund failure after revocation does not override an extant full refund or lost dispute

**Observation:** PASS. Transition precedence checks lost dispute and aggregate full refund before payment proof or refund-failure recovery (`api/_lib/entitlement.ts:455-508`). Credential revocation occurs with terminal revocation (`api/_lib/account.ts:4044-4047`).

**Concrete attack checked:** Deliver `refund.failed` after another refund already made the Charge fully refunded, or after a dispute became lost. Canonical full-refund/lost proof remains dominant, so the event cannot reactivate access.

**Recommended remediation:** None beyond ordering/freshness fixes.

### PASS-04 — All eight current dispute statuses are explicitly classified, including `prevented`

**Observation:** PASS. `api/_lib/account.ts:3536-3559` gives deterministic priority to open/warning, closed/won/prevented, and lost states; `api/_lib/entitlement.ts:455-508` makes lost irreversible, open suspending, and closed/prevented eligible for activation only with paid proof. Unknown status fails conservatively into suspension rather than active access.

**Concrete attack checked:** Substitute each of the eight current status values, multiple disputes with conflicting status, and an unknown future value. Lost dominates; open warnings suspend; won/prevented/closed require payment proof; unknown does not grant access.

**Recommended remediation:** Keep a table-driven test sourced from the official enum so a future Stripe status cannot silently drift.

### PASS-05 — Dispute/refund overlap has conservative precedence

**Observation:** PASS. Lost dispute and full refund revoke; any open dispute suspends; only the absence of those conditions plus valid paid proof permits active state (`api/_lib/entitlement.ts:455-508`).

**Concrete attack checked:** Full refund plus won dispute, partial refund plus open dispute, lost dispute plus failed refund, and prevented dispute plus unpaid Charge. None can bypass the stronger revoke/suspend condition.

**Recommended remediation:** None specific; preserve precedence tests when restructuring reconciliation.

### PASS-06 — Exact Checkout, zero-value promotion, and no-PaymentIntent purchases are constrained

**Observation:** PASS. Fulfillment retrieves the exact Checkout Session and verifies mode/status/plan/Product/Price/quantity (`api/_lib/account.ts:3165-3383`, `api/_lib/entitlement.ts:249-302`). A missing PaymentIntent is accepted only for `no_payment_required` with zero total and matching currency (`api/_lib/account.ts:3386-3432`). Promotion codes are allowed (`api/_lib/account.ts:1218`), and zero-gross commerce is recorded as comped (`api/_lib/customer-commerce.ts:215-260`).

**Concrete attack checked:** Wrong Product, wrong Price, quantity other than one, unpaid nonzero Session, `no_payment_required` with nonzero total, and currency mismatch. Exact fulfillment proof rejects them. P1-02 concerns later reactivation of an already-corrupt row, not initial fulfillment.

**Recommended remediation:** None in code; provider-side Product/Price/promotion inventory remains a rollout attestation under P2-03.

### PASS-07 — Standalone Charges do not mint one-time entitlements

**Observation:** PASS. Customer-commerce can project captured standalone Charge money (`api/_lib/customer-commerce.ts:303-343`), while entitlement lifecycle requires a uniquely matching local license PaymentIntent/Charge/customer (`api/_lib/account.ts:3630-3809`).

**Concrete attack checked:** Send a captured Charge with no Customer 360 license or PaymentIntent linkage. It can contribute to commerce truth but cannot select an entitlement candidate or mint access.

**Recommended remediation:** None.

### PASS-08 — Livemode, namespace, PaymentIntent, Charge, and customer mismatches fail closed

**Observation:** PASS. Queue reconciliation validates event livemode against the trusted namespace before entitlement or commerce work (`api/_lib/stripe-events.ts:450-486`, `api/_lib/customer-commerce.ts:972-995`). Canonical entitlement facts verify PaymentIntent, Charge, customer, amount, and currency (`api/_lib/entitlement.ts:406-451`).

**Concrete attack checked:** Test event in a live namespace, live event in test, wrong PaymentIntent/Charge/customer/currency/amount, and namespace-like payload text. Trusted runtime environment and canonical provider/local identity, not payload namespace alone, control acceptance.

**Recommended remediation:** None beyond the database-target attestation in P1-04.

### PASS-09 — Normal webhook durability, duplicate delivery, lost response, and bounded retry are sound

**Observation:** PASS. The endpoint verifies the official signature, awaits durable insert, then acknowledges (`api/stripe/webhook.ts:1-95`). Event-ID conflict deduplicates retries (`api/_lib/stripe-events.ts:100-124`). Claims use leases, compare-and-set terminal/failure updates, exponential local backoff, and a normal maximum of eight attempts (`api/_lib/stripe-events.ts:13-18`, `api/_lib/stripe-events.ts:324-448`, `api/_lib/stripe-events.ts:571-657`). Final-attempt crash reclaim dead-letters instead of creating an unapproved ninth normal attempt (`api/_lib/stripe-events.ts:138-321`).

**Concrete attack checked:** Duplicate same Event ID, webhook response loss after insert, two normal workers, worker crash before terminal update, poison exception, and final-attempt lease expiry. The ledger/claim token bounds normal processing. Separate Event objects for the same underlying object rely on canonical reconciliation; equal-second convergence remains blocked by P1-01.

**Recommended remediation:** None beyond P1-03 for false `ignored` outcomes and P3-01 for batch accounting.

### PASS-10 — Attempt-9 recovery is exact-event, digest-bound, and has no bulk/direct-entitlement mode

**Observation:** PASS with the concurrency and target-identity exceptions already classified. The CLI requires one exact event ID, dry-run/report/request evidence, an untouched attempt-8 dead letter, test namespace/livemode, and a matching request digest before atomically authorizing attempt 9 (`scripts/recover-stripe-dead-letter.mjs:97-203`, `scripts/recover-stripe-dead-letter.mjs:251-559`). It invokes the normal processor rather than editing entitlement rows directly (`scripts/recover-stripe-dead-letter.mjs:566-582`). There is no event-range, bulk, Production, or direct-entitlement-edit flag.

**Concrete attack checked:** Omit the event ID, select multiple events, recover before attempt 8, alter the report/request, request attempt 10, choose live mode, or directly set entitlement status. The CLI/migration contract rejects or does not expose those operations.

**Recommended remediation:** Preserve this narrow surface while adding exclusive recovery ownership (P2-01), ingress binding (P2-02), and database identity (P1-04).

### PASS-11 — Recovery audit rows are database-immutable and least-privilege by default

**Observation:** PASS. The recovery audit table stores digests/authorization metadata rather than raw customer/payment payloads, has update/delete/truncate blockers, RLS, revoked public/authenticated access, and queue-state constraints tying attempt 9 to an audit row (`db/migrations/20260717230000_add_stripe_event_recovery_audit.sql:1-122`).

**Concrete attack checked:** Update/delete/truncate an audit row, put a queue row at attempt 9 without recovery audit linkage, or read the audit through default public/authenticated roles. Database controls reject those paths.

**Recommended remediation:** Preserve audit immutability; extend the immutable evidence boundary to the original ingress facts as described in P2-02.

## Required remediation order

1. Fix P1-01 and P2-05 together by making reconciliation a fresh, fenced canonical convergence operation; delete the lexicographic causal assumption and its approving test.
2. Make every inactive-to-active transition re-prove the exact entitlement purchase and current owner (P1-02).
3. Split proved no-op from retry/dead-letter failure (P1-03).
4. Add database-resident environment identity before any attempt-9 Production-adjacent use (P1-04).
5. Add exclusive attempt-9 ownership, immutable ingress binding, endpoint API-version attestation, and lockfile-bound dependencies (P2-01 through P2-04).
6. Run the complete isolated local Postgres gate with real concurrency barriers, crash/reclaim cases, migration constraints, and tamper cases. Unit mocks alone are insufficient.

Until those items are implemented and the isolated Postgres gate passes, Customer 360 payment/entitlement recovery should remain non-Production.

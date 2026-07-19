# Customer 360 final audit: data, privacy, and migrations

## Scope

This is a read-only hostile review of the Customer 360 implementation at
`f955feb` on `orch/audit-data-privacy-migrations`. The implementation delta was
reviewed from the declared offline base `602f377` through `f955feb`, including
the 25 changed paths in that range. The review then followed every Customer 360
dependency outside that diff: all 24 ordered SQL migrations, the migration
runner, Postgres target selection, profile/identity/commerce/usage/query/admin
code, telemetry TLS construction, backfill, retention inventory, Preview
environment and deployment verifiers, and their local and Postgres tests.

The starting authorities were `README.md`, `docs/customer-360.md`, and
`docs/customer-360-preview-test-plan.md`. The contract correctly says Customer
360 is not deployed, Production is not migrated, and the current Preview
environment is rejected (`docs/customer-360.md:3-30`; `README.md:674-677`). The
Preview/Test matrix keeps every dependent live row Blocked and explicitly says
even a complete Preview Pass does not authorize Production
(`docs/customer-360-preview-test-plan.md:263-290,440-464`). This report does not
alter that state or authorize a connection, migration, backfill, retention
action, provider request, deployment, or usage sync.

No connection value, secret, customer identifier, or identity evidence is
included here. Sequences below refer only to parameter classes and synthetic
actors.

## Evidence method and severity

Evidence was gathered from the exact branch history and file/line inspection.
No live database or provider was contacted. The installed dependency contract
was checked against `pg` 8.22.0 and `pg-connection-string` 2.14.0 as locked in
`package-lock.json:2576-2586,2610-2614`; this matters because query parameters in
a Postgres connection string are connection configuration, not inert metadata.

| Class | Meaning |
| --- | --- |
| P0 | Immediate catastrophic impact or active compromise. |
| P1 | Release blocker with a concrete path to wrong-target mutation, credential exposure, integrity loss, or material stale data. |
| P2 | Important correctness, privacy, least-privilege, or operational weakness that needs remediation before its affected gate. |
| P3 | Bounded hardening or contract-consistency issue. |
| PASS | The attacked property is defended by code and evidence inspected here. |

## Executive result

- **P0: none observed.** That is not a release approval.
- **P1: seven release blockers.** Effective database targets can diverge from
  verifier fingerprints; several database paths lack authenticated TLS; the
  deployment verifier can send credentials to an unbound host; migration apply
  is ambient and implicit; usage cursors lose Postgres microseconds; two claimed
  immutable audits permit `TRUNCATE`; and Test backfill apply is not bound to a
  separately approved digest/target.
- **P2: eight important findings.** Role ownership is unproved, catalog
  postconditions are incomplete, file inputs are not regular-file safe,
  retention is inventory-only, association keys are replayable, commerce
  ordering is ambiguous within a Stripe second, money aggregation can leave the
  safe-integer range, and the one-time usage confirmation is reusable.
- **P3: two bounded findings.** Pre-parsed admin bodies bypass the byte cap, and
  backfill reads privacy-forbidden fields instead of rejecting them.
- **Decision: NOT READY for Preview/Test execution or Production release.** The
  existing blocked rollout state is correct, and P1-01 through P1-07 must be
  closed before the affected non-Production gates are attempted.

## P1 findings

### P1-01 — Authority-only fingerprints do not bind the effective Postgres target

**Evidence.** The Preview environment verifier derives identity from only URL
authority host, authority port, and path
(`scripts/verify-customer-360-preview-environment.mjs:224-262`). It uses those
values for same/different-target checks
(`scripts/verify-customer-360-preview-environment.mjs:50-131`). Runtime target
normalization preserves unrecognized query parameters and passes the resulting
connection string to `pg` (`api/_lib/postgres.ts:107-146,241-253`). The disposable
test guard likewise compares only authority host/port/path
(`scripts/run-postgres-integration.mjs:38-59,88-95`). Telemetry blocks query
`host` but omits query `port` from its pool-owned set
(`api/_lib/customer-usage.ts:13-30,1413-1482`), while its collision identity also
uses authority values (`api/_lib/customer-usage.ts:1394-1398`). Retention hashes
authority values but later gives the original connection string to `pg`
(`scripts/plan-customer-360-retention.mjs:234-249,605-615`).

**Concrete sequence.** A configured value names approved target A in its
authority and supplies a target-bearing query option for target B. The offline
verifier and collision guard fingerprint A and can report separation. The
driver parses the preserved option and connects to B. A duplicate TLS option
creates the same disagreement in retention because validation reads one value
at lines 584-595 while the original string is used at lines 605-615. DNS aliases
and an IPv4/IPv6 name resolving to the same endpoint also evade string equality.

**Impact.** A migration, runtime write, telemetry read, backfill, or retention
inventory can touch a different database or endpoint from the one reviewed.
This defeats the central Production/Test isolation gate.

**Recommended remediation.** Create one code-owned connection parser used by
every verifier and pool. Reject duplicate keys and every query parameter capable
of changing host, port, database, credentials, TLS, options, service, timeout,
or session state. Bind approval to provider resource ID plus an authenticated
post-connect fingerprint (`current_database`, server address/port, role, and
provider identity), never URL text alone.

**Required test.** Table-drive query host/port/database attempts, duplicate
parameters in both orders, percent-encoded names, DNS aliases, IPv4/IPv6
loopback, Unix/socket inputs, and two names resolving to one endpoint. Assert
preflight and the connected fingerprint cannot disagree.

### P1-02 — Runtime, migration, and backfill connections permit TLS downgrade or unauthenticated peers

**Evidence.** The website runtime enables encryption while explicitly disabling
certificate validation (`api/_lib/postgres.ts:107-146`). The migration pool does
the same and also permits a process variable to disable TLS
(`scripts/apply-postgres-migrations.mjs:416-446`). The shared integration helper
accepts a remote non-TLS selector and otherwise uses
`rejectUnauthorized: false`; Test backfill imports that helper directly
(`scripts/run-postgres-integration.mjs:72-85`;
`scripts/backfill-customer-360.mjs:1244-1260`). README already identifies this as
a Production blocker (`README.md:712-713`). Telemetry has stronger construction,
but P1-01's unblocked query `port` still weakens its effective-target guarantee.

**Concrete sequence.** An operator runs against a remote endpoint on an
untrusted network or with a poisoned DNS answer. The peer presents any
certificate, or the Test/backfill selector explicitly disables TLS. The client
authenticates to the peer with database credentials and accepts the session.

**Impact.** Credentials and Customer 360 data can be exposed, and migrations or
backfill can be observed or modified in transit. Encryption without peer
authentication does not prove the target.

**Recommended remediation.** Require provider CA trust and hostname validation
for every non-loopback runtime, migration, backfill, telemetry, and retention
connection. Reject all disable/no-verify aliases and conflicting duplicate
parameters before pool construction. Do not infer safety from a hostname string.

**Required test.** Use a local TLS Postgres fixture with trusted, untrusted,
wrong-host, expired, and absent certificates. Prove only the trusted matching
peer succeeds, and prove connection/session errors never contain credentials.

### P1-03 — Deployment verification sends real bearer credentials to a caller-selected host

**Evidence.** The verifier's Production denylist contains only three literal
hosts (`scripts/verify-customer-360-preview-deployment.mjs:10-14`). Target
validation checks syntactic HTTPS equality with a separately caller-supplied
expected host, rejects literal IPs/local names, but does not bind Vercel team,
project, deployment, commit, environment, or DNS resolution
(`scripts/verify-customer-360-preview-deployment.mjs:204-243,462-468`). Its host
proof is an unauthenticated `HEAD` response carrying two easily reproduced
header shapes (`scripts/verify-customer-360-preview-deployment.mjs:315-324,552-557`).
After that check it loads the real admin secret and, in usage mode, the cron
secret, then sends authenticated requests to the selected origin
(`scripts/verify-customer-360-preview-deployment.mjs:245-310,326-400`).

**Concrete sequence.** A typo, stale DNS record, renamed Production alias, or
attacker-controlled Vercel deployment is supplied as both target arguments. It
returns the expected two headers to `HEAD`. The verifier then sends a valid
admin bearer; usage mode also sends the cron bearer and invokes a mutating route.

**Impact.** Secrets can be disclosed to the wrong deployment, and a usage sync
can run against an unapproved environment. A short hardcoded hostname denylist
cannot establish deployment provenance.

**Recommended remediation.** Resolve immutable deployment provenance through an
owner-authenticated Vercel API before any secret-bearing request. Bind team,
project, deployment ID, commit/build ID, environment, immutable hostname, and
effective aliases to the approved manifest. Never send Production credentials
through this Preview verifier. Pin DNS/TLS identity or perform the probes from a
trusted provider-side channel.

**Required test.** Simulate a Vercel-looking hostile host, a new Production
alias, DNS rebinding, a redirect, and a project/commit mismatch. Assert zero
secret-bearing requests and zero mutation before provenance passes.

### P1-04 — Migration mutation is implicit and inherits ambiguous ambient state

**Evidence.** With no operation flag, the migration CLI selects `apply`
(`scripts/apply-postgres-migrations.mjs:145-160`). For connected modes it loads
two optional env files, then selects the first nonempty variable from a broad
priority list (`scripts/apply-postgres-migrations.mjs:19-29,128-142,162-206`).
The env loader silently skips malformed lines and refuses to replace any
inherited nonempty value, so process state wins over reviewed file contents
(`scripts/apply-postgres-migrations.mjs:460-475`). The only connected console
evidence is the selected variable name, not a target fingerprint
(`scripts/apply-postgres-migrations.mjs:191-195`).

**Concrete sequence.** An operator intends status or Test apply, has an old
higher-priority selector in the shell, and invokes the bare package script or a
reviewed env file. The old selector survives, no explicit `--apply` is required,
and pending migrations run against the ambient target.

**Impact.** This is a direct wrong-target mutation path, including accidental
Production migration. `--validate` and `--dry-run` do not reduce the hazard of
the default connected mode.

**Recommended remediation.** Make the default and bare command non-mutating.
Require an explicit `--apply`, a single exact selector, an empty/sanitized
environment, a pinned env-file digest, expected migration-set digest, expected
connected-target fingerprint, namespace, and typed one-time confirmation. Split
status and apply launchers.

**Required test.** Seed every selector with distinct sentinels, including empty
and inherited variants. Assert ambiguous state fails, bare invocation cannot
connect, and apply cannot begin before the connected identity matches approval.

### P1-05 — Usage high-water conversion loses Postgres microseconds and can replay forever or strand the tail

**Evidence.** The high-water type stores `receivedAt` as JavaScript `Date`, and
comparison uses millisecond epoch time plus JavaScript locale ordering
(`api/_lib/customer-usage.ts:82-85,217-224`). Source high-water and batch
checkpoints are read as `timestamptz` and normalized through that type
(`api/_lib/customer-usage.ts:681-745`). SQL paginates by the exact tuple
`(received_at, telemetry_event_id)` (`api/_lib/customer-usage.ts:749-766`), but
the next query receives the truncated `Date`. The loop assigns that checkpoint
without a progress assertion (`api/_lib/customer-usage.ts:409-447`). Completion
can also advance stored freshness/checkpoint to the truncated upper bound
(`api/_lib/customer-usage.ts:1329-1356`). Existing Postgres fixtures use whole or
millisecond timestamps, for example
`tests/customer-360/pipeline-postgres.test.mjs:600-617`, so they do not exercise
the boundary.

**Concrete sequence.** A source row has nonzero microseconds beyond the first
three fractional digits. If it is a batch checkpoint below a later upper row,
the driver returns a millisecond `Date`; the next `>` tuple query sees the same
source row as newer and selects it again. If it is the newest upper row, the
truncated `<= upper` bound can exclude it, so the run completes while freshness
claims the truncated boundary. Locale comparison can also disagree with
Postgres text collation for non-ASCII or locale-sensitive event IDs.

**Impact.** A normal Postgres timestamp can cause repeated batches until timeout,
duplicate work, stale materialization, or a newest event that remains invisible
until a later row arrives. This breaks replay, freshness, and cursor guarantees.

**Recommended remediation.** Keep high-water timestamps in canonical
microsecond-preserving strings (or integer microseconds) end to end. Let
Postgres return a canonical cursor token and compare IDs with the same bytewise
ordering/collation used in SQL. Assert each batch checkpoint is strictly greater
than the prior checkpoint and no greater than upper.

**Required test.** Insert multiple same-millisecond rows with distinct
microseconds, same-timestamp IDs, a fractional newest tail, and batch size one.
Prove exact-once convergence, strict progress, retry idempotency, and matching JS
and SQL ordering.

### P1-06 — Two “immutable” Customer 360 audits can be erased with `TRUNCATE`

**Evidence.** The profile-merge audit guard fires only before row `UPDATE` or
`DELETE` (`db/migrations/20260715120000_add_customer_360_core.sql:369-384`). The
identity-review audit has the same gap
(`db/migrations/20260715121000_add_customer_identity_links.sql:99-112`). By
contrast, the later recovery audit correctly adds a statement-level `BEFORE
TRUNCATE` guard and fixes its function search path
(`db/migrations/20260717230000_add_stripe_event_recovery_audit.sql:81-104`). RLS
does not turn `TRUNCATE` into row deletion, and the migration chain does not
separate table ownership from the broad runtime/migrator credential.

**Concrete sequence.** A role with ownership or `TRUNCATE` privilege truncates
either table. The row triggers never fire; merge lineage or pending conflict
evidence disappears even though docs and comments call it immutable.

**Impact.** Identity conflicts can lose their review history, and profile
tombstones can outlive the audit evidence required to explain them. This is an
integrity and privacy-accountability failure.

**Recommended remediation.** Add statement-level `BEFORE TRUNCATE` guards to
both tables, use fixed `search_path = pg_catalog`, revoke `TRUNCATE`, and make a
non-login owner distinct from migrator and runtime roles. Preserve audit rows in
append-only backup/WORM evidence according to the approved retention policy.

**Required test.** Under owner, migrator, runtime, admin-read, anonymous, and
authenticated roles, assert update/delete/truncate all fail except a separately
reviewed migration-only mechanism; verify audit rows survive rollback/recreate.

### P1-07 — Test backfill apply is not cryptographically bound to the separate approval

**Evidence.** The planner computes an input digest and a present checkpoint is
bound to it (`scripts/backfill-customer-360.mjs:214-227,757-803`). However CLI
apply requires only explicit Test namespace plus input and checkpoint *paths*;
the named checkpoint may be absent and is then treated as a fresh checkpoint
(`scripts/backfill-customer-360.mjs:82-158,1181-1191`). The CLI exposes the exact
apply form in help (`scripts/backfill-customer-360.mjs:1203-1217`) even though the
contract intentionally provides no apply command and requires separate approval
of digest, target identity, migration state, checkpoint, and rollback plan
(`docs/customer-360.md:503-533`). The apply path does not accept an approved
digest, connected-target fingerprint, candidate SHA, approval token, or expiry
before constructing the Test pool (`scripts/backfill-customer-360.mjs:1232-1261`).

**Concrete sequence.** A reviewer approves dry-run digest A and target A. The
input path is replaced, the checkpoint path is absent or replaced, or the Test
selector is changed. CLI apply recomputes digest B, creates a fresh logical
checkpoint, and writes to the currently selected target without proving either
value matches the approval.

**Impact.** Dry-run approval can be confused with apply authority, and reviewed
data can be applied to an unreviewed Test target. Production namespace is blocked
in code, but a target-selection bypass from P1-01 can still make a nominal Test
operation unsafe.

**Recommended remediation.** Require an existing regular checkpoint initialized
by the approved dry run; explicit expected input digest, connected-target
fingerprint, candidate SHA, migration digest, batch size, expiry, and a one-time
approval token. Remove the apply syntax from general help and generate a bounded
invocation only inside the approved run artifact.

**Required test.** Change each approved component independently, replace files
between validation and open, start with a missing checkpoint, and smuggle target
parameters. Assert zero connection and zero write for every mismatch.

## P2 findings

### P2-01 — Least-privilege roles, ownership, FORCE RLS, and function search paths are not encoded

**Evidence.** Customer migrations enable RLS and revoke PUBLIC plus optional
`anon`/`authenticated` roles, e.g.
`db/migrations/20260715120000_add_customer_360_core.sql:443-479` and
`db/migrations/20260715122000_add_customer_commerce_ledger.sql:1703-1741`.
They do not create or attest distinct owner, migrator, runtime-writer, admin-read,
and telemetry-read roles; do not `FORCE ROW LEVEL SECURITY`; and generally omit a
fixed function search path. The Postgres pipeline applies and exercises the CRM
schema through an administrative pool, while only the telemetry role gets an
explicit select-only proof (`tests/customer-360/pipeline-postgres.test.mjs:114-185`).

**Concrete sequence.** Deployment uses the migration owner as runtime because no
runtime grants are defined. That role bypasses ordinary RLS, can alter/drop or
truncate tables, and can execute more functions than intended. Alternatively, a
separate runtime role has no required grants and rollout relies on undocumented
manual privilege changes.

**Recommended remediation.** Add reviewed role/ownership/grant migrations or an
attested provider bootstrap. Use non-login owners, separate migrator/runtime/admin
roles, least-privilege EXECUTE/table grants, `FORCE RLS` where appropriate, and
fixed safe search paths on every stored/trigger function.

**Required test.** Build a role matrix from the clean migration chain and assert
every allowed and forbidden operation, including DDL, TRUNCATE, BYPASSRLS,
function execution, and cross-namespace access.

### P2-02 — Migration success does not prove exact catalog shape or immutable ledger state

**Evidence.** Core Customer tables use `CREATE TABLE IF NOT EXISTS`, for example
`db/migrations/20260715120000_add_customer_360_core.sql:24-87,207-243,251-275`.
The runner's ledger validator checks only four column names/types/nullability,
not primary key, checks, owner, RLS, grants, triggers, or indexes
(`scripts/apply-postgres-migrations.mjs:382-401`). It verifies checksums recorded
in ledger rows (`scripts/apply-postgres-migrations.mjs:98-120`) but the ledger
itself has no immutable guard or post-connect provider binding. There is no
post-migration catalog manifest comparison.

**Concrete sequence.** A same-named table or ledger with compatible columns but
missing constraints exists before apply. `IF NOT EXISTS` skips canonical table
definition; ledger shape passes; later statements can either fail late or allow
the migration row to be recorded without the exact intended object contract.
A privileged actor can also rewrite ledger rows to current checksums.

**Recommended remediation.** Fail on preexisting unledgered objects. After every
file, compare an exact catalog manifest covering columns, defaults, constraints,
indexes, triggers, function bodies/config, RLS/FORCE RLS, ownership, and grants.
Make the ledger append-only and include target and migration-set fingerprints.

**Required test.** Precreate every Customer object and ledger with one subtle
defect at a time. Assert apply fails before recording success and the entire file
rolls back.

### P2-03 — Operator file inputs permit symlinks, special files, unbounded reads, and replacement races

**Evidence.** Preview snapshots are read before the 1 MiB size check and without
`lstat`/regular-file verification
(`scripts/verify-customer-360-preview-environment.mjs:207-222`). Migration SQL and
env files are resolved/read without realpath containment or regular-file checks
(`scripts/apply-postgres-migrations.mjs:14,47-58,460-475`). Retention policies and
backfill input/checkpoints are unrestricted `readFile` calls
(`scripts/plan-customer-360-retention.mjs:645-653`;
`scripts/backfill-customer-360.mjs:1168-1191`). Backfill writes a predictable
PID-based temporary name with ordinary `writeFile`
(`scripts/backfill-customer-360.mjs:1193-1200`).

**Concrete sequence.** A path is a FIFO/device, a symlink is swapped after review,
or a large file is supplied. The process can block, exhaust memory, read a
different file, load external SQL, or follow a precreated temporary symlink when
writing checkpoint content.

**Recommended remediation.** Open with no-follow/exclusive flags, require a
regular file owned by the expected operator, enforce size before full read,
compare inode/device after open, constrain migration realpaths to the repository,
and create random exclusive temp files in the destination directory before
fsync+rename.

**Required test.** Cover symlink/hardlink swaps, FIFO/device files, oversized and
sparse inputs, wrong owner/mode, alternate working directory, and precreated temp
paths.

### P2-04 — Retention has no enforcement path, so stated customer data persists indefinitely

**Evidence.** The contract explicitly says no Customer 360 deletion,
anonymization, or aggregate-expiry job exists
(`docs/customer-360.md:401-439`; `README.md:674`). The planner begins a repeatable
read, read-only transaction and always rolls back
(`scripts/plan-customer-360-retention.mjs:328-385`). That is a good inventory
property, but it does not implement approved periods or dependency order.

**Concrete sequence.** Profiles, verified contact, identity links, install
memberships, daily usage, and commerce materializations age past a proposed
period. Inventory reports them; no mutation follows, so the rows remain.

**Recommended remediation.** Obtain explicit policy/owner approval, then design a
separate idempotent dependency-aware anonymization/expiry pipeline. Preserve
merge and conflict audit meaning, prove foreign-key order, bound batches, hold
legal exceptions, and record aggregate evidence without row disclosure.

**Required test.** Build aged graphs spanning live roots, tombstones, links,
installs, usage, money, and audits. Prove approved actions, preserved immutable
domains, retry safety, referential integrity, and no cross-namespace mutation.

### P2-05 — Replay of a valid association key can pollute another profile

**Evidence.** Activation start accepts client `installIdHash`, `supportCode`, and
`installerReceiptIdHash`, normalizes them, and attaches them in the activation
transaction (`api/_lib/account.ts:1851-1912`). Identity code explicitly treats
these values as association rather than authentication
(`api/_lib/customer-identity.ts:65-94,115-139`). It selects the first existing
owner as the target profile, then can add a new install membership to it
(`api/_lib/customer-identity.ts:149-195,543-592,691-748`). Uniqueness and conflict
review stop ownership overwrite, but possession, route-specific provenance,
expiry, or one-time use is not established inside this boundary.

**Concrete sequence.** An actor replays a leaked valid association value while
starting a fresh activation with a new install hash. The existing owner becomes
the profile root and the actor's install membership/activity can be associated
with that customer, without changing entitlement.

**Recommended remediation.** Treat each association key as a scoped proof:
server-verify receipt state, bind it to activation/request context and namespace,
expire or consume replayable claims, and quarantine rather than attach when a
new install is introduced solely through a preexisting client key.

**Required test.** Replay each association type across sessions, accounts,
namespaces, expired receipts, and a new install. Assert no profile pollution and
no raw evidence disclosure.

### P2-06 — Same-second Stripe events use event ID as state chronology

**Evidence.** Commerce converts Stripe's second-resolution `event.created` to an
event timestamp (`api/_lib/customer-commerce.ts:126-151`). Materializations and
invoice-payment edges choose the later state by `(event_created_at, event_id)`
(`db/migrations/20260715122000_add_customer_commerce_ledger.sql:1290-1308,1607-1624`).
Stripe event IDs are uniqueness keys, not a documented causal sequence.

**Concrete sequence.** Two state-changing events for one source object have the
same creation second and arrive out of order. Lexicographically larger ID wins,
which can preserve the older business state and mark the actual later state
stale.

**Recommended remediation.** Reconcile mutable source objects from canonical
Stripe object state after verified events, or define an object-version/causal
ordering that is stronger than event ID. Keep insert-only event IDs for
idempotency, not chronology.

**Required test.** Generate every conflicting same-second pair in both delivery
orders and with reversed ID order. Assert one canonical final state and stable
money totals.

### P2-07 — Array money sums are not revalidated after addition

**Evidence.** Individual amounts must be nonnegative safe integers
(`api/_lib/customer-commerce.ts:834-840`), but `sumAmounts` reduces them with
ordinary JavaScript addition and never checks the aggregate
(`api/_lib/customer-commerce.ts:843-846`). Currency is validated separately
(`api/_lib/customer-commerce.ts:825-831`).

**Concrete sequence.** A verified object contains several individually valid
minor-unit amounts whose total exceeds JavaScript's safe-integer range. The sum
rounds before it reaches SQL or JSON, while still appearing numeric.

**Recommended remediation.** Sum with `bigint`, enforce a documented database and
business bound, and serialize decimal strings across the TypeScript/Postgres
boundary. Reject overflow before constructing observations.

**Required test.** Exercise exact safe boundary, boundary plus one, many-item
overflow, and currency separation; assert no rounding or mixed-currency sum.

### P2-08 — “Run once” usage confirmation is deterministic and reusable

**Evidence.** The confirmation is a fixed string derived only from hostname
(`scripts/verify-customer-360-preview-deployment.mjs:143-145`). Parsing compares
that string but does not bind time, candidate SHA, deployment ID, environment
fingerprint, reviewer, or previous use
(`scripts/verify-customer-360-preview-deployment.mjs:147-201`). The verifier then
invokes usage sync when all preceding probes pass
(`scripts/verify-customer-360-preview-deployment.mjs:394-403`).

**Concrete sequence.** A command or shell history entry approved for one run is
reused against the same hostname after deployment or environment changes. The
confirmation remains valid and a second mutation is attempted.

**Recommended remediation.** Use a server-validated, single-use, expiring token
bound to immutable deployment, commit, environment/target fingerprints, mode,
reviewer approval, and invocation count. Record consumption in an immutable
audit.

**Required test.** Replay before and after deployment/target changes and after
expiry; only the exact first approved invocation may reach the route.

## P3 findings

### P3-01 — Pre-parsed admin bodies bypass the 16 KiB request limit

**Evidence.** `readCustomerAdminJson` returns a pre-parsed `request.body` before
checking declared or streamed size (`api/_lib/customer-admin.ts:85-113`). The
stream path enforces the limit correctly.

**Concrete sequence.** A platform adapter populates a large parsed body. The
helper accepts it without a byte cap, then shape validation happens only after
the allocation already occurred.

**Recommended remediation.** Configure the platform parser limit and reject a
pre-parsed body whose canonical/raw byte length exceeds the same bound. Prefer
one raw-body path.

**Required test.** Send oversized streamed and pre-parsed objects, including
multi-byte strings; both must return the same bounded 413 response.

### P3-02 — Backfill reads privacy-forbidden fields and silently discards them

**Evidence.** The contract says backfill must never read email, name, IP,
timestamps, behavior, search text, campaign HMACs, or installer-referral data
(`docs/customer-360.md:503-510`). The implementation explicitly allowlists those
field names as ignored (`scripts/backfill-customer-360.mjs:23-60`), after the
entire JSON document has already been parsed
(`scripts/backfill-customer-360.mjs:1168-1178`). Unknown non-allowlisted fields
fail, but named prohibited fields do not.

**Concrete sequence.** A reviewed export accidentally includes contact or
behavioral data. Dry-run accepts the file and keeps the prohibited values in
process memory long enough to normalize them away, so the privacy input gate is
reported successful instead of failing review.

**Recommended remediation.** Reject any prohibited field before planning and
report only its field name/count, never its value. Prefer an upstream streaming
extractor that emits the narrow durable schema.

**Required test.** Supply each prohibited field individually and nested; assert
fail-closed, value-free errors, no digest/report/checkpoint, and no database or
network access.

## PASS observations

### PASS-01 — Production and current Preview remain fail-closed

The repository states Customer 360 is not deployed and Production is not
migrated (`docs/customer-360.md:3-30`). Production backfill apply is rejected in
code (`scripts/backfill-customer-360.mjs:138-156`). The current matrix is Blocked
at environment isolation and requires every dependent gate to stop
(`docs/customer-360-preview-test-plan.md:263-311`). No code finding in this report
changes those facts.

### PASS-02 — Namespace, merge-cycle, and tombstone invariants are strong at the row boundary

Composite foreign keys keep profiles, links, installs, and merges in one
namespace (`db/migrations/20260715120000_add_customer_360_core.sql:24-87,207-243`).
The merge trigger makes namespace/creation order/tombstones immutable, requires a
strict older-root order, and performs a recursive cycle check under a namespace
lock (`db/migrations/20260715120000_add_customer_360_core.sql:96-202`). Runtime
merge also takes the namespace lock and locks/re-resolves roots before reassignment
(`api/_lib/customer-profiles.ts:274-383`). The remaining audit-TRUNCATE gap is
separately classified P1-06.

### PASS-03 — Verified identity conflicts fail closed instead of partially attaching

Identity evidence locks are deterministic and namespace scoped
(`api/_lib/customer-identity.ts:543-581`). Verified account evidence checks all
owners first, records conflicts, and uses a savepoint so racing conflicts cannot
leave a partial verified set (`api/_lib/customer-identity.ts:325-438`). Unique
namespace/evidence constraints backstop the runtime
(`db/migrations/20260715120000_add_customer_360_core.sql:204-243`). The replayable
association concern is narrower and classified P2-05.

### PASS-04 — Customer 360 does not make entitlement or device decisions

The contract separates CRM association and money projection from active device
and entitlement authority (`docs/customer-360.md:118-178`). Identity code states
that association never mutates device bindings, credentials, transfers, policy,
or entitlement (`api/_lib/customer-identity.ts:115-117`). Commerce explicitly
labels materializations as not entitlement truth
(`db/migrations/20260715122000_add_customer_commerce_ledger.sql:1692-1697`). The
full Postgres pipeline snapshots license/token/device/transfer counts and asserts
they remain unchanged after merge, commerce, usage, and backfill
(`tests/customer-360/pipeline-postgres.test.mjs:188-205,420-442,691-712`). No
Customer 360 path was found that grants, revokes, or changes device enforcement.

### PASS-05 — Private query shape, namespace binding, and cursors are defensive

List/detail reads run in repeatable-read, read-only transactions and scope SQL to
the explicit validated namespace (`api/_lib/customer-query.ts:172-177,226-309`).
List cursors bind namespace, limit, and all filters through a hash and an HMAC
verified with constant-time comparison (`api/_lib/customer-query.ts:312-325,437-487`).
Admin auth rejects browser Origin and wrong methods before query, and responses
are no-store/nosniff (`api/_lib/customer-admin.ts:25-82,116-131`). P3-01 is the
bounded body-size exception.

### PASS-06 — Money rows remain currency partitioned and scalar amounts reject unsafe input

The contract and schema keep totals per lowercase three-letter currency
(`docs/customer-360.md:136-178`;
`db/migrations/20260715122000_add_customer_commerce_ledger.sql:1692-1697`). Scalar
amounts reject negative, fractional, and unsafe values
(`api/_lib/customer-commerce.ts:825-840`). P2-07 covers only aggregate overflow;
no cross-currency summation path was found.

### PASS-07 — Retention inventory itself is read-only and secret-safe by shape

The inventory requires a complete eight-domain policy, produces aggregate
reports/digests/fingerprints, begins `REPEATABLE READ READ ONLY`, and rolls back
on success and failure (`scripts/plan-customer-360-retention.mjs:225-325,328-385`).
It exposes no customer rows or target names by contract
(`docs/customer-360.md:414-434`). P1-01/P1-02 cover target/TLS parsing, and P2-04
covers the intentionally missing enforcement path.

### PASS-08 — Migration files are ordered, checksummed, locked, and transactional per file

The runner validates filename order/content, checks known baseline hashes, rejects
ledger checksum drift, and serializes with an advisory lock
(`scripts/apply-postgres-migrations.mjs:47-120,195-215`). Each pending file and its
ledger insert share one transaction and roll back on failure
(`scripts/apply-postgres-migrations.mjs:244-289`). The pipeline applies all 24
migrations twice in an isolated random schema and expects the second apply to be
a no-op (`tests/customer-360/pipeline-postgres.test.mjs:114-125`). P1-04 and P2-02
cover invocation/target and catalog-attestation gaps, not per-file atomicity.

### PASS-09 — Telemetry filtering, read-only posture, and secret-safe pool logging are materially hardened

Telemetry queries project an allowlisted aggregate schema rather than raw JSON
(`api/_lib/customer-usage.ts:32-40,749-780`). The pool is single-connection,
timeout-bounded, and requests default transaction read-only
(`api/_lib/customer-usage.ts:183-195`). Tests cover common TLS aliases, no-verify,
host/options/timeout overrides, literal loopback, malformed URLs, and bounded
error-code logging without secrets
(`tests/customer-360/telemetry-tls.test.mjs:36-169`). The Postgres pipeline proves
the dedicated telemetry role cannot write or access CRM schema
(`tests/customer-360/pipeline-postgres.test.mjs:127-185`). P1-01 identifies the
remaining target-option/DNS gap.

### PASS-10 — DST-sensitive merge ordering preserves database microseconds

The merge comparator recognizes the database's fixed six-microsecond UTC form
and compares it lexically before falling back to `Date.parse`, with UUID as the
final tie-breaker (`api/_lib/customer-profiles.ts:580-607`). This avoids local-DST
reinterpretation for the database form. The usage cursor does not use this
representation and is separately P1-05.

## Recommended remediation order

1. Keep all live matrix rows Blocked. Do not run migration, backfill apply,
   deployment verification with real secrets, retention inventory against a
   remote target, or usage sync.
2. Close P1-01 and P1-02 with one effective-target/TLS library plus connected
   provider identity proof. These fixes are prerequisites for every database
   gate.
3. Close P1-03 and P2-08 by binding deployment probes and one-time mutation to an
   immutable, owner-authenticated deployment approval.
4. Make migration/apply launchers explicit and clean-environment only (P1-04),
   then add exact catalog/role/audit protections (P1-06, P2-01, P2-02).
5. Fix microsecond cursor preservation and progress assertions (P1-05) before any
   source sync or freshness claim.
6. Bind backfill to approval and harden every file input (P1-07, P2-03, P3-02).
7. Resolve identity replay, commerce ordering/overflow, retention policy, and
   admin body cap (P2-04 through P2-07, P3-01).
8. Add the adversarial tests named above, rerun the complete isolated local
   Postgres gate, then collect fresh Preview/Test evidence from the beginning.
   None of that alone authorizes Production.

## Audit limitations

This step intentionally made no runtime, test, migration, README, provider, or
database change. `node_modules` is absent in this worktree, so dependency-backed
test suites were inspected but not executed here. The required remediation step
must reproduce every issue in isolated fixtures, implement the smallest fixes,
and run the repository's documented full Customer 360 and Postgres gates. Live
DNS, TLS handshake, provider role/grant, Vercel provenance, and connected-target
claims remain unverified and therefore Blocked, not PASS.

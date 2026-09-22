# Full-app updater replacement: isolated Test controls

The September 21 privileged updater experiment was rejected because its required
Settings enrollment does not meet the customer experience. Local rollback commit
`4dd084a` reverses implementation `77076c3` and documentation `aa2863f` / `5e7873f`.
The resulting source tree exactly matched canonical `origin/main`
`f8a5526bdf77acf2f49ef31fc73fad30a36acb72` before this documentation was added.
There are no deployed replacement updater API routes or enabled server keys/flags.
Do not recover the old routes as the replacement baseline.

## Boundaries and next gate

Website owns signed policy, immutable artifact delivery and operator controls.
FlowState owns CEP, native user companions, installers and local lifecycle health.
Its new clean checkout is `/Users/alexgarrett/.codex/worktrees/flowstate-user-updater-20260922`,
from canonical FlowState `55602785f6fa629a8a4f91f608d6a46c8ea4d93e`.
Read its `docs/user-updater.md` for the enrollment probe, Sparkle evaluation,
filesystem trust, migration and the complete validation gates.

The first gate requires a signed isolated Test A-to-B update: normal installation with
no required Settings step, background survival, held download with A usable,
exact signed approval, safe selection while Adobe hosts are closed, real Premiere
B load, rapid relaunch without mixed files and Adobe validation without debug mode.
Do not expand server implementation until this mechanism is measured. Apple user
LaunchAgent feasibility and an installed helper are insufficient evidence.

The September 22 signed native enrollment probe registered immediately as the
current Mac user with `requiresApproval=false` and an advancing background
heartbeat. No Settings action was taken, but prior publisher approvals on this
developer account prevent a clean-machine claim. The probe was unregistered
after testing. The later signed/notarized `mechanism-05` passed the Mac arm64 A-to-B gate: held B download while A 1.0.24 remained usable, host-open approval hold, normal closure, actual B 1.0.25 load with bridge ready, and two quick relaunches including an immediate offline relaunch. Adobe debug modes were 0. This is existing-account evidence, not clean-machine, Windows or x64 proof.

The v2 Test policy below separately names download and activation targets/cohorts,
binds exact immutable ID, full hash, scope and compatibility, expires approval,
prevents replay, supports hold/revocation and requires explicit exact rollback
authority. Operator history and policy revisions persist locally. Release/policy
trust roles remain separate; clients cannot choose destinations or commands.
An unavailable approval authority leaves the current verified app usable. Offline
revocation cannot be instantaneous; document the lease and final-commit race.

[Sparkle's delegate documentation](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html)
does not make install-on-quit an approval barrier: returning either value from
the deferred-install callback still allows an install attempt on application exit.
Unapproved downloads must stay outside that install cycle. Companion self-update
also needs freshness enforcement at commit, not simply an approved feed response.

## Public-state and release boundary

Do not change `/api/releases/latest`, legacy `rolloutPercent`, `/api/download`,
paid pointers, checkout, entitlement, credits or attribution. No Website push,
deployment, public foundational installer or Production activation is authorized
by the replacement implementation request. Keep changes reviewable on local main.

September 22 live baseline: canonical Website version SHA `f8a5526`; public Mac
1.0.21 at 25%, Windows 1.0.16 at 100%. These are observations, not future guarantees.
Verify full exact manifests again at task end. Paid continuity remains blocked
until FlowState preserves original acquisition receipts and qualifies a separate
update-continuity chain without weakening existing receipt/activation checks.

Rollback evidence and private local snapshots are under
`/Users/alexgarrett/Documents/Codex/Plans/sidestream-user-updater-20260922`.
The old loopback service on 8894 was stopped after verifying its process ownership.
The old Mac service was unregistered; the reviewed signed maintenance package removed the installed app and shell
after Alex force-quit the stuck Mac host and the reopened empty instance quit
normally. Its store and older helper are preserved. None of this modifies hosted state.

After server work, run focused policy tests, existing release/rollout regressions,
API typecheck and build; retain the required entitlement and checkout contract
checks if those shared surfaces change. A later explicit release decision must
follow synchronized main-only Git deployment and verify canonical source and
checkout behavior. No direct Vercel deployment.


## Local mechanism proof authority

`scripts/user-update-proof-authority.mjs` is a standalone loopback-only authority
for the native FlowState mechanism proof. It creates separate Test Ed25519 release
and policy keys outside the repository, serves immutable local payload/manifest
files, and issues 60-second policies with durable increasing revisions. It has no
write HTTP endpoint, customer identities, deployed routes or Production keys.
Policy changes are explicit local operations. Activation must name both the exact
catalog release ID and archive hash; held download has no activation authority.

```sh
node scripts/user-update-proof-authority.mjs --keygen --state /private/proof-keys
node scripts/user-update-proof-authority.mjs --set --state /private/proof-keys --catalog /private/proof/catalog.json --download mechanism-01-b --activate hold
node scripts/user-update-proof-authority.mjs --serve --state /private/proof-keys --catalog /private/proof/catalog.json
node --test tests/user-update-proof.test.mjs
```

To approve, repeat `--set` with `--activate mechanism-01-b --activate-hash <exact
catalog SHA-256>`; download and activation stay separate. This local Test harness
is not the future authenticated remote operator UI or durable release database.
The narrow policy tests cover held download, exact approval, scope/revisions and
signature tampering. They do not establish native installation or Premiere proof.


## Durable Test protocol v2

`scripts/user-update-test-control.mjs` validates immutable targets, deterministic
independent download/activation cohorts, explicit exact rollback and revocation.
`scripts/user-update-test-server.mjs` provides the isolated operator CLI and
loopback-only service on `127.0.0.1:8896`. It has no HTTP mutation endpoint, deployed
API route, customer identity, Production key or connection to existing release
manifests. The retained v1 proof authority on 8895 remains unchanged for historical
reproduction. V2 uses scope `sidestream-user-release-test-2`.

Each client has a random local Test identifier represented as a SHA-256 string;
it is not an account, acquisition or hardware identity. Cohort assignment hashes
scope, operator salt and this identifier. Download and activation can name different
releases and percentages. Activation does not grant download access. A cached
release can activate while a different future release downloads. Companion download
and activation targets are separate again and require a companion-kind catalog item.

An operator prepares a private JSON control file with this shape (replace IDs and
hashes from the exact immutable catalog; no key values belong in this file):

```json
{
  "schema": "sidestream.user-control.v2",
  "download": {"id": "mechanism-06-b", "sha256": "<exact SHA-256>", "salt": "test-download", "percent": 100},
  "activate": null,
  "rollback": null,
  "revoked": [],
  "companion": null
}
```

Review/apply it with:

```sh
node scripts/user-update-test-server.mjs --set --state /private/test-keys --catalog /private/catalog.json --control /private/control.json
node scripts/user-update-test-server.mjs --serve --state /private/test-keys --catalog /private/catalog.json
node --test tests/user-update-proof.test.mjs tests/user-update-test-control.test.mjs
```

`--set` checks catalog bytes and hashes before persisting the control and append-only
operator history in one atomic file. History is bounded at 1,024 revisions and
requires explicit archiving when full. Operator and server lock files prevent
concurrent writers. A crashed process may leave a lock; verify that exact process
is absent before removing its task-owned stale lock. Do not bypass a live owner.

To approve a release, set `activate` to its exact ID/hash, cohort salt and percentage.
To hold, set `activate` to null. To revoke future download/activation, add the hash
to `revoked` and clear any target referencing it. To authorize rollback, name its
exact activation target and add `rollback: {"fromSha256":"<currently selected>",
"toSha256":"<approved target>"}`. The native high-water mark still prevents an
ordinary policy from replaying historical releases after rollback. Companion
controls use `companion: {"download": <choice or null>, "activate": <choice or null>}`.
They cannot change native keys or agent registration through policy.

Signed `/policy?client=<hash>` responses bind the client, complete targets,
monotonic durable revision and a 60-second lease. Signed `/delivery` responses
issue short-lived exact-target URLs only to the eligible download cohort. Range
requests require the matching strong hash ETag, exact start/end and a maximum
4 MiB range; malformed ranges, changed ETags, expired URLs and revoked artifacts
fail closed. Clients refresh a URL for each chunk and independently verify signed
inventories, prefix checkpoints and final hashes. A URL grant is never activation
authority. The native wrapper limits bytes, disk, rate, attempts and expensive
networks; server range behavior does not substitute for those limits.

The signed native builder can pin an explicit HTTPS authority; HTTP is permitted
only for exact Test loopback and redirects are refused. The service can remain a
loopback origin behind a separately reviewed TLS ingress, with remote operators
using authenticated host access for the CLI. No such ingress is deployed here.

The service is an implemented local Test surface, not an authenticated remote
operator dashboard or deployed release database. Any remote transport, ingress,
operator authentication, durable database adapter and key-management deployment
requires a separately reviewed release decision. No policy becomes public merely
because a local candidate or test passes. Current native v2/self-update results
must be read from the evidence report separately from the proven v1 mechanism.

The signed native mechanism-06 has loaded A with its bridge ready and Adobe debug
modes 0. A held B download retained 19 verified chunks through an authority outage
and an OS-restarted helper, then completed without redownloading that prefix.
Exact B approval still waits for the empty proof host to close. Its stuck native
accessibility menu is recorded separately; no v2 B load, live rollback or companion
exchange has been claimed. Signed/notarized companion-07 contains the subsequent
bounded-transfer fix and preserves the same authority, keys and service identity.
The private evidence report records precise source/artifact hashes and unpassed
gates; these results do not authorize a remote deployment or customer migration.

Companion-07 subsequently downloaded completely with its exact full hash, but the
installed native extractor refused publication because it tried to seal a CEP-only
metadata file inside the native app. FlowState fixed this and added a real extraction
regression that fails before the correction and passes afterward. This installed
extractor cannot deliver its own repair; the next gate needs a normal explicit
replacement with the corrected signed Test app, preserving the current evidence.
The corrected candidate-08 build stopped before signing because the Mac exhausted
disk space. Only verified reproducible task copies were reclaimed; signed archives,
streams and installed stores remain. All download/activation targets are held and
the loopback service is stopped. No companion swap or new-build acknowledgment
has occurred. Native qualification needs host closure and adequate build space.

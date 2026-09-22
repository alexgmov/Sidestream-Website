# Full-app updater replacement: held at the mechanism gate

The September 21 privileged updater experiment was rejected because its required
Settings enrollment does not meet the customer experience. Local rollback commit
`4dd084a` reverses implementation `77076c3` and documentation `aa2863f` / `5e7873f`.
The resulting source tree exactly matched canonical `origin/main`
`f8a5526bdf77acf2f49ef31fc73fad30a36acb72` before this documentation was added.
There are no replacement updater API routes or enabled server keys/flags yet.
Do not recover the old routes as the replacement baseline.

## Boundaries and next gate

Website owns signed policy, immutable artifact delivery and operator controls.
FlowState owns CEP, native user companions, installers and local lifecycle health.
Its new clean checkout is `/Users/alexgarrett/.codex/worktrees/flowstate-user-updater-20260922`,
from canonical FlowState `55602785f6fa629a8a4f91f608d6a46c8ea4d93e`.
Read its `docs/user-updater.md` for the enrollment probe, Sparkle evaluation,
filesystem trust, migration and the complete validation gates.

The first gate is a signed isolated Test A-to-B update: normal installation with
no required Settings step, background survival, held download with A usable,
exact signed approval, safe selection while Adobe hosts are closed, real Premiere
B load, rapid relaunch without mixed files and Adobe validation without debug mode.
Do not expand server implementation until this mechanism is measured. Apple user
LaunchAgent feasibility and an installed helper are insufficient evidence.

The September 22 signed native enrollment probe registered immediately as the
current Mac user with `requiresApproval=false` and an advancing background
heartbeat. No Settings action was taken, but prior publisher approvals on this
developer account prevent a clean-machine claim. The probe was unregistered
after testing. No A/B payload or Premiere-loaded replacement is qualified yet.

The future policy must separately name download and activation targets/cohorts;
bind exact immutable ID, full hash, scope and compatibility; expire approval;
prevent replay; support hold and revocation; and require explicit exact rollback
authority. Persist operator revision history and audit, pin release/policy trust
roles separately, and never let a client choose destinations or executable commands.
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
The old Mac service was unregistered; installed app/shell removal is separately
pending normal host closure and the signed maintenance package. Its store and
older helper are preserved. None of this modifies hosted state.

After server work, run focused policy tests, existing release/rollout regressions,
API typecheck and build; retain the required entitlement and checkout contract
checks if those shared surfaces change. A later explicit release decision must
follow synchronized main-only Git deployment and verify canonical source and
checkout behavior. No direct Vercel deployment.

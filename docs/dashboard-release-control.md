# Dashboard Windows rollout control

The Website owns the protected Save operation in `ops/release-control/`.
FlowState owns the slider, owner unlock form, and live rollout view under
`analytics/src/`. The sanitized dashboard remains publicly readable; changing
Production requires owner access. This control changes update notices only.
Every new Windows installer request continues to receive the current release.

## Save contract

The request contains only the Windows release version, artifact SHA-256,
expected current percentage, and requested integer percentage from 0 to 100.
The control verifies the live release before writing. Zero pauses notices;
100 offers them to all eligible existing installations. This does not install
updates silently. Mac and paid installer manifests are independent.

Save runs serially against clean synchronized `main` in
`/srv/sidestream/website-backend`. It verifies Production source before editing,
updates only the Windows manifest/approval sidecar and README, runs rollout and
entitlement tests, builds the Website and checks Linux API types, commits on
`main`, and pushes only `main:main`. It builds the Linux runtime output only
after the push succeeds, so a failed pre-publication check cannot leave compiled
unpublished manifest data for a later restart. The existing Vercel Git integration publishes Production.
The control restarts only the Linux Website API and verifies the exact public
version/digest/percentage, canonical website commit marker, and direct Checkout
redirect before reporting success. No Vercel CLI deployment is used.

The installer bytes and cumulative `startedAt` remain fixed; each Save updates
`rolloutApprovedAt`. The slider is a manual owner approval, not an automatic
health decision. Automatic rollout is not enabled by this feature. Declines are
allowed for rollback of notice eligibility. Already installed software and
already completed installer downloads are unaffected.

## Hosting and authentication

`server.mjs` listens only on `127.0.0.1:8790`. Include `nginx.conf` next to the
existing dashboard proxy to expose only `/analytics/api/rollout-control/`.
Do not expose port 8790 directly. The dedicated systemd service uses a root
controller solely to restart the Website API; Git, builds, and file changes run
as `sidestream-dev`. Installed control scripts live under the root-owned
`/usr/local/lib/sidestream-release-control/`, separate from the mutable checkout.

Generate a separate random owner key at `/etc/sidestream/rollout-owner-key`,
root-owned mode 0600. Never reuse the CRM, telemetry, Stripe, or Git credential.
An owner unlock exchanges that key for a 30-day signed Secure, HttpOnly,
SameSite=Strict cookie. The key is never returned by an API, embedded in public
JavaScript, or logged. Rotating it revokes existing cookies after service restart.
The login endpoint bounds attempts per gateway IP. Every write requires a
custom header and JSON; cross-origin forms/preflights are refused. Nginx must
preserve cookies and the custom header and replace `X-Real-IP` with the actual
client IP. TLS and the existing public-read gateway remain required.

GET `/status` reveals authentication state and, only to the owner, the current
save job. POST `/login` unlocks. POST `/save` returns a job immediately; the UI
polls until saved or failed. A stale release/percentage, concurrent Save, dirty
checkout, failed checks/push, or unverified Production response cannot become a
successful Save. Raw command output and credentials never reach the browser.

## Recovery and checks

Before its commit, a failed operation restores only its own three source files.
After commit or push, it preserves the change for audit; it never resets history
or force-pushes. Refresh the public percentage before retrying after a failure.
An interrupted browser does not stop publication. Service interruption can
leave an operation without a completion message; public manifest and canonical
SHA are the recovery truth. Resolve any local-ahead or dirty-main condition
deliberately before the next Save. Git and service deployment permissions must
remain available to the existing owner/runtime accounts.

Run `node --test tests/release-control.test.mjs` for owner authentication,
cross-origin write rejection, stale-release rejection, serial saves, idempotent
same-percentage verification, invalid inputs, and failed-apply reporting.
Verify the deployed UI by saving the already-live percentage (no release
mutation), then check both public manifest and dashboard. A changed-percentage
release must still pass the exact canonical SHA and Checkout checks.

The FlowState Windows Release Rollout view owns the live slider. Verify an
owner-authenticated same-percentage Save after deployment and keep owner access
private. Local owner key backup: `.env.rollout-owner.local` (ignored by Git).
The hosted operator uses the previous canonical commit's author email for the
automation commit so the existing Git integration recognizes the owner.
`apply.mjs <exact-change-json> --check` runs clean-main/source/tests/build
preflight without changing release source. Existing unrelated user work is
preserved by deploying only the scoped dashboard files from canonical main.

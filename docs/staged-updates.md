# Signed full-app update controls — Test only, default off

These endpoints are separate from `/api/releases/latest`, `rolloutPercent`, public
installer download pointers and the managed yt-dlp updater. They change no checkout,
entitlement, credit or acquisition contract. FlowState owns native helpers, CEP
bootstrap, packaging and local health. Its `docs/staged-updater.md` owns native
qualification and known incomplete Windows/paid integration.

## Routes and data

| Surface | Contract |
| --- | --- |
| `GET/HEAD /api/releases/staged` | Exactly `channel`, `platform`, `arch`, `flavor`; signed policy lease, `no-store` |
| `GET/HEAD /api/releases/staged-artifact` | Same scope plus exact `releaseId`, `sha256`; fresh five-minute private artifact redirect |
| `api/_lib/staged-updates.ts` | Strict versioned scope/release/policy/envelope schemas, canonical bytes, RSA verification, stable cohorts and replay checks |
| `data/staged-update-catalog.json` | Empty by default; public pinned certificates, signed per-scope controls, immutable identity history when managed by operator |
| `scripts/manage-staged-updates.mjs` | Local dry-run-first signing operation, exact confirmations, compare-and-swap revision and durable signed audit |
| `scripts/publish-staged-update-artifact.mjs` | Verify signed release and immutable local bytes; private Blob upload refuses overwrite |

No enabling flag exists for Production. `SIDESTREAM_STAGED_UPDATES_TEST_ENABLED=1`
enables only Test; other requests receive 404. Disabled routes receive 503. Set
`SIDESTREAM_STAGED_UPDATES_KEY_ID` and `SIDESTREAM_STAGED_UPDATES_PRIVATE_KEY` only
in protected server configuration. `SIDESTREAM_STAGED_UPDATES_CATALOG` optionally
points to an absolute protected runtime catalog (local service); Vercel defaults
to the Git-bundled catalog. All remain unconfigured during development.

Scope is Test/Production, darwin/win32, arm64/x64 and standard/paid-onboarding.
Windows arm64 scope is invalid. The schema can express paid flavor; the current
native service refuses paid enrollment until receipt continuity is qualified.
Release identity includes version, exact full ZIP hash/size, expanded-size bound,
file-manifest hash, immutable filename and OS/host/helper/engine compatibility.

`sidestream.signed.v1` signs canonical JSON bytes using RSA-3072 PKCS#1 SHA-256.
The envelope binds `kind` and trusted `keyId`; the signed schema binds the domain.
Clients pin certificate fingerprints out of band in signed protected enrollment.
Role checks separate policy and release authority. Internal Test candidates use
one Test-only key; any customer design must provision separate offline release
and online policy keys. A remote policy cannot add trust. Key rotation/recovery
requires a reviewed signed foundational/helper repair with overlapping old/new
public pins, then changing the server signer after enrollment coverage. Compromised
trust cannot be repaired by downloading an unauthenticated replacement key.

Policy has independent `download` and `activation` targets/percentages, `hold`,
exact revocations, signed releases, audit operator/reason, monotonic revision and
15-minute maximum lease. Activation is always exact ID + hash, never “latest”.
Ordinary downgrades fail; emergency authorization names exact `rollbackFrom`.
Optional `healthRollbackTo` names one signed previous healthy generation; leave
it null outside controlled tests until native caller health evidence is qualified.

Stable download/activation cohorts use independent SHA-256 buckets over scope,
purpose and persistent local installation identity. Increasing a percentage grows
that cohort without reshuffling. Artifact delivery does not receive the installation
identity: percentages are client eligibility, not artifact secrecy/access control.
Hold stops activation but permits an eligible background download. Revocation
stops both future delivery and activation for that exact identity; existing installed
code keeps working. None of these controls changes the legacy notice percentage.

## Freshness and offline operation

The server renews only `issuedAt`/`expiresAt` on the already signed operator control.
Changing control fields requires a higher operator revision. Clients persist the
highest revision, control digest, issued time and observed clock. Old revisions,
same-revision equivocation, backdated leases and clock rollback fail closed.

The helper fetches policy after expensive verification and immediately before
selection. No successful response means no new installation. Revocation is visible
at the next response or cached lease expiry, never instantly on an offline device.
There is a small unavoidable race after the final signed response; an already
committed switch needs an explicitly authorized rollback. Disabling the server
does not disable the installed app. Restoring service must preserve revision history.

## Operator workflow

Start with immutable signed release envelopes from the qualified FlowState builder,
a protected signing key (POSIX mode 0600), and a proposed policy JSON matching the
contract. Do not put private keys, signed URLs, customer IDs or credentials in Git.
The `audit.operator` label is descriptive; authorization comes from possession of
the trusted private key and protected publication access, not the label.

```sh
npm run release:staged-artifact -- --release RELEASE_ENVELOPE.json --keys PUBLIC_KEYS.json --artifact EXACT_ID-HASH.zip
npm run release:staged-policy -- --catalog CATALOG.json --policy PROPOSED_POLICY.json --artifacts ARTIFACT_DIRECTORY --expected-revision 0
```

Dry runs verify signatures, scopes, byte hashes and immutable identities without
writing or calling a provider. Add `--keys PUBLIC_KEYS.json` only for initial trust
setup. Applying policy requires `--apply --key-id KEY_ID --private-key PRIVATE_KEY`
and `--confirm-download RELEASE_ID:SHA256` / `--confirm-activation RELEASE_ID:SHA256`
for each configured target, even at 0%. Emergency rollback also requires
`--confirm-rollback OLD_ID:OLD_SHA256>NEW_ID:NEW_SHA256` as one quoted argument.
Always set a fresh issuance/expiry and increment the previous operator revision by
exactly one. Review separate scopes independently.

Artifact publication additionally requires `--apply --confirm RELEASE_ID:SHA256`
and protected Blob credentials. It uploads the exact verified bounded buffer to
`staged-updates/<scope>/<releaseId>-<sha256>.zip`, with random suffix and overwrite
disabled. A published artifact alone grants no activation. Download routes check
the exact currently offered identity and provider length; the native client verifies
the signature and complete hash regardless of provider metadata or URL changes.

Policy apply locks the local catalog, checks the original revision/content again,
fsyncs an immutable signed audit entry before atomic catalog replacement, then
syncs its parent directory. Retrying the identical interrupted operation is safe;
conflicting revision reuse fails. A process crash can leave `CATALOG.json.lock`: after confirming no other operator is running, remove only that stale lock and retry the identical reviewed operation. Never remove audit/history files to bypass a conflict. Preserve the catalog, identity history and audit
together. Concurrent operators or a stale manual edit must not replace them.
This command does not deploy or update a remote server.

For local Test staging, use the generated candidate catalog/key/artifacts:

```sh
npm run dev:staged-updates -- --catalog /path/to/candidate/catalog.json --artifacts /path/to/candidate/artifacts --private-key /path/to/ignored/publisher.key --key-id staged-test-2026 --port 8894
```

The qualification server binds only `127.0.0.1`, uses the real route/signing code,
and serves expiring HMAC-protected local range downloads. It is not a deployment or
a remote control panel. FlowState's candidate qualification command uses a disposable
store, accelerated transfer and simulated host timing, then returns activation to
hold. No OS service or real Adobe launch is implied.

## Checks and publication gates

`npm run test:staged-updates` covers signatures, wrong roles, strict scope, hashes,
cohort independence, hold/revocation, lease renewal, replay/expiry/clock handling,
default-off/Production behavior and operator confirmation/revision checks. Set
`SIDESTREAM_UPDATE_CORE` and `SIDESTREAM_UPDATE_NATIVE` to the isolated FlowState
core and native verifier to additionally run the cross-language signed-policy test.
The legacy release tests and entitlement/build gates remain mandatory.

Keep Test policy held and download/activation states distinct. Do not enable customer
activation or publish a foundational customer installer under this implementation
request. Source must first pass review and applicable Mac/Windows real-host gates,
including authenticated health, paid identity continuity, upgrade/repair/uninstall,
OS approval and actual next-launch version. Proposed later steps are Test, internal,
1%, 5%, 25%, 100% independently per OS, with dwell time and minimum evidence chosen
with Alex. Do not reuse legacy release-notice adoption or simulated launch evidence.

Any Website publication requires Alex's final release decision, then the synchronized
main-only contract: `verify:production-source`, `test:entitlement`, `build`, commit,
push `main:main`, wait for the Git-linked Production deployment and verify canonical
`version.json` SHA plus `/api/checkout/start` redirect. No direct Vercel deployment.
No key, flag, Blob publication or customer pointer is changed by these source edits.

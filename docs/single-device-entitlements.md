# Single-device entitlement device-domain and support reference

> **Reference status: device-domain/support only. No Production action is
> authorized here.** No executable Production procedure exists. The former
> cutover in this file is removed, and
> [`docs/api-hardening-runbook.md`](api-hardening-runbook.md) records API facts,
> blockers, and capabilities required by a future separately reviewed plan
> only. Neither document authorizes status, backup, migration, deployment,
> backfill, enforcement, support mutation, fallback, or rollback in Production.

## Contract

- Production permits one active device per Sidestream account at a time.
- Preview, development, and test deployments use the restricted `test` license namespace, exact test API hosts, and a dedicated Test database. Test is not a second production seat and must never share a production host or database target.
- A reconnect from the same device is idempotent and free: it does not consume a device move.
- A confirmed move to a different device deactivates the previous device, revokes its live access and refresh credentials, and counts toward the default limit of three confirmed moves in a rolling 30-day window.
- First activation does not count as a move. Deactivating and later activating the same device does not count; activating a different device after deactivation does count. A namespace-scoped support override can raise the absolute limit to at most 10 and can last at most 30 days.
- Download authorization is checked before a Pro media download starts. A download already accepted and in progress is not cancelled mid-transfer when a device is moved or deactivated. The next authorization, verify, or refresh request observes the new device state.
- Raw hardware fingerprints, serial numbers, device names, and raw client device identifiers are prohibited from storage, logs, operator output, analytics, and support notes. Only a server-secret HMAC-SHA-256 device digest and coarse metadata may cross the persistence boundary.
- OS-backed non-exportable device keys are a separate future hardening project. This contract does **not** deliver hardware-backed identity, anti-cloning protection, or a non-exportable key guarantee.

The database is the concurrency backstop. `public.sidestream_account_devices` keeps immutable lifecycle rows plus revocation state, while `public.sidestream_device_transfers` records confirmed replacements. Partial unique indexes allow at most one unrevoked row per account in `production` and one in `test`, even under a two-device race.

## Routing map

| Concern | Source of truth |
| --- | --- |
| Additive schema, constraints, RLS, and unique indexes | `db/migrations/20260714190000_add_single_active_account_devices.sql` |
| Pure decisions, move limits, policy modes, and public device codes | `api/_lib/device-policy.ts` |
| Trusted deployment, host, database, and credential namespaces | `api/_lib/license-environment.ts` |
| Transaction locking, activation, transfer, verify, refresh, download authorization, status, and deactivation | `api/_lib/account.ts` |
| Account decision and confirmed transfer page | `api/activation/claim.ts` |
| Signed-in coarse device status and deactivation UI | `account.html` |
| Activation-aware restore, move, or purchase entry | `upgrade.html` |
| Read-only audit and explicit backfill | `scripts/audit-license-devices.mjs` / `npm run devices:audit` |
| Read-only support view, binding clear, and temporary move override | `scripts/manage-license-device.mjs` / `npm run devices:manage` |
| Static and disposable-Postgres proof | `npm run test:single-device` |

## Data and privacy boundary

### `public.sidestream_account_devices`

Each row belongs to one `account_id` and one `license_namespace` (`production` or `test`). It stores the lowercase 64-character device HMAC, coarse `platform` (`macos`, `windows`, or `unknown`), bounded `app_version` and `build_channel` diagnostics, activation/last-seen timestamps, and optional revocation state.

Lifecycle rows are retained rather than rewritten or deleted. A revoked row has both `revoked_at` and a database reason of `deactivated` or `replaced`. Public credential failures use the stable codes `device_deactivated` and `device_replaced`.

### `public.sidestream_device_transfers`

Each row joins a prior and replacement lifecycle row from the same account and namespace. It records the coarse initiator (`account`, `support`, or `system`), reason, and timestamp. The rolling limit deduplicates lifecycle transitions and explicit transfer rows by destination so one confirmed move is not counted twice.

Both tables have RLS enabled and revoke direct `anon` and `authenticated` table access. Browser code and the CEP client must use server API routes; they must never receive a Postgres URL or direct table access.

The server hashes a raw `deviceId` with HMAC-SHA-256 before database use. `SIDESTREAM_LICENSE_HASH_SECRET` must remain stable. Existing production hashes predate that dedicated variable and can depend on the current Postgres connection-string fallback, so changing the secret during a rollout would strand existing devices with `device_mismatch`. Preserve the current compatible value and schedule any dual-hash secret rotation separately.

Account UI and API output are intentionally coarse: platform plus activation/last-seen dates, never a guessed computer name. Policy observations and operator reports use short one-way references instead of account UUIDs or device digests. Secrets, raw identifiers, activation keys, access/refresh tokens, database URLs, and payment data must not be logged.

## Environment contract

The server derives the namespace from trusted deployment state and the trusted request host. Client `buildChannel`, request JSON, query strings, or headers cannot choose a namespace.

| Variable | Contract |
| --- | --- |
| `SIDESTREAM_LICENSE_NAMESPACE` | Optional explicit `production` or `test`; when set it must agree with deployment and host state. |
| `VERCEL_ENV` | `production` selects production; `preview`, `development`, or `test` selects Test. |
| `SIDESTREAM_PRODUCTION_API_HOSTS` | Optional comma-separated additions to the production allowlist. Defaults already include `sidestream.tv`, `www.sidestream.tv`, and `sidestream-xi.vercel.app`. |
| `SIDESTREAM_TEST_API_HOSTS` | Required exact host allowlist for Test. It may not overlap a production host. |
| `SIDESTREAM_POSTGRES_URL` | Server-only production database selected for the production namespace. |
| `SIDESTREAM_TEST_POSTGRES_URL` | Dedicated Test database selected for preview/development/test. It must not resolve to the production database. In the integration-test process, this same variable must instead point at a disposable test database. |
| `SIDESTREAM_DEVICE_POLICY_MODE` | `off`, `observe`, or `enforce`; invalid or missing values resolve to `observe`. |
| `SIDESTREAM_LICENSE_HASH_SECRET` | Stable server-only HMAC secret; preserve the compatibility value during this cutover. |

Unknown hosts, missing Test hosts, missing selected databases, overlapping hosts, identical production/Test database targets, or conflicting namespace/deployment/host signals fail closed with `license_environment_unavailable` or a route-specific retryable `503`.

### Policy modes

- `observe` is the rollout and rollback mode. It allows non-definitive activation/credential mismatches while emitting `sidestream_device_policy_observation` with pseudonymous references.
- `enforce` returns the stable device error and requires the account transfer flow before a different device can become active.
- `off` suppresses both enforcement and observation for non-definitive mismatches. It is not the normal rollback target.

Explicitly revoked lifecycle rows and credentials older than a replacement generation remain invalid in every mode. `observe` therefore does not resurrect a device that was already deactivated or replaced. The download-authorization route also requires an exact active binding in every mode; its purpose is a definitive pre-download decision.

## Account and API states

### Account decision flow

`upgrade.html` sends activation-bearing recovery to `GET /api/activation/claim`. That GET authenticates first, is no-store/read-only, and shows exactly one decision:

- Free account: continue to the existing one-time purchase without pre-binding the activation.
- No active production device: connect/restore this device.
- Same active device: reconnect without consuming a move.
- Different active device: show coarse prior-device context, remaining moves, and an explicit checkbox confirming that the previous device will be deactivated.
- Limit reached: show `transfer_limit_reached`; no device is changed.

The mutation is a same-origin, account-bound, CSRF-protected POST. Transfer uses compare-and-swap against the reviewed prior binding; a concurrent change returns `binding_changed` rather than replacing an unreviewed device. Success redirects to `thank-you.html` with `connection=restored` or `connection=transferred`.

### Route contract

| Route | Success | Stable failure/state contract |
| --- | --- | --- |
| `POST /api/activation/status` | `active` with a device-scoped credential family | Status payloads include `pending`, `pending_payment`, `completed`, `not_found`, `device_mismatch`, `expired`, `transfer_required`, `transfer_limit_reached`, `device_replaced`, and `device_deactivated`. Device-policy states are returned in the JSON `status`/`code`; clients must not treat every HTTP 200 as active. |
| `GET /api/activation/claim` | Read-only HTML decision page | Authentication redirect, unavailable/limit page, or `409`; it never binds on GET. |
| `POST /api/activation/claim` | Confirmed restore or transfer redirect | `invalid_intent`, `csrf_rejected`, `transfer_intent_required`, `transfer_limit_reached`, `binding_changed`, or `unavailable`. |
| `POST /api/license/verify` | `200` with `active: true` | `400 invalid_request`; `401 invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`; `403 license_inactive`; `503 license_environment_unavailable`. |
| `POST /api/license/refresh` | `200` with a rotated/replayed active credential family | Same status classes as verify. A two-minute predecessor window returns the same rotated family after a lost response; callers retain credentials on transient failures. |
| `POST /api/license/authorize-download` | Exactly `{ "active": true }` | `401 device_replaced` or `device_deactivated`; `403 license_inactive`; retryable `503 authorization_unavailable`. It does not return account, device, token, or license details. |
| `GET /api/account/device` | `{ active, device }`, where device is null or coarse platform/date data | `401 authentication_required`; retryable `503 device_status_unavailable`. The route is read-only. |
| `POST /api/license/deactivate` | `{ active: false, deactivated }` | Requires an authenticated same-origin JSON request with `intent=deactivate_active_device`; otherwise `400 invalid_intent`, `401 authentication_required`, `403 same_origin_required`, or retryable `503 deactivation_unavailable`. |

Deactivation keeps the purchase and lifecycle history, revokes the active row and all live account token families in the selected deployment database, and leaves no active slot. Reconnecting the same device remains free; connecting a different device is evaluated against retained move history.

### Download boundary

The CEP client calls `POST /api/license/authorize-download` immediately before starting each Pro media transfer. A `200` accepts that attempt. Deactivation or a confirmed transfer affects subsequent authorization, verify, and refresh calls but does not reach into the downloader to abort bytes already in flight. Do not add a mid-transfer kill switch as an undocumented side effect; it would be a separate product and protocol change.

A retryable `503` is not an authorization success and should prevent a new transfer from starting, but it must not clear stored credentials or cancel a transfer that was already accepted. The public website installer route at `/api/download` is separate from this Pro media-download authorization contract.

## Operator and support workflow

This section describes support decisions, not a production command surface. The
current audit and support CLIs load a general environment file before a database
environment file, preserve inherited Postgres variables, and connect remotely
without provider-CA/hostname verification. Consequently, no production audit,
view, clear, override, or backfill example is executable from this reference.
Production use remains blocked until separately reviewed tooling can prove an
empty allowlisted environment, the one
selected non-pooling variable, a non-secret target fingerprint, provider-CA and
hostname verification, and the connected database without printing a connection
string. The API runbook records this blocker but is not an executable support
procedure.

### Fleet audit and backfill

The fleet report uses pseudonymous account references and classifies accounts as
zero, one, or multiple unrevoked credential candidates. Read-only mode
deliberately selects no winner. A separately reviewed backfill may choose the
most recently seen candidate with a deterministic opaque tie-break, create at
most one binding per eligible account, and leave zero-candidate accounts empty
for their next compatible activation. That description is implementation
behavior, not approval to run the production tool.

### Support view

Start every case with the pseudonymous read-only view only after the canonical
target and authenticated-transport gates exist and pass. Prefer self-service
next: same-device reconnect, confirmed transfer from the activation page, or
explicit deactivation from `account.html`.

If a separately authorized support procedure clears a stranded binding, it must
record a permitted reason and a lowercase non-email operator ID.

Allowed reasons are `customer_request`, `lost_device`, `repair_replacement`, `support_recovery`, and `fraud_review_resolved`. Clear deactivates the current binding, revokes that device's live tokens, retains history, and writes an idempotent support audit entry.

If the rolling limit blocks a legitimate recovery, a separately authorized
override sets the namespace's absolute move limit, not “extra moves.” The limit
remains 1-10 and the expiry remains within 30 days. This reference intentionally
does not reproduce the mutation command.

`features.singleDevicePolicy` is the reserved operator-owned support/audit key. Checkout and webhook fulfillment must preserve it for the same account. Do not hand-edit bindings, token rows, transfers, or this feature key with ad hoc SQL.

## Verification commands

The aggregate proof requires a disposable Postgres database:

```bash
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:single-device
npm run typecheck
npm run build
```

The harness rejects a target matching any configured runtime database URL, creates a random isolated schema, applies the complete migration chain there, blocks Stripe/Vercel network access, and drops the schema in cleanup. It proves migration/RLS state, database races, observe/enforce behavior, refresh replay, one-winner transfer and token revocation, deactivation, move limits and overrides, namespace isolation, legacy compatibility, and exact Checkout fulfillment. Do not aim it at production or a deployed Test database.

Useful narrower commands are `npm run test:single-device-postgres`, `npm run test:single-device-ops`, and `npm run test:entitlement`.

## Production procedure status

The production section that formerly appeared here is intentionally gone. It
contained a false no-ledger claim, a one-file database path, and alternate
backup, deployment, backfill, enforcement, and rollback ordering that could
bypass the full API-hardening gates.

No executable Production procedure exists.
[`docs/api-hardening-runbook.md`](api-hardening-runbook.md) records the current
API contract, open blockers, and capabilities a future separately reviewed plan
would need; it does not provide executable status, migration, deployment,
support, fallback, or rollback steps. Do not reconstruct the retired procedure
from Git history, tickets, or this domain reference. No Production action was
performed while neutralizing this document.

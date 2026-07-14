# Single-device entitlement contract and cutover runbook

> Operational status: **not executed**. This document defines a human-gated production cutover. It does not record or imply that a production backup, migration, deployment, device audit, backfill, or enforcement change has occurred. Attach dated operator evidence to the change record when each gate is actually completed.

## Contract

- Production permits one active device per Sidestream account at a time.
- Preview, development, and test deployments use the restricted `test` license namespace, exact test API hosts, and a dedicated Test database. Test is not a second production seat and must never share a production host or database target.
- A reconnect from the same device is idempotent and free: it does not consume a device move.
- A confirmed move to a different device deactivates the previous device, revokes its live access and refresh credentials, and counts toward the default limit of three confirmed moves in a rolling 30-day window.
- First activation does not count as a move. Deactivating and later activating the same device does not count; activating a different device after deactivation does count. A namespace-scoped support override can raise the absolute limit to at most 10 and can last at most 30 days.
- Download authorization is checked before a Pro media download starts. A download already accepted and in progress is not cancelled mid-transfer when a device is moved or deactivated. The next authorization, verify, or refresh request observes the new device state.
- Raw hardware fingerprints, serial numbers, device names, and raw client device identifiers are prohibited from storage, logs, operator output, analytics, and support notes. Only a server-secret HMAC-SHA-256 device digest and coarse metadata may cross the persistence boundary.
- OS-backed non-exportable device keys are a separate future hardening project. This cutover does **not** deliver hardware-backed identity, anti-cloning protection, or a non-exportable key guarantee.

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

The server hashes a raw `deviceId` with HMAC-SHA-256 before database use. `SIDESTREAM_LICENSE_HASH_SECRET` must remain stable. Existing production hashes predate that dedicated variable and can depend on the current Postgres connection-string fallback, so changing the secret during this cutover would strand existing devices with `device_mismatch`. Preserve the current compatible value and schedule any dual-hash secret rotation separately.

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

All commands accept `SIDESTREAM_ENV_FILE` and `SIDESTREAM_DB_ENV_FILE`. Mutations require an explicitly selected non-pooling `*_URL_NON_POOLING` variable; pooled/runtime endpoints are rejected. Never paste a connection string on the command line or into a ticket.

### Fleet audit and backfill

Read-only is the default:

```bash
SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env \
  npm run devices:audit -- \
  --target production \
  --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING
```

The report uses pseudonymous account references and classifies accounts as zero, one, or multiple unrevoked credential candidates. Read-only mode deliberately selects no winner. Apply mode is a separate cutover gate; it chooses the most recently seen candidate with a deterministic opaque tie-break, creates at most one production binding per eligible account, and leaves zero-candidate accounts empty for their next compatible activation.

### Support view

Start every case with the read-only view:

```bash
SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env \
  npm run devices:manage -- view \
  --account-id <account-uuid> \
  --namespace production \
  --target production \
  --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING
```

Prefer self-service next: same-device reconnect, confirmed transfer from the activation page, or explicit deactivation from `account.html`.

If support must clear a stranded binding, record a permitted reason and a lowercase non-email operator ID:

```bash
SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env \
  npm run devices:manage -- clear \
  --account-id <account-uuid> \
  --namespace production \
  --target production \
  --reason lost_device \
  --operator-id <support-operator-id> \
  --apply \
  --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
  --confirm-production MANAGE-PRODUCTION-DEVICE
```

Allowed reasons are `customer_request`, `lost_device`, `repair_replacement`, `support_recovery`, and `fraud_review_resolved`. Clear deactivates the current binding, revokes that device's live tokens, retains history, and writes an idempotent support audit entry.

If the rolling limit blocks a legitimate recovery, an override sets the namespace's absolute move limit, not “extra moves”:

```bash
SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env \
  npm run devices:manage -- override \
  --account-id <account-uuid> \
  --namespace production \
  --target production \
  --max-moves <1-10> \
  --expires-at <future-iso-timestamp-within-30-days> \
  --reason support_recovery \
  --operator-id <support-operator-id> \
  --apply \
  --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
  --confirm-production MANAGE-PRODUCTION-DEVICE
```

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

## Human-gated production cutover

Use one operator to execute and a second person to review the target, evidence, and go/no-go at every gate. Record the commit, deployment ID, UTC time, operator, reviewer, command or dashboard used, redacted output, and explicit decision. A checklist without evidence is not a completed cutover.

### 1. Back up the production database

**Gate:** confirm the direct production target out of band, maintenance owner, encrypted backup destination, retention, and restore owner.

```bash
export BACKUP_PATH='/secure/backups/sidestream-before-single-device.dump'
pg_dump "$SIDESTREAM_POSTGRES_URL_NON_POOLING" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$BACKUP_PATH"
pg_restore --list "$BACKUP_PATH" >/dev/null
shasum -a 256 "$BACKUP_PATH"
```

Stop if the dump, list check, checksum, encryption/retention confirmation, or target review fails. Record only the protected artifact reference and checksum, never the connection string.

### 2. Record migration status

The repository migration runner has no migration ledger; `--dry-run` lists files but does not prove database state. Use read-only catalog checks before applying anything:

```sql
select to_regclass('public.sidestream_account_devices') as account_devices,
       to_regclass('public.sidestream_device_transfers') as device_transfers;

select indexname
from pg_indexes
where schemaname = 'public'
  and indexname in (
    'sidestream_account_devices_one_active_production',
    'sidestream_account_devices_one_active_test'
  )
order by indexname;

select relname, relrowsecurity
from pg_class
join pg_namespace on pg_namespace.oid = pg_class.relnamespace
where nspname = 'public'
  and relname in ('sidestream_account_devices', 'sidestream_device_transfers')
order by relname;

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('sidestream_account_devices', 'sidestream_device_transfers')
  and grantee in ('anon', 'authenticated')
order by grantee, table_name, privilege_type;
```

Record whether the migration is absent, partial, or complete. Stop on a partial/unexpected shape and investigate; do not blindly rerun and call that “status.”

### 3. Apply the additive migration

**Gate:** backup evidence and migration-status review are approved.

Use the approved direct migration mechanism with `ON_ERROR_STOP`. A targeted `psql` invocation is:

```bash
psql "$SIDESTREAM_POSTGRES_URL_NON_POOLING" \
  -v ON_ERROR_STOP=1 \
  -f db/migrations/20260714190000_add_single_active_account_devices.sql
```

Re-run the catalog checks; confirm both tables, both partial unique indexes, RLS on both tables, and no direct `anon`/`authenticated` privileges. This migration is additive. Do not backfill in this gate.

### 4. Deploy the website backend in observe mode

**Gate:** schema verification is approved and the production environment matrix has been reviewed.

Deploy the exact reviewed commit with:

- `SIDESTREAM_DEVICE_POLICY_MODE=observe`
- a production namespace selected by agreeing `SIDESTREAM_LICENSE_NAMESPACE` (if set), `VERCEL_ENV`, and trusted production host
- the existing compatible `SIDESTREAM_LICENSE_HASH_SECRET` behavior unchanged
- the production database only; Test hosts and `SIDESTREAM_TEST_POSTGRES_URL` remain isolated

Verify route availability, normal same-device activation/verify/refresh, retryable fail-closed behavior for deliberately invalid environment state in a non-production check, and pseudonymous `sidestream_device_policy_observation` events. Do not enable `enforce` yet.

### 5. Run the read-only device audit

Run `npm run devices:audit` without `--apply`. Save the safe summary and review zero/one/multiple candidate counts, existing bindings, and eligible accounts. Read-only mode must report `mode: "read_only"` and `inserted: 0`.

Stop if counts are implausible, raw identifiers appear, the target is wrong, or the automatic newest-candidate rule is unacceptable for multiple-candidate accounts. Running apply because “the command exists” would be cowboy nonsense; the count review is the gate.

### 6. Release a compatible FlowState client

**Gate:** observe telemetry is understood and the client release has passed its own release checklist.

The compatible client must:

- send a stable device identifier and coarse platform metadata;
- use the account decision page for reconnect, transfer, or purchase;
- understand `transfer_required`, `transfer_limit_reached`, `device_replaced`, and `device_deactivated` without clearing credentials on transient `5xx` failures;
- call `/api/license/authorize-download` before each new Pro media download;
- allow a previously accepted in-progress download to finish rather than attempting a mid-transfer cancellation; and
- use only the production API host for production credentials.

Release through the normal platform pipeline while preserving signing truth: the Mac artifact must pass its signed/notarized gates, and Windows must not be labeled signed unless it is. Record the versions, manifests, staged rollout population, and rollback artifact. Server compatibility for legacy clients is not permission to skip the compatible-client gate.

### 7. Run the two-device Mac/Windows smoke test

Use a paid QA account and two real machines against the isolated Test namespace. Production remains in `observe`; Test may use `enforce` to exercise the final behavior.

1. Connect the Mac as the first device and verify account status, verify/refresh, and download authorization.
2. Reconnect the same Mac and confirm no move is consumed.
3. Start a controlled, throttled download after successful authorization.
4. Start recovery on Windows and confirm the page offers a device move, shows only coarse prior-device data, and requires the explicit deactivation checkbox.
5. Confirm the move. Verify Windows succeeds and the prior Mac receives `device_replaced` on new verify, refresh, and download-authorization attempts.
6. Confirm the already accepted Mac download is not cancelled mid-transfer.
7. Reconnect Windows and confirm the move count does not increment again.
8. Deactivate from the account page, confirm future Windows access returns `device_deactivated`, and confirm no raw fingerprint appears in UI, output, or logs.

Record client versions, OS versions, account safe reference, timestamps, expected/actual results, and sanitized screenshots/logs. Reset the Test fixture through the supported flow, not production SQL.

### 8. Apply the production backfill explicitly

**Gate:** compatible client rollout and two-device smoke evidence are approved; the read-only audit's candidate counts and newest-candidate rule are explicitly accepted.

```bash
SIDESTREAM_DB_ENV_FILE=/secure/prod-direct.env \
  npm run devices:audit -- \
  --target production \
  --apply \
  --database-url-env SIDESTREAM_POSTGRES_URL_NON_POOLING \
  --confirm-production BACKFILL-PRODUCTION-DEVICES
```

Require `mode: "apply"`, the expected inserted/already-bound/no-candidate counts, and no errors. Immediately rerun the read-only audit and a duplicate-count catalog check. Keep zero-candidate accounts empty; their next compatible activation claims the slot. Do not delete candidate history or manually fill ambiguous accounts after the fact.

The duplicate-count check must return zero without exposing account IDs:

```sql
select count(*) as duplicate_active_account_namespaces
from (
  select account_id, license_namespace
  from public.sidestream_account_devices
  where revoked_at is null
  group by account_id, license_namespace
  having count(*) > 1
) duplicates;
```

### 9. Enable enforcement

**Gate:** backfill verification is approved, support is staffed, rollback owner is present, and monitoring thresholds have been written before the change.

Set `SIDESTREAM_DEVICE_POLICY_MODE=enforce` on the production deployment and deploy the same reviewed code. Smoke one same-device reconnect, one controlled different-device transfer, verify/refresh on both sides, and one new download authorization. Stop on unexpected purchase prompts, elevated `503`, namespace/environment errors, or missing support visibility.

### 10. Monitor

During the agreed observation window, watch:

- activation status counts for `transfer_required` and `transfer_limit_reached`;
- verify/refresh/download-auth counts for `device_replaced`, `device_deactivated`, `license_inactive`, and retryable `503` outcomes;
- transfer success, `binding_changed`, and move-limit support contacts;
- read-only fleet totals and a count-only query for duplicate active rows; and
- support clear/override audit entries and override expiry.

Use pseudonymous references only. Compare against the prewritten thresholds and rollback immediately when a threshold or unknown failure mode is hit; do not improvise a new threshold after seeing bad data.

### 11. Roll back to observe mode

Rollback is a configuration/deployment change: restore `SIDESTREAM_DEVICE_POLICY_MODE=observe` on production and redeploy the last known-good compatible backend if needed. Verify same-device access, observation logging, and route health.

Do **not** reverse the additive migration, drop indexes/tables, delete transfer/lifecycle rows, or undo the backfill. Those actions destroy audit and race-safety state and are not required to stop new policy enforcement. Already deactivated or replaced credentials remain revoked in `observe`; use the supported account transfer/deactivation or support workflow for an individual recovery. If the incident is environment isolation rather than policy enforcement, repair the trusted host/database configuration or restore the previous known-good deployment—changing the policy mode alone cannot make an invalid environment resolve.

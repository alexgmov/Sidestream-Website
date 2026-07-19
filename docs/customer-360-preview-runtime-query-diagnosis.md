# Customer 360 isolated Preview runtime query diagnosis

## Scope and observed reproduction contract

This diagnosis is read-only. It did not call or mutate Vercel, Postgres, Stripe,
Google, FlowState, or any deployed provider resource.

The supplied isolated non-Production evidence is:

- the exact 25 SQL files currently under `db/migrations/` were applied in
  filename order;
- a non-browser `POST /api/internal/customers` supplied a valid
  `Authorization: Bearer <SIDESTREAM_CRM_ADMIN_SECRET>` header;
- the JSON body selected `{ "licenseNamespace": "test" }`;
- the response was `500` with `code: "customer_query_failed"`.

That response localizes the failure after admin authorization and request-body
handling. The list handler returns `401`, `403`, `405`, `413`, or a stable `400`
for the corresponding authorization, browser-origin, method, size, JSON, and
query-validation failures. It emits `500 customer_query_failed` only when an
unexpected error escapes `queryCustomerList()`.

The sanitized response intentionally does not disclose the underlying database
error. The repository still provides an offline reproduction of the failing
runtime boundary: with a trusted Preview/Test configuration containing only
`SIDESTREAM_TEST_POSTGRES_URL`, `resolveLicenseEnvironment()` selects that Test
database, while the default Customer 360 list transaction throws before making
a connection:

```text
trustedNamespace=test
trustedDatabaseVariable=SIDESTREAM_TEST_POSTGRES_URL
genericRuntimeDatabaseVariable=null
Error: Missing runtime Postgres connection (SIDESTREAM_POSTGRES_URL, SIDESTREAM_POSTGRES_PRISMA_URL, POSTGRES_URL, POSTGRES_PRISMA_URL)
```

## Smallest source-level cause

The Customer 360 read path bypasses the repository's trusted license-environment
database selection.

1. `api/_lib/customer-query.ts` defines its default dependency as
   `withPostgresTransaction(callback, ...)` without a database target.
2. `withPostgresTransaction()` reaches `getPostgresPool()` with no target.
3. The default resolver in `api/_lib/postgres.ts` searches the generic pooled
   runtime variables and intentionally does not search
   `SIDESTREAM_TEST_POSTGRES_URL`.
4. `api/_lib/license-environment.ts` separately defines
   `SIDESTREAM_TEST_POSTGRES_URL` as the trusted Preview/Development/Test target.
   The Customer 360 profile write path already passes that resolved target
   explicitly to `getPostgresPool()`.

Applying the migration chain cannot repair this mismatch. The migrations create
the Customer 360 tables and private read-model functions, but they do not choose
the serverless function's connection target. If a generic runtime URL is absent,
the read fails before connecting. If a generic alias is present with different
credentials, the read can use a role other than the trusted Test role even when
the host and database are the same. The exact sanitized database error may differ,
but both cases originate in the same target-selection bypass.

## Why existing tests passed

The query suites do not execute the deployed default transaction path:

- `tests/customer-360/query-api.test.mjs` replaces `./postgres.js` and supplies a
  mocked `transaction` override to every query-helper call.
- `tests/customer-360/query-api-postgres.test.mjs` also injects a transaction,
  rewrites `public.` to a disposable schema, and applies only the five Customer
  360 schema/read-model migrations needed by that fixture.
- `npm run test:customer-360` is the non-Postgres aggregate. It verifies the
  handler, validation, projection, cursor, privacy, and offline Preview contracts,
  but it cannot prove which deployed database selector the default transaction
  uses.

The tests therefore prove the SQL and response contract once a client is
injected, not the runtime client selection that failed in Preview.

## Proposed minimal repair

Make only the Customer 360 default read transaction target-aware:

1. Resolve the database from trusted server deployment state using the existing
   license-environment contract.
2. Pass the resolved connection string and environment-variable identity to the
   shared pool before starting the existing `repeatable read read only`
   transaction.
3. Fail closed before connection when trusted deployment state cannot be
   resolved.
4. Keep `licenseNamespace` as an authorized row-selection input. Never let the
   request body select a database target.
5. Preserve the explicit profile and money column lists, invoker-rights private
   read models, no-store handler response, sanitized `customer_query_failed`
   error, and all merged-tombstone/raw-evidence exclusions.

Add a focused regression that exercises the default dependency rather than
injecting a transaction. It should prove that trusted Preview/Test state selects
`SIDESTREAM_TEST_POSTGRES_URL`, trusted Production state selects
`SIDESTREAM_POSTGRES_URL`, invalid or conflicting state opens no connection, and
the request body's namespace cannot change the selected target.

Do not add `SIDESTREAM_TEST_POSTGRES_URL` to the generic runtime precedence, use
runtime DDL, broaden table/function grants, select a target from
`licenseNamespace`, or expose the underlying database error. Those shortcuts
would weaken Production fail-closed behavior or the Customer 360 privacy
boundary.

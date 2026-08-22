# Hetzner database transfer handoff

## Scope

This handoff authorizes private PostgreSQL setup, database copying, and
verification on the existing Sidestream Hetzner server. It does **not**
authorize DNS changes, Production traffic changes, Google/Stripe callback
changes, Vercel environment changes, telemetry rerouting, Neon suspension, or
provider deletion.

The server baseline previously observed was a Helsinki Ubuntu 24.04 CX33 with
4 vCPU, 8 GB RAM, and 80 GB local disk. Recheck those facts on the server rather
than treating this document as current infrastructure proof.

## Copy/paste prompt for Codex on the server

```text
Work independently on the existing Sidestream Hetzner server until both database copies are installed and verified, or until you have one concrete blocker.

You are authorized to install/configure PostgreSQL, create local roles and databases, copy data from the existing Neon sources, create a private backup/restore test, and run read-only verification. You are not authorized to change DNS, route Production traffic, modify Vercel/Neon/Stripe/Google configuration, redirect telemetry, disable a provider, delete source data, or expose PostgreSQL publicly.

Start by reading AGENTS.md and README.md from the current origin/main of the Sidestream Website repository. Preserve unrelated work and do not use historical branches. Also inspect the current origin/main README and database helper in the alexg.mov repository because that repository owns the existing /api/plugin-telemetry collector and its separate commerce/telemetry database.

There are two independent source databases. Do not assume that similarly named environment variables point to the same database:
1. Sidestream Website Production: accounts, Google sessions, licenses, devices, Stripe/Checkout state, acquisition, Customer 360, leads, credits, rate limits, and the checksummed migration ledger.
2. alexg.mov business ledger/telemetry: raw Sidestream telemetry, install/session rollups, and alexg.mov commerce/fulfillment tables.

Create two separate local target databases and separate owner/runtime credentials. The Sidestream Website database and telemetry database must remain different database identities because Customer 360 reads telemetry through a dedicated read-only source. Do not give either runtime role superuser, role-management, database-creation, or schema-creation privileges.

Match the source PostgreSQL major version before restoring. Configure password_encryption=scram-sha-256 and bind listen_addresses only to localhost/127.0.0.1/::1. PostgreSQL port 5432 must not be published by Docker or opened in the OS/Hetzner firewall. Only the future HTTPS application service may be public.

Keep every database URL and password in a mode-0600 server-only environment file. Never print, paste, commit, or include a connection string in the report. Before any later runtime URL change, preserve the current SIDESTREAM_LICENSE_HASH_SECRET compatibility value explicitly; do not derive a new device secret from the Hetzner URL.

For each database independently:
- Attest the connected source host, port, database name, PostgreSQL version, and source role without printing credentials.
- Confirm the local target is new/non-authoritative and has no traffic.
- Take a PostgreSQL custom-format dump from the direct source endpoint and restore it into the matching local target. Preserve source data and immutable history. Do not manually mark migrations applied or edit rows to force parity.
- Preserve/recreate the source's intentional RLS and PUBLIC/anon/authenticated revocations. Use an owner only for transfer/verification; do not solve missing grants by making the future runtime a database owner or superuser.
- From the current Sidestream Website repository, set SIDESTREAM_TRANSFER_SOURCE_POSTGRES_URL to that source and SIDESTREAM_TRANSFER_TARGET_POSTGRES_URL to the localhost target, then run `npm run verify:database-transfer`. It must report PASS for schema sections, migration ledger where present, every public table's count/content fingerprint, sequences, and target security.
- Create a fresh local restore-check database from the target backup and run the same verifier from target to restore-check. It must also report PASS. Drop nothing until the evidence is recorded and reviewed.

For the Sidestream Website target, also point only the one command invocation's SIDESTREAM_POSTGRES_URL_NON_POOLING at the localhost target and run `npm run db:migrate -- --status --target production`. Status must show the copied source ledger with matching checksums; report every pending repository migration as a separate cutover blocker. Do not apply or baseline anything merely to make status green.

Run `npm run test:postgres-transfer`, `npm run test:migrations`, `npm run test:postgres-config`, `npm run verify:checkout-contract`, `npm run test:entitlement`, `npm run typecheck`, and `npm run build` from the clean Sidestream Website checkout. These prove repository contracts, not live routing.

The alexg.mov deployed database resolver currently accepts only neon.tech hosts. Do not attempt telemetry rerouting in this phase; that requires a separate reviewed code/runtime change after the database copy passes.

At the end, report only sanitized evidence: server/PostgreSQL versions, loopback listen setting, database fingerprints, table/row totals, parity results for both live copies and both restore checks, migration status, test results, backup location/retention without credentials, and an explicit `NO PRODUCTION CUTOVER PERFORMED`. Stop on any mismatch.
```

## External port check

Run this from a machine outside Hetzner after PostgreSQL is configured, replacing
the placeholder with the server's public hostname or IP:

```bash
npm run verify:database-port-closed -- --host <public-host-or-ip>
```

An accepted TCP connection is a hard failure. A refusal or timeout establishes
only that port `5432` was not reachable from that external probe; retain the
server-side `listen_addresses` and firewall evidence as separate checks.

## Transfer verifier contract

`npm run verify:database-transfer` is read-only. It requires exact
`SIDESTREAM_TRANSFER_SOURCE_POSTGRES_URL` and
`SIDESTREAM_TRANSFER_TARGET_POSTGRES_URL` selectors, requires the target URL to
use loopback, opens one authenticated connection to each database, and uses
repeatable-read read-only transactions. It compares public tables, columns,
constraints, indexes, triggers, RLS policies, functions, views, enums, exposed
PUBLIC/browser-role grants, the checksummed migration ledger when present,
order-independent whole-table content fingerprints, row counts, and sequence
state. Reports contain only safe database fingerprints, object names, counts,
and mismatch categories.

Parity proves a stable copy only when writes to the source were paused for the
final dump and verification window. It does not prove that application traffic,
OAuth, Stripe webhooks, scheduled jobs, or telemetry have been cut over.

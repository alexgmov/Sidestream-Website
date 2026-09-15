# Direct Linux telemetry ingress

## Status and scope

**September 15 update:** the legacy `alexg.mov` hostname now resolves to Linux,
with both exact telemetry paths reaching the existing collector locally.
See [the hostname cutover record](alexg-legacy-telemetry-cutover.md) for current
routing, evidence, TLS renewal, and rollback. The September 10 compatibility
rewrite remains active for cached DNS and rollback. Statements below about old
clients traversing Vercel describe the prior migration stage.

Server ingress and legacy compatibility proxy activated September 10, 2026.
Client defaults and local stages are updated; public client release remains pending. The existing encrypted key works for
`root@2.29.9.121` after local unlock; the `sidestream-server` alias uses the
non-administrative `sidestream-dev` account. Do not add privileges to that account
or create replacement credentials merely to administer Nginx.

### Live evidence and remaining work

- GoDaddy A `telemetry` → `2.29.9.121`, TTL 600; both authoritative nameservers
  confirmed it. No AAAA record was added. HTTPS certificate expires December 9,
  2026; Certbot renewal is configured, with the scoped deploy hook from
  `ops/nginx/telemetry-cert-renewal.sh` installed and manually tested.
- Nginx 1.28.3 passed `nginx -t` before each graceful reload. Existing
  proxy-header hash warnings remain; the ingress cutover did not restart application/database services.
  The separate dashboard repair below restarted analytics only. Full pre-change Nginx configuration is backed up under
  `/root/telemetry-ingress-20260910T173012Z/nginx` (root-only parent).
- Direct ingress: OPTIONS 204 with wildcard CORS; GET 405; private path 404;
  malformed JSON 400; body over 512 KiB 413. A valid event carrying a forged
  internal-auth header returned 200 and `recorded:1, collector:postgres`.
  Repeating it produced exactly one row in `sidestream_telemetry`:
  `operator-direct-check-f101064b-5881-481b-ab10-bb800f00bd28`.
- Vercel route `58fa58be-82cf-4a74-b764-1c64102be129`, published at 17:33 UTC,
  retains exact regex `^/api/plugin-telemetry/?$`, now rewriting directly to
  `https://telemetry.sidestream.tv/v1/events`. Its name is **Sidestream telemetry
  direct Linux compatibility proxy**. The destination-host exclusion and
  automation-bypass request header were removed. The authenticated staging
  GET reached Nginx; anonymous staging POST was blocked by Vercel preview
  protection, so POST persistence was verified immediately after publication.
- Canonical legacy POST and OPTIONS passed with and without the trailing slash;
  retries acknowledged successfully and each probe had exactly one database row:
  `operator-legacy-live-00381015-0b49-47dd-813d-49f129151fee` and
  `operator-legacy-live-023615b6-5a47-4300-a039-3f511b11e11a`.
  Probes have no install/session identity and are not customer downloads.
- An isolated loopback Nginx fixture with an unavailable upstream returned 502,
  not a successful acknowledgement; the production collector stayed running.
- Alex approved scoped FlowState changes while preserving unrelated edits.
  `js/logger.js` and the future Production native-installer default now use the
  direct endpoint; overrides remain supported and Test installer telemetry stays
  disabled by default. Both package stages were rebuilt. The staged Test uploader
  posted `operator-test-client-c0063861-6a4f-47d9-8010-1b534bae05b4`; a separate
  database query confirmed exactly one row. This is executable staged-uploader
  proof, not loaded-Premiere or public-release proof. Shared-IP queue-drain
  qualification remains a client gate; the existing system-wide Production
  extension still shadows the user-level Production staging link.
- Dashboard refresh separately failed with PostgreSQL temporary-disk exhaustion.
  A scalar-only Overview projection plus private `work_mem=64MB` and ten-minute
  timeout returned 21,352 live user-day rows in 365 seconds. Only the analytics
  service was restarted with this surgical source patch; the collector and
  database stayed running. Original dashboard source is backed up at
  `/root/telemetry-dashboard-20260910/source.mjs`. After every restart, verify
  health, Overview, installs, and sessions share a current live snapshot. Cold
  rebuild can exceed the gateway's 180-second request timeout; wait for loopback
  readiness before checking the public page. Missing historical events remain
  unreconciled.

The first migration removes Vercel and the portfolio frontend from **new
telemetry traffic**. It reuses the existing Linux collector and telemetry
database: no new database, data migration, public PostgreSQL listener, or
replacement event-writing implementation. Website/account/payment routing is
outside this change.

```mermaid
flowchart LR
  N[Updated panel and installer] --> D[telemetry.sidestream.tv/v1/events]
  O[Already-installed versions] --> L[Legacy alexg.mov telemetry URL]
  L -->|Exact-path compatibility proxy| D
  D --> G[Linux Nginx: only telemetry]
  G --> C[Existing collector on loopback port 3102]
  C --> P[(Private Linux telemetry database)]
```

The old URL necessarily stays available for installed versions with that URL
compiled into them. DNS cannot route only one path of `alexg.mov` to another
server. That URL still passes through Vercel; its exact-path project rewrite now goes
directly to this public ingress, with no database handler, deployment-specific
bridge, or automation-bypass credential. Removing
Vercel from those old requests entirely would require moving the whole
`alexg.mov` hostname or updating those clients; neither is needed for this step.

## Ownership and files

- This Website repository owns the infrastructure templates in
  `ops/nginx/telemetry.sidestream.tv*.conf` and
  `ops/nginx/sidestream-telemetry-limits.conf`.
- The portfolio repository continues to own `api/plugin-telemetry.js`,
  `lib/postgres-db.js`, and the existing Linux service. Its unrelated dirty
  checkout must not be deployed as part of this migration.
- FlowState owns the client defaults in `js/logger.js` and
  `scripts/build-mac-native-installer.sh`. Both currently point at
  `https://alexg.mov/api/plugin-telemetry`; both need the new HTTPS URL after
  server qualification. Preserve its unrelated logger changes. Test-channel
  behavior, endpoint overrides, disabled Test installer telemetry, privacy
  redaction, bounded queues, retries, and strict acknowledgements stay intact.

## Ingress contract

`telemetry.sidestream.tv` must resolve directly to the existing Linux server,
not to Vercel. Verify its live address before DNS changes; the documented server
is `2.29.9.121`. Add IPv6 only if routing, firewall, listener, and TLS are tested.

Nginx exposes only `POST /v1/events` and `OPTIONS /v1/events`, forwarding the
unaltered body to `http://127.0.0.1:3102/api/plugin-telemetry`. The collector
retains body/event validation, redaction, atomic deduplication and rollups, and
its full-persistence acknowledgement. Malformed input and database failures
must not be converted into successful acknowledgements.

The supplied configuration limits body size to the existing 512 KiB collector
limit, bounds connections/request rate, disables upstream retries/caching, and
logs operational metadata without identities or event bodies. Rate-limit
responses are retryable 429s; validate queue drain for a shared-IP test before
client rollout. CORS preflight continues through the existing collector.

Incoming internal-auth and forwarding headers are discarded. Nginx injects the
existing collector origin secret from a root-owned, mode-0600 local snippet at
`/etc/nginx/snippets/sidestream-telemetry-origin-auth.conf`. That snippet contains
only `proxy_set_header X-Sidestream-Origin-Auth` with a correctly Nginx-escaped
value. Obtain it locally from the running service's existing protected runtime
configuration; do not rotate it for this migration, print it, put it in shell
history/Git, or ship it to a client. Do not use `nginx -T` in captured output,
because that dumps included secrets. Missing snippet or certificate must fail
configuration validation before reload. All other paths return 404, and the
existing origin-authentication gate remains enabled for other APIs.

## Ordered activation and proof

1. With authenticated server access, attest the active Nginx configuration,
   service unit/runtime file, loopback collector on 3102, and private database.
   Save the current relevant configuration and recovery-route version for rollback.
2. Install the HTTP bootstrap virtual host and shared limit/log declarations.
   Validate with `nginx -t` before a graceful reload. Publish only the new DNS
   record, verify resolution, and obtain its TLS certificate using the existing
   ACME webroot workflow. This does not change existing hostnames.
3. Create the local secret include, install the TLS virtual host, run
   `nginx -t`, then gracefully reload Nginx. Do not restart the application or
   database. Check the new host independently before sending clients to it.
4. Verify OPTIONS/CORS, GET rejection, arbitrary/private-route 404s, oversized
   body rejection, forged internal-header replacement, and TLS. A valid unique
   synthetic operator event without installation/session identity must return
   `recorded: 1`, `collector: postgres`, and be read back from the Linux dataset
   using a bounded timestamp window. Repeat its ID and prove deduplication;
   never count a synthetic event as a customer download. Test upstream failure
   with a local isolated fixture, never by stopping the production collector.
5. Replace only the legacy exact-path Vercel project recovery rule's destination
   with `https://telemetry.sidestream.tv/v1/events`; remove its automation-bypass
   header and old destination-host condition. Stage and verify that legacy POST
   bodies, acknowledgements, CORS, and retries survive the rewrite, then publish.
   Do not redirect: installed clients need a direct successful response.
6. Prepare FlowState's endpoint-default change in its normal Test workflow,
   run focused telemetry checks and both required package preparations, then
   verify a loaded Test panel's real upload and a staged installer receipt.
   Production publication follows the existing explicit Test-to-Production
   release policy; do not silently release an extension with this server change.
7. Verify fresh natural events, a refreshed dashboard, unchanged website/sign-in
   and installer routes, and continued Neon isolation. Keep the legacy proxy
   while old clients remain; report new/direct and legacy paths separately.

## Rollback

Before client rollout, restore the September 7 Vercel route version
`14bd4620-7428-409b-b97d-491a93abfbb8` if the new ingress fails, then verify a
legacy canary and its persistence. Do not disable the route: that restores the
original broken Vercel handler. Preserve the current working deployment and its automation
credential until that bridge is retired after verification. Revert only the new
virtual host if needed, validate Nginx, and reload; leave the database and other
virtual hosts alone. Once clients use the new hostname, keep that hostname and
restore its last working ingress configuration rather than deleting DNS. No
rollback reconnects Neon. Missing historical telemetry is a separate recovery
question, not solved by moving the endpoint.

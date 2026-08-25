# Support Automation Safety Contract

## Current state

The repository contains an inert-by-default support intake, durable processing
queue, durable notification outbox, and two-gate safety foundation. It does not
create a mailbox, change DNS, apply its migrations,
configure a provider, send customer replies, create branches or pull requests,
run database operations, merge, deploy, or enable Production automation.

`SIDESTREAM_SUPPORT_ENABLED=1` is admitted only when every required mailbox,
provider, encryption, model, alert, and admin setting is valid. Until the
activation checklist below is completed, existing public support links must
continue to use their current address.

## Bounded flow

```text
support mailbox
      |
      v
signed Resend webhook -- invalid/other address --> stop
      |
      v
encrypted ticket ledger + unique triage job (one transaction)
      |
      v
leased bounded processor -- crash/transient failure --> retry/backoff/dead letter
      |
      v
Gate 1: deterministic injection/systematic prefilter
      |                         |
      | safe                    | flag/error
      v                         v
structured triage model     transactional alert outbox + stop
      |
      v
bounded action request (never executable text)
      |
      v
future worker produces a PR artifact or registered DB-operation artifact
      |
      v
strict artifact schema -- raw SQL/unknown fields --> record flag + alert + reject
      |
      v
Gate 2: deterministic scope checks + independent safety model
      |                         |
      | pass                    | flag/error
      v                         v
record audit_passed         transactional alert outbox + stop
      |
      v
no executor in this release

alert outbox -- leased delivery --> Resend safety alert
      |
      +-- failure --> bounded retry/backoff --> visible dead letter
```

An `audit_passed` state is evidence from the second gate. It is not permission
to execute, merge, deploy, or write to a database. A later executor must be a
separately reviewed feature with narrow registered operations; never add a
generic shell or SQL tool.

## Gate 1: untrusted email

`api/_lib/support-safety.ts` owns the exact first-agent system prompt and the
deterministic prefilter. The email is serialized only into a `user`-role input.
It is never interpolated into system/developer instructions. The request uses
strict structured output, disables tools, disables provider storage, and sends
no HTML or attachment contents.

The first gate stops and requires human review for:

- requests to ignore, replace, or override instructions or safety rules;
- text impersonating system, developer, administrator, or tool messages;
- attempts to obtain hidden prompts, secrets, tokens, raw customer data,
  commands, scripts, SQL, or tool calls;
- encoded/obfuscated commands, privileged-message delimiters, or attempts to
  skip approval/audit;
- HTML-only messages or any attachment, because their contents are withheld in
  this version;
- reports that appear system-wide, affect multiple customers, or describe a
  Production outage;
- any model result that says the prompt is suspicious, the issue is systematic,
  or human approval is required, even if that result also says `pass`.

## Gate 2: independent artifact audit

`POST /api/internal/support/audit` is POST-only, rejects browser origins, and
requires `Authorization: Bearer <SIDESTREAM_SUPPORT_ADMIN_SECRET>`. The auditor
receives only one schema-validated artifact and the expected action type. It
never receives the original customer email.

A pull-request artifact must name the exact `sidestream-website` repository,
`main` base, changed files, tests, diff SHA-256, summary, and rollback plan. The
deterministic gate permits only support-specific API, test, migration, doc, and
README files. Package/dependency files or any core product file are flagged.

A database artifact must name the `sidestream_website` database, exact
Test/Production environment, only `sidestream_support_*` tables, registered
`support_*` operation IDs, a target fingerprint, a 1-100 row cap, dry-run
evidence, and a rollback plan. The safety gate flags non-support tables,
unregistered operations, over-25-row scopes, weak Production binding, or an
action-type mismatch. The schema has no SQL field and rejects unknown fields.

The independent model is also tool-free, strict-schema, and non-stored. It must
flag any possible impact to checkout, authentication, payment, entitlement,
devices, credits, acquisition, telemetry, installers, releases, deployment,
secrets, permissions, or unrelated customer data.

## Storage, queues, and notifications

`20260825120000_add_support_safety_ledger.sql` adds five server-only tables.
RLS is enabled and public/`anon`/`authenticated` access is revoked. Customer
email, subject, and body are encrypted with AES-256-GCM using a key derived from
`SIDESTREAM_SUPPORT_DATA_SECRET`; the searchable email value is a secret-keyed
HMAC. Messages, gate runs, and audit events are append-only.

`20260825130000_add_support_reliability_queues.sql` is an additive migration; do
not rewrite or baseline the first support migration. It adds one unique triage
job per inbound message, one idempotent notification-outbox row per gate
flag/error, and append-only notification delivery attempts. Both queues claim
with `SKIP LOCKED`, a two-minute lease, and an unguessable lease token. A crashed
worker's expired lease can be reclaimed; a stale worker cannot complete or fail
the newer lease. Attempts use 30-second exponential backoff capped at 30 minutes,
five attempts per cycle, visible `dead_letter` state, and at most three exact
operator recoveries. Queue/outbox tables have RLS and no public, `anon`, or
`authenticated` access.

The webhook acknowledges only after the encrypted ticket, append-only receipt
evidence, and processing job commit together. Duplicate provider event IDs,
provider message IDs, processing jobs, gate runs, and alert idempotency keys
converge. Gate `flag`/`error` evidence and its alert-outbox row commit in the
same transaction, so a provider outage cannot turn an alert into a log-only
failure.

Only a first-gate or second-gate `flag`/`error` creates an email for
`SIDESTREAM_SUPPORT_ALERT_EMAIL`. Alerts contain gate, outcome, opaque reference
ID, and bounded risk codes—never the customer address, subject, message,
proposed reply, HTML/attachment content, or provider secrets. Resend idempotency
keys converge a provider acceptance followed by a worker crash.

## Protected processor

`POST /api/internal/support/process` is non-browser, no-store, and accepts only
`Authorization: Bearer <SIDESTREAM_SUPPORT_ADMIN_SECRET>`. An empty JSON object
claims at most five due triage jobs and ten due alerts. Optional `jobLimit` and
`notificationLimit` values are integers from 1 to 25. Manual recovery accepts
exactly one `recoverJobId` or `recoverNotificationId` UUID; it can requeue only
that row when its state is already `dead_letter` and its three-recovery budget
is not exhausted. Unknown fields, broad recovery, shell, SQL, customer action,
and core-table controls do not exist.

Every response reports bounded claimed/completed/retried/new-dead-letter counts,
current processing/notification dead-letter totals, and `executed:false`. The
active Hetzner service must run a one-minute timer that POSTs `{}` without an
`Origin` header. Load the bearer from a root-readable mode-`0600` credential or
environment file; never place it in the timer unit, command history, process
listing, or logs. The webhook also makes a best-effort one-job wakeup, but that
is only a latency optimization—the timer is the durable backstop.

## Required configuration

All settings belong on the active Hetzner Website API service because Vercel
middleware routes `/api/*` there in target mode. Do not enable the webhook by
configuring Vercel alone.

| Setting | Requirement |
| --- | --- |
| `SIDESTREAM_SUPPORT_ENABLED` | Exact `1` only after all gates below pass |
| `SIDESTREAM_SUPPORT_INBOUND_ADDRESS` | Exact mailbox receiving tickets; defaults to `support@sidestream.tv` |
| `SIDESTREAM_SUPPORT_ALERT_EMAIL` | Alex's private exception-only notification mailbox |
| `SIDESTREAM_SUPPORT_EMAIL_FROM` | Verified Resend sender; defaults to `Sidestream Support Safety <support@sidestream.tv>` |
| `SIDESTREAM_SUPPORT_RESEND_WEBHOOK_SECRET` | Exact signing secret for the inbound webhook |
| `RESEND_API_KEY` | Retrieve inbound email and send safety alerts |
| `OPENAI_API_KEY` | Server-only key for both structured safety gates |
| `SIDESTREAM_SUPPORT_TRIAGE_MODEL` | Optional bounded override; default `gpt-5-mini` |
| `SIDESTREAM_SUPPORT_AUDIT_MODEL` | Optional bounded override; default `gpt-5-mini` |
| `SIDESTREAM_SUPPORT_DATA_SECRET` | Stable random value, at least 32 characters; rotation needs a data migration |
| `SIDESTREAM_SUPPORT_ADMIN_SECRET` | Separate random non-browser bearer secret, at least 32 characters |

## Activation checklist

1. Verify the current `sidestream.tv` MX records before changing DNS. Use
   `support@sidestream.tv` only if the required receiving MX records do not
   displace an existing mailbox provider. Otherwise use a dedicated receiving
   subdomain such as `help@support.sidestream.tv` and set the environment value
   exactly; do not guess or overwrite working mail DNS.
2. Add and verify the chosen receiving domain in Resend. Do not yet add the
   webhook and do not change public `mailto:` links.
3. Run `npm run test:support`, `npm run verify:vercel-contract`, `npm run
   typecheck`, `npm run verify:checkout-contract`, `npm run test:entitlement`,
   `npm run build`, and `git diff --check` from the clean candidate source.
4. Back up and attest the exact Website Production database. Inspect
   checksummed migration status, then apply both ordered support migrations only
   through the guarded migration runner. Confirm all eight tables, RLS,
   revocations, append-only triggers, unique job/outbox keys, lease/dead-letter
   constraints, and both migration checksums on the same target.
5. Install all required settings on the active Hetzner Website service with
   `SIDESTREAM_SUPPORT_ENABLED` absent. Rebuild/restart from the same pushed SHA
   and prove health, database reachability, the ordinary API, and Checkout remain
   unchanged. The support webhook and processor must both return disabled `503`,
   not routing `404`.
6. Install and start the one-minute protected processor timer while support is
   still disabled. Confirm its authenticated request reaches the route and gets
   the expected disabled `503`; no timer output may contain the bearer.
7. Configure Resend receiving and the chosen MX record. Confirm authoritative
   DNS and provider verification before enabling intake. Do not add the webhook
   or change public support links yet.
8. Set `SIDESTREAM_SUPPORT_ENABLED=1`, reload only the Website service, and prove
   an authenticated processor POST returns zero bounded work, zero dead letters,
   and `executed:false`. Add the Resend `email.received` webhook last.
9. Send one benign plain-text canary. Prove one encrypted ticket, one completed
   processing job, one triage gate run, one bounded action request, no alert,
   no customer reply, and no product state change.
10. Send separate prompt-injection, systematic-incident, HTML-only, and
    attachment canaries. Prove each stops at Gate 1, creates exactly one outbox
    item, delivers exactly one privacy-minimal alert, and exposes no customer
    content in that alert.
11. Submit a support-only PR artifact, a deliberately core Checkout-file
    artifact, a registered support-table transaction artifact, and raw
    SQL/core-table artifacts from a non-browser operator. Prove the two bounded
    support artifacts can record `audit_passed`; every core/SQL artifact records
    `audit_flagged`; every call returns `executed:false`; and only flags alert.
12. Replay the same webhook and audit inputs and run the processor concurrently.
    Prove there is no duplicate ticket, job, action, gate run, outbox item,
    delivery attempt for one claimed lease, or delivered alert.
13. Simulate a triage-model failure. Prove the job completes with a durable
    Gate 1 error/flag record and one alert-outbox item; the failure never becomes
    a customer reply or executable action.
14. Simulate alert-delivery failure. Prove retry/backoff, then exhaust one test
    alert to visible `dead_letter`, recover that exact notification UUID through
    the protected route, restore delivery, and prove one final delivered state
    with append-only failed/delivered attempts and no duplicate Resend alert.
15. Verify encrypted database evidence, exact alert delivery to the authorized
    private mailbox, zero processing/notification dead letters, and no code,
    database, customer, merge, deploy, or reply execution. Only then may a
    separate reviewed change replace public personal-address support links.

## Verification and rollback

`npm run test:support` covers the prompts, tell-tale injection patterns,
systematic/attachment stops, user-role model boundary, strict schemas, core-file
and core-table refusals, encryption/tamper rejection, signed webhook behavior,
ticket/job acknowledgment ordering, duplicate wakeups, bounded retry/backoff,
expired-lease recovery, stale-lease refusal, dead-letter visibility, exact
outbox recovery, protected audit/processor routes, privacy-minimal alerts,
transactional outbox idempotency, append-only delivery attempts, and both
migrations' privacy/immutability.

Emergency disable is `SIDESTREAM_SUPPORT_ENABLED=0` or removal of the setting,
followed by a Website-service reload. Then disable the Resend webhook and stop
the support processor timer. Do not delete pending/retry/dead-letter rows, bulk
requeue work, drop tables, erase evidence, rotate the data secret, or change
public support links during the incident. After the cause is reviewed, re-enable
the timer first, recover only exact approved dead-letter UUIDs, confirm zero
dead letters, and enable intake/webhook last. Existing checkout, entitlement,
installer, and Customer 360 behavior must remain unchanged throughout rollback.

# Support Automation Safety Contract

## Current state

The repository contains an inert-by-default support intake and two-gate safety
foundation. It does not create a mailbox, change DNS, apply its migration,
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
encrypted ticket ledger
      |
      v
Gate 1: deterministic injection/systematic prefilter
      |                         |
      | safe                    | flag/error
      v                         v
structured triage model     alert Alex + stop
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
record audit_passed         alert Alex + stop
      |
      v
no executor in this release
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

## Storage and notifications

`20260825120000_add_support_safety_ledger.sql` adds five server-only tables.
RLS is enabled and public/`anon`/`authenticated` access is revoked. Customer
email, subject, and body are encrypted with AES-256-GCM using a key derived from
`SIDESTREAM_SUPPORT_DATA_SECRET`; the searchable email value is a secret-keyed
HMAC. Messages, gate runs, and audit events are append-only.

Only a first-gate or second-gate `flag`/`error` sends an email to
`SIDESTREAM_SUPPORT_ALERT_EMAIL`. Alerts contain gate, outcome, opaque reference
ID, and bounded risk codes—never the customer address, message, proposed reply,
or provider secrets. Resend idempotency keys converge repeat sends.

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
   typecheck`, and `npm run build` from the clean pushed `origin/main` source.
4. Back up and attest the exact Website Production database. Inspect
   checksummed migration status, then apply
   `20260825120000_add_support_safety_ledger.sql` only through the guarded
   migration runner. Confirm all five tables, RLS, revocations, triggers, and
   migration checksum on the same target.
5. Install all required settings on the active Hetzner Website service with
   `SIDESTREAM_SUPPORT_ENABLED` absent. Rebuild/restart from the same pushed SHA
   and prove the ordinary API, checkout redirect, and health remain unchanged.
6. Add the Resend webhook endpoint
   `https://sidestream.tv/api/support/webhook` for `email.received`, copy its
   signing secret to the service, then set `SIDESTREAM_SUPPORT_ENABLED=1` and
   reload only the Website service.
7. Send one benign plain-text canary. Prove a single encrypted ticket, one
   triage gate run, one bounded action request, no safety alert, and no product
   state change.
8. Send separate injection, HTML-only/attachment, and systematic-incident
   canaries. Prove each stops at Gate 1 and sends one privacy-minimal alert.
9. Submit one support-only PR artifact and one deliberately core-scoped
   artifact to the audit endpoint from a non-browser operator. Prove the first
   can record `audit_passed`, the second records `audit_flagged`, one alert is
   delivered, and both return `executed:false`.
10. Replay the same webhook and audit inputs. Prove there is no duplicate
    ticket, action, gate run, or alert.
11. Only after the mailbox and alert canaries are visible should a separate
    reviewed change replace public personal-address support links with the new
    mailbox.

## Verification and rollback

`npm run test:support` covers the prompts, tell-tale injection patterns,
systematic/attachment stops, user-role model boundary, strict schemas, core-file
and core-table refusals, encryption/tamper rejection, signed webhook behavior,
protected audit route, alerts, and migration privacy/immutability.

Emergency disable is `SIDESTREAM_SUPPORT_ENABLED=0` or removal of the setting,
followed by a Website-service reload. Then disable the Resend webhook. Do not
drop tables, erase evidence, rotate the data secret, or change public support
links during the incident. Existing checkout, entitlement, installer, and
Customer 360 behavior must remain unchanged throughout rollback.

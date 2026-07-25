# Sidestream Landing Page

## Product Overview

Sidestream is an HTML-first landing page for a Premiere Pro panel that lets editors search, preview, and download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The main page remains a single canonical HTML document with embedded layout CSS and vanilla JavaScript, plus a small React/Tailwind layer mounted only for the full-page Paper shader background.

## File Map

- `Sidestream front end 2/Sidestream.html` - Inert `noindex` fallback document for the old exported page URL. Production requests never serve it because `vercel.json` sends the legacy path to `https://sidestream.tv/` with a server-side `308`.
- `index.html` - Canonical page implementation served at `/`. Contains the shader mount root, header, hero, desktop Mac/Windows download CTAs plus the DaVinci Resolve waitlist CTA and modal, mobile email handoff, feature sections, pricing, final CTA, footer, styles, rotating-word script, toast behavior, crawler metadata, and structured data.
- `public/robots.txt` - Public crawler policy copied to `/robots.txt` by Vite. Allows normal search plus OpenAI `OAI-SearchBot`, blocks all `/api/` routes from automatic crawlers, and opts out of training-oriented `GPTBot` separately.
- `public/sitemap.xml` - Valid source template for the canonical root-only XML sitemap. It intentionally contains no hand-maintained date; the build replaces its marker in `dist/sitemap.xml` with the root page's last meaningful source modification time.
- `public/llms.txt` - Concise AI-readable product summary and canonical-source guide for LLM/search agents. It is additive and does not replace normal SEO metadata or visible page content.
- `public/sidestream-social-card-v2.jpg` - Cache-busted 1200×630 Open Graph/Twitter card with readable Sidestream branding, product copy, and the Premiere Pro panel mockup. Social and structured-data metadata in `index.html` must use this filename so X does not reuse the obsolete blank preview.
- `components/ui/demo.tsx` - Adapted Paper demo component mounted as the page background. The active default effect keeps the original simple `MeshGradient` look with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`, with demo install/clipboard overlay text removed and no background mouse interaction.
- `components/ui/background-paper-shaders.tsx` - Exact pasted React Three Fiber shader primitives from the provided reference. They are kept as optional reference code and are not mounted by default.
- `account.html` - Minimal noindex account bridge on a plain near-black background. Signed-out visits immediately enter Google OAuth, while the server auth session shows returning users their plan status, latest installer, sign out, and a Manage Billing button that creates a Stripe Customer Portal session. A signed-in Free account submits Upgrade directly to the same-origin Checkout POST and follows its `303` straight to Stripe without rendering either Sidestream confirmation page; a cancelled account Checkout returns here. The unfinished device-status and deactivation UI stays off the account page until it can report a trustworthy device identity.
- `docs/single-device-entitlements.md` - Device-domain and support reference for the single-active-device contract, privacy boundary, API/page states, and conceptual support decisions. Its obsolete Production command surface has been removed; it authorizes no Production action and points to the API runbook only for blocker/capability status.
- `docs/api-hardening-runbook.md` - Exact hardened API/release contract, shared Postgres and migration model, Stripe/lead/maintenance facts, bounded configuration, metrics, alerts, and the current fail-closed Production blocker/capability inventory. Production cutover is blocked; this file contains no executable Production cutover or fallback recipe and does not claim Production was changed.
- `docs/customer-360.md` - Durable cross-repo Customer 360 contract: exact private list/detail fields and nullability, trusted write namespace versus authorized admin read selection, identity/merge and observe-by-default single-device separation, currency-partitioned money and purchase-history semantics in minor units, exhaustive stored/derivable usage versus compact API exposure, privacy/retention, observability, disposable tests, dry-run backfill, rollback, and the only human-gated Preview/Test-first rollout. Customer 360 is not deployed and Production is not migrated.
- `docs/customer-360-preview-test-plan.md` - Canonical non-Production Customer 360 execution matrix: current Preview rejection, commit/artifact and Preview/Production isolation gates, database/migration/provider evidence, protected API/identity/commerce/usage/backfill/FlowState acceptance, regression and failure injection, a Pass/Fail/Blocked UTC evidence log, non-Production rollback/recreate, and hard exit criteria. It authorizes no Production action.
- `thank-you.html` - Minimal noindex Checkout success page. Stripe success URLs land here after purchase, while legacy `/upgrade.html?checkout=success` links redirect here and preserve optional activation/session query values. It tells unlinked website/legacy buyers to sign in with the same verified Checkout email, then use Upgrade or Restore Purchase so the active account can claim the panel without a second charge.
- `upgrade.html` - Minimal noindex checkout/cancel fallback page. Anonymous website purchases use the server-owned `/api/checkout/start` confirmation boundary. Shipped panel Upgrade handoffs with an activation capability go directly through the activation-bearing Checkout route, while Restore Purchase remains on the authenticated claim path. The signed-in account Upgrade path does not render this page.
- `data/release-manifest.json` and `data/release-manifest.windows.json` - Sidestream-owned stable release manifests. The default file keeps the public Mac artifact; the Windows file is selected by the explicit `win32-x64` platform query used by the public Windows download CTA. Private Blob pathnames are never returned by the public manifest API.
- `api/download.ts` - Vercel Node Function for installer fulfillment. `HEAD` returns attachment metadata for the manifest-configured private Vercel Blob installer, and `GET` validates the Blob then redirects to a short-lived signed private Blob URL. Successful Gmail campaign `GET`s are recorded only after the redirect response ends. Bare requests remain Mac; `?platform=win32-x64` selects the Windows beta artifact. Supports `GET` and `HEAD` only.
- `api/_lib/installer-referral.ts` - Server-only Gmail installer-request attribution. It validates bounded UTM tags, accepts only `pilot` or `main` batch content, creates a campaign/day-scoped HMAC from request identity, discards the raw IP and user agent, flags likely link scanners, and inserts the privacy-limited event into Postgres without delaying installer delivery.
- `api/referral-visit.ts` and `api/_lib/referral-visits.ts` - First-party landing-page referral attribution. The POST-only route accepts the allowlisted `manychat`, `instagram-bio`, `instagram-alex`, `meta-ads-1`, `reddit-1`, and `reddit-2` sources, returns `204` before its bounded background write, hashes request identity per source/day without storing raw IP or user agent, flags likely scanners, and writes one deterministic private Vercel Blob record per daily visitor.
- `api/releases/latest.ts` and `api/_lib/release-manifest.ts` - Sidestream-owned update manifest endpoint for the CEP panel. It selects the Mac or Windows manifest by platform and serves public metadata without exposing the private Blob pathname.
- `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/_lib/download-lead-blob.ts` - Bounded JSON lead ingestion, canonical `(email, cta_source)` convergence, idempotency receipts, atomic Postgres email/IP rate limits, deterministic private-Blob fallback, and the private compare-and-swap Blob limiter used by the mobile email handoff. `api/internal/download-leads/replay.ts` replays mapped fallback records and deletes only after a committed database write plus ETag match.
- `api/resolve-waitlist.ts` - Dedicated Blob-only DaVinci Resolve waitlist ingestion. The POST route fixes `cta_source` to `davinci-resolve-waitlist`, applies durable hashed 5/email and 20/IP per-ten-minute Blob limits, and converges repeated submissions into deterministic private records under `sidestream/resolve-waitlist/v1/`; these records are durable waitlist data and are not part of the Postgres fallback replay queue.
- `api/send-download-links.ts` and `api/_lib/download-link-email.ts` - Mobile-only computer handoff. The public POST route requires an idempotency key, stores the `mobile-download-handoff` lead plus bounded UTM context in the existing private replay queue, enforces a durable hashed 3/email and 10/IP per-hour Blob limit, and sends one transactional Resend message from `downloads@alexg.mov` with direct Mac and Windows installer links plus the `STREAM20` Sidestream Pro discount code. The email presents both installers as matching white platform-marked capsules on a dark panel while retaining explicit platform labels; its Windows mark is a tiny PNG derived from the landing page silhouette and embedded as a Resend CID inline attachment so email clients do not strip it. Provider errors and logs never return or print the recipient address.
- `api/_lib/postgres.ts` and `api/_lib/rate-limit.ts` - Shared attached runtime Postgres pool/transaction ownership and atomic HMAC-dimension rate limiting. Production runtime requires a pooled URL; direct URLs are reserved for reviewed migrations/backfills and development/test fallback.
- `api/_lib/customer-profiles.ts` and `tests/customer-360/core*.test.mjs` - Server-only Customer 360 identity/profile primitives, transactional merge planning, privacy-contract proof, and disposable-Postgres coverage. Merge survivors follow the database's immutable `(created_at, id)` total order within one license namespace.
- `api/_lib/customer-commerce.ts`, `db/migrations/20260715122000_add_customer_commerce_ledger.sql`, and `tests/customer-360/commerce*.test.mjs` - Stripe-verified Customer 360 money projection. A settled PaymentIntent, or a captured standalone Charge without one, is canonical when present. Until then, paid Checkout and Invoice facts remain fallbacks; a paid InvoicePayment edge suppresses only the Checkout fallback for the same absent instrument, namespace, profile, and currency, preferring the related Invoice without collapsing their payment keys. Both fallbacks are atomically suppressed when the related instrument arrives. Gross includes all settled customer money, while `off_stripe_paid_minor` is an explicit subset in each profile/namespace/currency total. Current InvoicePayment objects persist as many-to-many allocation edges without unioning invoices and instruments into one payment key. Namespace-locked reconciliation attaches or quarantines a whole canonical payment group before currency totals refresh and never reads or mutates entitlement/device state.
- `api/_lib/customer-usage.ts`, `api/_lib/customer-query.ts`, `api/_lib/customer-admin.ts`, `api/internal/customer-usage/sync.ts`, and `api/internal/customers/*` - Once-daily privacy-limited telemetry aggregation plus private Customer 360 list/detail reads. The aggregate layer retains complete first/last use and attempt timestamps, outcome counts, activity/frequency, coarse client summaries, and freshness/materialization state; the compact API intentionally omits total accepted attempts and current subscription status. `SIDESTREAM_TELEMETRY_POSTGRES_URL` is a separate read-only source; remote sources require authenticated TLS and reject connection-string overrides of host, read-only, pool, and timeout controls. `SIDESTREAM_CRM_ADMIN_SECRET` protects POST-only non-browser reads and signs namespace/filter-bound cursors. Raw telemetry, identity values, `installIdHash`, Stripe IDs, search text, and merged tombstones stay excluded.
- `scripts/backfill-customer-360.mjs`, `scripts/verify-customer-360-backfill.mjs`, and `tests/customer-360/backfill*.test.mjs` - Offline identity-only Customer 360 backfill planning. Dry-run never opens Postgres or writes a checkpoint; Production apply is disabled; Test apply is separately human-gated, append-only, batch-atomic, resumable, idempotent, conflict-preserving, and restricted to `SIDESTREAM_TEST_POSTGRES_URL`.
- `scripts/plan-customer-360-retention.mjs` and `tests/customer-360/retention-ops.test.mjs` - Read-only Customer 360 retention inventory for eight explicit domains. It requires a complete reviewed policy, reports only aggregate age buckets and digests/fingerprints, uses authenticated remote TLS, and rejects every apply attempt before file or database access. It is groundwork, not a deletion or anonymization implementation.
- `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, and `api/_lib/license-environment.ts` - Shared server-only account/Stripe/Postgres implementation plus dependency-free entitlement primitives. They own exact Checkout verification, charged-PaymentIntent versus legitimate zero-total payment-source classification, account-device transactions, one-active-device decisions, transfer limits, production/Test isolation from trusted deployment state, short-lived access tokens, rotating refresh credentials, legacy compatibility through 1.0.13, safe OAuth return paths, and restore CSRF validation. Account-session, activation-status, verification, refresh, and download-authorization reads tolerate the pre-entitlement-lifecycle Production schema through one fail-closed JSON-based lifecycle expression, granting legacy compatibility only to the same exact one-time paid rows that the pending migration would backfill. Runtime Postgres parsing accepts the current Neon `channel_binding=require` query parameter, maps it to node-postgres channel binding, and still rejects weaker or unknown connection options. Serverless route imports intentionally use `.js` extensions so Vercel's Node ESM runtime resolves compiled helpers.
- `api/auth/google/start.ts` and `api/auth/google/callback.ts` - Google OAuth redirect/callback handlers. They require the configured callback to share the browser-facing start origin before setting a short-lived HTTP-only state cookie, upsert `sidestream_accounts`, issue a server-side session cookie, and render a retryable noindex HTML error instead of raw JSON when sign-in state is stale.
- `api/auth/session.ts` and `api/auth/logout.ts` - Account-session JSON and logout endpoints used by `account.html`.
- `api/checkout/start.ts`, `api/checkout/create.ts`, and `api/checkout/complete.ts` - Intentional one-time Sidestream Pro Checkout flow. Anonymous GET start creates/resumes only a signed database intent and renders confirmation; same-origin POST create is the website Session-creation boundary. Its signed-in account form branch creates the account-bound intent internally and returns straight to Stripe, while confirmed anonymous forms reuse one locked/idempotent Session. Activation-bearing GET start is the shipped-panel compatibility boundary and resumes or creates its one locked, idempotent, attached Stripe Session directly. Every path persists the exact Price/Product. Completion re-fetches Stripe truth before fulfillment and returns through the literal `{CHECKOUT_SESSION_ID}` placeholder. The old Vercel host still fails closed when legacy activation context is missing.
- `api/billing/portal.ts` - Authenticated Stripe Customer Portal redirect creator for customer billing details and invoice history where Stripe has actual Invoice objects to show.
- `api/billing/receipt.ts` - Authenticated one-time purchase receipt helper. It finds the signed-in account's latest Sidestream license PaymentIntent and returns the Stripe charge receipt URL, covering older Checkout payments that did not create invoices.
- `api/stripe/webhook.ts`, `api/_lib/stripe-events.ts`, and `api/internal/stripe-events/process.ts` - Signature verification, schema-compatible durable event recording, absolutely capped leased `SKIP LOCKED` claims, retry/backoff/dead-letter isolation, and watermark-protected entitlement reconciliation. Migrated schemas store and validate immutable ingress digests; the recognized baseline Production schema omits those optional columns and instead validates a claimed row against its signed raw payload. Expired final-attempt leases terminalize without a ninth normal processing attempt; Customer/account reads do not process this queue.
- `scripts/recover-stripe-dead-letter.mjs` and `db/migrations/20260717230000_add_stripe_event_recovery_audit.sql` - Exact-event, audited dead-letter recovery restricted to an isolated Test database, Test namespace, Stripe test mode, a non-livemode payload, and exact target/payload/state/reason/confirmation evidence. Read-only inspection is the default. Apply advances one reviewed attempt-8 row to the one authorized attempt 9 and has no Production, bulk replay, cap override, audit mutation, or entitlement-edit path; the migration is locally validated but not applied by this repository state.
- `api/_lib/maintenance.ts` and `api/internal/maintenance.ts` - Advisory-locked, bounded retention for expired sessions/credentials/limits/intents and Stripe payload redaction without deleting canonical leads or active entitlements.
- `api/activation/start.ts`, `api/activation/status.ts`, `api/activation/claim.ts`, and root `middleware.ts` - CEP-facing activation plus the authenticated restore/transfer/purchase decision surface. Shipped v1.0.14 panels require `restoreUrl` to remain the activation-claim route for every handoff. New `download_history` and `results_quota` Upgrade activations add `upgrade=1`, which route-scoped Vercel middleware internally rewrites straight to the activation-bearing Checkout route before API function selection, avoiding the claim function and its extra Postgres lookup. Older saved Upgrade claim URLs retain the database-classified fallback for signed-out and Free accounts; active Pro owners stay on the claim path so Checkout's reconnect redirect cannot loop back into the legacy fallback. `settings_account` remains on the authenticated claim route. Non-Upgrade claim GET is read-only; restore or transfer requires an active-license session, same-origin CSRF-protected POST, and an explicit prior-device deactivation confirmation for a move.
- `api/license/verify.ts`, `api/license/refresh.ts`, `api/license/authorize-download.ts`, `api/license/deactivate.ts`, and `api/account/device.ts` - Trusted-environment credential verification/rotation, exact active-device pre-download authorization, authenticated same-origin deactivation, and coarse read-only account device status. Stable device outcomes include `device_replaced` and `device_deactivated`.
- `db/migrations/20260626120000_add_sidestream_download_leads.sql` - Postgres schema for the private `public.sidestream_download_leads` table used by the download email gate.
- `db/migrations/20260703120000_add_sidestream_accounts_billing.sql` - Postgres schema for accounts, sessions, Stripe licenses/events, plugin activation sessions, and short-lived license tokens.
- `db/migrations/20260704120000_add_sidestream_billing_resources.sql` - Legacy Postgres schema for persisted Stripe subscription billing resources from the retired monthly-price flow.
- `db/migrations/20260704130000_allow_stripe_first_accounts.sql` - Postgres schema adjustment that allows Stripe-first account rows without a Google subject so Checkout can create/link Sidestream entitlements from webhook customer data.
- `db/migrations/20260704150000_allow_one_time_checkout_licenses.sql` - Postgres schema adjustment that lets `sidestream_licenses` store one-time Checkout Session and PaymentIntent IDs instead of requiring a Stripe subscription ID.
- `db/migrations/20260707120000_enable_sidestream_server_table_rls.sql` - Server-table hardening migration that enables RLS on Sidestream public tables and conditionally revokes direct `anon` / `authenticated` access when those legacy roles exist. The Vercel API routes continue to use the server-only Neon Postgres connection.
- `db/migrations/20260713180000_add_activation_checkout_and_refresh_rotation.sql` - Adds exact Checkout attachment/expiry/grace fields to activation rows and hashed current/previous refresh credential fields with database-enforced attachment and replay-window constraints.
- `db/migrations/20260713203000_add_checkout_intents.sql` - Additive private schema for `public.sidestream_checkout_intents`, which stores bounded signed website confirmation state before Stripe Session creation. This exact migration was applied and read-only verified against Production on 2026-07-22.
- `db/migrations/20260714120000_add_installer_request_tracking.sql` - Adds the server-owned `public.sidestream_installer_requests` attribution table, reporting indexes, RLS, and conditional direct-access revocations for legacy Data API roles when present.
- `db/migrations/20260714190000_add_single_active_account_devices.sql` - Additive private schema for `public.sidestream_account_devices` lifecycle rows and `public.sidestream_device_transfers` confirmations. Partial unique indexes enforce at most one active row per account in each of the separate production and Test namespaces; raw device identifiers are never persisted. This exact migration was applied and verified against Production on 2026-07-21.
- `db/migrations/20260713200000_add_api_operational_controls.sql` through `db/migrations/20260714200000_remove_redundant_download_lead_key_unique.sql` - Append-only hardening chain for the checksummed migration ledger, rate limits, credential uniqueness, Stripe claims/retries/watermarks, Checkout intents, refund/dispute lifecycle, canonical leads/replay receipts, retention indexes, and the final removal of the redundant unique `lead_key` constraint.
- `tests/entitlement.test.mjs`, `tests/stripe-event-claim-cap.test.mjs`, and `tests/stripe-events.test.mjs` - Focused Node and disposable-Postgres harnesses for exact paid-Session verification, charged and zero-total payment sources, schema-compatible Stripe event persistence/claims, signed-raw-payload validation, attacker-link/pre-bind regressions, device/account binding, restore CSRF/origin checks, safe OAuth return paths, and deterministic lost-response credential replay.
- `tests/download-referral.test.mjs` - Focused Node integration and helper tests for tagged redirects, non-blocking database failures, `HEAD`/`304` exclusions, UTM validation, anonymous HMACs, and likely-scanner detection.
- `tests/referral-visits.test.mjs` - Focused tests for ManyChat, Sidestream Instagram, Alex Instagram, Meta Ads, and Reddit source validation, privacy-limited daily hashing, deterministic private-Blob pathnames, short routes, and scanner classification.
- `tests/license-environment.test.mjs` and `tests/single-device-*.test.mjs` - Static and disposable-Postgres proof for the complete migration chain, including installer-referral RLS, namespace isolation, policy states, database races, transfers/revocation, support tooling, account pages, download authorization, legacy compatibility, and Checkout preservation. `npm run test:single-device` is the aggregate command and requires a safe `SIDESTREAM_TEST_POSTGRES_URL`.
- `scripts/apply-postgres-migrations.mjs` - Checksummed, advisory-locked migration runner for all SQL files under `db/migrations/`, with database-backed `--status`/`--baseline`/apply, local-only `--validate`/`--dry-run`, and atomic migration-plus-ledger transactions. Its current remote TLS configuration is not Production-safe; the canonical runbook records the implementation blocker.
- `scripts/apply-production-checkout-schema.mjs` - Narrow pinned Production operator for the already-applied `20260713203000_add_checkout_intents.sql` migration. Its current documented use is read-only `--verify`, which validates the exact Sidestream Vercel project, linked Neon resource, target fingerprint, required parent tables, columns, constraints, migration-owned indexes, RLS, and checked-in migration digest; it is not a general migration runner or deployment tool.
- `scripts/apply-production-device-schema.mjs` - Narrow pinned Production operator for the already-applied `20260714190000_add_single_active_account_devices.sql` migration. Its default documented use is read-only `--verify`, which validates the exact Sidestream Vercel project, linked Neon resource, target fingerprint, tables, columns, constraints, indexes, RLS, and checked-in migration digest; it is not a general migration runner or device-policy cutover.
- `scripts/verify-migration-baseline.mjs` - Read-only exact catalog/RLS verifier for recognized pre-20260713 profiles. Its current remote TLS path is not Production-safe, so Production use is blocked until the canonical runbook's authenticated-tooling prerequisite is implemented; never use it to bless unexplained drift.
- `scripts/run-api-tests.mjs`, `scripts/run-postgres-integration.mjs`, `scripts/validate-vercel-contract.mjs`, and `scripts/verify-vercel-build.mjs` - Aggregate handler/state-machine test discovery, disposable-Postgres concurrency proof with runtime-target rejection, static Vercel route/cron contract validation, and the human-only post-`vercel build` bundle verifier.
- `scripts/audit-legacy-subscriptions.mjs` - Read-only-by-default Stripe/Product/Price inventory plus explicitly confirmed direct-database backfill/quarantine for exact allowlisted legacy subscriptions. Its current remote database connection is not Production-safe, so neither audit nor apply is authorized there.
- `scripts/audit-license-devices.mjs` - Read-only-by-default pseudonymous fleet audit plus an explicitly confirmed direct-connection backfill mode. Its current environment selection and remote TLS path block every Production mode.
- `scripts/manage-license-device.mjs` - Account/namespace-scoped support view, binding clear, and bounded expiring move-limit override. Its current environment selection and remote TLS path block every Production mode, including read-only view.
- `scripts/ensure-freedev-promo.mjs` - Maintainer utility that creates or verifies the sandbox-only Stripe `FREEDEV` 100% off promotion code used to test no-cost Sidestream Pro Checkout.
- `scripts/migrate-download-leads-to-postgres.mjs` - Legacy-named HTTP replay client for the protected `/api/internal/download-leads/replay` route. It requires a replay endpoint plus `CRON_SECRET`, preserves Blob records by default, optionally requests delete-after-commit, and explicitly rejects the removed `--apply-schema` mode. Schema application belongs only to the migration runner.
- `scripts/dump-download-leads.mjs` - Maintainer utility that dumps captured Sidestream download leads from Postgres for local/disposable inspection. Its current remote TLS path disables certificate verification, so Production use is blocked.
- `scripts/report-installer-referrals.mjs` - Maintainer-only aggregate report for a Gmail installer campaign. It reports request, likely-scanner, likely-human, and unique daily likely-human request counts by batch without returning raw request hashes. Its current remote TLS path disables certificate verification, so Production use is blocked.
- `scripts/report-referral-visits.mjs` - Read-only aggregate report for first-party landing referrals stored in private Vercel Blob. It reports records, likely scanners, likely humans, and unique daily likely-human visitors without returning anonymous request hashes.
- `scripts/generate-sitemap.mjs` - Post-build sitemap generator. It uses local Git history for clean builds, the file mtime for a dirty local page, and Vercel's commit metadata plus the public GitHub commits API when Vercel strips `.git` before a Git-linked build. It writes the resulting ISO timestamp only to `dist/sitemap.xml`.
- `src/main.tsx` - React entry that mounts `DemoOne` into `#shader-background-root` and renders Vercel Analytics through `@vercel/analytics/react`.
- `src/paper-shaders-compat.d.ts` - Local TypeScript compatibility declarations for the pasted prop names that the installed Paper package does not type directly.
- `src/index.css` - Tailwind v4 theme/utilities import, `tw-animate-css`, shadcn theme tokens, and source paths for the background component. It avoids Tailwind preflight so the static HTML styles are not reset.
- `components.json` - shadcn configuration with aliases rooted at the repository root.
- `vite.config.ts` - Vite React/Tailwind build config with the canonical root page, legacy redirect, account page, and upgrade page as HTML inputs.
- `vercel.json` - Vercel deployment config. Forces npm install/build/dev commands and `dist` output, permanently canonicalizes the `www` host plus old-host non-API pages, `/index.html`, and the legacy nested HTML path onto `https://sidestream.tv`, and adds `X-Robots-Tag: noindex, nofollow` to `/api/`, account, checkout-success, and upgrade responses. The old Vercel hostname intentionally executes the same deployed `/api/*` handlers in place because installed 1.0.12 panels cannot follow a POST `308`. The dev command passes Vercel's `$PORT` to Vite.
- `mockups/mockup1_2.webm` - Browser-sized autoplay alpha WebM generated from the cleaner local MacBook Pro mockup source and mounted below the pricing panels.
- `demos/search demo.mp4` and `demos/preview demo.mp4` - Autoplaying feature demo videos showing the Tudor Place search and preview workflow.
- `demos/sidestream-panel-corner.webm` - Square VP9-alpha WebM generated from the ProRes source `sidestream demo Linked Comp 01_2.mov` using the full-plugin/timeline top-left crop. Mounted as an opaque decorative Premiere/Sidestream corner inside the hero, visually scaled to 70% from the Premiere panel's top-left corner and anchored at `45vw 25vh` on desktop. At `900px` and below, the same loop reflows into a compact, lifted, right-biased product demo with a low soft fade above the main hero copy.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`; the desktop header exposes Features and Account as compact glass pill links without Pricing or download CTAs
- Shader background - `#shader-background-root`, `src/main.tsx`, `components/ui/demo.tsx`, the active Paper `MeshGradient`, `components/ui/background-paper-shaders.tsx`, and `src/paper-shaders-compat.d.ts`
- Vercel Analytics - `src/main.tsx` imports `Analytics` from `@vercel/analytics/react` and renders it alongside the shader component
- SEO/GEO metadata - `<head>` metadata in `index.html` provides the title, description, robots directive, absolute canonical root URL, Open Graph/Twitter tags, sitemap hint, public OG image, and JSON-LD `Organization`, `WebSite`, `SoftwareApplication`, and `Product` graph for the product surface. Keep this crawler-readable layer aligned with visible product claims. `vercel.json` owns duplicate-host and duplicate-path `308` canonicalization; do not restore client-side redirect code in the legacy file.
- Hero - `#hero`, `.hero-split`, `.hero-copy`, `.hero-title-line`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, desktop `.desktop-download-ctas`, and the inline mobile `#mobile-download-handoff` form
- Windows download - `[data-windows-download]` lives beside the hero `[data-download]` `Download for Mac` CTA as a matching white platform pill with a Windows mark and links directly to `https://sidestream.tv/api/download?platform=win32-x64`.
- DaVinci Resolve waitlist - `[data-resolve-waitlist-open]` is the third desktop hero pill. It carries the inline stroke-free three-color Resolve mark with enough SVG viewport padding to preserve the lower lobes, opens `#resolve-waitlist-gate`, and records successful email submissions through the dedicated Blob-only `/api/resolve-waitlist` route. The server fixes `cta_source = "davinci-resolve-waitlist"`; the browser cannot choose another bucket. It is hidden with the rest of `.desktop-download-ctas` at `900px` and below, where the existing computer download handoff remains the only hero form.
- Feature sections - `#features` anchor, `.feature-glass` full-bleed frosted backdrop band, the two `.sec-pad` feature blocks, `.feature-subtext` heading sublines, `.shot` video frames with explicit `role="img"` labels, `.demo-video` MP4 embeds, the bottom inline viewport-playback observer, and the pointer-driven `.shot` 3D tilt handler
- Pricing - `#pricing`, `.pricing-head`, `.plans`, `.plan`, `.plan.featured`, `.beta-coming`, `.plan-beta-content`, `.beta-overlay`, `.final`, `.pricing-mockup`, `.macbook-mockup-video`, the MacBook playback helper, and the pricing-panel scroll reveal observer
- Final CTA - `.final` sits inside `#pricing` between the pricing cards and laptop mockup, with a single public installer download button
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download and upgrade actions - `[data-download]`, `[data-windows-download]`, `[data-purchase]`, `#mobile-download-handoff`, and `#toast`; desktop Mac/Windows CTAs retain their direct installers, while viewports at or below `900px` replace the hero platform choice with the email form and its "Email me the download link" submit action, then route lower-page download taps back to that form. Anonymous website entry points retain the no-store `/api/checkout/start` confirmation page, while activation-bearing panel handoffs remain direct. The authenticated Free-account Upgrade form posts directly to `/api/checkout/create` and receives the Stripe redirect without visiting `upgrade.html` or the start confirmation.
- Installer and update fulfillment - `data/release-manifest.json` is the default Mac release pointer and `data/release-manifest.windows.json` is the Windows beta pointer. `api/download.ts` and `api/releases/latest.ts` resolve the same platform-specific manifest so artifact and update truth cannot drift. Bare requests remain Mac, `win32-x64` selects Windows, and unknown platforms return `404` instead of silently serving the wrong OS.
- Installer referral attribution - Gmail launch URLs use `utm_source=gmail`, `utm_medium=email`, a bounded campaign ID, and optional `utm_content=pilot` or `utm_content=main` batch ID. Only a successful tagged installer `GET` creates `public.sidestream_installer_requests`; `HEAD`, `304`, invalid tags, and failed fulfillment create nothing. The event stores no email, raw IP, or raw user agent. Scanner-like `GET`s remain visible with `likely_scanner = true` so reports can separate them instead of pretending they never happened.
- Landing referral attribution - Vercel redirects `/m` to the canonical landing page with `utm_source=manychat`, `/ig` with `utm_campaign=bio` for Sidestream's Instagram, `/alex` with `utm_campaign=alex-bio` for Alex's personal Instagram, `/meta/1` with `utm_source=meta&utm_medium=paid_social&utm_campaign=1`, and `/reddit/1` plus `/reddit/2` with matching numbered Reddit campaign tags. The same routes with a trailing slash are accepted so copied or normalized URLs do not fall through to a `404`. The browser maps those owned links to separate `manychat`, `instagram-bio`, `instagram-alex`, `meta-ads-1`, `reddit-1`, and `reddit-2` sources and sends one non-blocking POST to `/api/referral-visit`; the server stores a private, scanner-aware, daily-deduplicated Blob record using the existing analytics HMAC secret. This measures landing visits, not installer downloads, purchases, or activations.
- Download lead capture and replay - `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/internal/download-leads/replay.ts` validate at most 8 KiB of JSON, converge repeated `(email, cta_source)` submissions, enforce 5/email and 20/IP per ten minutes, and fall back to deterministic private Blob records when Postgres fails. Scheduled replay processes 25 mapped records and deletes only after commit plus ETag match; manual replay is bounded to 100 and defaults to preserving records. Historical `windows-waitlist` rows remain queryable.
- Account/auth/billing/device entitlement - `account.html`, `thank-you.html`, `upgrade.html`, `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, `api/_lib/license-environment.ts`, `api/auth/*`, `api/checkout/*`, `api/billing/*`, `api/stripe/webhook.ts`, `api/activation/*`, `api/account/device.ts`, and `api/license/*` own optional Google account management, the server-owned $9.99 one-time Sidestream Pro Product/Price, confirmed Checkout intents, namespace-separated active-device rows, restricted Test isolation, refund/dispute lifecycle, confirmed transfers, download authorization, deactivation, and device-bound access/refresh credentials. Device mismatch policy defaults to `observe`; only explicit `enforce` blocks, and Customer 360 does not change that mode. The API/operator contract is `docs/api-hardening-runbook.md`; device/support details are in `docs/single-device-entitlements.md`.
- Customer 360 commerce ledger - `api/_lib/customer-commerce.ts`, `20260715122000_add_customer_commerce_ledger.sql`, and `tests/customer-360/commerce*.test.mjs`; settled money comes from one canonical PaymentIntent or standalone Charge per payment group. Before that instrument exists, a paid InvoicePayment edge makes the related Invoice the preferred fallback and suppresses only the Checkout view resolving to the same namespace/profile/currency payment key. Gross and its `off_stripe_paid_minor` subset stay currency-separated, unrelated Checkout fallbacks remain independent, paid InvoicePayment edges never collapse many-to-many allocations into alias equivalence, and contradictory live identity evidence triggers sticky whole-group quarantine.
- Customer 360 usage and private reads - `api/_lib/customer-usage.ts`, `api/_lib/customer-query.ts`, `api/internal/customer-usage/sync.ts`, `api/internal/customers/index.ts`, and `api/internal/customers/[customerId].ts`; schema-versioned telemetry becomes replaceable UTC daily aggregates with exhaustive stored/derivable first/last use and attempt timestamps, outcome counts, lifetime and rolling activity, attempts-per-active-day frequency, coarse client summaries, and source/materialization freshness. The compact list/detail projection exposes only its documented subset, requires an authenticated admin body to select an authorized namespace, binds that namespace into signed keyset cursors, and exposes neither total accepted attempts nor current subscription status. The full cross-repo field/privacy/rollout contract is `docs/customer-360.md`.
- Customer 360 backfill - `scripts/backfill-customer-360.mjs` and `scripts/verify-customer-360-backfill.mjs`; reviewed offline identity exports become privacy-safe candidate/orphan/conflict plans. Dry-run is the default and Production apply is unavailable. Any Test apply requires separate approval after dry-run review.
- Customer 360 Preview/Test acceptance - `docs/customer-360-preview-test-plan.md`, `scripts/verify-customer-360-preview-environment.mjs`, and `scripts/verify-customer-360-preview-deployment.mjs`; the matrix owns ordered evidence, stop conditions, one-time host-bound usage-sync verification with project-wide cron disabled, rollback/recreate, and the hard exit. The current Vercel Preview environment is rejected because its database, Stripe, Google, and base URL values match Production; isolated provisioning is a human gate.
- API operations - `api/_lib/postgres.ts` owns the shared bounded runtime pool; checksummed migrations own schema changes; `api/_lib/stripe-events.ts` owns durable claimed Stripe work; `api/_lib/maintenance.ts` owns bounded cleanup/redaction; `vercel.json` schedules all four `CRON_SECRET`-protected internal routes. Customer reads never run migrations or drain event backlog.

## Routes and Assets

There is no client router. Use Vite for local development so the TypeScript shader entry is compiled and served.

Vercel Analytics is initialized from the same compiled React entry as the shader background. It records deployed page visits after the site is built and visited on Vercel; local Vite previews are for integration/build checks, not production analytics confirmation.

When using a local preview server, the root URL serves the canonical page:

```text
http://localhost:5173/
```

The current canonical public landing URL for crawlers is:

```text
https://sidestream.tv/
```

The short ManyChat referral URL is:

```text
https://sidestream.tv/m
```

Vercel temporarily redirects it to `https://sidestream.tv/?utm_source=manychat`; the canonical root remains unchanged.

The short Sidestream Instagram bio URL is:

```text
https://sidestream.tv/ig
```

It temporarily redirects to the canonical root with `utm_source=instagram&utm_medium=social&utm_campaign=bio` so Instagram-bio visits remain separate from ManyChat visits. `/ig/` is supported identically for clients that append a trailing slash.

The short Alex personal Instagram bio URL is:

```text
https://sidestream.tv/alex
```

It uses `utm_campaign=alex-bio` and records as `instagram-alex`, keeping it separate from both Sidestream Instagram and ManyChat.

The first Meta Ads referral URL is:

```text
https://sidestream.tv/meta/1
```

It uses standard paid-social tags `utm_source=meta&utm_medium=paid_social&utm_campaign=1` and records separately as `meta-ads-1`. `/meta/1/` is supported identically.

The first Reddit referral URL is:

```text
https://sidestream.tv/reddit/1
```

It uses `utm_source=reddit&utm_medium=social&utm_campaign=1` and records separately as `reddit-1` through `/api/referral-visit`. `/reddit/1/` is supported identically.

The second Reddit referral URL is:

```text
https://sidestream.tv/reddit/2
```

It uses `utm_source=reddit&utm_medium=social&utm_campaign=2` and records separately as `reddit-2` through `/api/referral-visit`. `/reddit/2/` is supported identically.

The old exported static page path, `/Sidestream%20front%20end%202/Sidestream.html`, is kept only as a compatibility route. Vercel returns a server-side `308` to `https://sidestream.tv/`; the built fallback HTML contains no meta refresh or JavaScript redirect.

Vite copies public crawler assets to the site root:

```text
GET /robots.txt
GET /sitemap.xml
GET /llms.txt
GET /sidestream-social-card-v2.jpg
```

`robots.txt` allows normal search discovery plus OpenAI `OAI-SearchBot` and user-initiated `ChatGPT-User` access to public content, while disallowing all `/api/` routes so crawlers cannot create Checkout Sessions or trigger installer fulfillment. `GPTBot` is disallowed site-wide as a separate training choice; this does not opt the site out of ChatGPT search. OpenAI referrals can still be attributed through the `utm_source=chatgpt.com` query parameter they attach. The sitemap contains the canonical landing page only. `llms.txt` is an additive AI-readable summary for agents; do not use it as a place for claims that are absent from the landing page.

Every `/api/` response and the functional `account.html`, `thank-you.html`, and `upgrade.html` pages also receive `X-Robots-Tag: noindex, nofollow` from Vercel. The HTML pages keep matching meta directives as defense in depth. Host-conditional redirects are deployment routing and cannot be proven with Vite alone.

Vercel serves these serverless API surfaces. Unsupported methods return `405`
with `Allow`; see `docs/api-hardening-runbook.md` for exact error codes and
operator response.

| Surface | Exact methods | Successful response contract |
| --- | --- | --- |
| `/api/download` | `GET`, `HEAD` | GET `302` to a five-minute signed private Blob URL or `304` for a matching ETag; HEAD `200` attachment metadata |
| `/api/referral-visit` | `POST` | `204` after validating the source and scheduling a bounded private-Blob attribution write |
| `/api/releases/latest` | `GET`, `HEAD`, `OPTIONS` | GET `200` public manifest, HEAD matching metadata without a body, OPTIONS `204` |
| `/api/download-lead` | `POST` | `200 {"ok":true}` after Postgres or `200 {"ok":true,"queued":true}` after private-Blob fallback |
| `/api/resolve-waitlist` | `POST` | `200 {"ok":true}` only after durable hashed rate-limit consumption and a deterministic private-Blob write; fails closed if Blob is unavailable |
| `/api/send-download-links` | `POST` | `200 {"ok":true}` after a durable private-Blob rate-limit/lead write and Resend acceptance; fails closed when Blob storage or email delivery is unavailable |
| `/api/auth/google/start`, `/api/auth/google/callback` | `GET` | Existing-session account redirect or Google OAuth redirect and server session creation |
| `/api/auth/session` | `GET` | Read-only account/license session JSON; it never drains Stripe events |
| `/api/auth/logout` | `POST` | Clears the server session |
| `/api/checkout/start` | `GET` | `200` no-store signed intent confirmation HTML; no Stripe write |
| `/api/checkout/create` | `POST` | Signed-in account form or confirmed anonymous form `303` to Stripe; confirmed JSON request returns `200 {"url":"...","reused":boolean}` |
| `/api/checkout/complete` | `GET` | Exact Stripe re-verification then `303` to thank-you; not-ready is `409` |
| `/api/billing/portal`, `/api/billing/receipt` | `POST` | Authenticated Stripe portal redirect or latest receipt JSON |
| `/api/stripe/webhook` | `POST` | `200 {"received":true}` after durable insert; duplicate adds `"duplicate":true` |
| `/api/activation/start`, `/api/activation/status` | `POST` | Start returns activation key/expiry/URLs; status returns a stable activation/device state |
| `/api/activation/claim` | `GET`, `POST` | Read-only confirmation GET; CSRF/same-origin restore or transfer POST |
| `/api/account/device` | `GET` | `200 {"active":boolean,"device":object|null}` |
| `/api/license/verify`, `/api/license/refresh`, `/api/license/authorize-download`, `/api/license/deactivate` | `POST` | Credential verification/rotation, exact `{"active":true}` download authorization, or explicit device deactivation |
| `/api/internal/stripe-events/process` | `GET` | Protected summary `{ok,claimed,processed,ignored,retryable,deadLetter}` |
| `/api/internal/download-leads/replay` | `GET`, `POST` | Protected `{ok,summary,nextCursor,hasMore}`; scheduled GET is fixed at 25/delete, manual POST accepts bounded controls |
| `/api/internal/maintenance` | `GET` | Protected `{ok,outcome,durationMs,batchSize,hasMore,counts}` |
| `/api/internal/customer-usage/sync` | `GET` | `CRON_SECRET`-protected once daily aggregate summary `{ok,outcome,licenseNamespace,batches,sourceRowsScanned,dailyBucketsWritten,profilesRefreshed,sourceFreshnessAt}` |
| `/api/internal/customers` | `POST` | `SIDESTREAM_CRM_ADMIN_SECRET`-protected `{customers,nextCursor}`; browser origins are forbidden |
| `/api/internal/customers/[customerId]` | `POST` | Same protected compact shape as list, wrapped as `{customer}`; merged tombstones and cross-namespace IDs return `404` |

For `/api/activation/status`, a parsed non-null JSON value with missing or invalid
required fields returns `400 invalid_request`. Valid JSON `null` is currently
dereferenced before validation; it escapes as an unshaped platform `5xx`, as do
malformed JSON and body-read failures. None of those cases is a documented `400`
response. Changing that behavior requires a separately owned handler fix and
regression test.

All internal routes require `Authorization: Bearer <CRON_SECRET>`. The one shared
token must be 16-512 printable, non-space ASCII characters (`U+0021`-`U+007E`)
so all four route validators accept the same header; generate 32 random bytes
as 64 hexadecimal characters in the approved secret manager. A missing or weak
length configuration returns `503`; missing/wrong auth returns `401`.
`vercel.json` schedules Stripe processing every five minutes, lead replay every
ten minutes, maintenance daily at `04:13` UTC, and Customer 360 usage sync once
daily at `05:27` UTC.

### Customer 360 contract and rollout status

Customer 360 is not deployed and Production is not migrated. Money is
Stripe-verified, currency-separated minor units but is not entitlement truth;
local code now handles `refund.failed`, maps every current dispute status, and
absolutely caps normal Stripe claims, but historical repair and all live proof
still prevent describing Production entitlement enforcement as complete.
`installIdHash` is a Customer 360 association key, not the single-device
binding, and the Gmail installer-referral HMAC is attribution only, never
identity.

The code-owned closure is deliberately narrower than rollout approval. Local
tests prove authenticated remote telemetry TLS option construction, the
claim/reclaim cap, failed-refund recovery and dispute mapping, an audited
exact-event Test-only dead-letter recovery path, and a fail-closed aggregate
retention inventory. They do not prove a live TLS handshake, a connected target,
an applied recovery migration, a recovered event, an approved retention period
or mutation policy, Stripe endpoint configuration, or any deployed behavior.

The canonical execution checklist is
`docs/customer-360-preview-test-plan.md`. The current Vercel Preview environment
is rejected because its database, Stripe, Google, and base URL values match
Production. Provisioning and approving an isolated Preview target is a
human-owned gate; until it passes, no live Customer 360 deploy, migration,
protected call, usage sync, backfill apply, or FlowState Preview QA is authorized.
The return path still requires a freshly verified named isolated Preview target,
provider configuration and artifact evidence, authenticated connected database
and telemetry targets, checksummed non-Production migrations, separate backfill
dry-run and Test-apply approvals, an approved retention policy, named alert
destinations and source-lag/read budgets, live FlowState Preview QA, and a fresh
Production plan after every Preview/Test gate passes.

Trusted deployment state selects namespace for Customer 360 writes, identity,
telemetry, device, and entitlement behavior. The protected admin list/detail
POST body may select which authorized namespace to read, and signed cursors bind
that selection. `billingModel` describes purchase history, not current
subscription state. Device policy still defaults to observe, and Customer 360
does not enable enforcement.

For FlowState, the association transport is limited to optional
`installIdHash`, `supportCode`, and `installerReceiptIdHash` fields in the JSON
`POST` bodies for `/api/activation/start`, `/api/activation/status`,
`/api/license/verify`, and `/api/license/refresh`. FlowState must reuse its stable
telemetry `installIdHash` verbatim, never rehash or channel-salt it, and never
put any association value in activation, claim, checkout, restore, or account
URLs, query strings, or browser forms. The exact route matrix, canonical
formats, omission behavior, `400 invalid_customer_identity` contract, and
activation-record continuity rules are in `docs/customer-360.md`; trusted
website routing owns production/Test isolation.

Customer 360 identity attachment is schema-gated inside the existing account
transaction. The complete core table set must be present before any profile or
identity write runs; an older or intentionally unmigrated database skips the
optional attachment and continues the activation/license operation. This keeps
Customer 360 from adding another schema dependency to sign-in, restore, or
transfer. The account runtime separately preserves the shipped activation
purchase and device-hash credential contract on the known pre-hardening
Production baseline. Account-device management and transfer still require their
separately reviewed schema; the compatibility path does not pretend those newer
features are deployed.

The only rollout path is the human-gated Preview/Test-first sequence in
`docs/customer-360.md`, executed and evidenced through
`docs/customer-360-preview-test-plan.md`: review and merge, approve a
non-Production target, apply
checksummed migrations there, configure secrets and reviewed invocation/scheduling,
deploy Preview/Test,
dry-run and verify backfill, separately approve any Test apply, verify protected
APIs and source freshness, then run live FlowState integration/QA. Local or
fixture-backed FlowState implementation may proceed against the contract before
that live gate. Vercel cron scheduling remains project-wide across all four jobs,
so rollout must use an approved protected manual/separate non-Production scheduler
or separately approve all four before enabling scheduling. That document also owns
every list/detail field and nullability, cursor/auth behavior, conflict and
retention rules, rolling-window decay, disposable harness, observability, and
non-Production rollback. It authorizes no Production deployment, migration, or
backfill apply.

Release platform aliases are fail-closed and shared by both release routes:

Each route's `URLSearchParams` parser decodes `platform`; the shared selector then
trims and lowercases the decoded value before matching. The listed aliases are
therefore case-insensitive and may have surrounding decoded whitespace. An
omitted parameter defaults to Mac; an empty value after trimming or any unknown
normalized value returns `404`.

| `platform` | Public platform | Manifest/artifact |
| --- | --- | --- |
| omitted, `darwin-arm64`, `darwin-x64`, `macos`, `macos-arm64`, `macos-x64` | `macos` | `data/release-manifest.json`, DMG |
| `win32-x64`, `windows`, `windows-x64` | `win32-x64` | `data/release-manifest.windows.json`, EXE |
| empty or any unknown value | — | `404`; never serve another operating system |

`/api/releases/latest` normalizes `channel` separately. An omitted parameter or
literal empty `channel=` defaults to `stable`. A non-empty value is URL-decoded
by `URLSearchParams`, trimmed, lowercased, stripped of every character outside
`[a-z0-9_.-]`, and truncated to 40 characters; only a final value exactly equal
to `stable` is accepted. Consequently `STABLE`, surrounding encoded whitespace,
and `s%20table` currently resolve to `stable`, while any other final value returns
`404`. `/api/download` does not read `channel`.

`/api/download` serves the private Vercel Blob object named by the selected manifest at `artifact.pathname`, with `SIDESTREAM_INSTALLER_BLOB_PATHNAME` left only as a local fallback for the default Mac manifest. `HEAD /api/download` returns attachment metadata without exposing the private Blob URL. `GET /api/download` first verifies the Blob metadata, honors a matching `If-None-Match` with `304`, then returns a temporary redirect to a 5-minute signed private Blob URL so the browser downloads from Blob/CDN instead of proxying the full installer through the serverless function. After a tagged Gmail redirect is sent, Vercel `waitUntil()` gives the route's bounded writer at most one second to save a privacy-limited request event; a missing secret, database failure, or timeout is logged but cannot change delivery. Set the stable server-only `SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET` to at least 32 characters in every deployed environment that records referrals. `/api/releases/latest` serves the same selected manifest's public update metadata at `https://sidestream.tv/api/releases/latest`, omitting the private Blob pathname. Bare and Mac-platform requests use `data/release-manifest.json`; `platform=win32-x64` uses `data/release-manifest.windows.json`; unknown platforms return `404`. The Mac manifest keeps `1.0.12` as the minimum supported version, so v1.0.11 and older clients treat the latest release as a non-dismissible critical update while v1.0.12 and newer remain on the normal rollout path. Future manifest publishing defaults to the same floor unless `--min-supported-version` is explicitly supplied. The current public Mac pathname is:

```text
sidestream/1.0.14/Sidestream-1.0.14-Mac-Installer.dmg
```

The Blob store is the private `sidestream-release-105` store in Vercel project `sidestream`, store id `store_9KFjHEkmxI6IIWNi`, region `iad1`. Vercel Blob access is authenticated through either `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`, or a legacy `BLOB_READ_WRITE_TOKEN` if one is configured. `BLOB_STORE_ID` is set in the Vercel project environments, while installer pathnames live in the platform manifests; `.env.local` is generated by `vercel env pull` and must stay ignored. Bare website downloads should point at the native/base Mac installer DMG, not the Windows beta or older ZXP-helper path.

### Vercel Blob And CDN Usage Guardrails

Limits and the live team plan were rechecked on 2026-07-13; re-check [Vercel pricing](https://vercel.com/docs/pricing), [Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), and [CDN usage](https://vercel.com/docs/manage-cdn-usage) before making quota-sensitive changes. Production currently runs on Vercel Pro with usage billing active. The private store held about 1.406 GiB before the Windows `1.0.13` upload, so it was already beyond the old Hobby allowance without being blocked.

The current public Mac artifact, `Sidestream-1.0.14-Mac-Installer.dmg`, is 226,417,721 bytes, about 216 MiB. Windows beta EXEs are about 59 MiB. Use the live Vercel Usage view rather than stale Hobby math before adding artifacts or estimating a launch's transfer cost.

Flag any change that increases installer size, stores multiple release DMGs, uploads raw demo/video assets, makes `/api/download` easier for bots to hit, removes attachment/cache safeguards, proxies the installer through extra functions, or changes the email gate/CTA flow in a way that materially increases downloads. Estimate `artifact bytes * expected downloads` and verify Vercel Usage after publish.

Download CTAs are intentionally unblocked in the canonical HTML. Mac anchors point at `https://sidestream.tv/api/download`, while the hero Windows anchor points at `https://sidestream.tv/api/download?platform=win32-x64`, so local static previews and adjacent static hosts do not 404 on a relative API path. The old download-email modal remains only for historical compatibility, and visible Mac/Windows download clicks do not require an email before starting either installer. The separate Resolve CTA opens the active waitlist modal and posts to `/api/resolve-waitlist`. The route stores `cta_source = "davinci-resolve-waitlist"` in its own durable private-Blob prefix; prior Windows leads remain queryable through `cta_source = "windows-waitlist"` even though that retired modal is no longer in the page.

The SaaS/account flow is server-owned. The landing-page Account link enters `/api/auth/google/start`: a valid server session goes directly to `account.html`, while a signed-out visitor enters Google OAuth and the callback creates or reconnects the account. Direct signed-out visits to `account.html` use the same entry instead of rendering an empty account panel. The Google callback origin must exactly match the browser-facing OAuth start origin; Production uses `https://sidestream.tv/api/auth/google/callback` in Google Auth Platform, keeps `SIDESTREAM_BASE_URL=https://sidestream.tv`, and requires any optional `GOOGLE_REDIRECT_URI` override to use that same callback. The start route checks this before setting state cookies, so a stale deployment setting cannot send users through Google only to fail the callback on another hostname. The session is remembered for up to 30 days by the existing HTTP-only, `SameSite=Lax` `sidestream_session` cookie; do not add a browser-readable identity cookie. While Production intentionally remains on the pre-entitlement-lifecycle schema, every customer-facing license read uses the shared `LICENSE_ENTITLEMENT_STATUS_SQL` expression to detect the missing column without runtime DDL and treats only exact one-time paid `active`/`trialing` rows as compatible Pro access; after the column exists, its canonical stored value always wins. Sign out clears the server session and returns to the landing page so the automatic account entry cannot immediately sign the user back in. Sign-in is not required before purchase. Anonymous website `GET /api/checkout/start` creates or resumes only a 24-hour database intent and renders a signed confirmation whose POST token lasts 10 minutes; it never creates a Stripe Customer, Product, Price, or Checkout Session. An activation-bearing URL from a shipped CEP panel is one narrow exception: its high-entropy activation capability directly resumes or creates the one idempotent Stripe Session attached to that activation, preserving the pre-Customer-360 Upgrade contract. A signed-in Free account is the other: it submits one same-origin `account_purchase` form to `POST /api/checkout/create`; the handler authenticates the session, rate-limits by account and IP, creates the account-bound intent internally, and returns a `303` straight to Stripe. Other confirmed website POSTs remain bounded to 8 requests per intent and 20 per IP per 15 minutes. The locked worker creates one `mode=payment` card Session for one quantity of the exact Sidestream Pro Product/Price, sends account cancellations back to `account.html`, and preserves the confirmation page only for anonymous cancellations. The success callback re-fetches the literal `{CHECKOUT_SESSION_ID}` and verifies payment, line item, quantity, Price, Product, activation metadata, and attachment before fulfillment. Charged Sessions must resolve to their canonical PaymentIntent and Charge; a completed exact Session discounted to zero may legitimately omit both and fulfills only when `amount_total=0`, currency is valid, and Stripe reports `paid` or `no_payment_required`.

Canonical paid access requires `entitlement_status=active` on `sidestream_pro` or compatible `sidestream_unlimited`, but local lifecycle code is not live canonical Stripe proof. Partial refund remains `active/partial_refund`; full refund is `revoked/full_refund`; `refund.failed` can recover only from freshly retrieved canonical state and complete locked owner/Product/Price/Checkout/Customer/PaymentIntent/dispute/watermark proof. Historical rows with incomplete proof remain revoked. Four open inquiry/dispute statuses suspend; `warning_closed`, `prevented`, and `won` close and may reactivate unless a prior `lost` was persisted; `lost` stays irreversible. Recovery never revives old credentials. The Stripe-created-at plus event-ID watermark still prevents stale Checkout, refund, dispute, or subscription events from resurrecting a later state. Historical lifecycle repair, provider configuration, connected Preview/Test proof, and every other runbook gate still block Production. Legacy recurring access remains default-deny and requires an exact Product and Price in the two reviewed allowlists.

`POST /api/stripe/webhook` verifies the signature, durably records the event, and acknowledges it; it does not perform customer-state work inline. The insert first records immutable ingress identity/digests when those optional audit columns exist, then retries the same insert against only the recognized baseline column set when PostgreSQL reports that one of those optional columns is absent. Claims likewise avoid direct references to optional columns: migrated rows retain strict stored-digest validation, while baseline rows are checked against the signature-verified raw JSON before processing. Leased workers transition `received` to `processing`, then terminal `processed`/`ignored` or bounded `retryable`/`dead_letter`. Account/session/activation reads never drain this backlog. Required event subscriptions and queue operations live in `docs/api-hardening-runbook.md`.

Plugin activation rows are device-bound. `/api/activation/status` issues one deterministic, retry-safe credential family only after verified payment or an explicit restore. On the known pre-hardening Production schema, runtime catalog checks select the historical activation-bound fulfillment and device-hash credential behavior when Checkout-intent, entitlement-lifecycle, or account-device storage is absent; this compatibility path performs no DDL and automatically yields to the hardened path when those schema capabilities exist. Current clients may recover that family for 10 minutes after completion; legacy clients through 1.0.13 receive the same `active` response throughout the activation's 24-hour lifetime because they do not understand the terminal `completed` state. Current-client access tokens last seven days. Tokens whose database-linked activation records are from legacy clients through 1.0.13 receive a 365-day access lifetime and `/api/license/verify` rolls that expiry forward, because those clients cannot retain or rotate the paired refresh credential; this decision never trusts a spoofable request user agent. The paired opaque refresh token is hashed at rest, bound to the same device, rotates atomically through `/api/license/refresh`, and has a rolling 365-day expiry. A two-minute predecessor-hash window returns the same derived rotated pair after one lost response or concurrent retry without accepting the old credential indefinitely.

`/api/license/verify` and `/api/license/refresh` return 401 codes `invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`, and 403 `license_inactive`; callers retain credentials on transient 5xx failures. Restore uses `/api/activation/claim`: unauthenticated GET redirects through Google with an allowlisted next path, authenticated GET renders a no-store confirmation, and only an active-license, same-origin, CSRF-valid POST may CAS-bind a fresh activation whose account is still null or identical. An active Pro owner cannot start a second purchase: GET redirects an activation to claim/account, while confirmed POST returns `409 active_license` with account/restore routes. Do not store Stripe secrets, Google client secrets, raw payment data, activation keys, license tokens, refresh tokens, or permanent paid-state in browser code or logs.

### API data ownership and migration model

`api/_lib/postgres.ts` owns one attached pool for every runtime API feature. Production chooses a pooled URL in this order: `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, then `POSTGRES_PRISMA_URL`; direct/non-pooling fallback is forbidden in production runtime. `POSTGRES_POOL_MAX` defaults to 4 and is bounded 2-20, with bounded idle, connection, query, and statement timeouts. Reviewed migrations and backfills use `SIDESTREAM_POSTGRES_URL_NON_POOLING` or `POSTGRES_URL_NON_POOLING` outside the runtime.

`scripts/apply-postgres-migrations.mjs` owns an advisory-locked SHA-256 ledger in `public.sidestream_schema_migrations`. Database-backed `--status` is authoritative for every applied/pending filename in the complete chain and fails on a tracked ledger/local checksum mismatch, but its output does not print checksum values. `--validate` and `--dry-run` are strictly local file checks: both return before env-file loading or database selection and are not Production-state evidence. A future reviewed plan needs an authenticated status implementation plus a separate authenticated read-only export of local and ledger checksums. A non-empty legacy schema requires a verified explicit `--baseline`; `scripts/verify-migration-baseline.mjs` is only the narrower known-catalog/conditional-RLS guard and does not enumerate every later hardening migration. Applying commits each pending SQL file and ledger row together. Current database-backed runner/verifier modes are blocked against Production until they authenticate the server and selected endpoint. Runtime handlers never create or alter schema. The final migration removes the redundant unique `lead_key` constraint while preserving canonical `(email, cta_source)` uniqueness and a non-unique lookup index.

Key hardened environment/configuration ownership:

| Area | Contract |
| --- | --- |
| Cron | One stable `CRON_SECRET`, 16-512 printable non-space ASCII characters (`U+0021`-`U+007E`), protects Stripe process, lead replay, maintenance, and Customer 360 usage-sync routes; use a secret-manager-generated 64-character hexadecimal token |
| Pool | `POSTGRES_POOL_MAX` defaults to 4 (2-20); idle/connection/query/statement timeout variables are bounded and documented in the runbook |
| Limiter/lead | `SIDESTREAM_RATE_LIMIT_HASH_SECRET` and `SIDESTREAM_LEAD_HASH_SECRET` are stable server-only HMAC values of at least 32 characters; `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX` selects the private fallback prefix. Pro WAF is a per-region fixed-window counter. With exactly one shared rule/counter domain spanning every reachable host, the trailing boundary burst is approximately `2 * L * R` for regional limit `L` across reachable regions `R`, plus reconciliation risk. With `H` independent host/rule counter domains it grows to approximately `2 * L * R * H`. Require `H=1` with cross-host evidence, or measure/test/approve the larger bound; otherwise use a durable shared limiter. |
| Checkout intent | Confirmation is fixed at 10 minutes, intent at 24 hours; Product/Price selection uses `SIDESTREAM_PRO_PRODUCT_ID`, `SIDESTREAM_PRO_PRICE_ID`, and compatible `SIDESTREAM_UNLIMITED_PRICE_ID` |
| Stripe lifecycle | Normal claims and caught failures share an absolute attempt-8 cap. Expired final-attempt leases terminalize race-safely without increment or a ninth normal processor call. A separately approved exact-event isolated-Test recovery may bind one attempt-8 dead letter to one audited attempt 9; Production/livemode and bulk recovery are absent. Legacy recurring access requires exact comma-separated `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS`; local `refund.failed` and exhaustive dispute mapping do not replace historical repair or live provider/target proof. |
| License continuity | When `SIDESTREAM_LICENSE_HASH_SECRET` is absent, device hashing falls back to the first configured value from `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, or `POSTGRES_PRISMA_URL`; the runtime trims/selects and URL-normalizes that connection value first. A future reviewed plan needs a byte-preserving secret-continuity capability plus the same real device/token proof across any promotion. No such Production-safe capture/proof procedure currently exists. |
| Retention | `SIDESTREAM_MAINTENANCE_*`, session/credential/rate/intent grace variables, and Stripe processed/dead-letter payload retention variables are bounded before a query runs |
| Integration proof | `SIDESTREAM_TEST_POSTGRES_URL` is required, must be disposable, and is rejected if it matches any normalized runtime database target |

Exact defaults, bounds, required Stripe events, pool budget, and Production blockers live in `docs/api-hardening-runbook.md`.

### Single-device entitlement contract

The database model permits at most one active device row per account in each namespace, while runtime mismatch blocking depends on the policy mode below and is not yet cut over by default. Preview/development/test use a restricted, separate `test` namespace with exact Test hosts and `SIDESTREAM_TEST_POSTGRES_URL`; they are not an extra production seat and must not share a production host or database target. Same-device reconnect is free. A confirmed different-device move revokes the previous device and counts toward three moves per rolling 30 days; first activation and a same-device reconnect do not count. The database partial unique indexes remain the concurrency backstop.

`SIDESTREAM_DEVICE_POLICY_MODE` accepts `off`, `observe`, or `enforce` and defaults to `observe`. Observe mode records pseudonymous policy mismatches; enforce returns `transfer_required`, `transfer_limit_reached`, `device_replaced`, or `device_deactivated` as appropriate. Explicitly revoked/replaced credentials remain invalid in observe mode, and `/api/license/authorize-download` always requires the exact active binding. A newly accepted Pro download is authorized before it starts; if that accepted download is already in progress, a later transfer or deactivation does not cancel it mid-transfer, but future authorization/verify/refresh requests see the new state.

Only server-secret HMAC-SHA-256 device digests plus coarse platform/version/timestamps may be persisted. Raw hardware fingerprints, raw device IDs, serial numbers, and device names are prohibited from storage and logs. OS-backed non-exportable device keys are future hardening, not protection delivered by this implementation. See `docs/single-device-entitlements.md` only for the device schema, API/page states, environment matrix, privacy rules, and conceptual support decisions. The pinned Production device-schema operator is limited to exact verification of the already-applied additive schema; no general Production migration, device-policy cutover, or enforcement procedure is authorized. `docs/api-hardening-runbook.md` preserves the remaining blockers and future capability requirements.

The MacBook mockup media is a native autoplaying, muted, looping `<video>` that loads `mockups/mockup1_2.webm` from the canonical root HTML file. The generated VP9-alpha WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally. The mockup lives below the two pricing panels and the `.final` CTA inside `.pricing-mockup`, with the "Stop using sketchy websites to download music" panel now positioned above the laptop. It remains centered with a wide responsive video width and a soft bottom mask fade. It intentionally has no CSS drop shadow because filtering the alpha video can reveal a rectangular compositing edge during rotation. The bottom inline script keeps `.macbook-mockup-video` muted and calls `play()` on load/visibility return so the laptop continues spinning in normal browser viewing.

The feature cards are chrome-free video frames that use native muted, looping MP4s from `demos/`. The active demos are `search demo.mp4` and `preview demo.mp4`, both recorded around the Tudor Place workflow. The Search and Preview feature sections sit inside `.feature-glass`, a full-bleed dark translucent band with heavy `backdrop-filter` blur that separates the demo proof area from the continuous shader without changing the individual `.shot` card treatment. `.feature-corner-demo` mounts `demos/sidestream-panel-corner.webm` as a decorative VP9-alpha video inside the hero, starts at `40vw`, and uses `inset: 0 0 0 40vw` so the wrapper's bottom edge is the actual hero-to-feature boundary instead of a separate viewport-height estimate. The square full-plugin crop sits at `left: 5vw`, `top: 25vh`, `height: max(1000px, 90vw, 125%)`, `opacity: 0.9`, and `mix-blend-mode: screen`; the hero-height term keeps the recording running into that boundary on tall desktop viewports. Its `translate(-4.75%, -13.7%) scale(0.7)` transform uses the matching `4.75% 13.7%` transform origin so the visible Premiere panel's compensated top-left anchor stays at `45vw 25vh` as the desktop window changes size. The screen blend plus lowered opacity lets darker areas of the recording breathe into the shader without adding a fake background matte. The source is available at every breakpoint; at `900px` and below the hero switches to a vertical layout and reflows the same loop above the headline without horizontal overflow. The mobile wrapper is tall enough to expose the recording's Video/Audio download controls and applies an explicit WebKit-compatible alpha mask that stays opaque through `86%`, then fades smoothly through `91%` and `97%` alpha stops before becoming transparent at the bottom. This lengthens the soft transition beneath the controls instead of clipping or dimming them. At `520px` and below the video's responsive width drops exactly 10%, from `min(700px, 148vw)` to `min(630px, 133.2vw)`; its horizontal anchor is `70%`, its internal vertical translation stays at the safe `-8%`, and the entire clipping wrapper remains `24px` higher. This preserves the top edge and fade while reducing the phone-scale recording. The band spans the full feature wrapper vertically so the top and bottom separator lines have clear breathing room around the first and last demo videos. The Search and Preview feature copy blocks intentionally do not include inline download CTAs; each keeps the heading plus `.feature-subtext` as the centered copy block beside its demo video. They intentionally do not use the `autoplay` attribute; the bottom inline script uses `IntersectionObserver` to play each `.demo-video` only while it is visible and pause it when it leaves the viewport. On fine-pointer hover, the same script tilts the parent `.shot` from its midpoint with CSS variables capped at 15 degrees on X/Y and a tiny Z-axis twist, so the video frame reads as one subtle 3D plane. The hover math tracks against the card's untransformed layout box and resets with an S-curve transition to prevent corner-entry jitter. Raw Screen Studio project folders, ProRes `.mov` renders, and Premiere/After Effects project files should stay out of git; export compact MP4s or alpha WebMs for the site instead.

At `520px` and below, the final phone override supersedes the earlier crop values with a compact `clamp(260px, 32vh, 300px)` wrapper, a `min(590px, 124vw)` video, a `60px` wrapper lift, and a `-10%` internal vertical translation. That extra internal lift places the Premiere window's black top border above the clipping boundary instead of leaving it aligned with the first visible row. Its WebKit-compatible mask fades in across the top `8%` before retaining the existing lower fade. The headline and inline mobile handoff rise `88px` over the recording's dark lower fade, while `48px` bottom padding keeps the full email card visible at `390x844` with no horizontal overflow.

The page background should preserve the provided Paper demo's shader direction without keeping its demo-site UI. The canonical HTML keeps a black CSS fallback on `body`; `#shader-background-root` is a fixed full-viewport mount, and `src/main.tsx` renders the adapted `DemoOne` component from `components/ui/demo.tsx`. The demo's default `activeEffect` is `"mesh"`, so the visible background keeps the original simple black/charcoal/gray `MeshGradient` branch with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`. The active mesh branch is the plain Paper `MeshGradient`; it must not listen to pointer movement, add wake/ripple uniforms, jiggle the canvas, or layer extra mouse-driven overlays. Keep the background to the single Paper shader canvas with no drawn ripple outlines, extra canvases, new colors, CSS filters, or red fog. Page text tokens use the off-white `#E2E8F0` and translucent off-white variants for contrast, while cards and pricing surfaces are dark translucent glass.

The fixed shader mount uses its inset box instead of an explicit `100vh`, and `DemoOne` fills that mount with `h-full` rather than introducing a second `h-screen` height. The matching `#1b1b1b` theme color avoids a hard black Safari chrome band when the mobile browser viewport expands or collapses.

The header is a fixed transparent overlay with no scroll divider so the shader remains uninterrupted behind the nav. The `.hero-pad` section fills the first viewport and aligns the hero headline, subline, and primary `Download for Mac` CTA to the lower-left first-fold gutter. The Sidestream wordmark and hero copy share the viewport-left `24px` first-fold gutter, and the Features/Account navigation cluster is absolutely anchored to the viewport's top-right corner with a `15px` top offset and matching `24px` right gutter. Each desktop nav link uses a compact rounded glass frame with a white-fill hover state so it stays legible as the shader moves without competing with the larger download pills. The header intentionally has no Pricing or download CTA; pricing remains available in the page body, and downloads remain available in the hero, pricing, and final CTA sections.

On desktop, `.feature-start` keeps the Search demo group below the hero with positive top padding, creating a clear margin between the hero download buttons and the "Search for YouTube videos." heading without changing the shared lower-page `.sec-pad` rhythm.

The pricing headline intentionally sits halfway between the bottom of the `.feature-glass` band and the pricing cards: `#pricing` overrides the shared section top padding to `92px`, while `.pricing-head` uses a matching `92px` bottom margin so the cards stay in place. The mobile override uses a matching `74px` top padding and bottom margin. `.pricing-line` keeps "Unlock when you need more." on its own lighter-weight line. The two pricing cards use a larger `28px` corner radius and a pricing-only `IntersectionObserver` that adds `html.pricing-motion-ready` plus `.is-visible` so the cards glide up once before they fully enter the viewport; no global `.reveal` behavior is restored. The $0 card is labeled "Free" and says "5 free downloads every day." The Pro plan is a visible `$9.99 once` one-time upgrade that opens `/api/checkout/start`; no account is required to review and submit the purchase confirmation.

The hero rotating-word effect is also static-page native: `.rotating-copy` provides the stable text slot, `.rotating-word` animates the current noun, and the bottom inline script cycles `[data-rotating-word]` per `.rotating-copy` group. Incoming and outgoing words use paired, monotonic `translate3d` keyframes on the compositor path so the text stays smooth without bounce or transition/keyframe handoff. The active noun also uses a clipped red/white text gradient that drifts by animating `background-position` only. Do not add React or animation dependencies for this effect.

## Development Commands

Install dependencies once:

```bash
npm install
```

Run the local Vite server:

```bash
npm run dev
```

Then open:

```text
http://localhost:5173/
```

Use Vite, not `python -m http.server`, when checking the landing page background. The static server can serve the HTML and videos, but it does not compile `/src/main.tsx`, so the Paper shader mount stays black.

To test the Vercel Function route locally, use the Vercel dev server instead of plain Vite:

```bash
npx vercel@latest dev --listen 127.0.0.1:3000
```

Then check:

```bash
curl -I http://127.0.0.1:3000/api/download
curl -i http://127.0.0.1:3000/api/download
curl -I 'http://127.0.0.1:3000/api/download?platform=win32-x64'
curl -i 'http://127.0.0.1:3000/api/releases/latest?channel=stable&platform=win32-x64&version=1.0.12'
curl -i -X POST http://127.0.0.1:3000/api/download-lead \
  -H 'Content-Type: application/json' \
  --data '{"email":"test@example.com","page":"/","source":"/api/download"}'
curl -i -X POST http://127.0.0.1:3000/api/resolve-waitlist \
  -H 'Content-Type: application/json' \
  --data '{"email":"resolve@example.com","page":"/"}'
```

If Vercel Blob OIDC is disabled for the Development environment, local `/api/download` and `/api/resolve-waitlist` return Blob auth/config errors even though Preview and Production have Blob env attached. Fix that in the Vercel Blob store settings, or add a valid `BLOB_READ_WRITE_TOKEN` for local development. `/api/download-lead` prefers Postgres when `POSTGRES_URL` or a supported `SIDESTREAM_POSTGRES_*` connection string is available and only needs Blob auth for the fallback path; `/api/resolve-waitlist` is intentionally Blob-only.

`leads:migrate` is a legacy command name for the protected HTTP replay client; it
does not connect to Postgres or apply schema. Use it only against a loopback local
development server with a local `CRON_SECRET`, preserving Blob records by default:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_DOWNLOAD_LEADS_REPLAY_URL='http://127.0.0.1:3000/api/internal/download-leads/replay' \
  CRON_SECRET='<local printable non-space test secret of at least 16 characters>' \
  npm run leads:migrate -- --preserve
```

The client paginates the replay route and accepts `--delete-after-commit` only as
an explicit disposition request to the server-owned ETag/commit protocol. It
rejects `--apply-schema`; apply schema exclusively through the checksummed
migration runner after the canonical runbook's Production transport/tooling
blockers are closed. Do not aim this README example at Production, deployed Test,
or a public endpoint.

Validate local migration ordering/checksums and list the local chain without any
environment file or database connection:

```bash
npm run db:migrate -- --validate
npm run db:migrate -- --dry-run
```

Those modes return before env-file loading and database selection. For local
development only, database-backed status/apply may target a disposable loopback
Postgres through a single clean selector:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_POSTGRES_URL_NON_POOLING='<loopback disposable Postgres URL>' \
  npm run db:migrate -- --status
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_POSTGRES_URL_NON_POOLING='<loopback disposable Postgres URL>' \
  npm run db:migrate
```

The runner takes a global advisory lock, verifies ledger SHA-256 values, and
commits each migration plus its ledger row atomically. Never point these examples
at Production or deployed Test. Current Production `--status`, `--baseline`,
apply, and baseline verification remain blocked because their remote clients do
not authenticate the server certificate/hostname and can inherit unsafe target
selectors. `docs/api-hardening-runbook.md` records the missing capabilities but
is not an executable Production procedure; local `--validate`/`--dry-run` do not
close that blocker or prove Production state.

The exact additive Checkout-intent and device schemas are the only Production
exceptions recorded here. Their applications completed on 2026-07-22 and
2026-07-21 respectively; rerun only the read-only live verifiers to confirm the
pinned migration contracts and connected target:

```bash
node scripts/apply-production-checkout-schema.mjs --verify
node scripts/apply-production-device-schema.mjs --verify
```

Passing results prove the required shape of `public.sidestream_checkout_intents`,
`public.sidestream_account_devices`, and `public.sidestream_device_transfers`;
both live read-only verifiers pass against target fingerprint
`1c9e04dba0f2439c`. They do not authorize another apply, the general migration
runner, an application deployment, a Production alias change, or device-policy
enforcement. `sidestream_licenses.entitlement_status` and all Customer 360
schema remain unapplied and outside this Checkout repair.

Exercise the installer-campaign report only against a loopback disposable/local
database after its schema is applied:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_POSTGRES_URL='<loopback disposable Postgres URL>' \
  npm run analytics:installer -- --campaign windows_beta_1_0_13
```

The report's `requests` value means successful installer redirect requests, not completed downloads, installs, or first opens. `unique_daily_likely_human_requests` is a privacy-limited daily HMAC estimate and is not a count of identified people.
Do not use this script against Production: its current remote TLS client sets
`rejectUnauthorized:false` and does not provide authenticated connected-target
evidence. A separately owned tooling fix is required before a Production campaign
report is available.

Report first-party ManyChat landing referrals from private Vercel Blob credentials without exposing anonymous request hashes:

```bash
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source manychat --days 7
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source instagram-bio --days 7
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source instagram-alex --days 7
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source meta-ads-1 --days 7
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source reddit-1 --days 7
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source reddit-2 --days 7
```

`uniqueDailyLikelyHumanVisitors` is the sum of privacy-limited daily uniques in the selected window. It excludes likely scanners but does not prove an installer download, purchase, or activation.

The `20260707120000_enable_sidestream_server_table_rls.sql` migration is required for Neon-hosted copies of the Sidestream SaaS tables. It enables RLS for leads, accounts, sessions, activation rows, license rows, license-token hashes, Stripe event payloads, and billing resource rows, and conditionally revokes legacy Data API roles when they exist. Smoke-test the Vercel API routes after applying it because the app uses the server-only Neon Postgres connection and has no browser-side database client.

A protected runtime fingerprint on 2026-07-14 found that the canonical 41-row Windows waitlist database still had RLS disabled on the older `sidestream_download_leads` table. That is pre-existing schema drift and needs a separate, fully smoke-tested hardening pass. The new `sidestream_installer_requests` migration enables its own RLS and revokes `PUBLIC`, `anon`, and `authenticated` access independently, so do not weaken the new table while resolving the older one.

Inspect single-device operator commands before targeting a database:

```bash
npm run devices:audit -- --help
npm run devices:manage -- --help
```

`devices:audit` is read-only unless `--apply` is explicit, and
`devices:manage view` is always read-only, but neither is currently authorized for
Production: both can inherit unsafe target selectors and disable remote
certificate verification. The help invocations above are non-Production command
discovery only. Backfill, view, clear, and override remain blocked until the
code-owned authenticated-tooling prerequisite in `docs/api-hardening-runbook.md`
is implemented and reviewed. The API hardening runbook records that blocker but
authorizes no Production operation.

Create or verify the sandbox-only `FREEDEV` Stripe promotion code for no-cost checkout testing:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_ENV_FILE=.env.local npm run billing:ensure-freedev
```

If Vercel protects the Stripe secret from local pulls, put the sandbox `STRIPE_SECRET_KEY` in a separate ignored env file and run:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_STRIPE_ENV_FILE=/path/to/stripe-sandbox.env npm run billing:ensure-freedev
```

Exercise the lead dump only against a loopback disposable/local database:

```bash
env -i PATH="$PATH" HOME="$HOME" \
  SIDESTREAM_POSTGRES_URL='<loopback disposable Postgres URL>' \
  npm run leads:dump
```

Do not use the current dump script against Production. Its remote TLS client sets
`rejectUnauthorized:false`, so an empty process environment alone does not
authenticate the server or hostname. Production export remains blocked until a
separately owned authenticated reporting/export tool exists.

Build before publishing or after shader, TypeScript, Tailwind, static HTML, layout, or Vite config changes:

```bash
npm run build
```

Run the focused entitlement security suite after activation, checkout, webhook, restore, or license-token changes:

```bash
npm run test:entitlement
node --experimental-strip-types --test tests/stripe-event-claim-cap.test.mjs
node --experimental-strip-types --test tests/stripe-events.test.mjs
```

Run the aggregate single-device proof after account-device schema, environment, activation, transfer, verify/refresh, download authorization, deactivation, tooling, or account-page changes:

```bash
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:single-device
npm run typecheck
```

The aggregate applies the full migration chain to a random schema in a disposable Postgres database, blocks external Stripe/Vercel access, and drops the schema in cleanup. It rejects a database target matching any configured runtime Postgres URL. Never point `SIDESTREAM_TEST_POSTGRES_URL` at production or a deployed Test database for this command.

Run the complete hardened API contract and disposable-Postgres concurrency proof before release:

```bash
npm run test:api
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:postgres-integration
npm run typecheck
npm run build
node scripts/assert-no-runtime-ddl.mjs
node scripts/validate-vercel-contract.mjs
```

Run the complete Customer 360 contract with only a disposable
`SIDESTREAM_TEST_POSTGRES_URL` selected:

```bash
npm run test:customer-360
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres
```

The non-Postgres aggregate includes fixture-backed coverage for both Preview
environment and deployment verifiers; it uses temporary `.invalid` snapshots
and mocked requests, so it does not contact Vercel or any other provider. It also
includes the no-write retention inventory and telemetry TLS option/refusal suites;
the same explicit non-Postgres registry makes `npm run test:api` execute them.
The Postgres aggregate covers identity/merge, currency-partitioned commerce,
once-daily telemetry sync and rolling-window decay, protected list/detail reads,
dry-run backfill recovery, cross-namespace isolation, single-device separation,
and end-to-end replay. It scrubs ambient runtime database selectors and blocks
all network destinations except the approved disposable Postgres endpoint.

For the human-gated Customer 360 Preview/Test matrix, first compare restricted
environment snapshots offline, then verify only the separately approved
immutable Preview host. Keep secrets in the process environment, never in argv:

```bash
npm run verify:customer-360-preview-environment -- \
  --preview-env-file /absolute/restricted/path/preview.env \
  --production-env-file /absolute/restricted/path/production.env
SIDESTREAM_CRM_ADMIN_SECRET='<approved Preview secret>' \
  npm run verify:customer-360-preview-deployment -- \
  --origin https://<immutable-preview-host> \
  --expected-deployment-host <immutable-preview-host>
```

The environment preflight is offline and the default deployment verifier is
read-only. `docs/customer-360-preview-test-plan.md` owns their prerequisites,
the separately confirmed one-time Test usage-sync form, project-wide cron
prohibition, manual evidence, stop conditions, and non-Production rollback.

Generate a retention inventory only after a reviewer supplies a complete policy
for all eight domains. This is read-only in both namespaces and has no apply mode:

```bash
npm run customer-360:retention -- --dry-run \
  --namespace test --policy /absolute/restricted/path/reviewed-policy.json
```

Inspect a single Test dead letter without mutation with
`npm run stripe-events:recover-test -- --event-id evt_...`. Any apply requires
the separately reviewed exact confirmation contract in
`docs/api-hardening-runbook.md`, the unapplied recovery migration on a named
isolated Test database, and fresh human approval. Production recovery is absent.

`test:api` discovers every `tests/*.test.mjs` suite and fails if a Postgres suite is not explicitly classified. `test:postgres-integration` never silently skips: it requires `SIDESTREAM_TEST_POSTGRES_URL`, rejects a normalized host/port/database match with any runtime URL even when credentials/query options differ, runs serially in a random schema, and drops that schema in `finally`. After a human runs `npx vercel@latest build`, run `npm run verify:vercel-build` to inspect `.vercel/output`; that verifier deliberately fails when no Vercel build artifact exists.

The build copies the valid undated sitemap template, then `scripts/generate-sitemap.mjs` writes `dist/sitemap.xml` with an ISO `<lastmod>` derived from `index.html`. A clean Git checkout uses the latest commit that changed the page; a dirty local page uses its filesystem modification time. If Git history is unavailable, the build omits `<lastmod>` instead of inventing a build-time date. Do not put a manual `<lastmod>` back into `public/sitemap.xml`.

## Git / Publishing

This folder is a git repository for `git@github.com:alexgmov/Sidestream-Website.git`.

Relevant tracked files are the canonical root HTML page, legacy static redirect, React shader entry/component files, Vite/Tailwind/shadcn config, README, `.thumbnail`, generated WebM/MP4 demo assets, and reference screenshots. Finder `.DS_Store`, `node_modules/`, `dist/`, raw demo source renders, Premiere/After Effects project files, and local auto-save/download folders are ignored.

The generated MacBook mockup video in `mockups/mockup1_2.webm` is tracked. Raw mockup production files in `mockups/` are intentionally ignored because they can be hundreds of megabytes.

The project is linked to Vercel project `alex-3685s-projects/sidestream`. `.vercel/`, `.env.local`, and other `.env*` files are ignored. Publish Mac metadata with `npm run release:publish-manifest -- --platform macos --version <x.y.z> --artifact <local dmg> --pathname sidestream/<x.y.z>/Sidestream-<x.y.z>-Mac-Installer.dmg --signed --verified --uploaded --smoke-tested`. Publish an intentionally unsigned Windows beta with `--platform win32-x64`, an EXE/pathname, and `--unsigned-beta-approved --verified --uploaded --smoke-tested`; never lie by passing `--signed` for an unsigned build. Deploy after publication. Keep bare `/api/download` on the native/base Mac DMG and keep `.vercelignore` aligned with tracked publishable media so Vercel CLI deploys do not upload raw local `demos/` and `mockups/` production assets.

`vercel.json` deliberately pins `installCommand`, `buildCommand`, and `devCommand` to npm. The dev command must pass Vercel's `$PORT` into Vite; otherwise `vercel dev` can accept connections on its proxy port and hang. If the Vercel dashboard still has an old package-manager preference, the repo config should win. Vercel's host-based `has` matching works after deployment but not in `vercel dev`, so use a preview/production deployment plus `curl -I` to prove the `www` redirects and the non-API `sidestream-xi.vercel.app` redirects. The old host intentionally continues to serve `/api/*` in place because installed Sidestream 1.0.12 panels POST to that origin and do not follow Vercel's `308` response.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and check that the first fold intentionally places the hero copy lower than the older `Sidestream front end 2/screenshots/01-scan.png` reference.
- Run `npm run test:api` after any API, shared helper, migration, cron, or handler-contract change. Run `npm run test:postgres-integration` with a disposable `SIDESTREAM_TEST_POSTGRES_URL` after any database/concurrency change; it must never target production or a deployed Test database.
- After changing the hero CTA system or mobile handoff, run the focused `tests/download-leads.test.mjs` suite, then verify at a realistic phone width that the inline form replaces the desktop CTA row, invalid email stays local, success is announced, and lower download CTAs scroll back to the form. At desktop width, confirm the form is hidden, both direct platform downloads remain unchanged, and the Resolve waitlist opens, validates, submits to `/api/resolve-waitlist`, and reports success without starting a download. Route coverage must prove the fixed source, deterministic private-Blob pathname, hashed rate limit, `429`, and fail-closed `503` behavior.
- Run `node scripts/assert-no-runtime-ddl.mjs` and `node scripts/validate-vercel-contract.mjs` after API/migration/routing work. For a human Vercel build, follow `npx vercel@latest build` with `npm run verify:vercel-build`.
- Run `TZ=America/Los_Angeles node --experimental-strip-types --test tests/customer-360/core.test.mjs` after Customer 360 identity or profile-merge changes, then run `node --experimental-strip-types --test tests/customer-360/core-postgres.test.mjs` for the database total-order contract.
- Run `node --experimental-strip-types --test tests/customer-360/commerce.test.mjs` after commerce normalization changes, then run `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' node --experimental-strip-types --test tests/customer-360/commerce-postgres.test.mjs` after payment-group, identity-link trigger, allocation-edge, or totals changes. The Postgres suite proves partial capture authority, Checkout-only and paid-Invoice fallback replacement, paid InvoicePayment overlap deduplication with an unrelated-Checkout negative control, fully and partially off-Stripe totals, verified fallback dates, modern paid/open InvoicePayment shapes, many-to-many allocations, refund-first late attachment, product scope, and whole-group quarantine.
- Run `npm run test:customer-360`, then `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres`, after any Customer 360 contract, identity, commerce, usage, query, migration, or backfill change. Confirm the harness rejects runtime/telemetry endpoint collisions, protected list/detail fields match `docs/customer-360.md`, dry-run makes no connection or checkpoint write, and the complete pipeline leaves entitlement/single-device state unchanged.
- Execute `docs/customer-360-preview-test-plan.md` only against a human-approved isolated non-Production target. Record Pass/Fail/Blocked plus exact UTC timestamps; local tests and the secret-safe environment/deployment verifiers do not replace provider, database, artifact, FlowState, rollback, or manual evidence.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- Run `npm run test:download-referral` after changing installer attribution or `/api/download`. It verifies that tagged `GET`s are recorded only after a successful redirect, while `HEAD`, `304`, bad platforms, fulfillment errors, database errors, and database timeouts cannot create a false successful event or block delivery.
- Run `npm run test:referral-visits` after changing `/m`, `/ig`, `/meta/1`, `/reddit/1`, `/reddit/2`, `/api/referral-visit`, or the private-Blob attribution helper. It verifies the source allowlist, short routes, daily deduplication, privacy boundary, storage path, and scanner heuristic.
- After SEO/GEO metadata changes, run `npm run build`, confirm `dist/robots.txt`, `dist/sitemap.xml`, `dist/llms.txt`, and `dist/sidestream-social-card-v2.jpg` exist, validate both source and built sitemap XML, confirm the built sitemap contains a generated ISO `<lastmod>` while the source contains only the generator marker, and spot-check the built HTML for the absolute canonical URL, meta description, Open Graph/Twitter image tags, and valid JSON-LD. When replacing a social card, publish it under a new filename because X and other crawlers may retain the old image URL in cache.
- Run `npx vercel@latest build` after routing/header changes. Inspect `.vercel/output/config.json`, then verify a deployed response: `www`, the old-host root/non-API paths, `/index.html`, and `/Sidestream%20front%20end%202/Sidestream.html` must return `308` with `Location: https://sidestream.tv/`; old-host `/api/activation/start` must execute instead of redirecting; `/api/auth/session`, `HEAD /api/download`, `/account.html`, `/thank-you.html`, and `/upgrade.html` must return `X-Robots-Tag: noindex, nofollow`. Do not issue `GET /api/download` just to test headers.
- After publishing analytics changes, visit the deployed site without a content blocker and allow roughly 30 seconds before checking the Vercel Analytics dashboard for page-view data.
- Confirm the dark Paper shader renders behind the header, hero, cards, pricing, footer, and toast.
- Confirm the Sidestream wordmark and desktop hero copy share the viewport-left `24px` first-fold gutter, and the Features/Account header cluster sits at the viewport's top-right with a `15px` top offset and `24px` right gutter. Confirm each link has its own compact rounded glass frame, turns white with black text on hover, shows a visible keyboard focus ring, and does not introduce a Pricing or download header CTA.
- Confirm the brand wordmark, white pill-rounded download CTAs with the black Apple platform mark, black text, red hover fill/white hover text, check icons, and rotating noun gradient use the red accent palette without leftover orange accents.
- Confirm the background uses the pasted demo's black/charcoal/gray `MeshGradient` branch with the 20%-darker `#151515`, `#292929`, and `#a3a3a3` non-black stops, with no custom red CSS fog, extra overlay gradients, or mounted `EnergyRing`.
- Confirm moving the mouse across the desktop hero does not change the background. The backdrop should remain the plain Paper `MeshGradient` with one visible canvas, no wake/ripple artifacts, no whole-background jiggle, and no CTA hit-target interference.
- Confirm the final CTA panel stays clean above the pricing MacBook mockup and does not render the old top-right red radial glow.
- Confirm the pricing MacBook Pro mockup video autoplays, loops, stays muted, sits centered below the two pricing panels plus final CTA, and does not create horizontal overflow. If browser autoplay is fussy, confirm the inline `.macbook-mockup-video` playback helper kicks it after load or visibility return.
- Confirm the desktop hero copy still uses the wider left-anchored first-fold shell while staying aligned with the fixed Sidestream wordmark, sitting near the bottom-left corner of the first viewport, and rendering the "in Premiere Pro" subline in italic.
- Confirm both desktop hero platform links use the visible label `Download`, matching white pills, and their respective Apple and Windows marks; expose explicit platform-specific accessible names, start the correct installers without opening either historical modal, and retain the shared red hover treatment. At `900px` and below, confirm those links are replaced by the mobile email handoff instead of stacked installer buttons.
- Watch the pricing MacBook rotation long enough to confirm the laptop stays centered and the alpha edges are not clipped by the pricing wrapper.
- Confirm the Search demo group starts below the first fold with a deliberate gap between the hero download CTAs and the "Search for YouTube videos." heading on desktop and mobile.
- Confirm the "Start free. Unlock when you need more." headline sits centered in the vertical space between the bottom of the `.feature-glass` band and the pricing cards.
- Confirm "Unlock when you need more." renders as the lighter-weight `.pricing-line`, while "Start free." stays heavier.
- Scroll down to pricing and confirm both pricing cards begin animating before the section feels empty, with the Pro card following the Free card by a slight stagger, both cards using visibly rounder 28px corners, and the Pro card using a white outline with no drop shadow.
- Confirm the Free card says "5 free downloads every day."
- Confirm the Pro card says `$9.99 once`, links to `/api/checkout/start`, renders the signed no-store purchase confirmation without a Stripe write, and does not route users through the old Google-first upgrade interstitial.
- Confirm the feature demo videos are paused before they enter the viewport, start playing when scrolled into view, and pause again after leaving view.
- Confirm accessibility audits do not report prohibited ARIA attributes: named `.shot` and `.pricing-mockup` visuals use `role="img"`, and the named Pro plan card uses `role="group"`.
- Confirm the Search and Preview feature sections have no inline download buttons, while the heading and subtext blocks stay vertically centered beside their demo videos on desktop and mobile.
- Confirm the `.feature-glass` backdrop spans the full x-axis behind the Search and Preview demo sections, blurs/darkens the shader behind it, and stays in its normal post-hero position.
- Confirm the decorative `.feature-corner-demo-video` keeps the visible Premiere panel's compensated top-left anchor within `1px` of `45vw 25vh` at multiple desktop window sizes, reaches the hero-to-feature boundary without an empty strip at tall ratios such as `1892x1990`, is clipped at that section boundary, and keeps `.feature-glass` unmoved. At `900px` and below, confirm the same video uses the smaller lifted and right-biased crop above the hero headline, starts its soft fade low in the wrapper, plays inline without controls, and creates no horizontal overflow.
- At `520px` and below, confirm the compact recording ends in its lower fade above the headline, its clipped top boundary has no black line, the full mobile handoff remains visible at `390x844`, the shader has no horizontal viewport seam, and desktop geometry remains unchanged at `1440x900`.
- Confirm the top and bottom `.feature-glass` separator lines leave enough vertical breathing room around the first Search demo video and last Preview demo video.
- Confirm hovering each feature demo video tilts the frame subtly from its center, with the top-right pointer position pushing the top-right corner away from the camera, no top-left corner-entry jitter, a smooth S-curve reset on exit, and no hover tilt on reduced-motion or coarse-pointer devices.
- Confirm bare `/api/download` responds to `HEAD` with the current Mac attachment and `/api/releases/latest` returns the matching Mac manifest. Confirm `?platform=win32-x64` returns the Windows EXE/manifest, both Windows manifest links point at the platform route for v1.0.12 compatibility, and an unknown platform returns `404`. Confirm `GET` returns a temporary redirect to a signed private Blob URL; when testing the deployed route, use a ranged follow such as `curl -L -r 0-0` to avoid downloading the full installer.
- Confirm a tagged Gmail Windows `GET` using `utm_campaign=windows_beta_1_0_13` and a real `utm_content` batch creates one referral row after redirect, while the equivalent `HEAD` creates none. Use a separate smoke-test campaign or remove the exact smoke row afterward so verification does not inflate launch reporting.
- Confirm Mac and Windows download CTA clicks start their platform-specific public installers immediately without opening either historical email modal.
- In a disposable/local database, confirm `npm run leads:dump` includes seeded historical Windows waitlist submissions with `cta_source` equal to `windows-waitlist`. Do not use the current unauthenticated-TLS dump client to inspect Production; that check waits for the runbook's authenticated export-tool prerequisite.
- With Vercel dev and account env configured, confirm anonymous `GET /api/checkout/start` renders confirmation and makes no Stripe write; signed anonymous forms and the authenticated account's direct `account_purchase` form are the only `/api/checkout/create` branches that create/reuse website Checkout. Confirm the account form returns one `303` straight to hosted Stripe and cancellation returns to `/account.html` without either confirmation page. Separately confirm an activation-bearing GET from a shipped panel directly creates or resumes exactly one idempotent attached Stripe Session. Confirm successful Checkout passes through `/api/checkout/complete` to `/thank-you.html`, activation status returns active credentials on both the pre-hardening and fully migrated disposable schemas, anonymous cancellations resume/rotate intentionally, receipt and Customer Portal work, the webhook only records/queues signed Stripe events, and account/session reads never process queue backlog.
- On the signed-in desktop account page, confirm a Free account's Upgrade button posts directly to Checkout, disables as `Opening Stripe...`, and reaches hosted Stripe without rendering `upgrade.html` or `/api/checkout/start`; confirm every row action shares the panel's right edge, including wrapped receipt and refund controls. Below `680px`, confirm the controls remain full-width.
- From a signed-out browser, confirm the landing-page Account link and a direct `/account.html` visit enter Google OAuth without rendering the account headline or an empty sign-in panel. Confirm Google's `redirect_uri` is exactly `https://sidestream.tv/api/auth/google/callback`, stale or mismatched OAuth state renders the flat retry page instead of raw JSON, and a real Google round trip returns to the signed-in account page. From a browser with a valid `sidestream_session` cookie, confirm the Account link skips Google and opens the account page. Confirm Sign out clears the session and returns to `/`, and confirm the account background is a flat near-black with no red gradient.
- Run `npm run test:entitlement`. Confirm `/api/activation/start` rejects a missing device ID and returns `activationKey`, 24-hour `expiresAt`, `upgradeUrl`, and `restoreUrl`; status rejects a wrong device, stays pending before payment, and returns one seven-day access token plus a rotating 365-day refresh token only after exact Stripe verification. Confirm a webhook-delayed paid Session self-reconciles, an unpaid Session never binds, a repeated current-client status call returns the same credential family only inside the 10-minute completion replay window, and status cannot mint after that window or activation expiry. Separately confirm legacy clients through 1.0.13 receive `active` throughout the unexpired activation window, their access expiry rolls forward on verify, and old-host Checkout without an activation redirects to the non-purchasing `activation_required` state before Stripe.
- Run `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:single-device`, then `npm run typecheck` and `npm run build`, for the complete account-device contract. The aggregate must prove production/Test namespace isolation, one-winner database races, observe/enforce behavior, same-device reconnect, three confirmed transfers per rolling 30 days, `device_replaced`/`device_deactivated` revocation, refresh replay, download authorization, read-only status, explicit deactivation, support overrides, legacy compatibility, and exact Checkout support-state preservation.
- Confirm Restore Purchase opens a sign-in/confirmation GET without binding, rejects cross-site or missing-CSRF POSTs, rejects Free accounts and attempts to overwrite another account, and binds only after the active signed-in owner submits the confirmation form. Repeating that confirmation for the same unexpired account/activation must remain idempotent after the activation becomes `restored`, `paid`, or `linked`; expired and cross-account claims must still fail closed. Confirm `/api/license/refresh` atomically revokes the predecessor, returns the same pair for a two-minute lost-response replay, and uses the documented 401/403 codes without clearing credentials on 5xx failures.
- Scrub or watch the pricing MacBook rotation long enough to confirm hard alpha edges and video-plane edges do not show as dark lines.
- Let the hero rotating noun run through a full cycle and confirm each word swap stays smooth without bounce, clipping, or layout shift.
- Confirm the rotating noun gradient stays subtle, remains readable on "songs" and "overlays", and pauses under reduced-motion settings.
- Scroll from the hero through pricing and footer to confirm the background reads as one continuous fixed shader field without horizontal seams.
- Confirm `#E2E8F0` off-white and translucent off-white text remains readable over the dark shader on desktop and mobile.
- Confirm the background canvases are nonblank on desktop and mobile and continue rendering after scroll.
- Check desktop at `1280x748`, because all supplied reference screenshots use that size.
- Check mobile around `390x844` for text wrapping, CTA sizing, and image-card overflow.

## Known Gotchas

- Customer 360 captured money authority is the PaymentIntent `amount_received`, or `amount_captured` on a standalone Charge when no PaymentIntent exists. A paid Checkout or Invoice is a fallback only while its related settled instrument is absent, and refresh must replace rather than add that fallback when stronger truth arrives. Before instrument arrival, suppress a Checkout fallback only when a paid Invoice fact in the same namespace, profile, and currency has a paid InvoicePayment edge resolving to that Checkout payment key; prefer the Invoice and leave unrelated Checkout fallbacks countable. Checkout authorization must never re-inflate a partial capture. Invoice `amount_paid` is full gross customer money; `amount_paid_off_stripe` is a nonnegative subset of gross, not a deduction or an amount to add twice. Paid InvoicePayment rows are allocation edges keyed by `invoice_payment.id`; open/canceled rows do not attribute money, and an invoice/instrument many-to-many graph must not become alias equivalence.
- Customer 360 identity safety is a payment-group invariant. If any retained alias, trusted identity evidence, or already-safe owner resolves one canonical payment group to different live profiles, the namespace advisory lock must clear `profile_id` and set `identity_conflict=true` on every materialization in that group before totals refresh. This whole-group quarantine is sticky across replay, later one-owner rows, and identity-link triggers; only an explicit group-wide recomputation after a deterministic profile merge may clear it. A Stripe customer link alone never scopes unrelated product money.
- Customer 360 database `created_at` values reach TypeScript as fixed-width six-microsecond UTC timestamps without a timezone suffix. Compare two canonical values lexically before `Date.parse`; parsing first treats them as local time, can reverse order across a DST gap, and violates the database trigger's `(created_at, id)` total-order contract. ISO inputs from pure callers still use parsed instant ordering, and equal timestamps still use the UUID tie-breaker.
- Customer 360 still has no deletion, anonymization, or aggregate-expiry job. The retention CLI is a fail-closed, read-only aggregate inventory for eight explicit domains, requires a complete policy, and rejects apply before access; it does not enforce the proposed actions. Daily usage buckets, canonical profiles/identity, and commerce materializations persist; merge and pending-review audits are immutable. Humans must approve every period/action and a dependency-aware mutation design before implementation. Stripe payload redaction and the 90-day installer-referral policy are separate domains.
- Customer 360 is not deployed and Production is not migrated. The repository contract allows only the human-gated Preview/Test-first sequence in `docs/customer-360.md`; no dry-run, local test, build, or documentation result is Production approval.
- Customer 360 local or fixture-backed FlowState consumers may implement the audited contract before website deployment, but live upstream Preview/Test integration and QA remain gated on separately approved migration, configuration, deployment, protected API, freshness, and scheduling evidence. Vercel cannot enable only the usage job; the Preview/Test matrix keeps project-wide cron disabled and permits only its separately confirmed, host-bound one-time verifier after all prior gates pass.
- The current Vercel Preview environment fails the Customer 360 isolation gate because its database, Stripe, Google, and base URL values match Production. Do not work around this with client namespace fields, a mutable alias, or shared credentials; a human must provision and approve an isolated target before the Preview/Test matrix can advance.
- The project root was missing a README before this restoration.
- The page uses the local Apple/SF Pro system font stack and does not request external web fonts.
- Several screenshot files are duplicates or alternate experiments. Prefer the numbered scan series for the restored hero state.
- The React layer is intentionally limited to the background mount. Do not migrate header, hero, pricing, or toast behavior into React unless the whole page is being intentionally rebuilt.
- `src/index.css` imports Tailwind theme/utilities and `tw-animate-css` only. Avoid full Tailwind preflight here because it can override the existing static HTML typography selectors.
- The active Paper background is adapted from the pasted `DemoOne` component. Do not add wrapper overlays, demo install text, clipboard controls, extra shader props, red fog, or alternate defaults unless the design intentionally changes.
- Background mouse interactivity is intentionally removed. Keep `components/ui/demo.tsx` on the plain Paper `MeshGradient`; do not reintroduce custom `ShaderMount` pointer uniforms, wake/ripple sampling, CSS blur/filter interaction, particle decoration, drawn outlines, whole-background translation, resting-cursor pull, or a second visible overlay.
- The current `@paper-design/shaders-react` types do not include the pasted `backgroundColor`, `wireframe`, `dotColor`, `orbitColor`, or `intensity` prop names. Keep `src/paper-shaders-compat.d.ts` so the copied component can remain unchanged.
- `components/ui/background-paper-shaders.tsx` is copied exactly from the reference and is excluded from app typechecking because the pasted `THREE.Mesh` generic is broader than this repo's strict TypeScript settings.
- Do not mount the optional React Three Fiber `ShaderPlane` or `EnergyRing` primitives in the active background unless the design intentionally calls for visible flares/rings.
- No Alphanica font asset exists in this folder. The hero headline uses the SF Pro system stack to match the cleaner non-serif section style without adding a font dependency. The "in Premiere Pro" `.hero-subline` intentionally uses the same stack in italic.
- Mac and Windows download CTAs use `[data-download]` and `[data-windows-download]` overrides that win over primary/secondary button classes: matching white capsule backgrounds, black platform marks and text, and red hover fills with white text while preserving existing sizing. The adjacent `[data-resolve-waitlist-open]` pill uses the same capsule/hover treatment but keeps the inline three-color Resolve mark and opens a modal instead of a download. Both installer buttons show `Download` with explicit platform-specific accessible labels; the pricing and final Mac CTAs retain `Free Download` with `aria-label="Free Download for Mac"`. The header intentionally has no download CTA. All visible Mac download CTAs should point at `https://sidestream.tv/api/download` unless the fulfillment host intentionally changes. Do not reintroduce the email modal as a blocking step for either installer without explicitly revisiting the unblocked installer strategy.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav. Keep `.nav-links` anchored from the full viewport rather than the centered first-fold shell, or the control cluster drifts inward on wider screens.
- The desktop Features/Account links use individual compact glass pills with a `10px` gap. Keep them visually quieter than the solid white download CTAs, retain the white-fill hover and focus treatment, and remember that the entire nav remains hidden at `900px` and below.
- Desktop hero-to-feature spacing is tuned with `.hero-pad` filling `100svh`, bottom-aligning content, and using `padding: 112px 0 clamp(72px, 9vh, 104px)`, plus `.feature-start { margin-top: 0; padding-top: clamp(96px, 12vh, 136px); }`. Keep `.feature-glass` in normal post-hero flow; if the right-side demo needs to fill more space, resize or reposition `.feature-corner-demo-video` instead of moving the frosted feature band. The mobile override uses `.hero-pad { padding: 128px 0 72px; }` and `.feature-start { padding-top: 84px; }`, with a narrower override of `64px`/`72px` at `520px`; that breakpoint also makes both hero platform CTAs full width. Adjust those first-feature entries before changing shared `.sec-pad` rhythm, but keep the Search copy grid-centered beside its demo video.
- `.feature-corner-demo` is a non-interactive decorative layer inside `#hero`. Its clipping wrapper uses the hero's actual bounds from `40vw` to the right edge; the video sits another `5vw` into that wrapper, placing its source-space anchor at `45vw`. The paired `translate(-4.75%, -13.7%)` and `transform-origin: 4.75% 13.7%` values compensate for the WebM's transparent padding before the `scale(0.7)` transform, locking the visible Premiere panel's compensated top-left anchor to `45vw 25vh`. Keep the video tall enough to intersect the wrapper's bottom so only the following feature section crops it; keep those percentages paired if the source crop changes, and do not add background fills or box-shadow mattes because the alpha WebM will reveal them.
- Pricing headline placement is tuned independently from shared `.sec-pad`: `#pricing { padding-top: 92px; }`, `.pricing-head { margin-bottom: 92px; }`, and the mobile override uses matching `74px` top and bottom spacing. `.pricing-line` is intentionally `font-weight: 300`. The Pro card links to `/api/checkout/start`; server checkout price truth comes from async `getSidestreamProPriceId()` in `api/_lib/account.ts`. It selects the configured/default Product, then checks the explicit Pro Price, currently empty code default, compatible Unlimited fallback, expanded Product `default_price`, exact `sidestream_pro_once_999` lookup key, and any other active matching Product Price before its create fallback. If the amount changes, update the helper constants, then update visible copy, JSON-LD, `llms.txt`, and README together. The pricing-card motion should stay scoped to `#pricing .plan.reveal`, use an early positive bottom `IntersectionObserver` margin, and avoid re-enabling global `.reveal` because it was previously disabled for environment fill-mode issues.
- Desktop first-fold horizontal placement is tuned with `--hero-shell-maxw: 1280px` and `--first-fold-gutter: 24px`. `#hero > .wrap` is left-anchored above `900px` so the hero copy shares the same viewport-left guide as the fixed Sidestream wordmark. The MacBook mockup is no longer part of the hero; it is centered below `.plans` and the `.final` CTA in `.pricing-mockup`.
- Feature heading sublines use `.feature-subtext` with the SF Pro system stack at a light weight; `.feat-copy > h2:last-child` removes the trailing heading margin when there is no CTA so the heading/subtext block stays centered beside the demo. Avoid restoring the old serif treatment unless the whole feature-heading direction changes.
- The large footer `.wordmark` intentionally uses a Helvetica-first bold stack instead of the global SF Pro stack.
- The rotating noun should stay on matched keyframe animations for both enter and exit. Mixing CSS transitions with keyed enter animations or adding overshoot makes the headline feel choppy.
- The rotating noun gradient should animate only `background-position` and color/filter values. Do not animate the word transform for the gradient drift or it will fight the roll keyframes.
- Text tokens are tuned for a dark shader background, with `--ink` and `--white` set to `#E2E8F0` and `--ink-soft`/`--ink-faint` using translucent `#E2E8F0`. If the page returns to a light background, retune `--ink`, `--ink-soft`, `--ink-faint`, surfaces, and button states together.
- If the MacBook mockup is resized, keep enough vertical room in `.pricing-mockup` and preserve the bottom mask on `.macbook-mockup-video`; a too-short wrapper, unmasked video edge, or video-level CSS drop shadow can create a hard line around or below the laptop.
- Keep `mockups/mockup1_2.webm` checked after background changes; dark backgrounds can make transparent alpha edges more visible if the `.macbook-mockup-video` mask or shadow is changed.
- Mobile split sections must override both `.split` and `.split.flip`; otherwise the more-specific desktop flipped grid can leave feature cards half-width on narrow screens.
- Feature demo cards use 1800 x 1080 MP4 exports and a chrome-free `.shot` frame with a `5 / 3` aspect ratio, matching the videos without crop. Keep future feature demos muted, looping, and compressed before committing.
- Feature demo playback and pointer tilt both live in the bottom inline script. Keep `.demo-video` elements without `autoplay`; otherwise they can start before the user scrolls to the feature cards. Keep the tilt on `.shot`, not `.demo-video`, so the border, shadow, and video plane move together. The tilt handler intentionally uses a stable layout rect instead of `getBoundingClientRect()` for live hover math because transformed hit boxes can cause corner-entry jitter.
- The final CTA uses the shared dark glass panel only and lives above the pricing MacBook mockup. Do not restore the old `.final::after` red radial glow unless the design intentionally calls for a decorative flare.
- Plain `npm run dev`/Vite does not run Vercel Functions. Use `npx vercel@latest dev` when testing `/api/download` or `/api/download-lead`.
- Vercel compiles TypeScript API routes individually to Node ESM with a narrower library/control-flow surface than the root client typecheck. Keep relative API imports extension-explicit, avoid `Array.prototype.at` in API code, and use explicit discriminant comparisons or property guards for result unions; otherwise local `npm run typecheck` can pass while the provider build rejects a function.
- Local account/billing testing requires Vercel dev plus local/test Postgres and Stripe configuration. `SIDESTREAM_LICENSE_HASH_SECRET` must be stable and server-only; when absent, device hashing falls back to the first configured runtime URL after selection and URL normalization. The repository has no byte-safe Production continuity launcher or canary procedure, so any URL/pool change remains blocked until a separately reviewed mechanism preserves those exact bytes and proves the same real device/token across promotion. `SIDESTREAM_PRO_PRODUCT_ID` defaults to `prod_UpwXh6oO1OmPyQ`; runtime Price discovery checks explicit Pro Price, the empty code default, compatible Unlimited fallback, Product `default_price`, exact `sidestream_pro_once_999` lookup key, then any other active matching Product Price. Runtime compatibility is not Production approval. Use placeholders for local Stripe testing and rotate any secret pasted into chat.
- Production now has the exact additive `20260713203000_add_checkout_intents.sql` schema for `public.sidestream_checkout_intents`, applied and read-only verified on 2026-07-22, plus the earlier `20260714190000_add_single_active_account_devices.sql` schema applied and verified on 2026-07-21. Production still lacks `sidestream_licenses.entitlement_status`; the entitlement-lifecycle column and all Customer 360 schema remain unapplied and outside this Checkout repair. The schema application itself changed only schema availability; the separately audited application artifact was then promoted through Vercel. Device-policy enforcement did not change. Customer-facing lifecycle reads must still use `LICENSE_ENTITLEMENT_STATUS_SQL`; a direct `l.entitlement_status` reference fails at PostgreSQL parse time before fallback logic can run. Do not replace the remaining gaps with runtime DDL, a manual table or column addition, or an unreviewed migration. The compatibility expression recognizes only exact attached one-time paid rows and the legacy credential path remains device-hash bound.
- The current Production application preserves the shipped-panel direct Upgrade chain: marked v1.0.14 claim GETs rewrite to activation-bearing Checkout, older unmarked Upgrade claims retain database classification, and Checkout validates and reuses the activation-bound idempotent Stripe Session. The visible claim/confirmation regression came from deploying a later referral-tracking worktree that omitted this direct-handoff lineage. Every future Production deploy must preserve both that Upgrade chain and the current ManyChat, Sidestream/Alex Instagram, Meta, and Reddit referral routes.
- Checkout redirects an already-active Pro owner with an activation back to `/api/activation/claim` for reconnect. The legacy unmarked v1.0.14 Upgrade classifier must therefore run only for signed-out or inactive sessions; redirecting an active owner back to Checkout creates an immediate `claim -> checkout -> claim` loop and Chrome reports `ERR_TOO_MANY_REDIRECTS`.
- License environment resolution fails closed unless deployment state, trusted host, and selected database agree. Production uses `SIDESTREAM_POSTGRES_URL`; preview/development/test require exact `SIDESTREAM_TEST_API_HOSTS` plus a distinct `SIDESTREAM_TEST_POSTGRES_URL`. Client `buildChannel` is diagnostic only and cannot select a namespace.
- The 2026-07-20 Production Upgrade recovery applied only the recognized legacy account/billing chain through `20260713180000_add_activation_checkout_and_refresh_rotation.sql` to the existing Neon database, recorded the eight baseline/applied migrations in `sidestream_schema_migrations`, and bound Production `SIDESTREAM_POSTGRES_URL` to that same pooled Neon target. Checkout-intent, entitlement-lifecycle, device-enforcement, and Customer 360 migrations were outside that recovery; the later 2026-07-21 repair applied only the exact additive device schema, and the 2026-07-22 repair applied only the exact Checkout-intent schema. Neither later repair enabled enforcement or applied the entitlement-lifecycle or Customer 360 schema. After the 2026-07-20 deployment, a public v1.0.14 activation returned `200` and its activation-bearing Upgrade request returned `303` to live Stripe Checkout; that historical observation is not proof that the current repair candidate or alias is deployed.
- The Postgres migration runner has a checksummed ledger and advisory lock. Database-backed `npm run db:migrate -- --status` is authoritative for complete applied/pending filenames and rejects ledger/local checksum drift, but it prints no checksum values. `--validate` and `--dry-run` are local-only and cannot prove a Production target or state. The general runner, baseline verifier, legacy audit/apply, device tools, campaign report, and lead dump currently permit remote TLS without authenticated certificate/hostname proof, so their Production use remains blocked until code-owned changes enforce clean selection, provider CA trust, verify-full-equivalent validation, and connected-target evidence. The narrow `scripts/apply-production-checkout-schema.mjs --verify` and `scripts/apply-production-device-schema.mjs --verify` results are authoritative only for their pinned schema contracts and target; they are not an authenticated general Production status/checksum procedure or a qualified runtime-distinct fallback.
- Current env-file ingestion is not a Production-safe launcher: the migration runner loads `SIDESTREAM_ENV_FILE` before `SIDESTREAM_DB_ENV_FILE`, Node env files can apply startup options before inline validation, and inherited selectors survive. A future pinned and integrity-attested launcher must validate raw bytes and exact keys before Node, reject NUL/unknown/duplicate/empty/malformed entries, start from an empty environment, and keep secrets out of argv. No current command surface closes this blocker.
- Migration `20260714200000_remove_redundant_download_lead_key_unique.sql` is not compatible with the pre-hardening `c34ef25` lead writer: that code uses `ON CONFLICT (lead_key)` after the required unique constraint has been removed, so an otherwise-valid capture that reaches Postgres fails and can enter Blob fallback without consuming the database limiter. No runtime-distinct, full-chain-qualified fallback artifact is recorded yet: `git diff --name-only c93bc09..HEAD` contains only these documentation files, so `c93bc09` is the same hardened runtime, not an application rollback. Production mutation is blocked until a different runtime artifact is built, preserved, and proved against the complete migration chain; never treat an arbitrary prior deployment or a docs-only commit difference as rollback-safe.
- Vercel Preview/Test remains the only Stripe test-mode lifecycle proof. No staged Production artifact, actual-runtime-selector attestation, signed qualification, or promotion proof exists. A future reviewed plan needs pinned provider tooling or an owner-authenticated API that proves exact immutable release/fallback identities, project/team, target, commit/build, aliases, protection, metadata, and actual selector overrides including explicit empty values.
- The current repository has no Production maintenance rule or operator bypass. A future reviewed plan needs a complete effective firewall/hostname/order export and a tested exact rule matrix; custom-rule bypasses skip later custom and managed WAF rules, and tagged download GETs can schedule referral writes. Until those controls exist, no Production firewall mutation or operator route invocation is authorized.
- Any future maintenance or fallback plan must keep the live Stripe event destination enabled, complete an exact pre-drain, and preserve its earliest boundary/timers. Every future main and fallback path must freeze a provisional historical scan after pre-drain but before boundary/deny activation, then consume its exact manifest/checksum/watermark in a post-deny full/delta reconciliation after old writes drain and before migration, promotion, fallback, or reopening. Queue terminality is not canonical-state proof. Live automatic retries last at most three days, Dashboard/Workbench resend at most 15 days, and Stripe CLI resend at most 30 days; events created while a destination is disabled do not auto-resend.
- Vercel cron scheduling is a project-wide disable/enable control for the four routes in `vercel.json`; the repo has no one-job toggle, per-job kill switch, approved operator bypass, or secret-safe launcher. That gap blocks Production operation until a separately reviewed control and invocation design exists.
- Switching a deployment from sandbox/test Stripe keys to live Stripe keys can leave existing account rows with customer IDs from the old mode. `findOrCreateStripeCustomer()` validates a saved customer against the currently configured Stripe mode before Checkout reuse and creates a fresh customer if Stripe returns `resource_missing`.
- Checkout Sessions currently pin `payment_method_types: ["card"]` so live Checkout works even before Stripe Dynamic Payment Methods are configured in the dashboard. Revisit this once the live Stripe account has the desired payment methods enabled.
- If a successful purchase still shows Free in the account page or plugin, check `/api/stripe/webhook`, `/api/checkout/complete`, activation logs, and Stripe queue evidence; current migration `--status` is loopback-disposable only, and Production requires the future reviewed authenticated status procedure. Runtime routes intentionally do not execute DDL, account/session reads do not drain the queue, and the status fallback cannot repair a missing migration, unattached Session, refund, dispute, or poisoned event.
- A 100% promotion can produce a completed Checkout Session with `payment_status=paid`, `amount_total=0`, and no PaymentIntent; `no_payment_required` is also valid for the same zero-total shape. Do not require a PaymentIntent for either status, and do not generalize the exception to a positive total, unpaid Session, invalid currency, wrong line item, Price, Product, metadata, attachment, or Customer. Production's baseline Stripe event table also lacks the optional Customer 360 `ingress_*` audit columns, so webhook ingestion and claim SQL must retain their explicit baseline-schema compatibility until that migration is separately reviewed and applied.
- Hosted Checkout only accepts promotion codes that already exist in the same Stripe account and mode as `STRIPE_SECRET_KEY`. The repo utility `npm run billing:ensure-freedev` creates or verifies the sandbox `FREEDEV` 100% off promotion code and refuses live keys unless `--allow-live` is passed intentionally. If Stripe Checkout says `FREEDEV` is invalid, first confirm the Checkout page is in sandbox mode, then run the utility with the same env file that powers that deployment. Vercel protected env pulls can return `STRIPE_SECRET_KEY=""`; in that case, use an ignored local env file through `SIDESTREAM_STRIPE_ENV_FILE`.
- Plain static servers such as `python -m http.server` do not compile `/src/main.tsx`, so the static HTML route can appear to lose the Paper shader background even though the markup is correct. Static servers also cannot serve local Vercel Functions; the visible download CTAs use the public Vercel download URL so static preview clicks still start the installer instead of hitting a local `/api/download` 404. Use Vite on the active preview port when visual-checking the background, and Vercel dev when testing the API routes themselves.
- Vercel Analytics depends on the compiled React entry in `src/main.tsx`. If analytics stops appearing, confirm the shader root still exists in the canonical HTML, the deployed bundle includes `@vercel/analytics/react`, the page was visited on the deployed Vercel URL, and content blockers are disabled for the check.
- Vercel CLI versions before the current `54.x` line can report stale Blob auth/token errors. Prefer `npx vercel@latest ...` for Blob store checks.
- `/api/download` uses the Blob SDK control-plane calls (`head`, `issueSignedToken`, `presignUrl`) and redirects on `GET`. Do not switch it back to SDK `get()` proxy streaming unless you have verified private object fetches in the deployed Vercel runtime; a broken `GET` can still look healthy if only `HEAD` is checked.
- Installer attribution deliberately measures successful signed-redirect requests, not completed Blob transfers. Email security scanners can issue `GET`; keep their rows and use `likely_scanner` as a transparent heuristic. Do not label request counts as downloads, installs, first opens, or active users.
- ManyChat and Instagram-bio attribution measure browser visits after the `/m` or `/ig` redirect, not upstream clicks that never load the page and not downstream downloads, installs, purchases, or activations. Same source/day/request identity converges to one private Blob record; use the scanner-separated aggregate report instead of counting raw objects as people.
- `SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET` is a stable server-only HMAC secret for privacy-limited daily request deduplication. Preserve it across database credential rotations, never expose it in browser or CEP code, and never store the raw request IP or user agent in `sidestream_installer_requests`.
- Keep per-request installer attribution only as long as launch analysis needs it. Preserve aggregate campaign totals if useful, then delete the request rows after 90 days so the anonymous HMACs do not become an indefinite behavioral history.
- Without `vercel.json`, `vercel dev` may inherit a Yarn command from the Vercel project settings and hang on machines without Yarn.
- Vercel's path redirect patterns do not match the bare `/` request. Keep the explicit host-conditioned `/` rules for `www.sidestream.tv` and `sidestream-xi.vercel.app` ahead of the path-preserving catchalls; keep the old-host path rule narrowed with `/:path((?!api/).*)` so static pages canonicalize while legacy CEP POST APIs execute without a `308`.
- The shipped v1.0.14 panel validates every `restoreUrl` as `/api/activation/claim`, even after an Upgrade click. Keep root `middleware.ts` scoped to that path and its query-conditioned `upgrade=1` rewrite to `/api/checkout/start` so new Upgrade clicks bypass the claim function and redundant Postgres classification without breaking that client validator. A `vercel.json` rewrite cannot replace this middleware because filesystem API functions take precedence. The marker is routing only, not authorization; Checkout still validates the activation capability and payment state. Claim URLs without the marker and every POST must continue to the claim function for already-saved activations and account actions.
- `.vercelignore` deliberately strips `.git` before Git-linked builds. The sitemap generator therefore resolves `index.html`'s most recent commit through Vercel's `VERCEL_GIT_*` metadata and GitHub's public commits API; it fails the build instead of publishing an invented date when that provenance lookup is unavailable.
- The private Blob store currently has OIDC/env wired for Preview and Production. Development has `BLOB_STORE_ID` and the installer pathname, but local Blob reads still need Development OIDC enabled in Vercel Blob settings or a `BLOB_READ_WRITE_TOKEN`.
- Check the Vercel Blob/CDN usage guardrails and live Pro usage before changing installer artifacts, `/api/download`, CTA/email-gate volume, or demo media. The current Mac artifact is about 216 MiB, so even usage-billed transfer can climb quickly during a real launch.
- Production, Preview, and Development should resolve the manifest artifact pathname to the uploaded native/base `sidestream/1.0.12/Sidestream-1.0.12-Mac-Installer.dmg` artifact. The `Mac-ZXP-Installer.dmg` path is the retired ZXP-helper handoff and should not be used for the public website download.
- The email gate is a website CTA gate, not hard security. A direct request to `/api/download` still serves the installer; true server-enforced lead capture would require issuing download tokens or moving `/api/download` behind a verified lead/session check.
- The Windows waitlist is historical: `cta_source = "windows-waitlist"` rows remain queryable, but its retired modal/capture code was replaced by the active DaVinci Resolve waitlist after the Windows hero pill became a direct platform download. Resolve submissions use the dedicated Blob-only `/api/resolve-waitlist`, not `/api/download-lead`; records live under `sidestream/resolve-waitlist/v1/fallback-v2/<shard>/<lead-hmac>.json`, pathnames contain no plaintext email, and repeated `(email, source)` submissions merge into the same private record. Do not point the generic fallback replay job at this durable waitlist prefix.
- Resolve waitlist capture requires `BLOB_READ_WRITE_TOKEN` or Vercel Blob OIDC plus `BLOB_STORE_ID`, `SIDESTREAM_LEAD_HASH_SECRET`, and `SIDESTREAM_RATE_LIMIT_HASH_SECRET` in Preview and Production. The route fails closed with `503` when rate limiting or storage is unavailable and logs only aggregate outcome/error codes, never the submitted email or raw request IP.
- Mobile download email delivery requires the server-only `RESEND_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `SIDESTREAM_LEAD_HASH_SECRET`, and `SIDESTREAM_RATE_LIMIT_HASH_SECRET` in Preview and Production. It defaults to `Sidestream <downloads@alexg.mov>` with replies sent to `alex@alexg.mov`; optional `SIDESTREAM_DOWNLOAD_EMAIL_FROM` and `SIDESTREAM_DOWNLOAD_EMAIL_REPLY_TO` overrides must not contain line breaks. The public route stores the lead in the existing deterministic private replay queue and consumes durable HMAC-keyed email/IP counters with Blob ETag compare-and-swap writes. It refuses to send when either private write fails, and the browser reuses one idempotency key across an uncertain retry so Resend cannot duplicate the same accepted request.
- Download-lead capture and SaaS entitlement storage share the bounded server-only pool in `api/_lib/postgres.ts`. Production precedence is `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, then `POSTGRES_PRISMA_URL`; direct/non-pooling fallback is rejected in production runtime and belongs only to reviewed tools/development/test. Do not expose any private database URL to HTML, React browser code, or the CEP plugin.
- `CRON_SECRET` is the one 16-512 character scheduler secret for all four internal routes, but the common denominator is stricter: every character must be printable non-space ASCII (`U+0021`-`U+007E`) because lead replay rejects spaces and non-ASCII even though the other routes compare the whole header. Generate a 64-character hexadecimal token from 32 random bytes in the approved secret manager. Missing configuration must produce `503`, wrong/missing bearer auth must produce `401`, and the value must never appear in commands captured by logs or in committed files.
- Checkout and lead rate limits are atomic Postgres controls, not a substitute for edge protection. The Blob fallback cannot consume the database lead limiter. Vercel Pro WAF uses per-region fixed windows. Only one shared rule/counter domain spanning all reachable hosts keeps the trailing-boundary estimate at approximately `2 * L * R`, plus regional reconciliation risk. If host-specific or duplicated rules create `H` independent counter domains, the estimate is approximately `2 * L * R * H`; cross-host boundary tests must measure that larger exposure. Require an explicit rejecting action plus security approval, or a durable shared fallback limiter; if the counter domain or bound cannot be proved, cutover is blocked.
- Stripe lifecycle code now handles `refund.failed` from freshly retrieved canonical Stripe state and explicitly maps all eight current Dispute statuses: four open states suspend, `warning_closed`, `prevented`, and `won` are closed outcomes, and `lost` stays irreversible. Full-refund recovery additionally requires locked agreement across license owner, configured Product, stored Price/Product, canonical Checkout line item, Customer, PaymentIntent, and watermark; incomplete historical rows fail closed. This closes the mapper implementation gap only. No endpoint configuration or live lifecycle proof changed, and historical events terminalized under the old mapper still require the separate repair gate below.
- No executable live one-time Pro catalog proof exists. A future owner-authenticated provider/runtime proof must bind the exact configured/default Product and selected Price to the immutable deployed artifact, mirror runtime precedence, create nothing, and retain exact-ID, live/active, linkage, one-time USD 999, and checksum evidence. The recurring legacy proof is not a substitute.
- Legacy subscription access is default-deny. Before either audit or apply, a clean-environment catalog gate must reject malformed allowlist entries, assert the exact expected ID sets, and directly retrieve every expected live Product and Price. It must prove livemode, active state, Price-to-Product linkage, recurring shape, exact amount, and currency; the audit script's database-referenced subset is not catalog proof.
- Historical lifecycle reconciliation is a separate pre-cutover blocker. The repository has no tested idempotent tool that can find and repair refund/dispute events terminalized by the known-bad mapper. Any future tool must retain an inclusive high-watermark, exact-ID/type manifest/checksum, source and authenticated-target evidence, canonical outcomes, and entitlement watermarks; produce that provisional evidence on both main and fallback paths after pre-drain but before boundary/deny activation; consume the exact evidence in a post-deny full/delta reconciliation; and prove an idempotent no-op rerun before migration or reopening. Manual ledger or entitlement edits are forbidden.
- Stripe payload retention redacts processed work after 14 days by default and dead-letter work after 90 days by default; event identity and audit metadata remain. Maintenance deletes bounded expired operational rows, never canonical leads or active entitlements. Alert on unexpected deletion/redaction counts instead of disabling retention blindly.
- Stripe `dead_letter` rows remain terminal to normal claims. The repository now has an audited exact-event recovery CLI only for a named isolated Test database: read-only inspection is the default, and a separately approved apply binds the attempt-8 row, payload digest, non-secret target fingerprint, Test namespace/key/payload, terminal expectation, reason, and exact confirmation to one attempt 9 plus an immutable digest-only audit. There is no bulk, reset, Production, livemode, entitlement-edit, or audit-mutation path. The checksummed recovery migration is not applied by local validation; any dead letter still blocks Preview/Test until the migration, approval, execution, and resulting evidence pass. Never update queue or entitlement rows by hand.
- Normal Stripe claims now have an absolute configured attempt cap. Exhausted received/retryable rows, and processing rows only after their final lease expires, are race-safely terminalized as `dead_letter` with `claim_attempt_limit_exhausted` without incrementing or returning a ninth normal processing attempt. A nonterminal row at or above the cap is still critical live evidence because no deployment, migration, cron, or connected-target behavior was proved here.
- Neon-hosted Sidestream SaaS tables keep RLS enabled with no direct browser database access. If a future feature adds browser-side database reads or writes, add the narrow role/policy intentionally and document the public data shape; do not make the private account, session, activation, license, license-token, Stripe event, or lead tables broadly readable.
- The canonical URL is the deployed root, `https://sidestream.tv/`. Keep every crawler-facing URL in the HTML head, sitemap, `llms.txt`, and README pointed at `/`; keep the duplicate-host and duplicate-path canonicalization in `vercel.json` as server-side `308` rules. The legacy fallback file must remain inert and `noindex`, not become a second client-side redirect implementation.
- Keep structured data conservative and matched to visible page claims. Do not add FAQ, review, rating, or price claims unless the same facts are present in the visible landing page.
- `llms.txt` is useful as an AI-readable summary, but it is not a substitute for crawlable HTML, normal metadata, structured data, sitemap hygiene, or external citations/backlinks.

## Recent Change Log

- 2026-07-24: Raised and reduced the phone hero recording, moved the headline and mobile handoff into the readable lower fade, and removed the mobile Safari shader/chrome seam without changing desktop geometry.
- 2026-07-24: Added a short phone-only top mask fade to blend the alpha WebM's hard Premiere-window boundary into the shader without changing its size or position.
- 2026-07-24: Lifted the phone video pixels from `-8%` to `-10%` so the Premiere window's black top border sits above the clipping boundary.
- 2026-07-24: Reframed the mobile computer handoff with an "On your phone?" heading and a 20%-off explanation, then added the active `STREAM20` code to both HTML and plain-text download emails.
- 2026-07-24: Reduced the phone-width hero recording by 10%, adjusted its horizontal anchor to `70%`, raised its whole clipping wrapper without cropping the top edge, then extended the mobile/tablet wrapper and lengthened a soft lower-edge fade beneath the recording's Video/Audio download controls, without changing the desktop composition.
- 2026-07-23: Renamed the mobile computer-handoff submit action to "Email me the download link," including the reset label shown after a failed delivery attempt.
- 2026-07-23: Reduced the mobile hero demo size, moved it farther right and slightly up, and lowered its bottom-fade transition while preserving the desktop composition.
- 2026-07-23: Enlarged and nudged the mobile hero demo to the right, adding a soft bottom mask so the video blends into the main copy while leaving desktop unchanged.
- 2026-07-23: Reflowed the existing Sidestream/Premiere demo video into a centered mobile hero block above the main copy while preserving its desktop corner treatment.
- 2026-07-22: Stopped active Pro owners from re-entering Checkout through the legacy saved-v1.0.14 Upgrade fallback, eliminating the live claim/Checkout redirect loop while preserving direct Checkout for signed-out and Free accounts.
- 2026-07-22: Removed the dark outline from the inline DaVinci Resolve hero mark and expanded its SVG viewport around the complete rotated geometry so the red and green lobes render without clipping.
- 2026-07-22: Added a DaVinci Resolve waitlist pill beside the desktop Mac and Windows hero downloads, including the three-color Resolve mark and a dedicated email modal. Added fail-closed `/api/resolve-waitlist` backend storage with a server-fixed source, deterministic private-Blob records, hashed email/IP rate limits, and focused route coverage; the mobile download handoff remains unchanged.
- 2026-07-22: Added `/reddit/2` for Reddit campaign ID `2`, including trailing-slash support and a separate `reddit-2` source in the first-party `/api/referral-visit` tracker.
- 2026-07-22: Added `/reddit/1` for Reddit campaign ID `1`, including trailing-slash support, standard social UTMs, and a separate `reddit-1` source in the existing first-party `/api/referral-visit` tracker.
- 2026-07-22: Removed both Sidestream confirmation pages from the authenticated Free-account Upgrade path. The account button now submits one same-origin POST that creates its account-bound intent server-side and returns a `303` directly to Stripe; account Checkout cancellation returns to the account page, while anonymous and shipped-panel activation safeguards remain intact.
- 2026-07-22: Normalized one-time Checkout fulfillment across charged and 100%-discounted Sessions: exact zero-total Sessions may omit a PaymentIntent whether Stripe reports `paid` or `no_payment_required`, while positive/unpaid/mismatched Sessions still fail closed. Stripe webhook persistence and leased claims now support both the baseline Production event schema and the optional immutable-ingress audit schema without applying runtime DDL; focused regressions cover fallback scope and signed-raw-payload validation. This repository change is not itself proof of a Production deployment or a completed live paid/discounted fulfillment.
- 2026-07-22: Applied and read-only verified `20260713203000_add_checkout_intents.sql`, then promoted the audited direct shipped-panel Stripe Upgrade artifact to Production with the current ManyChat/Instagram/Meta routes intact. The visible claim/confirmation regression came from a later referral-tracking worktree that omitted the direct-handoff lineage, so future deploys must retain both chains. The earlier device schema remains verified; entitlement-lifecycle and Customer 360 remain unapplied.
- 2026-07-21: Applied and read-only verified the additive `20260714190000_add_single_active_account_devices.sql` migration against Production, restoring the exact `sidestream_account_devices` and `sidestream_device_transfers` schema required by account claim, credential verification/refresh, download authorization, and transfer/deactivation paths. Checkout-intent, entitlement-lifecycle, broader hardening, Customer 360, deployment, and device-policy enforcement remained outside this run.
- 2026-07-21: Preserved the route-scoped activation-claim middleware and legacy unmarked-URL recovery needed by shipped v1.0.14 Upgrade handoffs; the later 2026-07-22 entry records the subsequent referral-tracking lineage regression and current deployment boundary.
- 2026-07-21: Added `/meta/1` for Meta Ads campaign ID `1` with standard paid-social UTMs, trailing-slash support, and a separate `meta-ads-1` first-party referral source.
- 2026-07-21: Accepted trailing-slash variants for `/ig`, `/alex`, and `/m` so Instagram and other link clients cannot turn referral shortcuts into `404` pages.
- 2026-07-21: Added the short `/alex` personal Instagram bio redirect with a separate `instagram-alex` source in the existing first-party private referral tracker.
- 2026-07-21: Added the short `/ig` Instagram bio redirect with standard social/bio UTM tags and a separate `instagram-bio` source in the existing first-party private referral tracker.
- 2026-07-21: Added the short `/m` ManyChat redirect and first-party landing referral tracking through a POST-only API, privacy-limited daily HMACs, scanner-aware deterministic private-Blob records, an aggregate reporting command, and focused tests.
- 2026-07-21: Removed the Pricing link from the top-right desktop header while keeping the Features and Account glass-pill links and the in-page pricing section unchanged.
- 2026-07-20: Removed the unfinished active-device status and deactivation row from the Account page so signed-in customers no longer see an unavailable device card; the server-side device policy and APIs remain unchanged.
- 2026-07-20: Restored and streamlined the shipped v1.0.14 Upgrade path in Production without deploying Customer 360. Activation-bearing Checkout GETs resume or create one idempotent attached Stripe Session; v1.0.14 keeps its required activation-claim `restoreUrl`, while new Upgrade URLs use route-scoped Vercel middleware to reach Checkout before claim-function selection, avoiding the redundant Neon lookup. Older saved Upgrade claims retain the database-classified fallback. That recovery added only the recognized legacy account/billing migrations through activation Checkout attachment and refresh rotation; checkout-intent, entitlement-lifecycle, device, and Customer 360 migrations were outside its scope. The later 2026-07-21 repair applied only the additive device schema recorded above. Production has the required `SIDESTREAM_POSTGRES_URL` binding to that same pooled Neon target. Vercel per-function TypeScript compatibility fixes are runtime-neutral and keep the provider build deployable.

- 2026-07-17: Consolidated the local Customer 360 closure gate: authenticated telemetry TLS, absolute Stripe claim bounds, failed-refund/dispute lifecycle handling, audited Test-only exact dead-letter recovery, and read-only retention inventory are implemented and locally tested. Preview remains hard-blocked on the shared environment and every named human/live gate; no deployment, migration, backfill, usage sync, Stripe/provider configuration, cron change, FlowState Preview QA, or Production approval occurred.

- 2026-07-17: Published the canonical Customer 360 Preview/Test acceptance and rollback matrix, routed it from the repository contract, documented the current shared-environment rejection and human-owned isolated-provisioning gate, and added exact secret-safe environment/deployment verification commands. The matrix keeps Vercel project-wide cron disabled, permits only a separately confirmed one-time Test usage sync after all prerequisites, requires Pass/Fail/Blocked UTC evidence and a rollback/recreate drill, and authorizes no Production action.

- 2026-07-17: Embedded the email's Windows mark as a Resend CID inline PNG after real-client testing proved CSS data images were stripped. The visible shape still comes from the landing page's Windows silhouette and requires no remote image load.
- 2026-07-17: Replaced the download email's four-square Windows font approximation with the landing page's exact Windows SVG mark, including the matching white hover treatment.
- 2026-07-17: Restyled the computer-handoff email's Mac and Windows installer links as matching white platform-marked capsules on a dark panel, including the website's red hover treatment and a narrow-screen stacked fallback, while retaining explicit platform labels.
- 2026-07-17: Tightened the mobile download handoff by removing the explanatory Mac/Windows sentence and the default "One email. No account required." note. The empty live region remains hidden until it needs to show validation or delivery feedback.
- 2026-07-17: Restored Production activation polling, license verification, refresh, and download authorization against the pre-entitlement-lifecycle database. Every customer-facing license read now shares the fail-closed JSON-based lifecycle compatibility expression instead of directly referencing the absent column; targeted source regressions prevent any route from drifting back to the parse-time `42703` failure. No Production schema or entitlement row was mutated.
- 2026-07-17: Added the mobile computer handoff: phone-width visitors see one inline email form instead of choosing Mac or Windows, lower mobile download CTAs return to that form, and the new fail-closed `/api/send-download-links` route stores bounded campaign context in the existing private replay queue before sending one idempotent Resend email with both installers from the existing `alexg.mov` domain. Its hashed email/IP limits use private Blob compare-and-swap writes so the MVP does not require the currently unapplied Postgres hardening tables. Desktop downloads remain direct.
- 2026-07-17: Replaced the nearly blank Open Graph/Twitter screenshot with a cache-busted 1200×630 Sidestream product card and updated every social and JSON-LD image reference.
- 2026-07-16: Fixed the live Google sign-in hostname split by standardizing Production on the canonical `sidestream.tv` callback, rejecting callback/start origin mismatches before setting OAuth cookies, and replacing raw OAuth error JSON with a flat retry page.
- 2026-07-16: Restored signed-in Account routing against the intentionally pre-entitlement-lifecycle Production database. Session reads now detect the absent `entitlement_status` field without runtime DDL, preserve compatibility only for exact one-time paid rows the migration would mark active, and automatically prefer canonical lifecycle state after the migration exists.
- 2026-07-16: Bound the decorative Premiere/Sidestream recording's clipping wrapper to the hero's real bounds and added hero-height coverage for tall desktop ratios, removing the empty strip below the plugin so the following feature section is its only bottom crop.
- 2026-07-16: Routed the landing-page Account link through a session-aware Google OAuth entry, redirected direct signed-out account visits into the same flow, kept returning users on the existing 30-day HTTP-only server session, returned sign-out to the landing page, and replaced the account page's red gradient with a flat near-black background.
- 2026-07-16: Shortened the visible hero Windows CTA from `Download for Windows` to `Download`, matching the Mac CTA while retaining the Windows icon, platform-specific installer URL, and explicit Windows accessible label.
- 2026-07-16: Removed the optional Customer 360 identity bridge as the first hard dependency blocking Production activation start. Identity attachment now remains dormant unless the complete core Customer 360 table set exists, so activation creation works on the intentionally unmigrated Production database. Live verification then exposed the next existing blocker: activation status still assumes the unapplied entitlement-lifecycle schema, and full sign-in/transfer remains blocked pending a reviewed migration cutover or explicit pre-20260713 compatibility implementation.
- 2026-07-16: Moved the decorative Premiere/Sidestream recording's compensated anchor farther up and left, from `50vw 35vh` to `45vw 25vh`, without changing its scale or mobile hide behavior.
- 2026-07-16: Moved the decorative Premiere/Sidestream recording's compensated top-left anchor from `50vw 50vh` to `50vw 35vh`, preserving its horizontal alignment while revealing more of the recording's lower edge on desktop.
- 2026-07-15: Set the canonical Mac manifest minimum supported version to `1.0.12`, making v1.0.11 and older update banners critical/non-dismissible while still routing directly to the current v1.0.14 installer; the release publisher now preserves that floor by default.
- 2026-07-15: Published and verified the stable Mac `1.0.14` release through the signed `/api/download` route and `/api/releases/latest`, backed by the private versioned Blob pathname. The public DMG is 226,417,721 bytes with SHA-256 `09d31bd4373f030184593f2cae361f776b82bf1552b0b543bc15be1a30c1c79e`.
- 2026-07-15: Completed the FlowState Customer 360 association contract with the exact four-route JSON-body matrix, strict identity formats and omission/error behavior, verbatim telemetry `installIdHash` reuse, website-owned production/Test isolation, browser/URL privacy boundary, and activation-record continuity. No deployment, migration, backfill, entitlement, or device change was performed.
- 2026-07-15: Corrected the Customer 360 contract after semantic audit: distinguished trusted write namespace from authorized admin read selection, documented one-time/subscription/comped/mixed history without implying current subscription state, preserved observe-by-default single-device status, separated local FlowState work from live Preview/Test QA, exhaustively inventoried stored/derivable telemetry versus the compact API, defined null/zero success-rate behavior, corrected the cron response/log split, and accounted for Vercel's four-job project-wide scheduling control. Customer 360 is not deployed and Production is not migrated.
- 2026-07-15: Published the durable cross-repo Customer 360 field/privacy/identity/commerce/usage contract and human-gated Preview/Test-first rollout guide. Documented the protected API, `SIDESTREAM_CRM_ADMIN_SECRET`, separate `SIDESTREAM_TELEMETRY_POSTGRES_URL`, disposable `SIDESTREAM_TEST_POSTGRES_URL` harness, `installIdHash` versus single-device separation, money minor units, first-attempt/success and rolling-window semantics, retention gap, observability, dry-run backfill, and non-Production rollback. Customer 360 is not deployed and Production is not migrated.
- 2026-07-15: Deduplicated a paid Checkout fallback against only its related paid Invoice fallback before their shared instrument arrives. The paid InvoicePayment allocation edge now selects the Invoice as the one economic purchase without aliasing their payment keys; unrelated Checkout purchases remain countable before and after the related PaymentIntent materializes. Added disposable-Postgres overlap and negative-control coverage. No Production query, migration, backfill, deployment, Stripe/Vercel configuration change, entitlement mutation, or device mutation was performed.
- 2026-07-15: Recovered Customer 360 paid-amount fallbacks without weakening payment-group guards. Paid Checkout-only and Invoice-without-instrument facts now remain queryable until a related settled PaymentIntent or captured Charge atomically replaces them; gross includes fully and partially off-Stripe Invoice money, with `off_stripe_paid_minor` exposed as a constrained totals subset. Added disposable-Postgres regressions for Checkout `999`, Invoice `500` replacement, full off-Stripe `700`, mixed `1000/200/800`, and verified fallback dates. No Production query, migration, backfill, deployment, Stripe/Vercel configuration change, entitlement mutation, or device mutation was performed.
- 2026-07-15: Recovered Customer 360 commerce integrity around canonical captured money and identity conflicts. PaymentIntent/standalone-Charge instruments now own gross and paid timing, current InvoicePayment records persist as allocation edges without collapsing valid many-to-many graphs, `charge.refund.updated` and current cash-balance events route correctly, off-Stripe invoice money remains explicit, and contradictory identity evidence atomically applies sticky whole-group quarantine. Added disposable-Postgres regressions for partial capture, allocation graphs, refund-first late attach, product scope, and late/bridged conflicts. No Production query, migration, backfill, deployment, entitlement mutation, or device mutation was performed.
- 2026-07-15: Made Customer 360 profile merge ordering timezone-safe by comparing canonical UTC microsecond timestamps before parsed ISO fallback, with both argument orders covered across the Los Angeles DST gap. No Production migration, deployment, backfill, or cutover was performed.
- 2026-07-15: Removed the unsafe executable Production cutover and fallback recipe. Production cutover is blocked; the API runbook now records only current facts, blockers, and capabilities required by a future separately reviewed plan. No Production action was performed.
- 2026-07-14: An earlier documentation attempt claimed live Pro catalog, historical-lifecycle, deployment-binding, and promotion evidence that independent review found non-executable or unsafe. Those claims are superseded by the 2026-07-15 blocked status; no Production action was performed.
- 2026-07-14: Recorded the intended historical-lifecycle ordering, but later review found that the fallback path consumed provisional evidence it never produced. Both future main and fallback paths are now explicit capability blockers; no Production action was performed.
- 2026-07-14: Earlier recipes attempted WAF, release/fallback identity, database transport, Stripe drain, and cron sequencing. Later review rejected their provider attestation, launcher, signature, and lifecycle assumptions; no Production action was performed.
- 2026-07-14: Removed the obsolete single-device command surface and centralized API/runtime facts. The API runbook now records blockers/capabilities only and is not an executable Production procedure; no Production action was performed.
- 2026-07-14: Earlier audit remediation documented empty-environment and account/target assertions, but later review reproduced pre-main env injection and other unsafe input/file handling. The executable recipe is removed; no Production action was performed.
- 2026-07-14: Earlier follow-up attempt, superseded by the audit entry above: documented release-channel normalization, env-file injection, checksum evidence, deterministic Vercel linking, WAF bypass effects, and resend ceilings. Later review found the inherited-env and lifecycle gaps now recorded as blockers. No production action was performed.
- 2026-07-14: Earlier three-verdict remediation attempt, superseded by the audit entry above: added enabled Stripe delivery, staged Production artifacts, the WAF matrix, global cron sequencing, migration status, and license continuity. Later review proved that endpoint-only event reconciliation was incomplete. No production action was performed.
- 2026-07-14: Earlier consolidation, superseded by the audit entry above: assembled the hardened API contract, checksummed migrations, activation compatibility, lifecycle transitions, retries/dead letters, lead replay, protected crons, retention, alerts, and disposable-database proof. It did not make the stale alternate cutover safe or resolve the current lifecycle blockers. No production action was performed.
- 2026-07-14: Locked the decorative Premiere/Sidestream recording's visible panel corner to the center of the desktop viewport at every supported window size while preserving the existing `900px` hide-and-pause breakpoint.
- 2026-07-14: Removed the explanatory sentence beneath the hero's "in Premiere Pro" subline, cleaned up its unused responsive styles, and retained deliberate spacing above the platform download buttons.
- 2026-07-14: Framed the desktop Features, Pricing, and Account nav links as compact rounded glass pills with clearer hover and keyboard-focus states, leaving the mobile-hidden behavior and header CTA count unchanged.
- 2026-07-14: Added privacy-limited Gmail installer referral attribution with batch UTM tags, post-response Postgres writes, likely-scanner flags, an aggregate maintainer report, RLS hardening, and focused route/privacy tests without changing installer delivery behavior.
- 2026-07-14: Consolidated the single-active-device schema, production/Test environment contract, API/page states, operator/support workflow, disposable-Postgres tests, and privacy boundary. Its original migration/cutover directions were removed; `docs/api-hardening-runbook.md` records blockers and future capabilities only, and no Production migration, deployment, backfill, or enforcement was claimed.
- 2026-07-14: Made Restore Purchase confirmation idempotent for same-account retries after an activation reaches `restored`, `paid`, or `linked`, preventing a successful first submit plus duplicate browser submit from ending on a false `unavailable` error while preserving expiry and account-isolation checks.
- 2026-07-14: Added explicit image/group roles to the named demo, pricing-card, and MacBook containers so Chromium produces a well-formed accessibility tree instead of rejecting `aria-label` on generic `div` elements.
- 2026-07-14: Removed the top-right `Free Download` CTA from the fixed header while keeping the Features, Pricing, and Account navigation links plus all in-page download CTAs.
- 2026-07-14: Shortened the hero Mac CTA from `Download for Mac` to `Download` while retaining the Apple mark, explicit Mac accessible label, platform-specific URL, and full-width mobile treatment.
- Added secure instant Pro synchronization: persisted/idempotent activation Checkout Sessions, a server completion callback plus webhook-delayed reconciliation, exact Stripe Price/Product/quantity verification, device-bound access and rotating refresh credentials with lost-response replay, explicit signed-in CSRF-protected Restore Purchase, second-purchase avoidance for signed-in Pro activations, bounded activation token replay, additive schema constraints, and focused entitlement regression tests.
- Kept `/api/*` executable on the legacy `sidestream-xi.vercel.app` project host while continuing to canonicalize its root and non-API pages, so installed 1.0.12 panels no longer fail their account POSTs on a `308`.
- 2026-07-13: Renamed the hero Mac CTA from `Free Download` to `Download for Mac` so the paired Mac and Windows buttons use parallel platform labels, and made the pair equal full-width buttons below `520px`; no helper line was added and the other Mac CTAs remain unchanged.
- 2026-07-13: Replaced the hero Windows waitlist trigger with a direct `Download for Windows` link to the platform-scoped `1.0.13` beta EXE route; the Mac download path remains unchanged and the old waitlist modal is dormant.
- 2026-07-13: Protected the `https://sidestream.tv/` canonical and `$9.99` one-time Sidestream Pro offer across the landing page, legacy redirect, checkout resolver, JSON-LD, crawler files, fallback page, and README.
- Right-aligned wrapped account-row actions so receipt and refund controls share the same desktop edge as sign out, Stripe Portal, and installer actions while preserving the full-width mobile layout.
- Added server-side `308` canonical redirects for `www.sidestream.tv`, `sidestream-xi.vercel.app`, `/index.html`, and the legacy nested HTML path; added response-level `X-Robots-Tag` protection for functional HTML/API responses; blocked automatic crawlers from `/api/`; kept `OAI-SearchBot` enabled while opting out of `GPTBot`; and moved sitemap `<lastmod>` generation into the build with GitHub-backed provenance for Vercel's Git-history-free build environment.
- Added platform-scoped Windows beta fulfillment: bare site downloads and Mac CTAs remain on Mac `1.0.12`, while `win32-x64` manifest/download requests serve Windows `1.0.13` and unknown platforms fail closed.
- Promoted the public installer pointer to the private Blob `1.0.12` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.12-Mac-Installer.dmg`.
- Added the Sidestream-owned `/api/releases/latest` update manifest and moved `/api/download` to the same `data/release-manifest.json` release pointer so the plugin update check and public installer cannot drift between AlexG and Sidestream surfaces.
- Added an RLS hardening migration for server-owned Sidestream public tables, conditionally revoking legacy `anon` and `authenticated` Data API roles while preserving the server-only Postgres route contract.
- Retired the first-week-unlimited free-trial offer, which was never implemented in the entitlement backend: the Free pricing card and `llms.txt` now say "5 free downloads every day," matching the plugin's actual free-tier daily cap. Only backend-issued Sidestream Pro license tokens bypass the cap.
- Replaced the inline hero Windows email box with a matching Windows platform pill that opens a centered waitlist modal.
- Added a hero Windows waitlist capture that posts emails to `/api/download-lead` with `source: "windows-waitlist"` while leaving Mac download CTAs unblocked.
- Promoted the public installer pointer to the private Blob `1.0.11` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.11-Mac-Installer.dmg`.
- Removed the account/subscription bullet from the Pro pricing card.
- Changed the Free pricing card copy from "Unlimited free downloads" to "Unlimited downloads for your first week."
- Sent successful Stripe Checkout returns to `thank-you.html`, kept cancelled Checkout on `upgrade.html`, and redirected legacy `upgrade.html?checkout=success` links to the new thank-you page.
- Added invoice creation for future one-time Stripe Checkout payments, a direct `/api/billing/receipt` route for existing one-time charge receipts, and account-page receipt/refund request controls so Customer Portal is not treated as the only purchase-history surface.
- Historical: Sidestream Pro was temporarily corrected from `$9.99` to `$4.99` for Price `price_1TqGeBDFKjeGlioXlV8fBGK8`; the 2026-07-13 `$9.99` change above supersedes this state.
- Historical: Checkout temporarily pinned `price_1TqGeBDFKjeGlioXlV8fBGK8`; the active `$9.99` lookup-key resolver now supersedes that default.
- Fixed Checkout customer reuse after sandbox-to-live Stripe key switches by validating saved Stripe customer IDs before passing them to Checkout.
- Renamed the paid one-time Checkout tier from Sidestream Unlimited to Sidestream Pro, switched new Checkout metadata to `sidestream_pro`, and resolved the `$9.99` Stripe Price from Product `prod_UpwXh6oO1OmPyQ` with legacy Unlimited webhook compatibility.
- Pinned one-time Stripe Checkout Sessions to card payments while the live Stripe account payment-method dashboard setup is incomplete.
- Removed the account page lede sentence so `account.html` goes straight from the account headline into the sign-in or account-management panel.
- Added a sandbox-guarded Stripe maintainer utility for creating/verifying the `FREEDEV` 100% off promotion code used to test no-cost Sidestream Pro Checkout.
- Promoted the public installer pointer to the private Blob `1.0.10` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.10-Mac-Installer.dmg`.
- Changed the paid plan from a monthly subscription path to a `$9.99` one-time Stripe Checkout payment with webhook fulfillment for one-time Checkout Session IDs and no Google sign-in requirement before purchase.
- Moved the canonical landing page to the clean root URL, `https://sidestream.tv/`, and changed the old exported `Sidestream%20front%20end%202/Sidestream.html` path into a noindex compatibility redirect.
- Changed the $0 pricing card from Beta to Free and removed beta-tester wording from the free-plan copy, structured data, and `llms.txt`.
- Fixed Vercel API route helper imports to use explicit `.js` extensions so auth, activation, checkout, billing, and webhook functions resolve `api/_lib/account.ts` after production compilation.
- Added the MVP SaaS account flow: unblocked download CTAs, noindex `account.html` and `upgrade.html`, Google OAuth, Stripe Checkout, Customer Portal redirects, webhook-owned entitlement tables, plugin activation endpoints, short-lived license tokens, and a generic Postgres migration runner.
- Added support for legacy Vercel connector database env names across account/billing APIs, download-lead capture, and Postgres maintainer scripts, with `SIDESTREAM_POSTGRES_URL` preferred over older generic `POSTGRES_URL` fallbacks.
- Promoted the public installer pointer to the private Blob `1.0.9` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.9-Mac-Installer.dmg`.
- Commented out the blurred `$19` Unlimited paid-plan details while keeping the "Coming soon" placeholder card stable for later restoration.
- Migrated hosted `POSTGRES_URL` to Neon Postgres, copied readable database tables into Neon, and redeployed production so `/api/download-lead` writes to the new database.
- Added non-visual SEO/GEO metadata, JSON-LD structured data, public `robots.txt`, `sitemap.xml`, `llms.txt`, and a stable public Open Graph image while leaving the visible landing page unchanged.
- Promoted the public installer pointer to the private Blob `1.0.8` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.8-Mac-Installer.dmg`.
- Added request IP capture to Sidestream download leads and removed the internal `storage_targets` column/dump field, which was only temporary migration bookkeeping.
- Moved Sidestream download email lead storage to Postgres table `public.sidestream_download_leads`, added a migration script for existing Vercel Blob lead JSON records, and kept private Blob writes as a temporary fallback when database capture is unavailable.
- Changed `GET /api/download` from private Blob proxy streaming to a metadata check plus short-lived signed private Blob redirect, fixing deployed GET failures where `HEAD` still succeeded.
- Added Vercel Analytics through the existing React entry and documented the verification path.
- Added `.vercelignore` so production Vercel deploys exclude raw local demo/mockup source assets while keeping the small tracked WebM/MP4 media files required by the landing page.
- Updated the documented Sidestream installer download pathname to the `1.0.6` native/base DMG after the production promotion.
- Documented Vercel Blob/CDN storage and egress guardrails for the public Sidestream installer path, including current Hobby allowances, the ~198 MiB installer transfer math, and explicit stop-and-ask triggers for artifact, `/api/download`, and CTA changes.
- Moved the right-side Sidestream/Premiere corner demo down another `12vh` for the live browser viewport after the previous adjustment still read too high.
- Made the right-side Sidestream/Premiere corner demo's screen blend more visible by lowering opacity to `0.9` and moved it another `4vh` down.
- Added a subtle `screen` blend mode plus `0.96` opacity to the right-side Sidestream/Premiere corner demo so darker recording areas breathe into the shader.
- Moved the right-side Sidestream/Premiere corner demo another 10vw left and 10vh down, widening the clipping/video overfill so the recording still reaches the right viewport edge.
- Pointed visible download CTA anchors at the canonical public Vercel download URL so local/static previews no longer 404 on `/api/download` after the email gate.
- Moved the right-side Sidestream/Premiere corner demo down by `10vh` and documented that the shader background requires Vite rather than a plain static server.
- Removed the fake dark matte from the right-side Sidestream/Premiere corner demo and regenerated the WebM from a square full-plugin/timeline crop so real video content covers the right/bottom gaps without zooming the old crop.
- Changed the email-gate continuation from a recursive anchor replay to direct `window.location.assign(...)` navigation so Download no longer flickers or stalls after submission.
- Scaled the right-side Sidestream/Premiere corner demo down from its visible top-left corner while preserving wide-screen horizontal overfill and leaving the frosted feature band in normal flow.
- Simplified the email-gate modal copy to avoid implying Sidestream updates depend on email.
- Changed the $0 pricing card label from "Free" to "Beta" while keeping the CTA copy as "Free Download".
- Bottom-aligned the 20%-smaller right-side Sidestream/Premiere corner demo to the normal frosted feature band, removing the bottom gap without moving the dark section.
- Added an email-gated download modal for all `/api/download` CTAs plus `POST /api/download-lead`, which stores each valid email submission as a private Vercel Blob JSON record before continuing the installer download.
- Updated the pricing cards so the Beta plan promises unlimited downloads for beta testers, while the blurred Unlimited card keeps the `$19` paid details behind a "Coming soon" / "Sidestream Unlimited" overlay.
- Changed the final CTA headline to "Stop using sketchy websites to download music".
- Moved the frosted feature band back down to its normal post-hero position and kept the decorative corner demo adjustment isolated to the video layer.
- Let `/api/download` CTA clicks navigate through their native anchors and kept the toast as feedback-only, removing the fragile `preventDefault()` plus manual `window.location.assign()` download handoff.
- Scaled the right-side Sidestream/Premiere corner demo down by 20% while compensating for the WebM's transparent alpha padding so the visible top-left Premiere corner stays in the same place.
- Changed the cropped VP9-alpha Sidestream/Premiere corner demo from a small floating card into a right-side decorative placement behind the hero-to-feature transition.
- Uploaded the native/base `Sidestream-1.0.5-Mac-Installer.dmg` to private Vercel Blob and switched the documented Vercel download pathname away from the ZXP-helper DMG.
- Changed the visible Unlimited one-time price from `$29` to `$19` across the pricing card, purchase CTA, and final CTA copy.
- Increased the hero rotating noun slot's lower paint buffer so descenders like the `g` in `songs` no longer clip during the word cycle.
- Lowered the pricing headline by equalizing the space above and below it, centering it between the `.feature-glass` band and pricing cards without moving the cards.
- Moved the `.feature-glass` bottom separator to the end of the feature wrapper so the Preview demo video has more buffer above the lower line.
- Moved the `.feature-glass` top separator to the start of the feature wrapper so the Search demo video has more buffer below the line.
- Tuned the pricing-card reveal to trigger earlier with a shorter upward glide and tighter Unlimited-card stagger so the pricing section no longer feels empty while scrolling.
- Wrapped the Search and Preview demo sections in a single full-bleed `.feature-glass` dark frosted backdrop so that proof area is visually separated from the continuous shader background.
- Removed all background mouse interactivity and restored the active background to the plain Paper `MeshGradient`.
- Added a black Apple platform mark inside the visible `Free Download` CTAs and accessible `Free Download for Mac` labels for `/api/download` links.
- Reworded the hero description to explicitly call Sidestream a panel inside Premiere Pro for searching, previewing, and downloading YouTube videos without leaving the app.
- Changed every visible `/api/download` CTA label from `Download` to `Free Download`.
- Moved the final CTA panel above the rotating pricing MacBook mockup.
- Italicized the hero "in Premiere Pro" subline while keeping it outside the animated H1.
- Anchored the hero headline, description, and primary Free Download CTA to the lower-left first-fold gutter, then moved the Search demo group down to add breathing room below the hero Free Download button.
- Removed the inline Download buttons from the Search and Preview demo sections and kept their heading/subtext blocks centered beside the videos.
- Removed trailing periods from the visible hero rotating noun labels and matching aria label.
- Moved the rotating MacBook mockup out of the hero and centered it below the two pricing panels inside `.pricing-mockup`, with a small playback helper to keep it spinning.
- Removed the secondary "Get Unlimited" button from the final CTA so the closing panel only offers `Free Download`.
- Smoothed the demo-video 3D hover by tracking against the card's stable layout box and returning to rest with an S-curve reset.
- Anchored the Features/Pricing/Download header cluster to the viewport's top-right with a `15px` top offset and `24px` right gutter.
- Pinned the fixed Sidestream wordmark and desktop hero copy to the shared viewport-left `24px` first-fold gutter instead of the older centered shell.
- Shifted the desktop hero copy left by left-anchoring the wider `1280px` first-fold shell.
- Changed the Unlimited pricing card from a red outline/drop shadow treatment to a white outline with no shadow.
- Rounded the two pricing cards to `28px` corners and added a pricing-only scroll reveal that glides them upward with a slight stagger when they enter the viewport.
- Added a subtle center-origin 3D hover tilt to the two feature demo video frames, capped at 15 degrees and disabled for reduced-motion/coarse-pointer users.
- Removed the red radial corner glow from the final CTA panel.
- Moved the enlarged hero MacBook mockup a little farther right by easing `.hero-mockup-video` from `translateX(-2%)` to `translateX(0)` on desktop and narrow mobile.
- Moved the hero MacBook mockup a little farther right by easing `.hero-mockup-video` from `translateX(-4%)` to `translateX(-2%)` on desktop and matching the narrow-mobile offset.
- Lightened the "Unlock when you need more." pricing headline line with `.pricing-line { font-weight: 300; }`.
- Raised the pricing headline and increased its gap above the pricing cards so it sits halfway between the Preview demo video and pricing cards.
- Increased the hero MacBook mockup scale by 20%, changing `.hero-mockup-video` from `185%` to `222%` on desktop and from `177%` to `212%` on narrow mobile.
- Let `.hero-media` overflow visibly so the enlarged rotating MacBook no longer gets clipped by the hero grid boundary.
- Changed every `/api/download` CTA label from `Download now` to `Download` and moved download buttons to a white capsule style with black text, red hover fill, and white hover text.
- Reduced the hero bottom padding and added `.feature-start` so the Search demo group starts inside the first fold on desktop and mobile.
- Nudged the desktop hero MacBook mockup slightly right by easing the desktop-only alpha video offset from `translateX(-6%)` to `translateX(-4%)`.
- Rounded `[data-download]` CTAs into Apple-style capsules while preserving their existing size and red primary treatment.
- Reverted the hero CTA experiment back to a single red `Download now` button that points to `/api/download`.
- Tightened the desktop hero composition by capping `.hero-split` width, reducing its responsive grid gap, and nudging the alpha MacBook video left so the copy and mockup sit closer together.
- Changed the solid and translucent white text tokens plus direct white text cases to the slightly softer off-white `#E2E8F0`.
- Darkened the active Paper `MeshGradient` background by 20% by scaling the non-black shader stops from `#1a1a1a`, `#333333`, and `#cccccc` to `#151515`, `#292929`, and `#a3a3a3`.
- Removed the red square brand mark from the fixed top-left nav so the header starts with the Sidestream wordmark only.
- Added a lighter `.hero-description` line below "in Premiere Pro" to explain that Sidestream searches, previews, and downloads YouTube media inside the Premiere workflow.
- Removed red drop shadows from primary CTA buttons while keeping their fill, hover color, and hover lift.
- Widened `.hero-description` so the explanatory line extends a little past the right edge of "Download YouTube" on desktop.
- Kept "Download YouTube" together on the hero's first headline line with `.hero-title-line`, widened the desktop hero copy track to fit it at `1280x748`, and left the rotating noun on the second line.
- Added `@vercel/blob`, linked the repo to Vercel project `sidestream`, pulled local env, configured the private `products` Blob store id and installer pathname, and added `/api/download` to stream the current Sidestream installer from private Blob storage.
- Added `vercel.json` to force npm-based Vercel install/build/dev commands and `dist` output for this Vite project.
- Updated all `Download now` CTAs to target `/api/download` while preserving the toast feedback before navigation.
- Aligned the mounted Paper `MeshGradient` brightest color stop to `#cccccc` so the light background phase is about 20% less bright.
- Forced the pricing heading to break after "Start free." so the desktop pricing section matches the intended two-line copy.
- Made the Tudor Place feature demo videos start only when scrolled into view and pause when they leave the viewport.
- Shifted the desktop hero copy and MacBook mockup upward by redistributing hero top/bottom padding for better 14-inch MacBook viewport centering.
- Removed the pasted Paper demo's centered `21st` install text and clipboard rectangle from the background layer while keeping the active mesh shader.
- Copied the provided Paper demo exactly into `components/ui/demo.tsx`, mounted it directly as the background, copied `background-paper-shaders.tsx` exactly, and added type declarations so the pasted prop names can remain unchanged.
- Removed the fake stoplight/browser-title chrome from the Tudor Place Search and Preview demo cards so each feature frame is just the video.
- Replaced the Search and Preview placeholder cards with Tudor Place MP4 demos, removed the third Download feature block, and ignored raw Screen Studio project folders under `demos/`.
- Restored the React/Paper/Tailwind shader mount and made the active background follow the pasted reference more closely with black/charcoal/gray/white `MeshGradient` plus `DotOrbit`, removing the red CSS fog approximation.
- Added a dependency-free CSS shader/mesh background adapted from the pasted Paper/Three reference while keeping the page static HTML and Vite-only.
- Replaced the mounted Paper/React shader background with a plain black `body` background, removed the background mount script, deleted the unused React/Tailwind/shadcn files, removed their dependencies, and simplified the Vite config.
- Added a pointer-reactive gravity/water wake to the full-page Paper `MeshGradient` background using `requestAnimationFrame` and CSS variables, while keeping the background to a single shader canvas.
- Removed the unused React Three Fiber/Three background reference component and uninstalled the now-unused `@react-three/fiber`, `three`, and `@types/three` packages.
- Removed the hero MacBook video's CSS drop shadow so the alpha WebM no longer reveals a rectangular compositing edge during rotation.
- Softened the full-page Paper shader contrast so animated background bands no longer read as hard edges around the rotating MacBook.
- Changed the landing-page accent palette from orange to red across CTAs, brand mark, rotating noun gradient, pricing highlights, check icons, glow shadows, shadcn theme tokens, and optional shader primitive defaults.
- Removed the mounted React Three Fiber shader-plane canvas so the top-left and lower-page lens-flare/schmutz artifacts no longer appear over the background.
- Removed the mounted `DotOrbit` layer and disabled MeshGradient grain so the background no longer shows random grey dots that were not part of the original page.
- Removed the visible `EnergyRing` from the mounted background so the top-right hero area no longer shows a distracting colored ring.
- Replaced the earlier light background with a dark Paper shader direction and retuned page text/surfaces to white-on-dark.
- Swapped the hero MacBook video to the cleaner `mockup1_2` alpha animation and generated a browser-sized WebM.
- Added the Vite/React/Tailwind/shadcn project shell and the `@paper-design/shaders-react` shader background component.
- Mounted `ShaderBackground` once at the top of the canonical page and removed the old CSS Aurora/body glow.
- Changed formerly black text tokens to white/translucent white and darkened page cards, placeholders, pricing cards, and toast surfaces for shader contrast.
- Ignored generated `node_modules/` and `dist/` output.
- Restored the page to a mostly white background and softened the MacBook video shadow/mask to reduce alpha edge artifacts during rotation.
- Added a subtle animated gradient to the hero rotating noun.
- Increased the hero MacBook mockup scale by roughly 30% while preserving the taller media frame and bottom fade mask.
- Enlarged the hero headline/subline and MacBook mockup slightly, removed the hero-only shader layer, and made the page glow one continuous non-repeating background field.
- Fixed the mobile flipped-grid override so feature cards use the full mobile width.
- Set the large footer SIDESTREAM wordmark to Helvetica Bold.
- Smoothed the hero rotating noun by replacing the mixed transition/keyframe handoff with matched monotonic `translate3d` keyframes and per-group rotation setup.
- Replaced the hero screenshot placeholder with an autoplaying muted loop of the rotating MacBook Pro mockup and added the generated WebM asset.
- Removed the fixed header's scroll divider/shadow so the hero glow no longer reads as a hard horizontal cutoff while scrolling into the first feature section.
- Made the Aurora-style glow continuous between the hero and first feature by removing the clipped hero edge and strengthening the page-wide glow mask.
- Switched all page text to the SF Pro system font stack and removed the unused Google Fonts request and monospace mock-label overrides.
- Restored the hero layout, media scale, and section spacing while keeping the hero headline, subline, and CTA smaller.
- Added a shared sans width control so SF Pro-style text is subtly tighter.
- Increased the Aurora-style page glow intensity and kept the pricing band translucent so the glow remains visible through the landing page.
- Reduced the hero headline, subline, and CTA sizing for a smaller first-fold text treatment.
- Extended the Aurora-style glow through the landing page and softened the pricing band so there is no hard stop after the hero.
- Removed the Terms link from the footer and cleaned up unused footer-link styles.
- Removed the support email link from the footer.
- Added the "Maximum audio and video quality" bullet to both pricing plans.
- Added the "Full video and audio downloads" bullet to the Unlimited pricing plan.
- Initialized this folder for publishing to `git@github.com:alexgmov/Sidestream-Website.git` and ignored Finder `.DS_Store` files.
- Removed the "Maximum available quality" bullet from the Unlimited pricing plan.
- Removed the "03 Download" eyebrow from the third feature section and cleaned up the now-unused eyebrow styles.
- Removed the "02 Preview" eyebrow from the second feature section.
- Removed the "01 Search" eyebrow from the first feature section.
- Removed the hero "Premiere Pro Plugin" eyebrow above the headline.
- Changed the hero "in Premiere Pro" subline color to black.
- Changed feature heading sublines from the old serif accent style to lighter SF Pro-style subtext.
- Increased the hero "in Premiere Pro" subline to a medium SF Pro-style weight.
- Made the header a transparent fixed overlay above the Aurora hero background, preserved hero spacing with extra top padding, and added anchor scroll padding for fixed-nav links.
- Changed the hero rotating noun to always roll upward with a subtle Bezier overshoot.
- Added a root `index.html` redirect so the local server root opens the canonical Sidestream page.
- Replaced the hero rotating noun rebound with smoother directional Bezier-style roll-off motion.
- Lightened the hero "in Premiere Pro" subline with a thinner SF Pro-style treatment.
- Added a lighter hero subline reading "in Premiere Pro" below the main rotating headline.
- Removed the secondary "Get Unlimited" button from the hero CTA row.
- Added bottom buffer to the hero rotating-word slot so descenders in words like "songs" and "overlays" are not clipped.
- Updated the free plan limit copy from "About 10 downloads per month" to "5 downloads per day."
- Removed the pricing intro paragraph under the "Start free" heading.
- Removed em dash punctuation from the page title, feature eyebrows, mock-window labels, and Unlimited CTA copy.
- Removed the hero install/free-start note below the CTA row.
- Removed the hero lead paragraph so the headline now jumps straight to the CTA row.
- Changed the hero headline to a sans-serif "Download YouTube" message with a dependency-free rotating noun slot for editor download use cases.
- Added a dependency-free Aurora/light-ray background behind the hero and documented that it is a static CSS translation of the pasted React/Tailwind component.
- Restored the hero to the numbered screenshot state: serif headline, plugin eyebrow, two hero CTAs, title-case brand, and wider right-side mock window.
- Added this README as the routing layer for future coding sessions.

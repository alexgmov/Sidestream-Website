# Sidestream Landing Page

## Product Overview

Sidestream is an HTML-first landing page for a Premiere Pro panel that lets editors search, preview, and download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The main page remains a single canonical HTML document with embedded layout CSS and vanilla JavaScript, plus a small React/Tailwind layer mounted only for the full-page Paper shader background.

## File Map

- `Sidestream front end 2/Sidestream.html` - Inert `noindex` fallback document for the old exported page URL. Production requests never serve it because `vercel.json` sends the legacy path to `https://sidestream.tv/` with a server-side `308`.
- `index.html` - Canonical page implementation served at `/`. Contains the shader mount root, header, hero, desktop Mac/Windows download CTAs, mobile email handoff, dormant historical waitlist modal, feature sections, pricing, final CTA, footer, styles, rotating-word script, toast behavior, crawler metadata, and structured data.
- `public/robots.txt` - Public crawler policy copied to `/robots.txt` by Vite. Allows normal search plus OpenAI `OAI-SearchBot`, blocks all `/api/` routes from automatic crawlers, and opts out of training-oriented `GPTBot` separately.
- `public/sitemap.xml` - Valid source template for the canonical root-only XML sitemap. It intentionally contains no hand-maintained date; the build replaces its marker in `dist/sitemap.xml` with the root page's last meaningful source modification time.
- `public/llms.txt` - Concise AI-readable product summary and canonical-source guide for LLM/search agents. It is additive and does not replace normal SEO metadata or visible page content.
- `public/sidestream-social-card-v2.jpg` - Cache-busted 1200×630 Open Graph/Twitter card with readable Sidestream branding, product copy, and the Premiere Pro panel mockup. Social and structured-data metadata in `index.html` must use this filename so X does not reuse the obsolete blank preview.
- `components/ui/demo.tsx` - Adapted Paper demo component mounted as the page background. The active default effect keeps the original simple `MeshGradient` look with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`, with demo install/clipboard overlay text removed and no background mouse interaction.
- `components/ui/background-paper-shaders.tsx` - Exact pasted React Three Fiber shader primitives from the provided reference. They are kept as optional reference code and are not mounted by default.
- `account.html` - Minimal noindex account bridge on a plain near-black background. Signed-out visits immediately enter Google OAuth, while the server auth session shows returning users their plan status, coarse active-production-device status, explicit device deactivation, latest installer, sign out, and a Manage Billing button that creates a Stripe Customer Portal session.
- `docs/single-device-entitlements.md` - Device-domain and support reference for the single-active-device contract, privacy boundary, API/page states, and conceptual support decisions. Its obsolete Production command surface has been removed; it authorizes no Production action and points to the API runbook only for blocker/capability status.
- `docs/api-hardening-runbook.md` - Exact hardened API/release contract, shared Postgres and migration model, Stripe/lead/maintenance facts, bounded configuration, metrics, alerts, and the current fail-closed Production blocker/capability inventory. Production cutover is blocked; this file contains no executable Production cutover or fallback recipe and does not claim Production was changed.
- `thank-you.html` - Minimal noindex Checkout success page with a plain near-black background and no activation-delay lede. Stripe success URLs land here after purchase, while legacy `/upgrade.html?checkout=success` links redirect here and preserve optional activation/session query values. It tells unlinked website/legacy buyers to sign in with the same verified Checkout email, then use Upgrade or Restore Purchase so the active account can claim the panel without a second charge.
- `upgrade.html` - Minimal noindex checkout/cancel fallback page. Public website purchases without an activation open the explicit `/api/checkout/start` confirmation page; activation-bearing app Upgrade links and authenticated Free activation claims skip that confirmation and continue directly to Stripe, while active-owner recovery enters the authenticated claim page so the account can safely choose same-device reconnect or confirmed transfer without a duplicate charge.
- `data/release-manifest.json` and `data/release-manifest.windows.json` - Sidestream-owned stable release manifests. The default file keeps the public Mac artifact; the Windows file is selected by the explicit `win32-x64` platform query used by the public Windows download CTA. Private Blob pathnames are never returned by the public manifest API.
- `api/download.ts` - Vercel Node Function for installer fulfillment. `HEAD` returns attachment metadata for the manifest-configured private Vercel Blob installer, and `GET` validates the Blob then redirects to a short-lived signed private Blob URL. Successful Gmail campaign `GET`s are recorded only after the redirect response ends. Bare requests remain Mac; `?platform=win32-x64` selects the Windows beta artifact. Supports `GET` and `HEAD` only.
- `api/_lib/installer-referral.ts` - Server-only Gmail installer-request attribution. It validates bounded UTM tags, accepts only `pilot` or `main` batch content, creates a campaign/day-scoped HMAC from request identity, discards the raw IP and user agent, flags likely link scanners, and inserts the privacy-limited event into Postgres without delaying installer delivery.
- `api/releases/latest.ts` and `api/_lib/release-manifest.ts` - Sidestream-owned update manifest endpoint for the CEP panel. It selects the Mac or Windows manifest by platform and serves public metadata without exposing the private Blob pathname.
- `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/_lib/download-lead-blob.ts` - Bounded JSON lead ingestion, canonical `(email, cta_source)` convergence, idempotency receipts, atomic Postgres email/IP rate limits, deterministic private-Blob fallback, and the private compare-and-swap Blob limiter used by the mobile email handoff. `api/internal/download-leads/replay.ts` replays mapped fallback records and deletes only after a committed database write plus ETag match.
- `api/send-download-links.ts` and `api/_lib/download-link-email.ts` - Mobile-only computer handoff. The public POST route requires an idempotency key, stores the `mobile-download-handoff` lead plus bounded UTM context in the existing private replay queue, enforces a durable hashed 3/email and 10/IP per-hour Blob limit, and sends one transactional Resend message from `downloads@alexg.mov` with direct Mac and Windows installer links. The email presents both installers as matching white platform-marked capsules on a dark panel while retaining explicit platform labels; its Windows mark is a tiny PNG derived from the landing page silhouette and embedded as a Resend CID inline attachment so email clients do not strip it. Provider errors and logs never return or print the recipient address.
- `api/_lib/postgres.ts` and `api/_lib/rate-limit.ts` - Shared attached runtime Postgres pool/transaction ownership and atomic HMAC-dimension rate limiting. Production runtime requires a pooled URL; direct URLs are reserved for reviewed migrations/backfills and development/test fallback.
- `api/_lib/telemetry-identity.ts` - Server-only, fail-open telemetry identity bridge. It treats the optional lowercase 64-character `installIdHash` as a persistent OS-profile telemetry association, first-binds it to the namespace-scoped server-HMAC device digest, returns a private bridge UUID only to trusted callers, and may attach one account verified by the account runtime. It is not authentication, hardware identity, or ownership proof. Conflicts never overwrite the first device or account binding and never weaken the surrounding activation, verification, refresh, entitlement, or device transaction.
- `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, and `api/_lib/license-environment.ts` - Shared server-only account/Stripe/Postgres implementation plus dependency-free entitlement primitives. They own exact Checkout verification, account-device transactions, one-active-device decisions, transfer limits, production/Test isolation from trusted deployment state, short-lived access tokens, rotating refresh credentials, legacy compatibility through 1.0.13, safe OAuth return paths, restore CSRF validation, private activation-to-telemetry references, and verified account attachment after restore/transfer or fulfilled Checkout. Account-session, activation-status, verification, refresh, and download-authorization reads tolerate the pre-entitlement-lifecycle Production schema through one fail-closed JSON-based lifecycle expression, granting legacy compatibility only to the same exact one-time paid rows that the pending migration would backfill. Serverless route imports intentionally use `.js` extensions so Vercel's Node ESM runtime resolves compiled helpers.
- `api/auth/google/start.ts` and `api/auth/google/callback.ts` - Google OAuth redirect/callback and direct app Checkout-continuation handlers. They require the configured callback to share the browser-facing start origin, use short-lived HTTP-only state and opaque Checkout-capability cookies, fail closed on invalid state/capabilities, upsert `sidestream_accounts`, issue a server-side session cookie, atomically bind an activation intent to the first verified account, and enter the existing locked Checkout worker only after a valid account session exists.
- `api/auth/session.ts` and `api/auth/logout.ts` - Account-session JSON and logout endpoints used by `account.html` and `upgrade.html`.
- `api/checkout/start.ts`, `api/checkout/create.ts`, and `api/checkout/complete.ts` - Intentional one-time Sidestream Pro Checkout flow. `GET /api/checkout/start` creates or resumes only an opaque database intent and creates no Stripe resources. Activation-bearing app Upgrade links skip confirmation and continue through an existing account session or Google OAuth before the locked/idempotent worker redirects to Stripe; public website purchases without an activation retain the explicit signed same-origin confirmation POST. Completion re-fetches Stripe truth before fulfillment and returns through the literal `{CHECKOUT_SESSION_ID}` placeholder. The old Vercel host still fails closed when legacy activation context is missing.
- `api/billing/portal.ts` - Authenticated Stripe Customer Portal redirect creator for customer billing details and invoice history where Stripe has actual Invoice objects to show.
- `api/billing/receipt.ts` - Authenticated one-time purchase receipt helper. It finds the signed-in account's latest Sidestream license PaymentIntent and returns the Stripe charge receipt URL, covering older Checkout payments that did not create invoices.
- `api/stripe/webhook.ts`, `api/_lib/stripe-events.ts`, and `api/internal/stripe-events/process.ts` - Signature verification, durable event recording, leased `SKIP LOCKED` claims, retry/backoff/dead-letter isolation, and watermark-protected entitlement reconciliation. Customer/account reads do not process this queue.
- `api/_lib/maintenance.ts` and `api/internal/maintenance.ts` - Advisory-locked, bounded retention for expired sessions/credentials/limits/intents and Stripe payload redaction without deleting canonical leads or active entitlements.
- `api/activation/start.ts`, `api/activation/status.ts`, and `api/activation/claim.ts` - CEP-facing activation plus the authenticated restore/transfer/purchase decision surface. Claim GET is read-only; a Free eligible claim redirects to `/api/checkout/start` so the authenticated app flow reaches Stripe without another confirmation page, while restore or transfer requires an active-license session, same-origin CSRF-protected POST, and an explicit prior-device deactivation confirmation for a move. Of the activation-to-telemetry linkage values, only the activation key crosses the browser boundary; the telemetry install hash, private bridge UUID, and device digest remain server/CEP-side.
- `api/license/verify.ts`, `api/license/refresh.ts`, `api/license/authorize-download.ts`, `api/license/deactivate.ts`, and `api/account/device.ts` - Trusted-environment credential verification/rotation, exact active-device pre-download authorization, authenticated same-origin deactivation, and coarse read-only account device status. Stable device outcomes include `device_replaced` and `device_deactivated`.
- `db/migrations/20260626120000_add_sidestream_download_leads.sql` - Postgres schema for the private `public.sidestream_download_leads` table used by the download email gate.
- `db/migrations/20260703120000_add_sidestream_accounts_billing.sql` - Postgres schema for accounts, sessions, Stripe licenses/events, plugin activation sessions, and short-lived license tokens.
- `db/migrations/20260704120000_add_sidestream_billing_resources.sql` - Legacy Postgres schema for persisted Stripe subscription billing resources from the retired monthly-price flow.
- `db/migrations/20260704130000_allow_stripe_first_accounts.sql` - Postgres schema adjustment that allows Stripe-first account rows without a Google subject so Checkout can create/link Sidestream entitlements from webhook customer data.
- `db/migrations/20260704150000_allow_one_time_checkout_licenses.sql` - Postgres schema adjustment that lets `sidestream_licenses` store one-time Checkout Session and PaymentIntent IDs instead of requiring a Stripe subscription ID.
- `db/migrations/20260707120000_enable_sidestream_server_table_rls.sql` - Supabase hardening migration that enables RLS on server-owned Sidestream public tables and revokes direct `anon` / `authenticated` Data API access. The Vercel API routes continue to use the server-only Postgres connection.
- `db/migrations/20260713180000_add_activation_checkout_and_refresh_rotation.sql` - Adds exact Checkout attachment/expiry/grace fields to activation rows and hashed current/previous refresh credential fields with database-enforced attachment and replay-window constraints.
- `db/migrations/20260714120000_add_installer_request_tracking.sql` - Adds the server-owned `public.sidestream_installer_requests` attribution table, reporting indexes, RLS, and explicit direct-access revocations for Supabase API roles.
- `db/migrations/20260714190000_add_single_active_account_devices.sql` - Additive private schema for retained account-device lifecycle rows and confirmed device transfers. Partial unique indexes enforce at most one active row per account in each of the separate production and Test namespaces; raw device identifiers are never persisted.
- `db/migrations/20260713200000_add_api_operational_controls.sql` through `db/migrations/20260714200000_remove_redundant_download_lead_key_unique.sql` - Append-only hardening chain for the checksummed migration ledger, rate limits, credential uniqueness, Stripe claims/retries/watermarks, Checkout intents, refund/dispute lifecycle, canonical leads/replay receipts, retention indexes, and the final removal of the redundant unique `lead_key` constraint.
- `db/migrations/20260722120000_retire_customer_360.sql` - Checksummed retirement migration. It removes the retired Customer 360 read-model tables/functions and creates the private `sidestream_telemetry_identity_links` bridge with namespace/hash checks, account foreign key, RLS, and direct-access revocation. Historical migrations remain in the ledger and must not be edited or skipped.
- `db/migrations/20260722230000_add_activation_telemetry_link.sql` - Additive activation-linkage migration. It gives each private bridge row a unique server-generated UUID and adds the nullable, indexed `sidestream_activation_sessions.telemetry_identity_link_id` foreign key with `ON DELETE SET NULL`, preserving preceding-runtime writes and fail-open rollback compatibility.
- `tests/entitlement.test.mjs` - Focused Node test harness for exact paid and zero-dollar Session verification, attacker-link/pre-bind regressions, device/account binding, restore CSRF/origin checks, safe OAuth return paths, and deterministic lost-response credential replay.
- `tests/download-referral.test.mjs` - Focused Node integration and helper tests for tagged redirects, non-blocking database failures, `HEAD`/`304` exclusions, UTM validation, anonymous HMACs, and likely-scanner detection.
- `tests/license-environment.test.mjs` and `tests/single-device-*.test.mjs` - Static and disposable-Postgres proof for the complete migration chain, including installer-referral RLS, namespace isolation, policy states, database races, transfers/revocation, support tooling, account pages, download authorization, legacy compatibility, and Checkout preservation. `npm run test:single-device` is the aggregate command and requires a safe `SIDESTREAM_TEST_POSTGRES_URL`.
- `scripts/apply-postgres-migrations.mjs` - Checksummed, advisory-locked migration runner for all SQL files under `db/migrations/`, with database-backed `--status`/`--baseline`/apply, local-only `--validate`/`--dry-run`, and atomic migration-plus-ledger transactions. Its current remote TLS configuration is not Production-safe; the canonical runbook records the implementation blocker.
- `scripts/verify-migration-baseline.mjs` - Read-only exact catalog/RLS verifier for recognized pre-20260713 profiles. Its current remote TLS path is not Production-safe, so Production use is blocked until the canonical runbook's authenticated-tooling prerequisite is implemented; never use it to bless unexplained drift.
- `scripts/run-api-tests.mjs`, `scripts/run-postgres-integration.mjs`, `scripts/validate-vercel-contract.mjs`, and `scripts/verify-vercel-build.mjs` - Aggregate handler/state-machine test discovery, disposable-Postgres concurrency proof with runtime-target rejection, static Vercel route/cron contract validation, and the human-only post-`vercel build` bundle verifier.
- `scripts/audit-legacy-subscriptions.mjs` - Read-only-by-default Stripe/Product/Price inventory plus explicitly confirmed direct-database backfill/quarantine for exact allowlisted legacy subscriptions. Its current remote database connection is not Production-safe, so neither audit nor apply is authorized there.
- `scripts/audit-license-devices.mjs` - Read-only-by-default pseudonymous fleet audit plus an explicitly confirmed direct-connection backfill mode. Its current environment selection and remote TLS path block every Production mode.
- `scripts/manage-license-device.mjs` - Account/namespace-scoped support view, binding clear, and bounded expiring move-limit override. Its current environment selection and remote TLS path block every Production mode, including read-only view.
- `scripts/ensure-freedev-promo.mjs` - Maintainer utility that creates or verifies the sandbox-only Stripe `FREEDEV` 100% off promotion code used to test no-cost Sidestream Pro Checkout.
- `scripts/migrate-download-leads-to-postgres.mjs` - Legacy-named HTTP replay client for the protected `/api/internal/download-leads/replay` route. It requires a replay endpoint plus `CRON_SECRET`, preserves Blob records by default, optionally requests delete-after-commit, and explicitly rejects the removed `--apply-schema` mode. Schema application belongs only to the migration runner.
- `scripts/dump-download-leads.mjs` - Maintainer utility that dumps captured Sidestream download leads from Postgres for local/disposable inspection. Its current remote TLS path disables certificate verification, so Production use is blocked.
- `scripts/report-installer-referrals.mjs` - Maintainer-only aggregate report for a Gmail installer campaign. It reports request, likely-scanner, likely-human, and unique daily likely-human request counts by batch without returning raw request hashes. Its current remote TLS path disables certificate verification, so Production use is blocked.
- `scripts/generate-sitemap.mjs` - Post-build sitemap generator. It uses local Git history for clean builds, the file mtime for a dirty local page, and Vercel's commit metadata plus the public GitHub commits API when Vercel strips `.git` before a Git-linked build. It writes the resulting ISO timestamp only to `dist/sitemap.xml`.
- `src/main.tsx` - React entry that mounts `DemoOne` into `#shader-background-root` and renders Vercel Analytics through `@vercel/analytics/react`.
- `src/paper-shaders-compat.d.ts` - Local TypeScript compatibility declarations for the pasted prop names that the installed Paper package does not type directly.
- `src/index.css` - Tailwind v4 theme/utilities import, `tw-animate-css`, shadcn theme tokens, and source paths for the background component. It avoids Tailwind preflight so the static HTML styles are not reset.
- `components.json` - shadcn configuration with aliases rooted at the repository root.
- `vite.config.ts` - Vite React/Tailwind build config with the canonical root page, legacy redirect, account page, and upgrade page as HTML inputs.
- `vercel.json` - Vercel deployment config. Forces npm install/build/dev commands and `dist` output, permanently canonicalizes the `www` host plus old-host non-API pages, `/index.html`, and the legacy nested HTML path onto `https://sidestream.tv`, and adds `X-Robots-Tag: noindex, nofollow` to `/api/`, account, checkout-success, and upgrade responses. The old Vercel hostname intentionally executes the same deployed `/api/*` handlers in place because installed 1.0.12 panels cannot follow a POST `308`. The dev command passes Vercel's `$PORT` to Vite.
- `mockups/mockup1_2.webm` - Browser-sized autoplay alpha WebM generated from the cleaner local MacBook Pro mockup source and mounted below the pricing panels.
- `demos/search demo.mp4` and `demos/preview demo.mp4` - Autoplaying feature demo videos showing the Tudor Place search and preview workflow.
- `demos/sidestream-panel-corner.webm` - Square VP9-alpha WebM generated from the ProRes source `sidestream demo Linked Comp 01_2.mov` using the full-plugin/timeline top-left crop. Mounted as an opaque decorative Premiere/Sidestream corner inside the hero, visually scaled to 70% from the Premiere panel's top-left corner, anchored at `45vw 25vh` on desktop, clipped only by the hero-to-feature boundary, and hidden at `900px` and below.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`; the desktop header exposes Features and Account as compact glass pill links without Pricing or download CTAs
- Shader background - `#shader-background-root`, `src/main.tsx`, `components/ui/demo.tsx`, the active Paper `MeshGradient`, `components/ui/background-paper-shaders.tsx`, and `src/paper-shaders-compat.d.ts`
- Vercel Analytics - `src/main.tsx` imports `Analytics` from `@vercel/analytics/react` and renders it alongside the shader component
- SEO/GEO metadata - `<head>` metadata in `index.html` provides the title, description, robots directive, absolute canonical root URL, Open Graph/Twitter tags, sitemap hint, public OG image, and JSON-LD `Organization`, `WebSite`, `SoftwareApplication`, and `Product` graph for the product surface. Keep this crawler-readable layer aligned with visible product claims. `vercel.json` owns duplicate-host and duplicate-path `308` canonicalization; do not restore client-side redirect code in the legacy file.
- Hero - `#hero`, `.hero-split`, `.hero-copy`, `.hero-title-line`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, desktop `.desktop-download-ctas`, and the inline mobile `#mobile-download-handoff` form
- Windows download - `[data-windows-download]` lives beside the hero `[data-download]` `Download for Mac` CTA as a matching white platform pill with a Windows mark and links directly to `https://sidestream.tv/api/download?platform=win32-x64`. The old `#windows-waitlist-gate` markup and capture code remain dormant for historical compatibility, with no active page trigger.
- Feature sections - `#features` anchor, `.feature-glass` full-bleed frosted backdrop band, the two `.sec-pad` feature blocks, `.feature-subtext` heading sublines, `.shot` video frames with explicit `role="img"` labels, `.demo-video` MP4 embeds, the bottom inline viewport-playback observer, and the pointer-driven `.shot` 3D tilt handler
- Pricing - `#pricing`, `.pricing-head`, `.plans`, `.plan`, `.plan.featured`, `.beta-coming`, `.plan-beta-content`, `.beta-overlay`, `.final`, `.pricing-mockup`, `.macbook-mockup-video`, the MacBook playback helper, and the pricing-panel scroll reveal observer
- Final CTA - `.final` sits inside `#pricing` between the pricing cards and laptop mockup, with a single public installer download button
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download and upgrade actions - `[data-download]`, `[data-windows-download]`, `[data-purchase]`, `#mobile-download-handoff`, and `#toast`; desktop Mac/Windows CTAs retain their direct installers, while viewports at or below `900px` replace the hero platform choice with the email form and route lower-page download taps back to that form. Public Sidestream Pro website entry points open the no-store `/api/checkout/start` confirmation page and reach Stripe only after the signed same-origin POST. Activation-bearing app Upgrade links and authenticated Free claims skip the confirmation UI, authenticate only when needed, and reach Stripe through the same locked worker.
- Installer and update fulfillment - `data/release-manifest.json` is the default Mac release pointer and `data/release-manifest.windows.json` is the Windows beta pointer. `api/download.ts` and `api/releases/latest.ts` resolve the same platform-specific manifest so artifact and update truth cannot drift. Bare requests remain Mac, `win32-x64` selects Windows, and unknown platforms return `404` instead of silently serving the wrong OS.
- Installer referral attribution - Gmail launch URLs use `utm_source=gmail`, `utm_medium=email`, a bounded campaign ID, and optional `utm_content=pilot` or `utm_content=main` batch ID. Only a successful tagged installer `GET` creates `public.sidestream_installer_requests`; `HEAD`, `304`, invalid tags, and failed fulfillment create nothing. The event stores no email, raw IP, or raw user agent. Scanner-like `GET`s remain visible with `likely_scanner = true` so reports can separate them instead of pretending they never happened.
- Download lead capture and replay - `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/internal/download-leads/replay.ts` validate at most 8 KiB of JSON, converge repeated `(email, cta_source)` submissions, enforce 5/email and 20/IP per ten minutes, and fall back to deterministic private Blob records when Postgres fails. Scheduled replay processes 25 mapped records and deletes only after commit plus ETag match; manual replay is bounded to 100 and defaults to preserving records. Historical `windows-waitlist` rows remain queryable.
- Account/auth/billing/device entitlement - `account.html`, `thank-you.html`, `upgrade.html`, `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, `api/_lib/license-environment.ts`, `api/auth/*`, `api/checkout/*`, `api/billing/*`, `api/stripe/webhook.ts`, `api/activation/*`, `api/account/device.ts`, and `api/license/*` own optional Google account management, the server-owned $9.99 one-time Sidestream Pro Product/Price, confirmed Checkout intents, namespace-separated active-device rows, restricted Test isolation, refund/dispute lifecycle, confirmed transfers, download authorization, deactivation, and device-bound access/refresh credentials. Device mismatch policy defaults to `observe`; only explicit `enforce` blocks. The API/operator contract is `docs/api-hardening-runbook.md`; device/support details are in `docs/single-device-entitlements.md`.
- Telemetry identity association - FlowState telemetry remains the behavioral source. `api/_lib/telemetry-identity.ts`, `public.sidestream_telemetry_identity_links`, and the activation row's private foreign key provide only the narrow install-to-device/account bridge described below. Separate installations remain separate anonymous identities and converge on one account only after an explicit verified restore/transfer or Checkout action. No Customer 360 directory, materializer, sync, cron, behavioral profile, duplicated email, or duplicated payment/entitlement state is restored, and the bridge exposes no browser or admin API.
- API operations - `api/_lib/postgres.ts` owns the shared bounded runtime pool; checksummed migrations own schema changes; `api/_lib/stripe-events.ts` owns durable claimed Stripe work; `api/_lib/maintenance.ts` owns bounded cleanup/redaction; `vercel.json` schedules three `CRON_SECRET`-protected internal routes. Account reads never run migrations or drain event backlog.

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
| `/api/releases/latest` | `GET`, `HEAD`, `OPTIONS` | GET `200` public manifest, HEAD matching metadata without a body, OPTIONS `204` |
| `/api/download-lead` | `POST` | `200 {"ok":true}` after Postgres or `200 {"ok":true,"queued":true}` after private-Blob fallback |
| `/api/send-download-links` | `POST` | `200 {"ok":true}` after a durable private-Blob rate-limit/lead write and Resend acceptance; fails closed when Blob storage or email delivery is unavailable |
| `/api/auth/google/start`, `/api/auth/google/callback` | `GET` | Existing-session account/direct Checkout redirect or state-verified Google OAuth and server session creation; invalid Checkout capabilities fail closed |
| `/api/auth/session` | `GET` | Read-only account/license session JSON; it never drains Stripe events |
| `/api/auth/logout` | `POST` | Clears the server session |
| `/api/checkout/start` | `GET` | Public no-activation purchase: `200` no-store signed confirmation HTML. Activation-bearing app Upgrade: `303` to authenticated continuation. Active owners go to claim/account; checkout/start creates no Stripe resources |
| `/api/checkout/create` | `POST` | Confirmed browser form `303` to Stripe or JSON `200 {"url":"...","reused":boolean}` |
| `/api/checkout/complete` | `GET` | Exact Stripe re-verification then `303` to thank-you; not-ready is `409` |
| `/api/billing/portal`, `/api/billing/receipt` | `POST` | Authenticated Stripe portal redirect or latest receipt JSON |
| `/api/stripe/webhook` | `POST` | `200 {"received":true}` after durable insert; duplicate adds `"duplicate":true` |
| `/api/activation/start`, `/api/activation/status` | `POST` | Start returns activation key/expiry/URLs; status returns a stable activation/device state |
| `/api/activation/claim` | `GET`, `POST` | Read-only GET decision; eligible Free claims redirect into direct app Checkout, while active-owner restore or transfer requires a CSRF/same-origin POST |
| `/api/account/device` | `GET` | `200 {"active":boolean,"device":object|null}` |
| `/api/license/verify`, `/api/license/refresh`, `/api/license/authorize-download`, `/api/license/deactivate` | `POST` | Credential verification/rotation, exact `{"active":true}` download authorization, or explicit device deactivation |
| `/api/internal/stripe-events/process` | `GET` | Protected summary `{ok,claimed,processed,ignored,retryable,deadLetter}` |
| `/api/internal/download-leads/replay` | `GET`, `POST` | Protected `{ok,summary,nextCursor,hasMore}`; scheduled GET is fixed at 25/delete, manual POST accepts bounded controls |
| `/api/internal/maintenance` | `GET` | Protected `{ok,outcome,durationMs,batchSize,hasMore,counts}` |

For `/api/activation/status`, a parsed non-null JSON value with missing or invalid
required fields returns `400 invalid_request`. Valid JSON `null` is currently
dereferenced before validation; it escapes as an unshaped platform `5xx`, as do
malformed JSON and body-read failures. None of those cases is a documented `400`
response. Changing that behavior requires a separately owned handler fix and
regression test.

All internal routes require `Authorization: Bearer <CRON_SECRET>`. The one shared
token must be 16-512 printable, non-space ASCII characters (`U+0021`-`U+007E`)
so all three route validators accept the same header; generate 32 random bytes
as 64 hexadecimal characters in the approved secret manager. A missing or weak
length configuration returns `503`; missing/wrong auth returns `401`.
`vercel.json` schedules Stripe processing every five minutes, lead replay every
ten minutes, and maintenance daily at `04:13` UTC.

Vercel cron invokes the linked project's Production-target deployment, not a
Preview alias. For an isolated Test project, that Production target must run the
same audited source as the Preview being exercised and must carry an aligned
Test-only environment: Test license namespace, isolated Test database, Stripe
Sandbox, dedicated Test Google client, shared server secrets, and target-correct
base URL/host allowlist. The resolver must select that explicit Test contract
without weakening real Production isolation even though Vercel injects
`VERCEL_ENV=production` for the cron target. A configured unauthenticated `401`
or a queue event rescued through Preview does not prove scheduled cron
execution. The 2026-07-24 isolated Test cron target still fails with
`license_environment_unresolved`, and project-wide scheduling remains disabled;
do not describe automatic cron as passing until a focused resolver fix, aligned
redeployment, authenticated processor run, and terminal queue proof all pass.

### Telemetry-first account bridge

FlowState telemetry remains the source of behavioral facts. The website does
not copy or aggregate that behavior. `installIdHash` is the persistent anonymous
telemetry association for one OS profile; it is not authentication, a hardware
fingerprint, a device credential, or proof of account, device, or purchase
ownership. A reset or separate installation has a different hash and remains a
separate anonymous identity, even on the same device. Separate rows converge on
one account only after each installation participates in an explicit verified
account action.

The private `public.sidestream_telemetry_identity_links` table is keyed by the
trusted license namespace plus `installIdHash`. It first-binds that install to
the website's server-HMAC device digest. The additive
`20260722230000_add_activation_telemetry_link.sql` migration gives the bridge a
unique server-generated UUID and adds nullable, indexed
`sidestream_activation_sessions.telemetry_identity_link_id` as a foreign key
with `ON DELETE SET NULL`. This is a private correlation reference, not a new
public identity. `sidestream_accounts` relationally owns verified email/contact
identity; `sidestream_licenses` plus the Stripe event lifecycle own entitlement
and payment state; account-device tables own the active-device decision. The
bridge duplicates none of those facts.

The CEP JSON routes `/api/activation/start`, `/api/activation/status`,
`/api/license/verify`, and `/api/license/refresh` may send the optional
`installIdHash`. Omission, `null`, and an empty string skip association; any
other value must be a lowercase 64-character hexadecimal hash or the route
returns `400 invalid_request`. The value must stay out of URLs, query strings,
browser forms, browser storage, account pages, claim pages, Checkout, and logs.
`supportCode` and `installerReceiptIdHash` remain FlowState telemetry/support
concepts and are ignored by the website association path. Of the linkage values,
only the activation key crosses the CEP-to-browser claim/Checkout boundary; the
install hash, private UUID, device digest, account UUID, and credentials do not.

The linkage flow is deliberately narrow:

1. Activation start inserts the activation first. If the optional install hash
   first-binds successfully, the same transaction stores only the returned
   private UUID on that activation. A skipped, conflicting, missing-schema, or
   failed bridge operation leaves the activation valid and the reference null.
2. An authenticated, same-origin, CSRF-valid restore or transfer POST attaches
   the verified account immediately through that private reference. Claim GET
   and standalone account OAuth do not attach telemetry. Direct app Checkout
   OAuth may bind the opaque intent to the verified account and enter the
   Checkout worker, but the telemetry bridge still attaches only after canonical
   fulfillment. Legitimate same-account POST replays retry the idempotent
   attachment.
3. Checkout attaches only after canonical Stripe payment verification, active
   entitlement fulfillment, and successful activation binding. Cancelled,
   expired, unpaid, inactive, or unattached Sessions cannot attach telemetry.
4. Activation status, license verify, and license refresh keep their existing
   install-hash association calls as fallback repair after a verified account
   relationship already exists.

The bridge is deliberately fail-open after request validation: a missing bridge
schema, missing activation-reference column, or failed bridge write rolls back
to an internal savepoint while the surrounding activation, claim, Checkout,
verification, refresh, entitlement, and device operation continues. The first
device and account bindings are immutable; conflicts expose no private UUID and
never authorize a merge.

No Customer 360 directory, materializer, usage sync, cron, behavioral profile,
commerce read model, or duplicated payment/entitlement state was restored. The
website retains only this private association; FlowState retains behavioral
facts, and the relational account/license tables retain email and entitlement
authority.

#### Safe rollout order (not executed)

This ordering is a future non-Production qualification sequence, not a command
surface or evidence that any environment changed:

1. Deploy an exact reviewed artifact of the already reduced runtime that has no
   Customer 360 runtime dependency and remains compatible with the old and
   additive schemas.
2. Identify one isolated Test provider, prove it is distinct from every live
   provider/selector, take an authenticated schema and migration-ledger
   inventory, and retain a verified backup plus rollback artifacts.
3. Apply the complete checksummed chain in order, including
   `20260722120000_retire_customer_360.sql` and then
   `20260722230000_add_activation_telemetry_link.sql`; retain authenticated
   post-apply schema, ledger, checksum, RLS, and grant evidence.
4. Deploy the exact reviewed enhanced runtime containing the private activation
   reference and verified account-attachment behavior.
5. In real isolated Test browser and Premiere surfaces, prove anonymous start,
   Google-authenticated explicit restore/transfer, no-cost Test Checkout,
   credential completion, a second installation linking to the same account
   only after verified action, fallback repair, and cancelled/expired/unpaid,
   cross-account, conflict, and partial/missing-schema failure paths.
6. Stop. Any Production migration or deployment requires a separate explicit
   approval after all Production gates close.

This repository change is source-only. It performs no provider migration,
Vercel alias change, Stripe account change, CEP package change, Preview/Test
deployment, secret deletion, Test database disposal, schema apply, or Production
action. Authenticated Production migration tooling, Stripe lifecycle closure,
live-provider isolation, a runtime-distinct qualified fallback with retained
rollback artifacts, and real browser/Premiere evidence remain open blockers.
Any provider deletion, Test database disposal, or Production mutation needs its
own explicit approval and retained evidence. The complete blocker inventory
lives in `docs/api-hardening-runbook.md`.

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

Download CTAs are intentionally unblocked in the canonical HTML. Mac anchors point at `https://sidestream.tv/api/download`, while the hero Windows anchor points at `https://sidestream.tv/api/download?platform=win32-x64`, so local static previews and adjacent static hosts do not 404 on a relative API path. The old download-email and Windows-waitlist modal markup remains for historical compatibility, but visible download clicks no longer require an email before starting either installer; prior Windows leads remain queryable through `cta_source = "windows-waitlist"`.

The SaaS/account flow is server-owned. The landing-page Account link enters `/api/auth/google/start`: a valid server session goes directly to `account.html`, while a signed-out visitor enters Google OAuth and the callback creates or reconnects the account. Direct signed-out visits to `account.html` use the same entry instead of rendering an empty account panel. The Google callback origin must exactly match the browser-facing OAuth start origin; Production uses `https://sidestream.tv/api/auth/google/callback` in Google Auth Platform, keeps `SIDESTREAM_BASE_URL=https://sidestream.tv`, and requires any optional `GOOGLE_REDIRECT_URI` override to use that same callback. The start route checks this before setting state cookies, so a stale deployment setting cannot send users through Google only to fail the callback on another hostname. The session is remembered for up to 30 days by the existing HTTP-only, `SameSite=Lax` `sidestream_session` cookie; do not add a browser-readable identity cookie. While Production intentionally remains on the pre-entitlement-lifecycle schema, every customer-facing license read uses the shared `LICENSE_ENTITLEMENT_STATUS_SQL` expression to detect the missing column without runtime DDL and treats only exact one-time paid `active`/`trialing` rows as compatible Pro access; after the column exists, its canonical stored value always wins. Sign out clears the server session and returns to the landing page so the automatic account entry cannot immediately sign the user back in.

`GET /api/checkout/start` creates or resumes only a 24-hour opaque database
intent; checkout/start creates no Stripe Customer, Product, Price, or Checkout
Session. Activation-bearing app Upgrade links skip the confirmation UI. A valid
Free account session continues directly through the rate-limited locked worker;
a signed-out browser carries the capability and optional cancellation-rotation
request through state-verified Google OAuth in the 10-minute HTTP-only
`sidestream_oauth_checkout_intent` and `sidestream_oauth_checkout_rotate`
cookies. These cookies are opaque capabilities, not identity. The callback
revalidates the capability before exchange and again with the verified account;
the first verified account is atomically bound, and cross-account or otherwise
invalid capabilities fail closed without Stripe work. Active owners go to the
activation claim page or account instead of starting another purchase.

Public website purchases without an activation retain the explicit no-store
confirmation page and 10-minute signed form. Sign-in is not required for that
public purchase path. Its same-origin `POST /api/checkout/create`, and the
authenticated direct app handlers, share the 8-per-intent and 20-per-IP
15-minute limits and the same locked/idempotent worker. Signed-in activation
Checkout uses the verified account's Stripe customer and existing account
metadata. A cancellation request can expire an attached open Session and
replace it only through that worker's locked, rate-limited, attempt-specific
rotation contract; it cannot supply a Stripe or activation tuple. The worker
creates one `mode=payment` card Session for one quantity of the exact Sidestream
Pro Product/Price. The success callback re-fetches the literal
`{CHECKOUT_SESSION_ID}` and verifies payment, line item, quantity, Price,
Product, activation metadata, and attachment before fulfillment.

A canonical zero-dollar Checkout may omit a PaymentIntent. This exception is
evaluated only after the retrieved Session has passed exact Session ID,
activation, plan, Price, Product, line-item quantity, `mode=payment`,
`status=complete`, and payment-status checks. With no PaymentIntent, fulfillment
requires `amount_total === 0`, a lowercase three-letter currency, and
`payment_status` equal to either `paid` or `no_payment_required`. A nonzero
Session without a PaymentIntent still fails closed with
`missing_payment_intent`; unpaid, incomplete, mismatched, malformed-currency, or
otherwise noncanonical Sessions also remain unfulfilled. The exception does not
relax activation/account/device conflicts, one-license-per-Checkout behavior,
credential issuance, telemetry attachment, or idempotent replay.

Canonical paid access requires `entitlement_status=active` on `sidestream_pro` or compatible `sidestream_unlimited`, but the current lifecycle implementation is not complete Stripe truth. Partial refund remains `active/partial_refund`; full refund becomes irreversible `revoked/full_refund`; open inquiry/dispute statuses suspend; `won` may reactivate unless a prior `lost` was persisted; and `lost` is irreversible. Production is blocked because `refund.failed` is not handled and a failed full refund cannot restore access, while current Stripe terminal statuses `warning_closed` and `prevented` are incorrectly treated as open. A separately owned implementation/test change or an explicitly approved conservative policy plus tested customer recovery is required. The Stripe-created-at plus event-ID watermark still prevents stale Checkout, refund, dispute, or subscription events from resurrecting a later state. Legacy recurring access remains default-deny and requires an exact Product and Price in the two reviewed allowlists.

`POST /api/stripe/webhook` verifies the signature, durably records the event, and acknowledges it; it does not perform customer-state work inline. Leased workers transition `received` to `processing`, then terminal `processed`/`ignored` or bounded `retryable`/`dead_letter`. Account/session/activation reads never drain this backlog. Required event subscriptions and queue operations live in `docs/api-hardening-runbook.md`.

Plugin activation rows are device-bound. `/api/activation/status` issues one deterministic, retry-safe credential family only after verified payment or an explicit restore. Current clients may recover that family for 10 minutes after completion; legacy clients through 1.0.13 receive the same `active` response throughout the activation's 24-hour lifetime because they do not understand the terminal `completed` state. Current-client access tokens last seven days. Tokens whose database-linked activation records are from legacy clients through 1.0.13 receive a 365-day access lifetime and `/api/license/verify` rolls that expiry forward, because those clients cannot retain or rotate the paired refresh credential; this decision never trusts a spoofable request user agent. The paired opaque refresh token is hashed at rest, bound to the same device, rotates atomically through `/api/license/refresh`, and has a rolling 365-day expiry. A two-minute predecessor-hash window returns the same derived rotated pair after one lost response or concurrent retry without accepting the old credential indefinitely.

`/api/license/verify` and `/api/license/refresh` return 401 codes `invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`, and 403 `license_inactive`; callers retain credentials on transient 5xx failures. Restore uses `/api/activation/claim`: unauthenticated GET redirects through Google with an allowlisted next path, authenticated GET renders a no-store confirmation, and only an active-license, same-origin, CSRF-valid POST may CAS-bind a fresh activation whose account is still null or identical. An active Pro owner cannot start a second purchase: Checkout start/auth handlers divert activation-bearing ownership to claim and other ownership to account, while a public confirmed POST returns `409 active_license` with account/restore routes. Do not store Stripe secrets, Google client secrets, raw payment data, activation keys, license tokens, refresh tokens, or permanent paid-state in browser code or logs.

### API data ownership and migration model

`api/_lib/postgres.ts` owns one attached pool for every runtime API feature. Production chooses a pooled URL in this order: `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, then `POSTGRES_PRISMA_URL`; direct/non-pooling fallback is forbidden in production runtime. `POSTGRES_POOL_MAX` defaults to 4 and is bounded 2-20, with bounded idle, connection, query, and statement timeouts. Reviewed migrations and backfills use `SIDESTREAM_POSTGRES_URL_NON_POOLING` or `POSTGRES_URL_NON_POOLING` outside the runtime.

`scripts/apply-postgres-migrations.mjs` owns an advisory-locked SHA-256 ledger in `public.sidestream_schema_migrations`. Database-backed `--status` is authoritative for every applied/pending filename in the complete chain and fails on a tracked ledger/local checksum mismatch, but its output does not print checksum values. `--validate` and `--dry-run` are strictly local file checks: both return before env-file loading or database selection and are not Production-state evidence. A future reviewed plan needs an authenticated status implementation plus a separate authenticated read-only export of local and ledger checksums. A non-empty legacy schema requires a verified explicit `--baseline`; `scripts/verify-migration-baseline.mjs` is only the narrower known-catalog/conditional-RLS guard and does not enumerate every later hardening migration. Applying commits each pending SQL file and ledger row together. Current database-backed runner/verifier modes are blocked against Production until they authenticate the server and selected endpoint. Runtime handlers never create or alter schema. The chain ends with `20260722230000_add_activation_telemetry_link.sql`: the preceding `20260722120000_retire_customer_360.sql` preserves the historical ledger, removes the retired read model, and creates the private telemetry bridge; the final additive migration gives that bridge a private UUID and adds the nullable activation foreign key without invalidating preceding-runtime writes. The earlier lead migration still preserves canonical `(email, cta_source)` uniqueness and a non-unique `lead_key` lookup index.

Key hardened environment/configuration ownership:

| Area | Contract |
| --- | --- |
| Cron | One stable `CRON_SECRET`, 16-512 printable non-space ASCII characters (`U+0021`-`U+007E`), protects Stripe process, lead replay, and maintenance routes; use a secret-manager-generated 64-character hexadecimal token |
| Pool | `POSTGRES_POOL_MAX` defaults to 4 (2-20); idle/connection/query/statement timeout variables are bounded and documented in the runbook |
| Limiter/lead | `SIDESTREAM_RATE_LIMIT_HASH_SECRET` and `SIDESTREAM_LEAD_HASH_SECRET` are stable server-only HMAC values of at least 32 characters; `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX` selects the private fallback prefix. Pro WAF is a per-region fixed-window counter. With exactly one shared rule/counter domain spanning every reachable host, the trailing boundary burst is approximately `2 * L * R` for regional limit `L` across reachable regions `R`, plus reconciliation risk. With `H` independent host/rule counter domains it grows to approximately `2 * L * R * H`. Require `H=1` with cross-host evidence, or measure/test/approve the larger bound; otherwise use a durable shared limiter. |
| Checkout intent | Public signed confirmation and app OAuth capability cookies are fixed at 10 minutes; the database intent lasts 24 hours. Product/Price selection uses `SIDESTREAM_PRO_PRODUCT_ID`, `SIDESTREAM_PRO_PRICE_ID`, and compatible `SIDESTREAM_UNLIMITED_PRICE_ID` |
| Stripe lifecycle | Caught processing failures use fixed backoff and dead-letter at attempt 8, but process termination followed by lease reclaim has no claim-side attempt cap and can increment/reclaim indefinitely. A tested total-attempt terminal cap is a Production blocker. Legacy recurring access requires exact comma-separated `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS`; `refund.failed` handling/recovery and complete current dispute-status mapping are separate blockers. |
| License continuity | When `SIDESTREAM_LICENSE_HASH_SECRET` is absent, device hashing falls back to the first configured value from `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, or `POSTGRES_PRISMA_URL`; the runtime trims/selects and URL-normalizes that connection value first. A future reviewed plan needs a byte-preserving secret-continuity capability plus the same real device/token proof across any promotion. No such Production-safe capture/proof procedure currently exists. |
| Retention | `SIDESTREAM_MAINTENANCE_*`, session/credential/rate/intent grace variables, and Stripe processed/dead-letter payload retention variables are bounded before a query runs |
| Integration proof | `SIDESTREAM_TEST_POSTGRES_URL` is required, must be disposable, and is rejected if it matches any normalized runtime database target |

Exact defaults, bounds, required Stripe events, pool budget, and Production blockers live in `docs/api-hardening-runbook.md`.

### Single-device entitlement contract

The database model permits at most one active device row per account in each namespace, while runtime mismatch blocking depends on the policy mode below and is not yet cut over by default. Preview/development/test use a restricted, separate `test` namespace with exact Test hosts and `SIDESTREAM_TEST_POSTGRES_URL`; they are not an extra production seat and must not share a production host or database target. Same-device reconnect is free and atomically replaces any predecessor credential family for that license/device while preserving the single active device row. A confirmed different-device move revokes the previous device and counts toward three moves per rolling 30 days; first activation and a same-device reconnect do not count. The database partial unique indexes remain the concurrency backstop.

`SIDESTREAM_DEVICE_POLICY_MODE` accepts `off`, `observe`, or `enforce` and defaults to `observe`. Observe mode records pseudonymous policy mismatches; enforce returns `transfer_required`, `transfer_limit_reached`, `device_replaced`, or `device_deactivated` as appropriate. Explicitly revoked/replaced credentials remain invalid in observe mode, and `/api/license/authorize-download` always requires the exact active binding. A newly accepted Pro download is authorized before it starts; if that accepted download is already in progress, a later transfer or deactivation does not cancel it mid-transfer, but future authorization/verify/refresh requests see the new state.

Only server-secret HMAC-SHA-256 device digests plus coarse platform/version/timestamps may be persisted. Raw hardware fingerprints, raw device IDs, serial numbers, and device names are prohibited from storage and logs. OS-backed non-exportable device keys are future hardening, not protection delivered by this implementation. See `docs/single-device-entitlements.md` only for the device schema, API/page states, environment matrix, privacy rules, and conceptual support decisions. No executable Production procedure exists; `docs/api-hardening-runbook.md` records blockers and future capability requirements but authorizes no Production action.

The MacBook mockup media is a native autoplaying, muted, looping `<video>` that loads `mockups/mockup1_2.webm` from the canonical root HTML file. The generated VP9-alpha WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally. The mockup lives below the two pricing panels and the `.final` CTA inside `.pricing-mockup`, with the "Stop using sketchy websites to download music" panel now positioned above the laptop. It remains centered with a wide responsive video width and a soft bottom mask fade. It intentionally has no CSS drop shadow because filtering the alpha video can reveal a rectangular compositing edge during rotation. The bottom inline script keeps `.macbook-mockup-video` muted and calls `play()` on load/visibility return so the laptop continues spinning in normal browser viewing.

The feature cards are chrome-free video frames that use native muted, looping MP4s from `demos/`. The active demos are `search demo.mp4` and `preview demo.mp4`, both recorded around the Tudor Place workflow. The Search and Preview feature sections sit inside `.feature-glass`, a full-bleed dark translucent band with heavy `backdrop-filter` blur that separates the demo proof area from the continuous shader without changing the individual `.shot` card treatment. `.feature-corner-demo` mounts `demos/sidestream-panel-corner.webm` as a decorative VP9-alpha video inside the hero, starts at `40vw`, and uses `inset: 0 0 0 40vw` so the wrapper's bottom edge is the actual hero-to-feature boundary instead of a separate viewport-height estimate. The square full-plugin crop sits at `left: 5vw`, `top: 25vh`, `height: max(1000px, 90vw, 125%)`, `opacity: 0.9`, and `mix-blend-mode: screen`; the hero-height term keeps the recording running into that boundary on tall desktop viewports. Its `translate(-4.75%, -13.7%) scale(0.7)` transform uses the matching `4.75% 13.7%` transform origin so the visible Premiere panel's compensated top-left anchor stays at `45vw 25vh` as the desktop window changes size. The screen blend plus lowered opacity lets darker areas of the recording breathe into the shader without adding a fake background matte. Its `<source>` is desktop-gated with `media="(min-width: 901px)"`, `.feature-corner-demo` is hidden at the same breakpoint, and the bottom inline playback helper pauses it while hidden. The band spans the full feature wrapper vertically so the top and bottom separator lines have clear breathing room around the first and last demo videos. The Search and Preview feature copy blocks intentionally do not include inline download CTAs; each keeps the heading plus `.feature-subtext` as the centered copy block beside its demo video. They intentionally do not use the `autoplay` attribute; the bottom inline script uses `IntersectionObserver` to play each `.demo-video` only while it is visible and pause it when it leaves the viewport. On fine-pointer hover, the same script tilts the parent `.shot` from its midpoint with CSS variables capped at 15 degrees on X/Y and a tiny Z-axis twist, so the video frame reads as one subtle 3D plane. The hover math tracks against the card's untransformed layout box and resets with an S-curve transition to prevent corner-entry jitter. Raw Screen Studio project folders, ProRes `.mov` renders, and Premiere/After Effects project files should stay out of git; export compact MP4s or alpha WebMs for the site instead.

The page background should preserve the provided Paper demo's shader direction without keeping its demo-site UI. The canonical HTML keeps a black CSS fallback on `body`; `#shader-background-root` is a fixed full-viewport mount, and `src/main.tsx` renders the adapted `DemoOne` component from `components/ui/demo.tsx`. The demo's default `activeEffect` is `"mesh"`, so the visible background keeps the original simple black/charcoal/gray `MeshGradient` branch with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`. The active mesh branch is the plain Paper `MeshGradient`; it must not listen to pointer movement, add wake/ripple uniforms, jiggle the canvas, or layer extra mouse-driven overlays. Keep the background to the single Paper shader canvas with no drawn ripple outlines, extra canvases, new colors, CSS filters, or red fog. Page text tokens use the off-white `#E2E8F0` and translucent off-white variants for contrast, while cards and pricing surfaces are dark translucent glass.

The header is a fixed transparent overlay with no scroll divider so the shader remains uninterrupted behind the nav. The `.hero-pad` section fills the first viewport and aligns the hero headline, subline, and primary `Download for Mac` CTA to the lower-left first-fold gutter. The Sidestream wordmark and hero copy share the viewport-left `24px` first-fold gutter, and the Features/Account navigation cluster is absolutely anchored to the viewport's top-right corner with a `15px` top offset and matching `24px` right gutter. Each desktop nav link uses a compact rounded glass frame with a white-fill hover state so it stays legible as the shader moves without competing with the larger download pills. The header intentionally has no Pricing or download CTA; pricing remains available in the page body, and downloads remain available in the hero, pricing, and final CTA sections.

On desktop, `.feature-start` keeps the Search demo group below the hero with positive top padding, creating a clear margin between the hero download buttons and the "Search for YouTube videos." heading without changing the shared lower-page `.sec-pad` rhythm.

The pricing headline intentionally sits halfway between the bottom of the `.feature-glass` band and the pricing cards: `#pricing` overrides the shared section top padding to `92px`, while `.pricing-head` uses a matching `92px` bottom margin so the cards stay in place. The mobile override uses a matching `74px` top padding and bottom margin. `.pricing-line` keeps "Unlock when you need more." on its own lighter-weight line. The two pricing cards use a larger `28px` corner radius and a pricing-only `IntersectionObserver` that adds `html.pricing-motion-ready` plus `.is-visible` so the cards glide up once before they fully enter the viewport; no global `.reveal` behavior is restored. The $0 card is labeled "Free" and says "5 free downloads every day." The Pro plan is a visible `$9.99 once` public website purchase that opens `/api/checkout/start`; because it has no activation, no account is required to review and submit its explicit confirmation.

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
curl -i -X POST http://127.0.0.1:3000/api/download-lead \
  -H 'Content-Type: application/json' \
  --data '{"email":"windows@example.com","page":"/","source":"windows-waitlist"}'
```

If Vercel Blob OIDC is disabled for the Development environment, local `/api/download` returns a Blob auth/config error even though Preview and Production have Blob env attached. Fix that in the Vercel Blob store settings, or add a valid `BLOB_READ_WRITE_TOKEN` for local development. `/api/download-lead` prefers Postgres when `POSTGRES_URL` or a supported `SIDESTREAM_POSTGRES_*` connection string is available and only needs Blob auth for the fallback path.

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

The `20260707120000_enable_sidestream_server_table_rls.sql` migration is required for Supabase-hosted copies of the Sidestream SaaS tables. It locks down direct Supabase Data API access to leads, accounts, sessions, activation rows, license rows, license-token hashes, Stripe event payloads, and billing resource rows. Re-run the Supabase Security Advisor after applying it and smoke-test the Vercel API routes, because the app should keep using the server-only Postgres connection rather than browser-side Supabase policies.

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
```

For the actual zero-dollar fulfillment/replay path, follow the focused matrix
with the disposable-Postgres regression:

```bash
SIDESTREAM_TEST_POSTGRES_URL='<local-disposable-postgres-url>' npm run test:single-device-postgres
```

The pair proves zero-dollar `paid` and `no_payment_required` Sessions without a
PaymentIntent, rejection of unpaid/nonzero/incomplete/malformed cases, and
idempotent replay without duplicate license, device, credential, activation, or
telemetry-link rows. The Postgres selector must be local and disposable, with
all runtime/deployed database selectors absent; never use Preview, deployed
Test, telemetry, or Production databases.

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
- After changing the mobile handoff, run the focused `tests/download-leads.test.mjs` suite, then verify at a realistic phone width that the inline form replaces both platform buttons, invalid email stays local, success is announced, and lower download CTAs scroll back to the form. At desktop width, confirm the form is hidden and both direct platform downloads remain unchanged.
- Run `node scripts/assert-no-runtime-ddl.mjs` and `node scripts/validate-vercel-contract.mjs` after API/migration/routing work. For a human Vercel build, follow `npx vercel@latest build` with `npm run verify:vercel-build`.
- Run `node --experimental-strip-types --test tests/telemetry-identity.test.mjs tests/activation-security.test.mjs tests/entitlement.test.mjs` after telemetry bridge, activation reference, restore/transfer attachment, or verified Checkout attachment changes. The focused proof must cover distinct anonymous installations, private UUID references, read-only claim GET and no pre-fulfillment telemetry attachment across OAuth, immediate verified attachment, fallback repair, cross-account immutability, and fail-open partial/missing-schema behavior. Run `npm run test:migrations` after changing the checksummed migration chain, and use `npm run test:single-device` with a disposable `SIDESTREAM_TEST_POSTGRES_URL` after any account/device association change.
- Before any separately approved Production action, complete the safe rollout qualification in an isolated Test provider and retain real browser/Premiere evidence for anonymous start, Google-authenticated explicit claim, no-cost Test Checkout, credential completion, second-install convergence, and failure paths. Local tests, Vite, a source commit, a Vercel build, or a deployed alias alone are not that evidence.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- Run `npm run test:download-referral` after changing installer attribution or `/api/download`. It verifies that tagged `GET`s are recorded only after a successful redirect, while `HEAD`, `304`, bad platforms, fulfillment errors, database errors, and database timeouts cannot create a false successful event or block delivery.
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
- Confirm the Pro card says `$9.99 once`, links to the public no-activation `/api/checkout/start` path, renders the signed no-store purchase confirmation without a Stripe write, and does not require Google sign-in.
- Confirm the feature demo videos are paused before they enter the viewport, start playing when scrolled into view, and pause again after leaving view.
- Confirm accessibility audits do not report prohibited ARIA attributes: named `.shot` and `.pricing-mockup` visuals use `role="img"`, and the named Pro plan card uses `role="group"`.
- Confirm the Search and Preview feature sections have no inline download buttons, while the heading and subtext blocks stay vertically centered beside their demo videos on desktop and mobile.
- Confirm the `.feature-glass` backdrop spans the full x-axis behind the Search and Preview demo sections, blurs/darkens the shader behind it, and stays in its normal post-hero position.
- Confirm the decorative `.feature-corner-demo-video` keeps the visible Premiere panel's compensated top-left anchor within `1px` of `45vw 25vh` at multiple desktop window sizes, reaches the hero-to-feature boundary without an empty strip at tall ratios such as `1892x1990`, is clipped at that section boundary, keeps `.feature-glass` unmoved, and remains hidden and paused at `900px` and below.
- Confirm the top and bottom `.feature-glass` separator lines leave enough vertical breathing room around the first Search demo video and last Preview demo video.
- Confirm hovering each feature demo video tilts the frame subtly from its center, with the top-right pointer position pushing the top-right corner away from the camera, no top-left corner-entry jitter, a smooth S-curve reset on exit, and no hover tilt on reduced-motion or coarse-pointer devices.
- Confirm bare `/api/download` responds to `HEAD` with the current Mac attachment and `/api/releases/latest` returns the matching Mac manifest. Confirm `?platform=win32-x64` returns the Windows EXE/manifest, both Windows manifest links point at the platform route for v1.0.12 compatibility, and an unknown platform returns `404`. Confirm `GET` returns a temporary redirect to a signed private Blob URL; when testing the deployed route, use a ranged follow such as `curl -L -r 0-0` to avoid downloading the full installer.
- Confirm a tagged Gmail Windows `GET` using `utm_campaign=windows_beta_1_0_13` and a real `utm_content` batch creates one referral row after redirect, while the equivalent `HEAD` creates none. Use a separate smoke-test campaign or remove the exact smoke row afterward so verification does not inflate launch reporting.
- Confirm Mac and Windows download CTA clicks start their platform-specific public installers immediately without opening either historical email modal.
- In a disposable/local database, confirm `npm run leads:dump` includes seeded historical Windows waitlist submissions with `cta_source` equal to `windows-waitlist`. Do not use the current unauthenticated-TLS dump client to inspect Production; that check waits for the runbook's authenticated export-tool prerequisite.
- With Vercel dev and account env configured, confirm public `GET /api/checkout/start` without an activation renders confirmation, makes no Stripe write, and reaches the worker only after its signed same-origin `POST /api/checkout/create`. Confirm an activation-bearing app Upgrade skips confirmation: a valid Free session redirects through the locked worker to Stripe, while a signed-out browser completes state-verified Google OAuth first. Invalid/stale/cross-account capabilities must fail closed before Stripe work; active owners must go to claim/account. Confirm cancellation rotation expires/replaces only through the same rate-limited locked worker, successful Checkout passes through `/api/checkout/complete` to `/thank-you.html`, `/account.html` can still sign in with Google, receipt and Customer Portal work, the webhook only records/queues signed Stripe events, and account/session reads never process queue backlog.
- On the signed-in desktop account page, confirm every row action shares the panel's right edge, including wrapped receipt and refund controls; below `680px`, confirm the controls remain full-width.
- From a signed-out browser, confirm the landing-page Account link and a direct `/account.html` visit enter Google OAuth without rendering the account headline or an empty sign-in panel. Confirm Google's `redirect_uri` is exactly `https://sidestream.tv/api/auth/google/callback`, stale or mismatched OAuth state renders the flat retry page instead of raw JSON, and a real Google round trip returns to the signed-in account page. From a browser with a valid `sidestream_session` cookie, confirm the Account link skips Google and opens the account page. Confirm Sign out clears the session and returns to `/`, and confirm the account background is a flat near-black with no red gradient.
- Run `npm run test:entitlement`. Confirm zero-dollar `paid` and `no_payment_required` Sessions without a PaymentIntent fulfill only after all exact Checkout checks, while unpaid, nonzero, incomplete, and malformed-currency variants fail closed. Confirm `/api/activation/start` rejects a missing device ID and returns `activationKey`, 24-hour `expiresAt`, `upgradeUrl`, and `restoreUrl`; status rejects a wrong device, stays pending before payment, and returns one seven-day access token plus a rotating 365-day refresh token only after exact Stripe verification. Confirm a webhook-delayed paid Session self-reconciles, an unpaid Session never binds, a repeated current-client status call returns the same credential family only inside the 10-minute completion replay window, and status cannot mint after that window or activation expiry. Separately confirm legacy clients through 1.0.13 receive `active` throughout the unexpired activation window, their access expiry rolls forward on verify, and old-host Checkout without an activation redirects to the non-purchasing `activation_required` state before Stripe.
- Run `SIDESTREAM_TEST_POSTGRES_URL='<local-disposable-postgres-url>' npm run test:single-device-postgres` after changing zero-dollar reconciliation or fulfillment. Confirm two exact completion calls keep one license, active device, credential family, activation, and telemetry link, and that rejected missing-PaymentIntent cases attach no account or entitlement state.
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

- `installIdHash` is a persistent OS-profile telemetry association, not authentication, hardware identity, a credential, or ownership proof. A reset or separate installation remains a separate anonymous row even when it uses the same device. Never use the value to authorize access, select an account, prove device/account ownership, infer payment, or silently merge installations; convergence requires an explicit verified account action for each installation.
- The private bridge UUID and `sidestream_activation_sessions.telemetry_identity_link_id` are server-only correlation references. Of these linkage values, only the activation key crosses claim/OAuth/Checkout browser surfaces. Keep the install hash, bridge UUID, device digest, account UUID, email, payment state, and credentials out of URLs, forms, browser storage, responses, and logs.
- Restore/transfer POST and verified Checkout perform the immediate account attachment; status, verify, and refresh are idempotent fallback repair. Telemetry conflict or unavailability must remain fail-open and cannot change the customer activation, claim, Checkout, entitlement, or device result.
- The documented Test-first rollout order is intentionally non-executable. Do not skip directly to the additive migration or enhanced runtime, and do not treat local checks as closure for authenticated Production tooling, Stripe lifecycle, live-provider isolation, rollback artifacts, or real browser/Premiere proof.
- The Customer 360 retirement migration drops both row-mutation and statement-level `no_truncate` guards before removing the retired review/merge functions. Some isolated Test ledgers include those later hardening triggers even when their historical Test-only migration files are not part of the portable repository chain; restore only byte-identical ledger files in an isolated runner workspace for status validation, never rewrite or bypass their ledger rows.
- The telemetry bridge intentionally ignores support code and installer receipt values. Do not add them to website requests, account pages, URLs, browser state, or the bridge table; FlowState owns their telemetry/support meaning.
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
- Mac and Windows download CTAs use `[data-download]` and `[data-windows-download]` overrides that win over primary/secondary button classes: matching white capsule backgrounds, black platform marks and text, and red hover fills with white text while preserving existing sizing. Both hero buttons show `Download` with explicit platform-specific accessible labels; the pricing and final Mac CTAs retain `Free Download` with `aria-label="Free Download for Mac"`. The header intentionally has no download CTA. All visible Mac download CTAs should point at `https://sidestream.tv/api/download` unless the fulfillment host intentionally changes. Do not reintroduce the email modal as a blocking step without explicitly revisiting the unblocked installer strategy.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav. Keep `.nav-links` anchored from the full viewport rather than the centered first-fold shell, or the control cluster drifts inward on wider screens.
- The desktop Features/Pricing/Account links use individual compact glass pills with a `10px` gap. Keep them visually quieter than the solid white download CTAs, retain the white-fill hover and focus treatment, and remember that the entire nav remains hidden at `900px` and below.
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
- Vercel compiles TypeScript API routes to Node ESM. Keep relative imports between API route files extension-explicit, such as `../_lib/account.js`; extensionless helper imports can pass local typecheck but fail in production with `ERR_MODULE_NOT_FOUND`.
- Local account/billing testing requires Vercel dev plus local/test Postgres and Stripe configuration. `SIDESTREAM_LICENSE_HASH_SECRET` must be stable and server-only; when absent, device hashing falls back to the first configured runtime URL after selection and URL normalization. The repository has no byte-safe Production continuity launcher or canary procedure, so any URL/pool change remains blocked until a separately reviewed mechanism preserves those exact bytes and proves the same real device/token across promotion. `SIDESTREAM_PRO_PRODUCT_ID` defaults to `prod_UpwXh6oO1OmPyQ`; runtime Price discovery checks explicit Pro Price, the empty code default, compatible Unlimited fallback, Product `default_price`, exact `sidestream_pro_once_999` lookup key, then any other active matching Product Price. Runtime compatibility is not Production approval. Use placeholders for local Stripe testing and rotate any secret pasted into chat.
- Production currently lacks `sidestream_licenses.entitlement_status`. Customer-facing reads must use `LICENSE_ENTITLEMENT_STATUS_SQL`; a direct `l.entitlement_status` reference fails at PostgreSQL parse time before fallback logic can run. Do not repair that incident with runtime DDL, a manual column addition, or an unreviewed lifecycle migration. The compatibility expression prefers canonical stored state when present and otherwise recognizes only the exact one-time paid rows the pending migration would backfill.
- License environment resolution fails closed unless deployment state, trusted host, and selected database agree. Production uses `SIDESTREAM_POSTGRES_URL`; preview/development/test require exact `SIDESTREAM_TEST_API_HOSTS` plus a distinct `SIDESTREAM_TEST_POSTGRES_URL`. Client `buildChannel` is diagnostic only and cannot select a namespace.
- A missing PaymentIntent is not generally equivalent to payment. It is accepted only for an otherwise-canonical zero-dollar Checkout with exact zero total, lowercase three-letter currency, and `payment_status` of `paid` or `no_payment_required`; nonzero missing-PaymentIntent Sessions still fail closed.
- Vercel cron for an isolated Test project runs that project's Production target, not its Preview alias. Keep the audited source and Test-only provider/namespace contract aligned across both targets, while preserving target-specific base URL and host values. The current isolated cron target's `VERCEL_ENV=production` conflict remains unresolved and project-wide cron scheduling is disabled; a successful Preview replay is not cron proof.
- The Postgres migration runner has a checksummed ledger and advisory lock. Database-backed `npm run db:migrate -- --status` is authoritative for complete applied/pending filenames and rejects ledger/local checksum drift, but it prints no checksum values. `--validate` and `--dry-run` are local-only and cannot prove a Production target or state. The runner, baseline verifier, legacy audit/apply, device tools, campaign report, and lead dump currently permit remote TLS without authenticated certificate/hostname proof, so Production use is blocked until code-owned changes enforce clean selection, provider CA trust, verify-full-equivalent validation, and connected-target evidence. No authenticated Production status/checksum procedure or qualified runtime-distinct fallback currently exists.
- Current env-file ingestion is not a Production-safe launcher: the migration runner loads `SIDESTREAM_ENV_FILE` before `SIDESTREAM_DB_ENV_FILE`, Node env files can apply startup options before inline validation, and inherited selectors survive. A future pinned and integrity-attested launcher must validate raw bytes and exact keys before Node, reject NUL/unknown/duplicate/empty/malformed entries, start from an empty environment, and keep secrets out of argv. No current command surface closes this blocker.
- Migration `20260714200000_remove_redundant_download_lead_key_unique.sql` is not compatible with the pre-hardening `c34ef25` lead writer: that code uses `ON CONFLICT (lead_key)` after the required unique constraint has been removed, so an otherwise-valid capture that reaches Postgres fails and can enter Blob fallback without consuming the database limiter. No runtime-distinct, full-chain-qualified fallback artifact is recorded yet: `git diff --name-only c93bc09..HEAD` contains only these documentation files, so `c93bc09` is the same hardened runtime, not an application rollback. Production mutation is blocked until a different runtime artifact is built, preserved, and proved against the complete migration chain; never treat an arbitrary prior deployment or a docs-only commit difference as rollback-safe.
- Vercel Preview/Test remains the only Stripe test-mode lifecycle proof. No staged Production artifact, actual-runtime-selector attestation, signed qualification, or promotion proof exists. A future reviewed plan needs pinned provider tooling or an owner-authenticated API that proves exact immutable release/fallback identities, project/team, target, commit/build, aliases, protection, metadata, and actual selector overrides including explicit empty values.
- The current repository has no Production maintenance rule or operator bypass. A future reviewed plan needs a complete effective firewall/hostname/order export and a tested exact rule matrix; custom-rule bypasses skip later custom and managed WAF rules, and tagged download GETs can schedule referral writes. Until those controls exist, no Production firewall mutation or operator route invocation is authorized.
- Any future maintenance or fallback plan must keep the live Stripe event destination enabled, complete an exact pre-drain, and preserve its earliest boundary/timers. Every future main and fallback path must freeze a provisional historical scan after pre-drain but before boundary/deny activation, then consume its exact manifest/checksum/watermark in a post-deny full/delta reconciliation after old writes drain and before migration, promotion, fallback, or reopening. Queue terminality is not canonical-state proof. Live automatic retries last at most three days, Dashboard/Workbench resend at most 15 days, and Stripe CLI resend at most 30 days; events created while a destination is disabled do not auto-resend.
- Vercel cron scheduling is a project-wide disable/enable control for the three routes in `vercel.json`; the repo has no one-job toggle, per-job kill switch, approved operator bypass, or secret-safe launcher. That gap blocks Production operation until a separately reviewed control and invocation design exists.
- Switching a deployment from sandbox/test Stripe keys to live Stripe keys can leave existing account rows with customer IDs from the old mode. `findOrCreateStripeCustomer()` validates a saved customer against the currently configured Stripe mode before Checkout reuse and creates a fresh customer if Stripe returns `resource_missing`.
- Checkout Sessions currently pin `payment_method_types: ["card"]` so live Checkout works even before Stripe Dynamic Payment Methods are configured in the dashboard. Revisit this once the live Stripe account has the desired payment methods enabled.
- If a successful purchase still shows Free in the account page or plugin, check `/api/stripe/webhook`, `/api/checkout/complete`, activation logs, and Stripe queue evidence; current migration `--status` is loopback-disposable only, and Production requires the future reviewed authenticated status procedure. Runtime routes intentionally do not execute DDL, account/session reads do not drain the queue, and the status fallback cannot repair a missing migration, unattached Session, refund, dispute, or poisoned event.
- Hosted Checkout only accepts promotion codes that already exist in the same Stripe account and mode as `STRIPE_SECRET_KEY`. The repo utility `npm run billing:ensure-freedev` creates or verifies the sandbox `FREEDEV` 100% off promotion code and refuses live keys unless `--allow-live` is passed intentionally. If Stripe Checkout says `FREEDEV` is invalid, first confirm the Checkout page is in sandbox mode, then run the utility with the same env file that powers that deployment. Vercel protected env pulls can return `STRIPE_SECRET_KEY=""`; in that case, use an ignored local env file through `SIDESTREAM_STRIPE_ENV_FILE`.
- Plain static servers such as `python -m http.server` do not compile `/src/main.tsx`, so the static HTML route can appear to lose the Paper shader background even though the markup is correct. Static servers also cannot serve local Vercel Functions; the visible download CTAs use the public Vercel download URL so static preview clicks still start the installer instead of hitting a local `/api/download` 404. Use Vite on the active preview port when visual-checking the background, and Vercel dev when testing the API routes themselves.
- Vercel Analytics depends on the compiled React entry in `src/main.tsx`. If analytics stops appearing, confirm the shader root still exists in the canonical HTML, the deployed bundle includes `@vercel/analytics/react`, the page was visited on the deployed Vercel URL, and content blockers are disabled for the check.
- Vercel CLI versions before the current `54.x` line can report stale Blob auth/token errors. Prefer `npx vercel@latest ...` for Blob store checks.
- `/api/download` uses the Blob SDK control-plane calls (`head`, `issueSignedToken`, `presignUrl`) and redirects on `GET`. Do not switch it back to SDK `get()` proxy streaming unless you have verified private object fetches in the deployed Vercel runtime; a broken `GET` can still look healthy if only `HEAD` is checked.
- Installer attribution deliberately measures successful signed-redirect requests, not completed Blob transfers. Email security scanners can issue `GET`; keep their rows and use `likely_scanner` as a transparent heuristic. Do not label request counts as downloads, installs, first opens, or active users.
- `SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET` is a stable server-only HMAC secret for privacy-limited daily request deduplication. Preserve it across database credential rotations, never expose it in browser or CEP code, and never store the raw request IP or user agent in `sidestream_installer_requests`.
- Keep per-request installer attribution only as long as launch analysis needs it. Preserve aggregate campaign totals if useful, then delete the request rows after 90 days so the anonymous HMACs do not become an indefinite behavioral history.
- Without `vercel.json`, `vercel dev` may inherit a Yarn command from the Vercel project settings and hang on machines without Yarn.
- Vercel's path redirect patterns do not match the bare `/` request. Keep the explicit host-conditioned `/` rules for `www.sidestream.tv` and `sidestream-xi.vercel.app` ahead of the path-preserving catchalls; keep the old-host path rule narrowed with `/:path((?!api/).*)` so static pages canonicalize while legacy CEP POST APIs execute without a `308`.
- `.vercelignore` deliberately strips `.git` before Git-linked builds. The sitemap generator therefore resolves `index.html`'s most recent commit through Vercel's `VERCEL_GIT_*` metadata and GitHub's public commits API; it fails the build instead of publishing an invented date when that provenance lookup is unavailable.
- The private Blob store currently has OIDC/env wired for Preview and Production. Development has `BLOB_STORE_ID` and the installer pathname, but local Blob reads still need Development OIDC enabled in Vercel Blob settings or a `BLOB_READ_WRITE_TOKEN`.
- Check the Vercel Blob/CDN usage guardrails and live Pro usage before changing installer artifacts, `/api/download`, CTA/email-gate volume, or demo media. The current Mac artifact is about 216 MiB, so even usage-billed transfer can climb quickly during a real launch.
- Production, Preview, and Development should resolve the manifest artifact pathname to the uploaded native/base `sidestream/1.0.12/Sidestream-1.0.12-Mac-Installer.dmg` artifact. The `Mac-ZXP-Installer.dmg` path is the retired ZXP-helper handoff and should not be used for the public website download.
- The email gate is a website CTA gate, not hard security. A direct request to `/api/download` still serves the installer; true server-enforced lead capture would require issuing download tokens or moving `/api/download` behind a verified lead/session check.
- The Windows waitlist is historical: its modal/capture code and `cta_source = "windows-waitlist"` rows remain, but there is no active trigger after the hero pill became a direct platform download. Reuse `/api/download-lead` if that lead flow is intentionally revived instead of creating a duplicate client-only endpoint or table.
- Mobile download email delivery requires the server-only `RESEND_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `SIDESTREAM_LEAD_HASH_SECRET`, and `SIDESTREAM_RATE_LIMIT_HASH_SECRET` in Preview and Production. It defaults to `Sidestream <downloads@alexg.mov>` with replies sent to `alex@alexg.mov`; optional `SIDESTREAM_DOWNLOAD_EMAIL_FROM` and `SIDESTREAM_DOWNLOAD_EMAIL_REPLY_TO` overrides must not contain line breaks. The public route stores the lead in the existing deterministic private replay queue and consumes durable HMAC-keyed email/IP counters with Blob ETag compare-and-swap writes. It refuses to send when either private write fails, and the browser reuses one idempotency key across an uncertain retry so Resend cannot duplicate the same accepted request.
- Download-lead capture and SaaS entitlement storage share the bounded server-only pool in `api/_lib/postgres.ts`. Production precedence is `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, then `POSTGRES_PRISMA_URL`; direct/non-pooling fallback is rejected in production runtime and belongs only to reviewed tools/development/test. Do not expose any private database URL to HTML, React browser code, or the CEP plugin.
- `CRON_SECRET` is the one 16-512 character scheduler secret for all three internal routes, but the common denominator is stricter: every character must be printable non-space ASCII (`U+0021`-`U+007E`) because lead replay rejects spaces and non-ASCII even though the other routes compare the whole header. Generate a 64-character hexadecimal token from 32 random bytes in the approved secret manager. Missing configuration must produce `503`, wrong/missing bearer auth must produce `401`, and the value must never appear in commands captured by logs or in committed files.
- Checkout and lead rate limits are atomic Postgres controls, not a substitute for edge protection. The Blob fallback cannot consume the database lead limiter. Vercel Pro WAF uses per-region fixed windows. Only one shared rule/counter domain spanning all reachable hosts keeps the trailing-boundary estimate at approximately `2 * L * R`, plus regional reconciliation risk. If host-specific or duplicated rules create `H` independent counter domains, the estimate is approximately `2 * L * R * H`; cross-host boundary tests must measure that larger exposure. Require an explicit rejecting action plus security approval, or a durable shared fallback limiter; if the counter domain or bound cannot be proved, cutover is blocked.
- Stripe lifecycle cutover is blocked until `refund.failed` has a tested recovery transition (or an explicitly approved permanent-revocation policy plus tested manual customer recovery) and every current Dispute status, including terminal `warning_closed` and `prevented`, has a tested mapping or approved conservative policy. Current code has neither approval path and must not be described as complete canonical Stripe truth.
- No executable live one-time Pro catalog proof exists. A future owner-authenticated provider/runtime proof must bind the exact configured/default Product and selected Price to the immutable deployed artifact, mirror runtime precedence, create nothing, and retain exact-ID, live/active, linkage, one-time USD 999, and checksum evidence. The recurring legacy proof is not a substitute.
- Legacy subscription access is default-deny. Before either audit or apply, a clean-environment catalog gate must reject malformed allowlist entries, assert the exact expected ID sets, and directly retrieve every expected live Product and Price. It must prove livemode, active state, Price-to-Product linkage, recurring shape, exact amount, and currency; the audit script's database-referenced subset is not catalog proof.
- Historical lifecycle reconciliation is a separate pre-cutover blocker. The repository has no tested idempotent tool that can find and repair refund/dispute events terminalized by the known-bad mapper. Any future tool must retain an inclusive high-watermark, exact-ID/type manifest/checksum, source and authenticated-target evidence, canonical outcomes, and entitlement watermarks; produce that provisional evidence on both main and fallback paths after pre-drain but before boundary/deny activation; consume the exact evidence in a post-deny full/delta reconciliation; and prove an idempotent no-op rerun before migration or reopening. Manual ledger or entitlement edits are forbidden.
- Stripe payload retention redacts processed work after 14 days by default and dead-letter work after 90 days by default; event identity and audit metadata remain. Maintenance deletes bounded expired operational rows, never canonical leads or active entitlements. Alert on unexpected deletion/redaction counts instead of disabling retention blindly.
- Stripe `dead_letter` rows are terminal and the repository currently has no reset/replay CLI or route for them. Any dead letter during Preview/Test blocks promotion; in production, preserve its payload, globally disable cron scheduling if processing must stop, and require a separately reviewed, event-specific recovery implementation before attempting replay. Do not update queue status or entitlement rows by hand.
- Stripe's documented attempt-8 dead-letter bound applies only when the processor catches a failure and runs `markStripeEventFailure`. A process termination leaves the row `processing`; after lease expiry the claim query has no `attempt_count` ceiling, reclaims it, and increments again. Repeated crash/reclaim cycles are therefore unbounded in current code. Production is blocked until the claim/reclaim path has a tested total-attempt terminal cap and alert; meanwhile any nonterminal row at or above the nominal cap is critical evidence, not a successful bounded retry.
- Supabase-hosted Sidestream SaaS tables must keep RLS enabled with no direct `anon` or `authenticated` table access. If a future feature needs browser-side Supabase reads or writes, add the narrow policy for that feature intentionally and document the public data shape; do not make the private account, session, activation, license, license-token, Stripe event, or lead tables broadly API-readable.
- The canonical URL is the deployed root, `https://sidestream.tv/`. Keep every crawler-facing URL in the HTML head, sitemap, `llms.txt`, and README pointed at `/`; keep the duplicate-host and duplicate-path canonicalization in `vercel.json` as server-side `308` rules. The legacy fallback file must remain inert and `noindex`, not become a second client-side redirect implementation.
- Keep structured data conservative and matched to visible page claims. Do not add FAQ, review, rating, or price claims unless the same facts are present in the visible landing page.
- `llms.txt` is useful as an AI-readable summary, but it is not a substitute for crawlable HTML, normal metadata, structured data, sitemap hygiene, or external citations/backlinks.

## Recent Change Log

- 2026-07-24: Made repeated same-device reconnects credential-idempotent: issuing a new activation credential family now revokes the predecessor for the exact account/license/device inside the existing account-device transaction, leaving one live family without consuming a device move.
- 2026-07-24: Removed the remaining app-flow Checkout interstitial: an authenticated Free activation claim now redirects to `/api/checkout/start`, which sends the existing session through the locked worker and directly to Stripe. Restore and transfer confirmations remain explicit because they can change the active device; public website purchases still retain their separate confirmation page.
- 2026-07-24: Split Checkout entry by source: activation-bearing app Upgrade links now skip the confirmation UI, use an existing valid account session or state-verified Google OAuth, bind the first verified account, and enter the existing locked/rate-limited worker; public website purchases without an activation retain the explicit signed confirmation POST. `checkout/start` itself still creates no Stripe resources, invalid capabilities fail closed, active owners divert to claim/account, and cancellation remains a bounded worker-owned rotation. The OAuth handoff uses explicit result discriminants so Vercel's serverless TypeScript analysis narrows the Checkout worker result consistently. The change is deployed only to the isolated Test aliases; the real `sidestream.tv` Production project is untouched.
- 2026-07-24: Added the fail-closed zero-dollar Checkout exception and its focused regressions: canonical zero-total `paid` or `no_payment_required` Sessions may omit a PaymentIntent only after exact Session/activation/Price/Product/quantity checks. Documented that isolated Test cron runs the project's Production target; the automatic cron target remains failed and six interactive identity rows remain blocked, so this change does not claim final live acceptance.
- 2026-07-22: The Customer 360 retirement migration now removes the isolated-Test `no_truncate` guards before dropping their immutable trigger functions, allowing the checksummed retirement to run against the previously hardened Test schema without `CASCADE` or ledger bypass.
- 2026-07-22: Added the source-only activation-to-telemetry reference and verified account-linkage contract. Activation start stores a private bridge UUID when available; restore/transfer POST and fulfilled Checkout attach immediately, while status/verify/refresh remain repair paths. No provider, Vercel alias, Stripe account, CEP package, Preview, Test, or Production environment was changed.
- 2026-07-22: Retired the Customer 360 runtime and consolidated documentation around the private telemetry-first install/device/account bridge. The source change performed no provider migration, deployment, secret deletion, Test database disposal, schema apply, or Production action; all live target inventory, migration, deployment, and real-flow proof remains separately human-gated.

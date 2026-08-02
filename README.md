# Sidestream Landing Page

## Product Overview

Sidestream is an HTML-first landing page for a Premiere Pro panel that lets editors search, preview, and download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The main page remains a single canonical HTML document with embedded layout CSS and vanilla JavaScript, plus a small React/Tailwind layer mounted only for the full-page Paper shader background.

This repository owns the whole Sidestream web service: the public/account frontend, Vercel middleware and APIs, website database migrations, release manifests, tests, and deployment scripts. Keeping the frontend and server together preserves one deployable web contract. The Premiere extension/app remains separately owned by `/Users/alexgarrett/alexg.mov/nle-plugins/FlowState` because it has a different runtime, build, signing, installation, and release lifecycle.

## File Map

- `AGENTS.md` - Durable repository instructions for the exact Upgrade, Google authentication, and Stripe sequence plus the only supported Production deployment command.
- `Sidestream front end 2/Sidestream.html` - Inert `noindex` fallback document for the old exported page URL. Production requests never serve it because `vercel.json` sends the legacy path to `https://sidestream.tv/` with a server-side `308`.
- `index.html` - Canonical page implementation served at `/`. Contains the shader mount root, header, hero, desktop Mac/Windows download CTAs in the hero and Free pricing card, optional mobile email handoff plus no-email secure computer-link sharing, dormant historical waitlist modal, feature sections, pricing, final CTA, footer, styles, rotating-word script, toast behavior, crawler metadata, and structured data.
- `public/robots.txt` - Public crawler policy copied to `/robots.txt` by Vite. Allows normal search plus OpenAI `OAI-SearchBot`, blocks all `/api/` routes from automatic crawlers, and opts out of training-oriented `GPTBot` separately.
- `public/sitemap.xml` - Valid source template for the canonical root-only XML sitemap. It intentionally contains no hand-maintained date; the build replaces its marker in `dist/sitemap.xml` with the root page's last meaningful source modification time.
- `public/llms.txt` - Concise AI-readable product summary and canonical-source guide for LLM/search agents. It is additive and does not replace normal SEO metadata or visible page content.
- `public/sidestream-social-card-v3.png` - Exact 3104×1614 landing-page screenshot used by Open Graph, X, and structured data. Social metadata uses the versioned filename, and fresh X posts should use `https://sidestream.tv/?card=v3` so X cannot reuse the root URL's older cached card.
- `components/ui/demo.tsx` - Adapted Paper demo component mounted as the page background. The active default effect keeps the original simple `MeshGradient` look with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`, with demo install/clipboard overlay text removed and no background mouse interaction.
- `components/ui/background-paper-shaders.tsx` - Exact pasted React Three Fiber shader primitives from the provided reference. They are kept as optional reference code and are not mounted by default.
- `account.html` - Minimal noindex account bridge on a plain near-black background. Signed-out visits immediately enter Google OAuth, while the server auth session shows returning users their plan status, coarse active-production-device status, explicit device deactivation, latest installer, sign out, and a Manage Billing button that creates a Stripe Customer Portal session.
- `docs/single-device-entitlements.md` - Device-domain and support reference for the two-active-device contract, privacy boundary, API/page states, and conceptual support decisions. Its obsolete Production command surface has been removed; it authorizes no Production action and points to the API runbook only for blocker/capability status.
- `docs/api-hardening-runbook.md` - Exact hardened API/release contract, shared Postgres and migration model, Stripe/lead/maintenance facts, bounded configuration, metrics, alerts, guarded Customer 360 operator commands, and the remaining full-service Production blockers. It does not claim Production was changed.
- `docs/customer-360.md` - Durable cross-repo Customer 360 contract: four separate identities (browser session, install/receipt evidence, sparse profile, and later verified account/contact), exact cookie/download/mobile-handoff/one-time-claim continuity, deterministic paid/anonymous/email attribution, private list/detail/funnel fields, usage semantics, TLS-safe guarded migration/backfill/sync/rescan commands, privacy/no-delete rules, environment-variable names, and the human-gated Preview/Test then Production configuration/deploy/scheduler/release/rollback/smoke sequence. It authorizes and claims no external operation; current Production behavior remains unverified until those gates are separately approved and observed.
- `thank-you.html` - Minimal noindex Checkout success page on a solid black background. Stripe success URLs land here after purchase with a direct return-to-Premiere instruction and one concise recovery path if the panel still shows Free.
- `paid-thank-you.html` - Phone-first noindex success page used only by verified paid-acquisition Checkout. It tells the buyer to find the separate Sidestream setup email on their Premiere computer, install from its receipt-gated platform link, and authenticate with the same Google email used at Checkout. The original `thank-you.html` remains the ordinary Upgrade/Restore destination.
- `data/release-manifest.json` and `data/release-manifest.windows.json` - Sidestream-owned stable release manifests. The default file keeps the public Mac artifact; the Windows file is selected by the explicit `win32-x64` platform query used by the public Windows download CTA. Private Blob pathnames are never returned by the public manifest API.
- `api/download.ts` - Vercel Node Function for installer fulfillment. `HEAD` returns attachment metadata for the manifest-configured private Vercel Blob installer, and `GET` validates the Blob then redirects to a short-lived signed private Blob URL. A valid anonymous first-touch cookie is reused, or a bounded direct/UTM cookie is created; session/first-installer-request persistence happens best-effort after the redirect and cannot block delivery. Successful Gmail campaign `GET`s are also recorded only after the redirect response ends. Bare requests remain Mac; `?platform=win32-x64` selects the Windows artifact. Supports `GET` and `HEAD` only.
- `api/_lib/installer-referral.ts` - Server-only Gmail installer-request attribution. It validates bounded UTM tags, accepts only `pilot` or `main` batch content, creates a campaign/day-scoped HMAC from request identity, discards the raw IP and user agent, flags likely link scanners, and inserts the privacy-limited event into Postgres without delaying installer delivery.
- `api/referral-visit.ts` and `api/_lib/referral-visits.ts` - First-party landing-referral attribution for the dedicated `https://sidestream.tv/manychat-instagram` organic Instagram ManyChat link and the legacy generic ManyChat routes. A real page load posts the allowlisted `manychat-instagram` or `manychat` source, receives `204` without waiting for storage, and writes at most one private Blob record per anonymous request fingerprint/day/classification. Daily HMACs reuse the installer-analytics secret; raw IP and user-agent values are never stored.
- `api/releases/latest.ts` and `api/_lib/release-manifest.ts` - Sidestream-owned update manifest endpoint for the CEP panel. It selects the Mac or Windows manifest by platform and serves public metadata without exposing the private Blob pathname.
- `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/_lib/download-lead-blob.ts` - Bounded JSON lead ingestion, canonical `(email, cta_source)` convergence, idempotency receipts, atomic Postgres email/IP rate limits, deterministic private-Blob fallback, and the private compare-and-swap Blob limiter used by the mobile email handoff. `api/internal/download-leads/replay.ts` replays mapped fallback records and deletes only after a committed database write plus ETag match.
- `api/send-download-links.ts`, `api/_lib/acquisition-handoff.ts`, and `api/_lib/download-link-email.ts` - Mobile computer continuity. The email path requires idempotency, stores the bounded `mobile-download-handoff` lead, enforces durable hashed 3/email and 10/IP per-hour limits, and sends separate signed Mac/Windows links. The no-email path accepts only `{"handoffOnly":true}` and returns one shareable secure link. Both links contain exactly one opaque encrypted/signed seven-day `handoff`; computer GET restores the acquisition cookie and redirects to the unchanged installer route. Forged, expired, duplicated, or identity-augmented handoffs return `404`. Provider errors and logs never return or print the recipient address.
- `api/_lib/acquisition-cookie.ts`, `api/_lib/anonymous-acquisition.ts`, `api/_lib/anonymous-install-claim.ts`, `api/installation/claim*.ts`, and `db/migrations/20260731120000_add_anonymous_acquisition_sessions.sql` - Private anonymous browser-to-install continuity. The server stores only a browser-token digest and bounded immutable first touch, optional signed experiment, first installer request, claim/quarantine state, and append-only conflict digest. After local receipt verification, the panel posts only `installIdHash` plus `installerReceiptIdHash`, receives a 15-minute opaque browser nonce, and connects the signed browser session to a sparse Customer 360 profile exactly once. Missing configuration fails association closed without blocking the page or installer.
- `api/_lib/postgres.ts` and `api/_lib/rate-limit.ts` - Shared attached runtime Postgres pool/transaction ownership and atomic HMAC-dimension rate limiting. Production runtime requires a pooled URL; direct URLs are reserved for reviewed migrations/backfills and development/test fallback.
- `api/_lib/customer-profiles.ts` and `tests/customer-360/core*.test.mjs` - Server-only Customer 360 identity/profile primitives, transactional merge planning, privacy-contract proof, and disposable-Postgres coverage. Merge survivors follow the database's immutable `(created_at, id)` total order within one license namespace.
- `api/_lib/customer-commerce.ts`, `db/migrations/20260715122000_add_customer_commerce_ledger.sql`, and `tests/customer-360/commerce*.test.mjs` - Stripe-verified Customer 360 money projection. A settled PaymentIntent, or a captured standalone Charge without one, is canonical when present. Until then, paid Checkout and Invoice facts remain fallbacks; a paid InvoicePayment edge suppresses only the Checkout fallback for the same absent instrument, namespace, profile, and currency, preferring the related Invoice without collapsing their payment keys. Both fallbacks are atomically suppressed when the related instrument arrives. Gross includes all settled customer money, while `off_stripe_paid_minor` is an explicit subset in each profile/namespace/currency total. Current InvoicePayment objects persist as many-to-many allocation edges without unioning invoices and instruments into one payment key. Namespace-locked reconciliation attaches or quarantines a whole canonical payment group before currency totals refresh and never reads or mutates entitlement/device state.
- `api/_lib/customer-usage.ts`, `api/_lib/customer-query.ts`, `api/_lib/customer-admin.ts`, `api/internal/customer-usage/sync.ts`, and `api/internal/customers/*` - Once-daily privacy-limited telemetry aggregation plus private Customer 360 list/detail reads. The aggregate layer retains complete first/last use and attempt timestamps, outcome counts, activity/frequency, coarse client summaries, and freshness/materialization state; the compact API intentionally omits total accepted attempts and current subscription status. `SIDESTREAM_TELEMETRY_POSTGRES_URL` is a separate read-only source, while `SIDESTREAM_CRM_ADMIN_SECRET` protects POST-only non-browser reads and signs namespace/filter-bound cursors. Raw telemetry, identity values, `installIdHash`, Stripe IDs, search text, and merged tombstones stay excluded.
- `api/_lib/acquisition-funnel.ts` and `api/internal/customers/funnel.ts` - Protected, read-only acquisition and retention report for first-install cohorts observed through a separately selected completed UTC-day boundary. Deterministic precedence is exact paid Checkout, exact anonymous claim, exact verified email, then unattributed. It reports complete attributed and unknown groups, auditable first-open/activation/return/one-and-done ratios, coverage by confidence class, and bounded privacy-safe journeys without exposing email, browser tokens, install/receipt/assignment hashes, Stripe IDs, or identity-link values.
- `scripts/sync-customer-usage.mjs` and `scripts/rescan-customer-usage.mjs` - Human-gated usage operators. Dry-run never connects; apply uses named selectors only, verified remote TLS, one connection, source/target fingerprints and collision rejection, source-freshness limits, append/update-only aggregate writes, and no deletes. Rescan persists a source/target/version-bound mode-`0600` checkpoint after committed batches and requires an additional exact confirmation for deliberate from-zero replay.
- `scripts/backfill-customer-360.mjs`, `scripts/verify-customer-360-backfill.mjs`, and `tests/customer-360/backfill*.test.mjs` - Offline identity-only Customer 360 backfill planning. Dry-run never opens Postgres or writes a checkpoint; connected status emits an operation-bound fingerprint; Test and separately confirmed Production apply are append-only, batch-atomic, resumable, idempotent, conflict-preserving, checkpointed, and restricted to their exact named selectors.
- `scripts/check-customer-360-readiness.mjs` - Sanitized, read-only Customer 360 readiness report for repository source, non-Production configuration, optional unauthenticated HTTPS route probes, and optional disposable-Test database inspection. It loads no `.env` file, performs no network or database access by default, and cannot prove Production migration, backfill, customer data, or operational readiness.
- `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, and `api/_lib/license-environment.ts` - Shared server-only account/Stripe/Postgres implementation plus dependency-free entitlement primitives. They own exact Checkout verification, account-device transactions, two-active-device decisions, unlimited confirmed moves, production/Test isolation from trusted deployment state, short-lived access tokens, rotating refresh credentials, legacy compatibility through 1.0.13, safe OAuth return paths, and restore CSRF validation. Account-session, activation-status, verification, refresh, and download-authorization reads tolerate the pre-entitlement-lifecycle Production schema through one fail-closed JSON-based lifecycle expression, granting legacy compatibility only to the same exact one-time paid rows that the pending migration would backfill. Serverless route imports intentionally use `.js` extensions so Vercel's Node ESM runtime resolves compiled helpers.
- `api/_lib/checkout-offers.ts` - Server-owned regional Checkout catalog, trusted-country selector, and formatted presentation helper. It allowlists the global USD `$19.99`, India INR `₹499`, and Brazil BRL `R$25` offers, reads only Vercel's server-side `x-vercel-ip-country` signal, and ignores browser query/body price, currency, country, and offer values. India and Brazil activate only when their matching regional Price IDs are configured; otherwise the approved global offer remains the fallback.
- `config/pricing-contract.mjs` - Canonical dependency-free pricing contract for Free, global USD, India INR, and Brazil BRL. It owns amounts, currencies, display locales, country order, the global Stripe lookup key, and regional Price environment-variable names. `api/_lib/checkout-offers.ts`, the global Stripe resolver, and paid landing generator consume it directly; `npm run pricing:sync` updates derived landing-page, structured-data, crawler, and generated paid-page fallbacks.
- `scripts/sync-pricing-contract.mjs` and `tests/pricing-contract.test.mjs` - Pricing drift guard and hypothetical-change proof. `npm run pricing:check` fails the build when public derived surfaces or the paid artifact do not match the canonical contract and proves ordinary Upgrade plus paid acquisition still enter the shared resolver. Change pricing in the contract, run `npm run pricing:sync`, provision the required immutable Stripe Price, then run the checkout and entitlement gates.
- `api/checkout/offer.ts` - Public read-only regional price-presentation endpoint used by the landing page. It selects from the same catalog and trusted Vercel country as Checkout, returns only the formatted price and currency, varies by the trusted country header, and is private/no-store so regional responses cannot leak through a shared cache. It never accepts country, amount, currency, offer, Product, or Price input from the browser.
- `api/auth/google/start.ts` and `api/auth/google/callback.ts` - Google OAuth redirect/callback handlers. They require the configured callback to share the browser-facing start origin before setting a short-lived HTTP-only state cookie, upsert `sidestream_accounts`, issue a server-side session cookie, and render a retryable noindex HTML error instead of raw JSON when sign-in state is stale.
- `api/auth/session.ts` and `api/auth/logout.ts` - Account-session JSON and logout endpoints used by `account.html`.
- `api/checkout/start.ts` and `api/checkout/complete.ts` - Authenticated one-time Sidestream Unlimited Checkout flow. Start sends signed-out users through Google authentication, resolves an approved offer from the trusted edge country, stores the exact offer/country/currency/amount/Product/Price snapshot on the locked database intent, creates or reuses the Stripe Session from that stored Price, and redirects to Stripe. Checkout tells buyers that the Sidestream download link will be emailed to the address entered above, followed by the existing one-time-payment/no-subscription reassurance. Checkout Session idempotency includes a canonical SHA-256 fingerprint of every Stripe request parameter plus the logical attempt, so historical Upgrade paths recover safely after changes to Price/Product, URLs, metadata, promotions, expiry, or customer mode instead of colliding with an older Stripe request. Completion loads the stored snapshot before re-fetching Stripe truth and requires exact Session, Product, Price, currency, amount, payment-state, account-metadata, activation, and attachment agreement before entitlement. A complete zero-total Stripe order may omit its PaymentIntent while reporting either `paid` or `no_payment_required`; fulfillment accepts that shape only when the original stored subtotal, exact discount reconciliation, and every other snapshot check pass.
- `middleware.ts`, `api/paid-acquisition/*`, and `api/_lib/paid-acquisition.ts` - Default-off paid mobile acquisition boundary. Only exact eligible top-level mobile `GET /mc` navigation can receive the signed sticky 50/50 assignment; missing assignment configuration, uncertain clients, control traffic, and non-eligible traffic fall back to the canonical ManyChat destination. The unlinked, noindex `/mc-preview` route deterministically renders the same paid cohort for maintainer review on desktop and replaces a control assignment without changing `/mc` eligibility. Middleware passes normalized campaign attribution to the private landing through a proof-bound internal header, preventing Vercel's rewrite query forwarding from duplicating otherwise valid UTM fields. The paid Checkout POST reuses the server-owned regional Sidestream Unlimited catalog and durable core intent worker, including Stripe's promotion-code entry field, without changing ordinary signed-in Free-account Checkout. Fulfillment accepts Stripe-managed promotions only when the stored offer subtotal and currency match exactly, Stripe's aggregate discount reconciles to the Session total, tax and shipping remain zero, and the canonical captured payment matches that discounted total and currency. A 100% promotion follows Stripe's exact zero-total/no-PaymentIntent settlement shape and uses the verified Checkout Session as its idempotent settlement reference.
- `api/_lib/paid-installer-email.ts`, `api/_lib/paid-release-manifest.ts`, `api/paid-download.ts`, `api/releases/paid-latest.ts`, and `data/release-manifest.paid*.json` - Receipt-gated Sidestream Unlimited email and installer surfaces. Provider delivery requires `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=1`; Production enables it so an exactly verified paid-acquisition Checkout creates one idempotent Resend delivery to Stripe's verified Checkout email. The customer email contains only a one-line Premiere Pro product description and Mac/Windows download buttons, while the private manifests give both downloads the customer-facing Sidestream Unlimited filename without changing either installer payload. Public responses expose only bounded metadata, and the installer never grants entitlement by itself.
- `db/migrations/20260727010000_add_paid_acquisition_experiment.sql`, `docs/paid-acquisition-contract.md`, `docs/paid-acquisition-runbook.md`, and `tests/paid*.test.mjs` - Namespaced paid-acquisition schema, normative contract/runbook, and deterministic provider-free evidence. Committing the migration does not apply it to any database, and this reconciliation performed no environment, migration-apply, email, payment, or deployment action.
- `db/migrations/20260729120000_add_regional_checkout_offer_snapshots.sql` - Append-only checkout-intent extension for the server-selected offer ID, trusted country, currency, amount in minor units, Stripe Product, and Stripe Price, plus currency-agnostic bounds for already server-verified paid-acquisition receipts. The all-or-none snapshot constraint prevents partial intent truth; committing this migration does not apply it to any database.
- `api/billing/portal.ts` - Authenticated Stripe Customer Portal redirect creator for customer billing details and invoice history where Stripe has actual Invoice objects to show.
- `api/billing/receipt.ts` - Authenticated one-time purchase receipt helper. It finds the signed-in account's latest Sidestream license PaymentIntent and returns the Stripe charge receipt URL, covering older Checkout payments that did not create invoices.
- `api/stripe/webhook.ts`, `api/_lib/stripe-events.ts`, and `api/internal/stripe-events/process.ts` - Signature verification, durable event recording, leased `SKIP LOCKED` claims, retry/backoff/dead-letter isolation, and watermark-protected entitlement reconciliation. Customer/account reads do not process this queue.
- `api/_lib/maintenance.ts` and `api/internal/maintenance.ts` - Advisory-locked, bounded retention for expired sessions/credentials/limits/intents and Stripe payload redaction without deleting canonical leads or active entitlements.
- `api/activation/start.ts`, `api/activation/status.ts`, `api/activation/claim.ts`, and `api/activation/paid-claim.ts` - CEP-facing activation plus authenticated account routing. Ordinary Free accounts continue to Checkout through the unchanged claim route. Only exact `paid-acquisition-mc-v1` activation source receives the dedicated paid claim URL; that route requests Google's account chooser, requires server-side active entitlement truth, renders support-only recovery when no active entitlement exists, and reuses the same CSRF-protected reconnect/confirmed-transfer engine.
- `api/license/verify.ts`, `api/license/refresh.ts`, `api/license/authorize-download.ts`, `api/license/deactivate.ts`, and `api/account/device.ts` - Trusted-environment credential verification/rotation, exact active-device pre-download authorization, authenticated same-origin deactivation, and coarse read-only account device status. Stable device outcomes include `device_replaced` and `device_deactivated`.
- `db/migrations/20260626120000_add_sidestream_download_leads.sql` - Postgres schema for the private `public.sidestream_download_leads` table used by the download email gate.
- `db/migrations/20260703120000_add_sidestream_accounts_billing.sql` - Postgres schema for accounts, sessions, Stripe licenses/events, plugin activation sessions, and short-lived license tokens.
- `db/migrations/20260704120000_add_sidestream_billing_resources.sql` - Legacy Postgres schema for persisted Stripe subscription billing resources from the retired monthly-price flow.
- `db/migrations/20260704130000_allow_stripe_first_accounts.sql` - Postgres schema adjustment that allows Stripe-first account rows without a Google subject so Checkout can create/link Sidestream entitlements from webhook customer data.
- `db/migrations/20260704150000_allow_one_time_checkout_licenses.sql` - Postgres schema adjustment that lets `sidestream_licenses` store one-time Checkout Session and PaymentIntent IDs instead of requiring a Stripe subscription ID.
- `db/migrations/20260707120000_enable_sidestream_server_table_rls.sql` - Supabase hardening migration that enables RLS on server-owned Sidestream public tables and revokes direct `anon` / `authenticated` Data API access. The Vercel API routes continue to use the server-only Postgres connection.
- `db/migrations/20260713180000_add_activation_checkout_and_refresh_rotation.sql` - Adds exact Checkout attachment/expiry/grace fields to activation rows and hashed current/previous refresh credential fields with database-enforced attachment and replay-window constraints.
- `db/migrations/20260714120000_add_installer_request_tracking.sql` - Adds the server-owned `public.sidestream_installer_requests` attribution table, reporting indexes, RLS, and explicit direct-access revocations for Supabase API roles.
- `db/migrations/20260714190000_add_single_active_account_devices.sql` - Original additive private schema for retained account-device lifecycle rows and confirmed device transfers. Its one-seat indexes are superseded by the later two-seat migration; raw device identifiers are never persisted.
- `db/migrations/20260729010000_allow_two_active_account_devices.sql` - Additive two-seat device migration. It replaces the original one-active-device indexes with concurrency-safe namespace-scoped slots 1 and 2 while retaining immutable lifecycle and replacement history.
- `db/migrations/20260713200000_add_api_operational_controls.sql` through `db/migrations/20260714200000_remove_redundant_download_lead_key_unique.sql` - Append-only hardening chain for the checksummed migration ledger, rate limits, credential uniqueness, Stripe claims/retries/watermarks, Checkout intents, refund/dispute lifecycle, canonical leads/replay receipts, retention indexes, and the final removal of the redundant unique `lead_key` constraint.
- `tests/entitlement.test.mjs` - Focused Node test harness for exact paid-Session verification, attacker-link/pre-bind regressions, device/account binding, restore CSRF/origin checks, safe OAuth return paths, and deterministic lost-response credential replay.
- `tests/download-referral.test.mjs` - Focused Node integration and helper tests for tagged redirects, non-blocking database failures, `HEAD`/`304` exclusions, UTM validation, anonymous HMACs, and likely-scanner detection.
- `tests/license-environment.test.mjs` and `tests/single-device-*.test.mjs` - Static and disposable-Postgres proof for the complete migration chain, including installer-referral RLS, namespace isolation, policy states, database races, transfers/revocation, support tooling, account pages, download authorization, legacy compatibility, and Checkout preservation. `npm run test:single-device` is the aggregate command and requires a safe `SIDESTREAM_TEST_POSTGRES_URL`.
- `scripts/apply-postgres-migrations.mjs` - Checksummed, advisory-locked migration runner for all SQL files under `db/migrations/`, with database-backed `--status`/`--baseline`/apply, local-only `--validate`/`--dry-run`, exact Test/Production selectors, authenticated remote TLS, connected namespace/target fingerprints, explicit Production confirmations, and atomic migration-plus-ledger transactions.
- `scripts/verify-migration-baseline.mjs` - Read-only exact catalog/RLS verifier for recognized pre-20260713 profiles. Its current remote TLS path is not Production-safe, so Production use is blocked until the canonical runbook's authenticated-tooling prerequisite is implemented; never use it to bless unexplained drift.
- `scripts/run-api-tests.mjs`, `scripts/run-postgres-integration.mjs`, `scripts/validate-vercel-contract.mjs`, `scripts/verify-production-source.mjs`, `scripts/generate-production-version.mjs`, `scripts/promote-canonical-production.mjs`, `scripts/verify-production-live.mjs`, and `scripts/verify-vercel-build.mjs` - Aggregate handler/state-machine test discovery, disposable-Postgres concurrency proof with runtime-target rejection, static Vercel route/cron validation, clean remote-main/project/checkout/live-ancestry deployment validation, build-time `version.json` generation, verified custom-domain promotion, canonical post-deploy verification, and the post-`vercel build` bundle verifier.
- `scripts/audit-legacy-subscriptions.mjs` - Read-only-by-default Stripe/Product/Price inventory plus explicitly confirmed direct-database backfill/quarantine for exact allowlisted legacy subscriptions. Its current remote database connection is not Production-safe, so neither audit nor apply is authorized there.
- `scripts/audit-license-devices.mjs` - Read-only-by-default pseudonymous fleet audit plus an explicitly confirmed direct-connection backfill mode. Its current environment selection and remote TLS path block every Production mode.
- `scripts/manage-license-device.mjs` - Account/namespace-scoped support view, binding clear, and bounded expiring move-limit override. Its current environment selection and remote TLS path block every Production mode, including read-only view.
- `scripts/ensure-freedev-promo.mjs` - Maintainer utility that creates or verifies the sandbox-only Stripe `FREEDEV` 100% off promotion code used to test no-cost Sidestream Unlimited Checkout.
- `scripts/migrate-download-leads-to-postgres.mjs` - Legacy-named HTTP replay client for the protected `/api/internal/download-leads/replay` route. It requires a replay endpoint plus `CRON_SECRET`, preserves Blob records by default, optionally requests delete-after-commit, and explicitly rejects the removed `--apply-schema` mode. Schema application belongs only to the migration runner.
- `scripts/dump-download-leads.mjs` - Maintainer utility that dumps captured Sidestream download leads from Postgres for local/disposable inspection. Its current remote TLS path disables certificate verification, so Production use is blocked.
- `scripts/report-installer-referrals.mjs` - Maintainer-only aggregate report for a Gmail installer campaign. It reports request, likely-scanner, likely-human, and unique daily likely-human request counts by batch without returning raw request hashes. Its current remote TLS path disables certificate verification, so Production use is blocked.
- `scripts/generate-sitemap.mjs` - Post-build sitemap generator. It uses local Git history for clean builds, the file mtime for a dirty local page, and Vercel's commit metadata plus the public GitHub commits API when Vercel strips `.git` before a Git-linked build. It writes the resulting ISO timestamp only to `dist/sitemap.xml`.
- `src/main.tsx` - React entry that mounts `DemoOne` into `#shader-background-root` and renders Vercel Analytics through `@vercel/analytics/react`.
- `src/paper-shaders-compat.d.ts` - Local TypeScript compatibility declarations for the pasted prop names that the installed Paper package does not type directly.
- `src/index.css` - Tailwind v4 theme/utilities import, `tw-animate-css`, shadcn theme tokens, and source paths for the background component. It avoids Tailwind preflight so the static HTML styles are not reset.
- `components.json` - shadcn configuration with aliases rooted at the repository root.
- `vite.config.ts` - Vite React/Tailwind build config with the canonical root page, legacy redirect, account page, and upgrade page as HTML inputs.
- `vercel.json` - Vercel deployment config. Forces npm install/build/dev commands and `dist` output, permanently canonicalizes the `www` host plus old-host non-API pages, `/index.html`, and the legacy nested HTML path onto `https://sidestream.tv`, gives Vite's content-hashed `/assets/` files one-year immutable browser caching, and adds `X-Robots-Tag: noindex, nofollow` to `/api/`, account, checkout-success, and upgrade responses. The old Vercel hostname intentionally executes the same deployed `/api/*` handlers in place because installed 1.0.12 panels cannot follow a POST `308`. The dev command passes Vercel's `$PORT` to Vite.
- `mockups/mockup1_2.webm` - Browser-sized alpha WebM generated from the cleaner local MacBook Pro mockup source and mounted below the pricing panels.
- `demos/search demo.mp4` and `demos/preview demo.mp4` - Fast-start 1800×1080 desktop feature demos showing the Tudor Place search and preview workflow.
- `demos/search demo mobile.mp4` and `demos/preview demo mobile.mp4` - Fast-start 1200×720 H.264 mobile renditions sized to cover a 430px-wide Pro Max-class viewport at 3× device density without making phones decode the desktop frame.
- `demos/search demo poster.png` and `demos/preview demo poster.png` - Lossless 1200×720 first-frame fallbacks that remain visible until each demo emits `playing`, preventing a black card when an embedded browser defers or rejects playback.
- `pryt.png` - Lightweight 500×500 transparent Premiere Pro/YouTube artwork shown only in the mobile hero, absolutely centered in a flexible wrapper so its padded canvas does not displace the conversion form.
- `demos/sidestream-panel-corner.webm` - Square VP9-alpha WebM generated from the ProRes source `sidestream demo Linked Comp 01_2.mov` using the full-plugin/timeline top-left crop. Mounted as an opaque decorative Premiere/Sidestream corner on the right side of the hero/main page, visually scaled to 70% from the Premiere panel's top-left corner, anchored at `45vw 25vh` on desktop, and hidden at `900px` and below.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`; the desktop header exposes Features and Account as compact glass pill links without Pricing or download CTAs
- Shader background - `#shader-background-root`, `src/main.tsx`, `components/ui/demo.tsx`, the active Paper `MeshGradient`, `components/ui/background-paper-shaders.tsx`, and `src/paper-shaders-compat.d.ts`
- Vercel Analytics - `src/main.tsx` imports `Analytics` from `@vercel/analytics/react` and renders it alongside the shader component
- SEO/GEO metadata - `<head>` metadata in `index.html` provides the title, description, robots directive, absolute canonical root URL, Open Graph/Twitter tags, sitemap hint, public OG image, and JSON-LD `Organization`, `WebSite`, `SoftwareApplication`, and `Product` graph for the product surface. Keep this crawler-readable layer aligned with visible product claims. `vercel.json` owns duplicate-host and duplicate-path `308` canonicalization; do not restore client-side redirect code in the legacy file.
- Hero - `#hero`, `.hero-split`, `.hero-copy`, `.hero-title-line`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, desktop `.desktop-download-ctas`, mobile `.mobile-hero-logos`/`pryt.png`, and the inline mobile `#mobile-download-handoff` form
- Windows download - `[data-windows-download]` lives beside the hero `[data-download]` `Download for Mac` CTA as a matching white platform pill with a Windows mark and links directly to `https://sidestream.tv/api/download?platform=win32-x64`. The old `#windows-waitlist-gate` markup and capture code remain dormant for historical compatibility, with no active page trigger.
- Feature sections - `#features` anchor, `.feature-glass` full-bleed frosted backdrop band, the two `.sec-pad` feature blocks, `.feature-subtext` heading sublines, `.shot` video frames with explicit `role="img"` labels, `.demo-poster` fallbacks, responsive `.demo-video` MP4 sources, the bottom inline prewarm/playback observers, and the pointer-driven `.shot` 3D tilt handler
- Pricing - `#pricing`, `.pricing-head`, `.plans`, `.plan`, `.plan.featured`, `.beta-coming`, `.plan-beta-content`, `.beta-overlay`, `.final`, `.pricing-mockup`, `.macbook-mockup-video`, the MacBook playback helper, and the pricing-panel scroll reveal observer
- Closing panel - `.final` sits inside `#pricing` between the pricing cards and laptop mockup, with headline and supporting copy only; the paragraph has no obsolete CTA margin below it, and download actions remain in the hero and Free pricing card
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download and upgrade actions - `[data-download]`, `[data-windows-download]`, `[data-purchase]`, `#mobile-download-handoff`, and `#toast`; desktop Mac/Windows CTAs retain their direct installers, while viewports at or below `900px` replace the hero platform choice with an optional email form plus “Share a secure computer link instead” no-email continuity. Lower-page download taps return to that form. The empty `aria-live` status stays hidden until validation or delivery feedback is available. The Sidestream Unlimited sequence remains Upgrade button, Google authentication, Stripe payment.
- Installer and update fulfillment - `data/release-manifest.json` is the default Mac release pointer and `data/release-manifest.windows.json` is the Windows release pointer. `api/download.ts` and `api/releases/latest.ts` resolve the same platform-specific manifest so artifact and update truth cannot drift. Bare requests remain Mac, `win32-x64` selects Windows, and unknown platforms return `404` instead of silently serving the wrong OS.
- Anonymous acquisition continuity - `middleware.ts`, `api/_lib/acquisition-cookie.ts`, `api/_lib/acquisition-handoff.ts`, `api/_lib/anonymous-acquisition.ts`, `api/_lib/anonymous-install-claim.ts`, `api/download.ts`, `api/send-download-links.ts`, and `api/installation/claim*.ts` keep browser token, install/receipt hashes, Customer 360 profile, and later verified account/email separate. A signed 30-day first-touch cookie survives direct desktop download, optional email, or no-email seven-day mobile handoff; a locally verified installation connects it to a sparse profile through one 15-minute opaque claim. Missing configuration or tracking failures never block the page/static installer, but association fails closed.
- Installer referral attribution - Gmail launch URLs use `utm_source=gmail`, `utm_medium=email`, a bounded campaign ID, and optional `utm_content=pilot` or `utm_content=main` batch ID. Only a successful tagged installer `GET` creates `public.sidestream_installer_requests`; `HEAD`, `304`, invalid tags, and failed fulfillment create nothing. The event stores no email, raw IP, or raw user agent. Scanner-like `GET`s remain visible with `likely_scanner = true` so reports can separate them instead of pretending they never happened.
- Landing referral attribution - `/manychat-instagram` and `/manychat-instagram/` are the dedicated organic Instagram ManyChat routes and reach the canonical root with `utm_source=manychat-instagram`, `utm_medium=dm`, and `utm_campaign=organic-instagram`. Legacy `/m`, `/m/`, `/mc/`, and exact `/mc` when the paid experiment is default-off/control/ineligible retain the generic `utm_source=manychat` bucket. The loaded page POSTs either allowlisted source to `/api/referral-visit`; private Blob pathnames dedupe repeated visits from the same anonymous request fingerprint on the same UTC day and separate likely-human from likely-scanner traffic. This measures landing visitor-days, not downloads, installs, activations, purchases, or durable identities.
- Download lead capture and replay - `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/internal/download-leads/replay.ts` validate at most 8 KiB of JSON, converge repeated `(email, cta_source)` submissions, enforce 5/email and 20/IP per ten minutes, and fall back to deterministic private Blob records when Postgres fails. Scheduled replay processes 25 mapped records and deletes only after commit plus ETag match; manual replay is bounded to 100 and defaults to preserving records. Historical `windows-waitlist` rows remain queryable.
- Account/auth/billing/device entitlement - `account.html`, `thank-you.html`, `api/_lib/checkout-offers.ts`, `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, `api/_lib/license-environment.ts`, `api/auth/*`, `api/checkout/*`, `api/billing/*`, `api/stripe/webhook.ts`, `api/activation/*`, `api/account/device.ts`, and `api/license/*` own Google account management, the server-owned global USD, India INR, and Brazil BRL one-time Sidestream Unlimited offers, immutable Checkout snapshots, namespace-separated active-device rows, restricted Test isolation, refund/dispute lifecycle, confirmed transfers, download authorization, deactivation, and device-bound access/refresh credentials. Every valid approved regional purchase grants the same `sidestream_pro` entitlement. Device mismatch policy defaults to `observe`; only explicit `enforce` blocks, and Customer 360 does not change that mode. The API/operator contract is `docs/api-hardening-runbook.md`; device/support details are in `docs/single-device-entitlements.md`.
- Paid mobile acquisition - Exact `/mc` is an unlinked, default-off experiment entry owned by `middleware.ts`; `/m`, `/m/`, and `/mc/` retain their existing redirects. Eligible paid-cohort navigation is internally rendered from deterministic `generated/mobile-paid-prototype.html`, generated from the current canonical root. Vite compiles that page as a dedicated entry so its shader and media use deployable hashed assets, then `scripts/stage-paid-landing-runtime.mjs` stages the compiled page at `runtime/mobile-paid-prototype.html` for the serverless bundle. The paid landing function injects its bounded Checkout token into that compiled runtime artifact. Paid Checkout uses the same trusted-country offer catalog and immutable snapshot as ordinary Checkout. Verified email, installer receipt, claim, artifact, and lifecycle records remain namespaced and cannot be selected by browser-supplied price, product, amount, currency, country, offer, cohort, or environment.
- Customer 360 commerce ledger - `api/_lib/customer-commerce.ts`, `20260715122000_add_customer_commerce_ledger.sql`, and `tests/customer-360/commerce*.test.mjs`; settled money comes from one canonical PaymentIntent or standalone Charge per payment group. Before that instrument exists, a paid InvoicePayment edge makes the related Invoice the preferred fallback and suppresses only the Checkout view resolving to the same namespace/profile/currency payment key. Gross and its `off_stripe_paid_minor` subset stay currency-separated, unrelated Checkout fallbacks remain independent, paid InvoicePayment edges never collapse many-to-many allocations into alias equivalence, and contradictory live identity evidence triggers sticky whole-group quarantine.
- Customer 360 usage and private reads - `api/_lib/customer-usage.ts`, `api/_lib/customer-query.ts`, `api/internal/customer-usage/sync.ts`, `api/internal/customers/index.ts`, and `api/internal/customers/[customerId].ts`; schema-versioned telemetry becomes replaceable UTC daily aggregates with exhaustive stored/derivable first/last use and attempt timestamps, outcome counts, lifetime and rolling activity, attempts-per-active-day frequency, coarse client summaries, and source/materialization freshness. The compact list/detail projection exposes only its documented subset, requires an authenticated admin body to select an authorized namespace, binds that namespace into signed keyset cursors, and exposes neither total accepted attempts nor current subscription status. The full cross-repo field/privacy/rollout contract is `docs/customer-360.md`.
- Acquisition and retention report - `api/_lib/acquisition-funnel.ts` and `api/internal/customers/funnel.ts`; an authenticated non-browser caller selects a namespace, bounded first-install cohort, and later completed UTC-day observation boundary, then receives complete source/experiment/confidence groups plus ordered, capped journeys. Precedence is exact paid Checkout, exact anonymous browser-to-install claim, exact verified email, then unattributed; candidates must predate or equal first install and every unlinked anonymous install remains `unknown`. Every first-open/activation/return/one-and-done and attribution-coverage value exposes its exact numerator and denominator. Overall stickiness continues to use all install IDs rather than only attributable profiles.
- Customer 360 backfill - `scripts/backfill-customer-360.mjs` and `scripts/verify-customer-360-backfill.mjs`; reviewed offline identity exports become privacy-safe candidate/orphan/conflict plans. Dry-run is the default; connected status and separately confirmed Test/Production apply use exact selectors, operation-bound fingerprints, append-only idempotent batches, and mode-`0600` checkpoints.
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

The canonical organic Instagram ManyChat referral URL is:

```text
https://sidestream.tv/manychat-instagram
```

Use that URL for new organic Instagram ManyChat placements. It redirects to the
canonical landing page with `utm_source=manychat-instagram`, `utm_medium=dm`,
and `utm_campaign=organic-instagram`, creating a separate first-party reporting
bucket from generic ManyChat traffic.

Legacy `/m`, `/m/`, and `/mc/` return the existing temporary redirect to
`https://sidestream.tv/?utm_source=manychat`. Exact `/mc` is reserved for the
default-off paid-acquisition experiment. Without a valid server-only assignment
secret it returns the same safe ManyChat destination; when separately enabled,
only an eligible top-level mobile `GET` can receive a sticky control/paid
assignment. The route is not linked from the canonical site. See
`docs/paid-acquisition-runbook.md`; this repository state does not authorize an
environment change or Production enablement.

The old exported static page path, `/Sidestream%20front%20end%202/Sidestream.html`, is kept only as a compatibility route. Vercel returns a server-side `308` to `https://sidestream.tv/`; the built fallback HTML contains no meta refresh or JavaScript redirect.

Vite copies public crawler assets to the site root:

```text
GET /robots.txt
GET /sitemap.xml
GET /llms.txt
GET /sidestream-social-card-v3.png
```

Every build also writes `/version.json` with the exact full Git SHA used for
that artifact. Vercel serves it with `Cache-Control: no-store`. It is deployment
lineage metadata, not a release version or customer identifier. Git-linked
Vercel builds use `VERCEL_GIT_COMMIT_SHA` directly because `.vercelignore`
removes `.git`; local builds fall back to `git rev-parse HEAD` only when neither
the explicit build SHA nor Vercel metadata exists.

`robots.txt` allows normal search discovery plus OpenAI `OAI-SearchBot` and user-initiated `ChatGPT-User` access to public content, while disallowing all `/api/` routes so crawlers cannot create Checkout Sessions or trigger installer fulfillment. `GPTBot` is disallowed site-wide as a separate training choice; this does not opt the site out of ChatGPT search. OpenAI referrals can still be attributed through the `utm_source=chatgpt.com` query parameter they attach. The sitemap contains the canonical landing page only. `llms.txt` is an additive AI-readable summary for agents; do not use it as a place for claims that are absent from the landing page.

Every `/api/` response and the functional `account.html` and `thank-you.html` pages also receive `X-Robots-Tag: noindex, nofollow` from Vercel. The HTML pages keep matching meta directives as defense in depth. Host-conditional redirects are deployment routing and cannot be proven with Vite alone.

Vercel serves these serverless API surfaces. Unsupported methods return `405`
with `Allow`; see `docs/api-hardening-runbook.md` for exact error codes and
operator response.

| Surface | Exact methods | Successful response contract |
| --- | --- | --- |
| `/api/download` | `GET`, `HEAD` | GET `302` to a five-minute signed private Blob URL or `304` for a matching ETag; HEAD `200` attachment metadata |
| `/api/referral-visit` | `POST` | `204` after accepting the allowlisted `manychat-instagram` or legacy `manychat` source and scheduling a private, daily-deduped anonymous Blob write |
| `/api/releases/latest` | `GET`, `HEAD`, `OPTIONS` | GET `200` public manifest, HEAD matching metadata without a body, OPTIONS `204` |
| `/api/download-lead` | `POST` | `200 {"ok":true}` after Postgres or `200 {"ok":true,"queued":true}` after private-Blob fallback |
| `/api/send-download-links` | `POST`, `GET` | Email POST returns `200 {"ok":true}` after durable lead/rate-limit storage and Resend acceptance and uses signed handoffs when anonymous continuity is configured; no-email `{"handoffOnly":true}` POST returns one opaque `handoffUrl`; GET accepts exactly that signed envelope, restores the acquisition cookie, and redirects to the same platform installer. Invalid handoffs return `404` |
| `/api/auth/google/start`, `/api/auth/google/callback` | `GET` | Existing-session account redirect or Google OAuth redirect and server session creation |
| `/api/auth/session` | `GET` | Read-only account/license session JSON; it never drains Stripe events |
| `/api/auth/logout` | `POST` | Clears the server session |
| `/api/checkout/start` | `GET` | `302` to Google authentication when signed out; `303` to Stripe Checkout for a signed-in Free account |
| `/api/checkout/complete` | `GET` | Exact Stripe re-verification then `303` to the ordinary thank-you page or, for server-verified paid acquisition, the phone-first paid thank-you page; not-ready is `409` |
| `/api/paid-acquisition/landing` | `GET` (internal rewrite only) | Private no-store paid landing after an exact signed paid `/mc` assignment proof |
| `/mc-preview` | `GET` | Unlinked maintainer review entry that deterministically renders the paid landing on desktop with the real Checkout boundary |
| `/api/paid-acquisition/checkout` | `POST` | Idempotent paid-cohort Checkout start using only the current server-owned Product/Price and a durable core intent |
| `/api/paid-acquisition/artifact` | `GET` | Verified paid receipt/session fulfillment then `302` to the selected short-lived paid artifact URL |
| `/api/paid-acquisition/claim` | `GET` | Receipt-cookie and Google-auth claim/recovery boundary without browser-selected payment or environment truth |
| `/api/paid-download` | `GET`, `HEAD` | Receipt-gated paid artifact redirect or matching metadata after manifest and Blob integrity checks |
| `/api/releases/paid-latest` | `GET`, `HEAD`, `OPTIONS` | Public paid-onboarding manifest metadata without private artifact identifiers |
| `/api/billing/portal`, `/api/billing/receipt` | `POST` | Authenticated Stripe portal redirect or latest receipt JSON |
| `/api/stripe/webhook` | `POST` | `200 {"received":true}` after durable insert; duplicate adds `"duplicate":true` |
| `/api/activation/start`, `/api/activation/status` | `POST` | Start returns activation key/expiry/URLs; status returns a stable activation/device state |
| `/api/activation/claim` | `GET`, `POST` | Authentication and Free-account Checkout routing; CSRF/same-origin restore or transfer POST for active owners |
| `/api/activation/paid-claim` | `GET`, `POST` | Exact-source paid onboarding authentication plus active-entitlement reconnect or confirmed transfer; inactive accounts receive a noindex support-only page with no purchase action |
| `/api/installation/claim` | `POST` | After local receipt verification, accepts exactly `installIdHash` and `installerReceiptIdHash` and returns a 15-minute opaque `browserUrl`/`expiresAt`; missing configuration is `503 claim_unavailable` |
| `/api/installation/claim-complete` | `GET` | Combines the single `nonce` parameter with the signed browser cookie once, attaches/creates the sparse profile, and always returns minimal private noindex HTML; missing/forged browser state does not consume the claim |
| `/api/account/device` | `GET` | `200 {"active":boolean,"device":object|null}` |
| `/api/license/verify`, `/api/license/refresh`, `/api/license/authorize-download`, `/api/license/deactivate` | `POST` | Credential verification/rotation, exact `{"active":true}` download authorization, or explicit device deactivation |
| `/api/internal/stripe-events/process` | `GET` | Protected summary `{ok,claimed,processed,ignored,retryable,deadLetter}` |
| `/api/internal/download-leads/replay` | `GET`, `POST` | Protected `{ok,summary,nextCursor,hasMore}`; scheduled GET is fixed at 25/delete, manual POST accepts bounded controls |
| `/api/internal/maintenance` | `GET` | Protected `{ok,outcome,durationMs,batchSize,hasMore,counts}` |
| `/api/internal/customer-usage/sync` | `GET` | `CRON_SECRET`-protected once daily aggregate summary `{ok,outcome,licenseNamespace,batches,sourceRowsScanned,dailyBucketsWritten,profilesRefreshed,sourceFreshnessAt}` |
| `/api/internal/customers` | `POST` | `SIDESTREAM_CRM_ADMIN_SECRET`-protected `{customers,nextCursor}`; browser origins are forbidden |
| `/api/internal/customers/[customerId]` | `POST` | Same protected compact shape as list, wrapped as `{customer}`; merged tombstones and cross-namespace IDs return `404` |
| `/api/internal/customers/funnel` | `POST` | Same protected non-browser boundary; returns a read-only first-install cohort report through an explicit completed UTC-day observation end, with auditable first-open/activation/return/one-and-done and coverage ratios, complete groups, and bounded privacy-safe journeys |

For `/api/activation/status`, a parsed non-null JSON value with missing or invalid
required fields returns `400 invalid_request`. Valid JSON `null` is currently
dereferenced before validation; it escapes as an unshaped platform `5xx`, as do
malformed JSON and body-read failures. None of those cases is a documented `400`
response. Changing that behavior requires a separately owned handler fix and
regression test.

The four scheduled internal routes require `Authorization: Bearer
<CRON_SECRET>`. The protected Customer 360 list/detail/funnel routes instead
require `Authorization: Bearer <SIDESTREAM_CRM_ADMIN_SECRET>`. The shared cron
token must be 16-512 printable, non-space ASCII characters (`U+0021`-`U+007E`)
so all four scheduled route validators accept the same header; generate 32
random bytes as 64 hexadecimal characters in the approved secret manager. A
missing or weak configuration returns `503`; missing/wrong auth returns `401`.
`vercel.json` schedules Stripe processing every five minutes, lead replay every
ten minutes, maintenance daily at `04:13` UTC, and Customer 360 usage sync once
daily at `05:27` UTC.

### Customer 360 contract and rollout status

Customer 360 route code and guarded migration/backfill/sync/rescan operators are
present in the repository. This code-only run did not inspect or change live
configuration, so current Production operational state is not claimed.
A read-only 2026-07-29 operator inspection found all required tables and read
functions plus materialized identity and commerce rows in the live dashboard
database. It did not prove backfill completeness or that the Production website
runtime selects that database, and it found no usage sync state or daily usage
rows. Source presence, a successful build, database rows, or an unauthenticated
protected-route response does not prove operational readiness. Money is Stripe-verified,
currency-separated minor units but is not entitlement truth; the separately
documented lifecycle blockers still prevent describing Production entitlement
enforcement as complete. `installIdHash` is a Customer 360 association key, not
the single-device binding, and the Gmail installer-referral HMAC is attribution
only, never identity.

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
transfer. It does not make the current hardened account runtime compatible with
the known pre-20260713 Production baseline: refresh rotation, entitlement
lifecycle, and single-device transfer still require their separately reviewed
migrations or an explicit compatibility implementation.

The only rollout path is the human-gated sequence in `docs/customer-360.md`:
complete Preview/Test migration/configuration, dry-run and separately approved
backfill, guarded sync/rescan with complete checkpoints, protected API and real
FlowState QA; then obtain new Production authorization for migration, Vercel
configuration, canonical `origin/main` Git deployment, real-product smoke,
one-time rescan, one guarded sync, the four-job scheduler decision, and only then
the separately signed FlowState release. Every stage has explicit failure-stop,
no-delete rollback, and canonical-surface evidence. Vercel cron control remains
project-wide across all four jobs. The documented future sequence authorizes and
claims no Production migration, secret change, scheduler change, deployment,
rescan, or product release.

#### Measurable acquisition and retention funnel

`POST /api/internal/customers/funnel` uses the same
`SIDESTREAM_CRM_ADMIN_SECRET`, POST-only, no-browser-origin, no-store boundary as
the Customer 360 list/detail routes. Its body is exactly
`licenseNamespace`, `cohortStart`, `cohortEnd`, required `observationEnd`, and
optional `journeyLimit`. The cohort timestamps must be UTC `Z` values and
`cohortEnd` is the exclusive first-install bound. `observationEnd` must be an
exclusive completed UTC-day boundary at `00:00:00Z`, at or after `cohortEnd`.
The cohort window remains capped at 366 days and the full
`cohortStart`-to-`observationEnd` span is capped at 730 days. `journeyLimit`
defaults to 50 and is bounded from 1 to 100. The query is a read-only
repeatable-read transaction.

The report uses these definitions:

- **Install / cohort:** `firstInstallAt` is the earliest
  `sidestream_customer_installs.first_seen_at` across a live profile's current
  install memberships. Cohort membership is
  `cohortStart <= firstInstallAt < cohortEnd`; groups include every profile in
  that cohort, including unknown source.
- **Open and active day:** an open is exactly a schema `0.2.0`
  `session_started` event. `firstOpenAt` is the earliest such event observed
  before `observationEnd`. An active UTC day has at least one
  `session_started`; installer events, heartbeats, download events, and other
  app telemetry do not create an open or active day.
- **Download:** an attempt starts at the first accepted, non-speculative
  `download_requested`, deduplicated by download/session/install identity with
  telemetry-event fallback. `dayZeroDownloadAttempts` counts those attempts on
  the UTC date of first open. A download attempt does not itself create an open
  day.
- **Activation:** `activationAt` is the earliest non-null `completed_at` on an
  activation session reached through that profile's exact
  `activation_record` identity link and completed before `observationEnd`.
  The activation numerator counts only first-opened profiles, so it is always a
  subset of its first-open denominator and cannot exceed 100 percent.
- **Return / one-and-done:** `laterOpenDays` contains distinct UTC open dates
  after the first-open date and before `observationEnd`. A profile is return
  eligible only after first open and when at least one complete later UTC day
  exists before the observation boundary. Only an eligible profile with no
  later open day has `oneAndDone=true`; an immature profile is not labeled
  one-and-done.

Top-level and per-group `firstOpenPercentage`, `activationPercentage`,
`returnPercentage`, and `oneAndDonePercentage` each expose numerator,
denominator, and percentage; zero denominators produce `percentage: null`.
`totals` exposes the corresponding profile counts. `dateWindow` keeps the
inclusive/exclusive first-install selection window separate from the completed
UTC-day observation boundary. `groups` cover the complete cohort. `journeys`
add explicit return eligibility and returned/one-and-done state, remain ordered
by `firstInstallAt` then customer UUID, and state whether the bounded sample was
truncated.

Attribution is deterministic and deliberately narrow. Precedence is:

1. `exact_paid_checkout`: an active completed paid-acquisition Checkout joined
   to its exact server record and exact receipt, Checkout Session, or claimed
   activation/account profile edge.
2. `exact_anonymous_claim`: an immutable browser first touch with a recorded
   installer request, completed one-time install/receipt claim, and exact
   claimed profile.
3. `exact_verified_email`: a `mobile-download-handoff` lead whose normalized
   email exactly equals both verified account and profile contact email.
4. `unattributed`: the complete remaining `source=unknown` cohort.

Paid wins over anonymous claim and verified email; anonymous claim wins over
verified email. Every candidate first touch must be at or before first install,
and a verified-email row's first and last capture must both predate/equal
install. Within each class, earliest exact evidence wins with stable database
tie-breakers. Repeated leads may fill only a previously null UTM field and may
retain only a valid signed `mc-mobile-paid-v1` assignment. There is no matching
by timing, IP, user agent, referrer, fuzzy email, or approximate identity.

`attributionCoverage` divides all three exact confidence classes by every
profile in the first-install cohort and reports paid, anonymous, freemium, and
unattributed counts. The parallel `coverage` object exposes total
attributed/unknown and each exact class against that same cohort denominator.
Unknown installs remain in product-wide install/open/return denominators.

Installer packages remain static and are never personalized. The locally
generated receipt hash is association evidence only; the exact anonymous claim
is what joins immutable browser first touch to the profile. Unlinked sessions
remain `source=unknown`.

The exact `session_started` rule replaced historical broad non-installer
activity buckets. The normal sync rereads only its bounded overlap, so a
one-time full append/update rescan of the source telemetry history is required
to replace older daily aggregate buckets before historical retention is
trusted. `scripts/rescan-customer-usage.mjs` now provides dry-run plus guarded
Test/Production-capable apply forms with verified remote TLS, source/target
fingerprint collision checks, source freshness, append/update-only aggregate
writes, no deletes, and a versioned source/target-bound mode-`0600` checkpoint.
`scripts/sync-customer-usage.mjs` provides the matching guarded one-run sync.
Their presence is not approval: exact commands, required Vercel variable names,
human migration/configuration/rescan/scheduler/deploy/release order, failure
stops, rollback, and the real-product smoke checklist live in
`docs/customer-360.md`. No external operation was performed by this docs change.

The operator sequence is dry-run, connected status, then separately approved
apply. Status writes nothing and emits operation-bound fingerprints after
database/port/namespace attestation. Test uses only
`SIDESTREAM_TEST_POSTGRES_URL`; Production uses only
`SIDESTREAM_POSTGRES_URL_NON_POOLING`; usage operators additionally require the
separate read-only `SIDESTREAM_TELEMETRY_POSTGRES_URL`:

```bash
node scripts/backfill-customer-360.mjs --dry-run --namespace test \
  --input /restricted/path/reviewed-input.json
node scripts/backfill-customer-360.mjs --status --namespace production
node scripts/backfill-customer-360.mjs --apply --namespace production \
  --input /restricted/path/reviewed-input.json \
  --checkpoint /restricted/path/customer-360-backfill.json \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_360_BACKFILL \
  --confirm-target pg-<reviewed-fingerprint>

node scripts/sync-customer-usage.mjs --status --target production
node scripts/sync-customer-usage.mjs --apply --target production \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_USAGE \
  --confirm-target pg-<reviewed-fingerprint>
node scripts/rescan-customer-usage.mjs --status --target production
node scripts/rescan-customer-usage.mjs --apply --target production \
  --checkpoint /restricted/path/customer-usage-rescan.json \
  --confirm-operation APPLY_PRODUCTION_CUSTOMER_USAGE \
  --confirm-target pg-<reviewed-fingerprint>
```

Test apply uses the same backfill/sync/rescan shapes with `test` and omits both
Production confirmations. Backfill and rescan atomically replace mode-`0600`
checkpoints after committed batches; resume relies on idempotent inserts/upserts
when a commit survives a checkpoint-write failure. Rescan replay from zero also
requires `--replay --confirm-replay REPLAY_SESSION_STARTED_AGGREGATES`. These
operators never delete raw telemetry or canonical Customer 360 identity,
commerce, audit, entitlement, or device state.

Use the readiness command for a sanitized, read-only status report:

```bash
npm run customer-360:readiness
npm run customer-360:readiness -- --origin https://approved-preview-host
SIDESTREAM_TEST_POSTGRES_URL='<disposable-only>' npm run customer-360:readiness -- --test-database
```

The default command checks source/backfill-source presence and validates the
required non-Production selectors already in the process environment. It does
not load `.env` files, contact a host, or open a database. A blocked report exits
zero for observation; append `--require-ready` only when a blocked result should
exit nonzero.

`--origin` accepts only a bare HTTPS origin. It follows no redirects and makes
unauthenticated probes to `POST /api/internal/customers` and
`GET /api/internal/customer-usage/sync`. Only exact `401` JSON
`code=unauthorized` responses classify both routes as configured and protected;
documented `503` unavailable codes remain blocked, and every other response
fails closed. Even the exact `401` result proves only the protected route
boundary at that origin, not migration, backfill, namespace isolation,
customer-data presence, or successful authenticated behavior.

`--test-database` may inspect only the disposable database selected by
`SIDESTREAM_TEST_POSTGRES_URL`. The existing target-separation guard rejects
runtime, Production, Preview, deployed-Test, generic, and telemetry endpoint
collisions. Inspection runs in a read-only transaction, checks the complete
table/read-function set and checksummed migration ledger, reads bounded backfill
indicators, and rolls back. It does not inspect or authorize Production or a
deployed Test runtime. Reports expose only booleans, bounded counts, and status
codes; supplied origins, selector values, connection strings, exception
messages, and response payloads are omitted.

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
sidestream/1.0.16/Sidestream-1.0.16-Mac-Installer.dmg
```

The current public Windows pathname is:

```text
sidestream/1.0.16/Sidestream-1.0.16-Windows-Installer.exe
```

The Blob store is the private `sidestream-release-105` store in Vercel project `sidestream`, store id `store_9KFjHEkmxI6IIWNi`, region `iad1`. Vercel Blob access is authenticated through either `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`, or a legacy `BLOB_READ_WRITE_TOKEN` if one is configured. `BLOB_STORE_ID` is set in the Vercel project environments, while installer pathnames live in the platform manifests; `.env.local` is generated by `vercel env pull` and must stay ignored. Bare website downloads should point at the native/base Mac installer DMG, not the Windows or older ZXP-helper path.

### Vercel Blob And CDN Usage Guardrails

Limits and the live team plan were rechecked on 2026-07-13; re-check [Vercel pricing](https://vercel.com/docs/pricing), [Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), and [CDN usage](https://vercel.com/docs/manage-cdn-usage) before making quota-sensitive changes. Production currently runs on Vercel Pro with usage billing active. The private store held about 1.406 GiB before the Windows `1.0.13` upload, so it was already beyond the old Hobby allowance without being blocked.

The current public Mac artifact, `Sidestream-1.0.16-Mac-Installer.dmg`, is 224,597,835 bytes, about 214 MiB. The current Windows artifact, `Sidestream-1.0.16-Windows-Installer.exe`, is 61,707,154 bytes, about 59 MiB. Use the live Vercel Usage view rather than stale Hobby math before adding artifacts or estimating a launch's transfer cost.

Flag any change that increases installer size, stores multiple release DMGs, uploads raw demo/video assets, makes `/api/download` easier for bots to hit, removes attachment/cache safeguards, proxies the installer through extra functions, or changes the email gate/CTA flow in a way that materially increases downloads. Estimate `artifact bytes * expected downloads` and verify Vercel Usage after publish.

Download CTAs are intentionally unblocked in the canonical HTML. Mac anchors point at `https://sidestream.tv/api/download`, while the hero Windows anchor points at `https://sidestream.tv/api/download?platform=win32-x64`, so local static previews and adjacent static hosts do not 404 on a relative API path. The old download-email and Windows-waitlist modal markup remains for historical compatibility, but visible download clicks no longer require an email before starting either installer; prior Windows leads remain queryable through `cta_source = "windows-waitlist"`.

The SaaS/account flow is server-owned. The landing-page Account link enters `/api/auth/google/start`: a valid server session goes directly to `account.html`, while a signed-out visitor enters Google OAuth and the callback creates or reconnects the account. Direct signed-out visits to `account.html` use the same entry instead of rendering an empty account panel. The Google callback origin must exactly match the browser-facing OAuth start origin; Production uses `https://sidestream.tv/api/auth/google/callback` in Google Auth Platform, keeps `SIDESTREAM_BASE_URL=https://sidestream.tv`, and requires any optional `GOOGLE_REDIRECT_URI` override to use that same callback. The start route checks this before setting state cookies, so a stale deployment setting cannot send users through Google only to fail the callback on another hostname. The session is remembered for up to 30 days by the existing HTTP-only, `SameSite=Lax` `sidestream_session` cookie; do not add a browser-readable identity cookie. While Production intentionally remains on the pre-entitlement-lifecycle schema, every customer-facing license read uses the shared `LICENSE_ENTITLEMENT_STATUS_SQL` expression to detect the missing column without runtime DDL and treats only exact one-time paid `active`/`trialing` rows as compatible Unlimited access; after the column exists, its canonical stored value always wins. Sign out clears the server session and returns to the landing page so the automatic account entry cannot immediately sign the user back in.

The paid sequence is exactly:

1. The user clicks Upgrade.
2. Google authentication establishes the Sidestream account session.
3. The browser opens Stripe Checkout for payment.

`GET /api/checkout/start` owns that sequence. It sends signed-out users to Google with an allowlisted return path. For a signed-in Free account, it applies the account/IP rate limit, normalizes only Vercel's trusted `x-vercel-ip-country` header, selects an approved server-owned offer, validates its immutable Stripe Price, and stores the offer ID, observed country (`ZZ` when unavailable), currency, amount in minor units, Product ID, and Price ID on the 24-hour database intent before Checkout creation. Browser query/body country, offer, currency, amount, Product, or Price values are never selectors. The locked/idempotent worker creates or reuses Stripe Checkout from that stored Price; a catalog or environment change while the Session remains open cannot reprice the intent. The Stripe idempotency key is derived from the logical intent, attempt, and a canonical fingerprint of the complete Session-create request; identical retries converge, while any request change receives a distinct key.

The global catalog entry owns the approved USD `1999` minor-unit amount and uses the existing Sidestream Unlimited Price resolver. India owns INR `49900` (`₹499`) through `SIDESTREAM_PRO_INDIA_PRICE_ID`; Brazil owns BRL `2500` (`R$25`) through `SIDESTREAM_PRO_BRAZIL_PRICE_ID`. All use the same Sidestream Product. Checkout accepts a regional Price only when Stripe reports the catalog's exact Product, currency, amount, active state, and one-time billing shape. A missing regional Price ID safely falls back to the approved global offer.

`GET /api/checkout/offer` applies that same trusted-country selection without creating an intent or calling Stripe. It returns only `{ formattedPrice, currency }`, sets `Cache-Control: private, no-store`, and ignores query/body inputs. The canonical and generated paid HTML render `$19.99` as a resilient global/SEO fallback, then replace only elements marked `[data-checkout-offer-price]` with the endpoint response. Checkout still resolves and snapshots its offer independently on the server, so changing or forging the displayed text cannot select a country, Price, currency, or amount.

Fulfillment first loads all intent rows attached to the requested Session, then fetches the completed Stripe Session and selects only the intent ID embedded by the server at creation. `isApprovedPurchase` becomes true only after the stored snapshot exactly matches the Session's plan, intent/account/offer metadata, activation metadata, one line item, quantity, Product, Price, currency, original subtotal, discounts, shipping, tax, total, settlement state, PaymentIntent/Charge customer, captured amount, and currency. It never resolves today's catalog or reads a current Price environment variable. A valid global, India, or Brazil purchase writes the same `sidestream_pro` entitlement. Stripe may represent a complete 100%-discounted order as `payment_status=paid` or `payment_status=no_payment_required` with no PaymentIntent; both remain valid only when the stored subtotal reconciles through the exact discount to zero and every other snapshot check succeeds.

Canonical paid access requires `entitlement_status=active` on `sidestream_pro` or compatible `sidestream_unlimited`, but the current lifecycle implementation is not complete Stripe truth. Partial refund remains `active/partial_refund`; full refund becomes irreversible `revoked/full_refund`; open inquiry/dispute statuses suspend; `won` may reactivate unless a prior `lost` was persisted; and `lost` is irreversible. Production is blocked because `refund.failed` is not handled and a failed full refund cannot restore access, while current Stripe terminal statuses `warning_closed` and `prevented` are incorrectly treated as open. A separately owned implementation/test change or an explicitly approved conservative policy plus tested customer recovery is required. The Stripe-created-at plus event-ID watermark still prevents stale Checkout, refund, dispute, or subscription events from resurrecting a later state. Legacy recurring access remains default-deny and requires an exact Product and Price in the two reviewed allowlists.

`POST /api/stripe/webhook` verifies the signature, durably records the event, and acknowledges it; it does not perform customer-state work inline. Leased workers transition `received` to `processing`, then terminal `processed`/`ignored` or bounded `retryable`/`dead_letter`. Account/session/activation reads never drain this backlog. Required event subscriptions and queue operations live in `docs/api-hardening-runbook.md`.

Plugin activation rows are device-bound. `/api/activation/status` issues one deterministic, retry-safe credential family only after verified payment or an explicit restore. Current clients may recover that family for 10 minutes after completion; legacy clients through 1.0.13 receive the same `active` response throughout the activation's 24-hour lifetime because they do not understand the terminal `completed` state. Current-client access tokens last seven days. Tokens whose database-linked activation records are from legacy clients through 1.0.13 receive a 365-day access lifetime and `/api/license/verify` rolls that expiry forward, because those clients cannot retain or rotate the paired refresh credential; this decision never trusts a spoofable request user agent. The paired opaque refresh token is hashed at rest, bound to the same device, rotates atomically through `/api/license/refresh`, and has a rolling 365-day expiry. A two-minute predecessor-hash window returns the same derived rotated pair after one lost response or concurrent retry without accepting the old credential indefinitely.

`/api/license/verify` and `/api/license/refresh` return 401 codes `invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`, and 403 `license_inactive`; callers retain credentials on transient 5xx failures. `/api/activation/claim` authenticates first. A signed-in Free account continues to `/api/checkout/start`; an active owner may use the no-store restore or transfer decision and its same-origin, CSRF-valid POST to CAS-bind a fresh activation whose account is still null or identical. `/api/activation/paid-claim` is selected only when activation start receives exact raw source `paid-acquisition-mc-v1`, rechecks that source on the activation row for both GET and POST, and never treats source or installer receipt as entitlement truth. An active owner receives the same reconnect/transfer policy; an inactive owner sees only signed-in identity and the existing `alex@alexg.mov` support destination, never Checkout or Upgrade. An active Unlimited owner is routed to claim/account instead of starting another purchase. Do not store Stripe secrets, Google client secrets, raw payment data, activation keys, license tokens, refresh tokens, or permanent paid-state in browser code or logs.

### API data ownership and migration model

`api/_lib/postgres.ts` owns one attached pool for every runtime API feature. Production chooses a pooled URL in this order: `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, then `POSTGRES_PRISMA_URL`; direct/non-pooling fallback is forbidden in production runtime. `POSTGRES_POOL_MAX` defaults to 4 and is bounded 2-20, with bounded idle, connection, query, and statement timeouts. Guarded migration and Customer 360 backfill operators accept only `SIDESTREAM_TEST_POSTGRES_URL` for Test or `SIDESTREAM_POSTGRES_URL_NON_POOLING` for Production.

`scripts/apply-postgres-migrations.mjs` owns an advisory-locked SHA-256 ledger in `public.sidestream_schema_migrations`. Database-backed `--status` is authoritative for every applied/pending filename in the complete chain and fails on tracked ledger/local checksum mismatch. Connected modes enforce exact named selectors, authenticated remote TLS, one connection, database/port/namespace attestation, and operation-bound fingerprints; Production baseline/apply also require exact operation and target confirmations. `--validate` and `--dry-run` are strictly local file checks and are not Production-state evidence. A non-empty legacy schema requires a separately reviewed explicit `--baseline`; `scripts/verify-migration-baseline.mjs` is only the narrower known-catalog/conditional-RLS guard. Applying commits each pending SQL file and ledger row together. Runtime handlers never create or alter schema. The final migration removes the redundant unique `lead_key` constraint while preserving canonical `(email, cta_source)` uniqueness and a non-unique lookup index.

Key hardened environment/configuration ownership:

| Area | Contract |
| --- | --- |
| Cron | One stable `CRON_SECRET`, 16-512 printable non-space ASCII characters (`U+0021`-`U+007E`), protects Stripe process, lead replay, maintenance, and Customer 360 usage-sync routes; use a secret-manager-generated 64-character hexadecimal token |
| Pool | `POSTGRES_POOL_MAX` defaults to 4 (2-20); idle/connection/query/statement timeout variables are bounded and documented in the runbook |
| Limiter/lead | `SIDESTREAM_RATE_LIMIT_HASH_SECRET` and `SIDESTREAM_LEAD_HASH_SECRET` are stable server-only HMAC values of at least 32 characters; `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX` selects the private fallback prefix. Pro WAF is a per-region fixed-window counter. With exactly one shared rule/counter domain spanning every reachable host, the trailing boundary burst is approximately `2 * L * R` for regional limit `L` across reachable regions `R`, plus reconciliation risk. With `H` independent host/rule counter domains it grows to approximately `2 * L * R * H`. Require `H=1` with cross-host evidence, or measure/test/approve the larger bound; otherwise use a durable shared limiter. |
| Checkout intent | Database intent TTL is 24 hours. `SIDESTREAM_PRO_PRODUCT_ID` selects the shared Product; the global USD Price uses the existing validated resolver, while optional `SIDESTREAM_PRO_INDIA_PRICE_ID` and `SIDESTREAM_PRO_BRAZIL_PRICE_ID` activate their regional catalog entries only after exact Product/currency/amount/one-time validation. The resulting offer snapshot, not current environment, is fulfillment truth. |
| Stripe lifecycle | Caught processing failures use fixed backoff and dead-letter at attempt 8, but process termination followed by lease reclaim has no claim-side attempt cap and can increment/reclaim indefinitely. A tested total-attempt terminal cap is a Production blocker. Legacy recurring access requires exact comma-separated `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS`; `refund.failed` handling/recovery and complete current dispute-status mapping are separate blockers. |
| License continuity | When `SIDESTREAM_LICENSE_HASH_SECRET` is absent, device hashing falls back to the first configured value from `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, or `POSTGRES_PRISMA_URL`; the runtime trims/selects and URL-normalizes that connection value first. A future reviewed plan needs a byte-preserving secret-continuity capability plus the same real device/token proof across any promotion. No such Production-safe capture/proof procedure currently exists. |
| Retention | `SIDESTREAM_MAINTENANCE_*`, session/credential/rate/intent grace variables, and Stripe processed/dead-letter payload retention variables are bounded before a query runs |
| Integration proof | `SIDESTREAM_TEST_POSTGRES_URL` is required, must be disposable, and is rejected if it matches any normalized runtime database target |

Exact defaults, bounds, required Stripe events, pool budget, and Production blockers live in `docs/api-hardening-runbook.md`.

### Two-device entitlement contract

The database model permits up to two active device rows per account in each namespace, while runtime mismatch blocking depends on the policy mode below and is not yet cut over by default. Preview/development/test use a restricted, separate `test` namespace with exact Test hosts and `SIDESTREAM_TEST_POSTGRES_URL`; they are not extra production seats and must not share a production host or database target. Same-device reconnect is free. A second device fills the available seat without replacing the first. Once both seats are occupied, a confirmed move replaces one reviewed device and revokes only that device's credential family. There is no rolling or lifetime move limit. Namespace-scoped active-slot unique indexes remain the concurrency backstop.

`SIDESTREAM_DEVICE_POLICY_MODE` accepts `off`, `observe`, or `enforce` and defaults to `observe`. Observe mode records pseudonymous policy mismatches; enforce returns `transfer_required`, `transfer_limit_reached`, `device_replaced`, or `device_deactivated` as appropriate. Explicitly revoked/replaced credentials remain invalid in observe mode, and `/api/license/authorize-download` always requires the exact active binding. A newly accepted Unlimited download is authorized before it starts; if that accepted download is already in progress, a later transfer or deactivation does not cancel it mid-transfer, but future authorization/verify/refresh requests see the new state.

Only server-secret HMAC-SHA-256 device digests plus coarse platform/version/timestamps may be persisted. Raw hardware fingerprints, raw device IDs, serial numbers, and device names are prohibited from storage and logs. OS-backed non-exportable device keys are future hardening, not protection delivered by this implementation. See `docs/single-device-entitlements.md` only for the device schema, API/page states, environment matrix, privacy rules, and conceptual support decisions. No executable Production procedure exists; `docs/api-hardening-runbook.md` records blockers and future capability requirements but authorizes no Production action.

The MacBook mockup media is a native muted, looping `<video>` that loads `mockups/mockup1_2.webm` from the canonical root HTML file. The generated VP9-alpha WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally. The mockup lives below the two pricing panels and the `.final` CTA inside `.pricing-mockup`, with the "Stop using sketchy websites to download music" panel now positioned above the laptop. It remains centered with a wide responsive video width and a soft bottom mask fade. It intentionally has no CSS drop shadow because filtering the alpha video can reveal a rectangular compositing edge during rotation. The bottom inline script prewarms it shortly before the viewport, starts it only while visible, pauses it offscreen or while the document is hidden, and keeps it from competing with the earlier feature demos during the initial mobile load.

The feature cards are chrome-free video frames that use native muted, looping MP4s from `demos/`. Each card offers a fast-start 1200×720 mobile source through `900px` and a fast-start 1800×1080 desktop source above it, all at 30 fps with one-second keyframe intervals. The mobile width covers a 430px Pro Max-class CSS viewport after the page's 24px gutters at 3× device density; do not lower it without checking small Premiere/Sidestream UI text at that actual surface. A lossless 1200×720 first-frame PNG sits over each video and is hidden only after the browser emits `playing`, so preload deferral, autoplay rejection, or a slow first decode leaves a high-fidelity static frame instead of black. A 500px prewarm observer changes `preload` from `none` to `auto` before the card arrives, while the separate visibility observer starts playback at 10% intersection and pauses it after it leaves. The Search and Preview feature sections sit inside `.feature-glass`, a full-bleed dark translucent band with heavy `backdrop-filter` blur that separates the demo proof area from the continuous shader without changing the individual `.shot` card treatment. `.feature-corner-demo` mounts `demos/sidestream-panel-corner.webm` as a decorative VP9-alpha video on the right side of the hero/main page, starts its clipping wrapper at `40vw` with `width: 60vw`, keeps `.feature-glass` in normal post-hero flow, and positions the square full-plugin crop at `left: 5vw`, `top: 25vh`, `width: max(1000px, 90vw)`, `opacity: 0.9`, and `mix-blend-mode: screen`. Its `translate(-4.75%, -13.7%) scale(0.7)` transform uses the matching `4.75% 13.7%` transform origin so the visible Premiere panel's compensated top-left anchor stays at `45vw 25vh` as the desktop window changes size. The screen blend plus lowered opacity lets darker areas of the recording breathe into the shader without adding a fake background matte. Its `<source>` is desktop-gated with `media="(min-width: 901px)"`, `.feature-corner-demo` is hidden at the same breakpoint, and the bottom inline playback helper pauses it while hidden. The band spans the full feature wrapper vertically so the top and bottom separator lines have clear breathing room around the first and last demo videos. The Search and Preview feature copy blocks intentionally do not include inline download CTAs; each keeps the heading plus `.feature-subtext` as the centered copy block beside its demo video. On fine-pointer hover, the same script tilts the parent `.shot` from its midpoint with CSS variables capped at 15 degrees on X/Y and a tiny Z-axis twist, so the video frame reads as one subtle 3D plane. The hover math tracks against the card's untransformed layout box and resets with an S-curve transition to prevent corner-entry jitter. Raw Screen Studio project folders, ProRes `.mov` renders, and Premiere/After Effects project files should stay out of git; export compact MP4s or alpha WebMs for the site instead.

The page background should preserve the provided Paper demo's shader direction without keeping its demo-site UI. The canonical HTML keeps a black CSS fallback on `body`; `#shader-background-root` is a fixed full-viewport mount, and `src/main.tsx` renders the adapted `DemoOne` component from `components/ui/demo.tsx`. The demo's default `activeEffect` is `"mesh"`, so the visible background keeps the original simple black/charcoal/gray `MeshGradient` branch with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`. The active mesh branch is the plain Paper `MeshGradient`; it must not listen to pointer movement, add wake/ripple uniforms, jiggle the canvas, or layer extra mouse-driven overlays. Keep the background to the single Paper shader canvas with no drawn ripple outlines, extra canvases, new colors, CSS filters, or red fog. Page text tokens use the off-white `#E2E8F0` and translucent off-white variants for contrast, while cards and pricing surfaces are dark translucent glass.

The header is a fixed transparent overlay with no scroll divider so the shader remains uninterrupted behind the nav. The `.hero-pad` section fills the first viewport and aligns the hero headline, subline, and primary `Download for Mac` CTA to the lower-left first-fold gutter. The Sidestream wordmark and hero copy share the viewport-left `24px` first-fold gutter, and the Features/Account navigation cluster is absolutely anchored to the viewport's top-right corner with a `15px` top offset and matching `24px` right gutter. Each desktop nav link uses a compact rounded glass frame with a white-fill hover state so it stays legible as the shader moves without competing with the larger download pills. The header intentionally has no Pricing or download CTA; pricing remains available in the page body, and downloads remain available in the hero and Free pricing card.

On desktop, `.feature-start` keeps the Search demo group below the hero with positive top padding, creating a clear margin between the hero download buttons and the "Search for YouTube videos." heading without changing the shared lower-page `.sec-pad` rhythm.

The pricing headline intentionally sits halfway between the bottom of the `.feature-glass` band and the pricing cards: `#pricing` overrides the shared section top padding to `92px`, while `.pricing-head` uses a matching `92px` bottom margin so the cards stay in place. The mobile override uses a matching `74px` top padding and bottom margin. `.pricing-line` keeps "Unlock when you need more." on its own lighter-weight line. The two pricing cards use a larger `28px` corner radius and a pricing-only `IntersectionObserver` that adds `html.pricing-motion-ready` plus `.is-visible` so the cards glide up once before they fully enter the viewport; no global `.reveal` behavior is restored. The $0 card is labeled "Free" and says "3 free downloads every day." The Unlimited plan renders `$19.99 once` as its global fallback and updates to `₹499 once` for trusted India traffic or `R$25 once` for trusted Brazil traffic; its link still opens `/api/checkout/start`, authenticates the user, and opens Stripe Checkout.

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
rejects `--apply-schema`; apply schema exclusively through the guarded,
checksummed migration runner after the canonical runbook's human gates are
satisfied. Do not aim this README example at Production, deployed Test,
or a public endpoint.

Validate local migration ordering/checksums and list the local chain without any
environment file or database connection:

```bash
npm run db:migrate -- --validate
npm run db:migrate -- --dry-run
```

Those modes return before database selection. Connected Test status/apply use
only `SIDESTREAM_TEST_POSTGRES_URL`:

```bash
SIDESTREAM_TEST_POSTGRES_URL='<approved Test Postgres URL>' \
  npm run db:migrate -- --status --target test
SIDESTREAM_TEST_POSTGRES_URL='<approved Test Postgres URL>' \
  npm run db:migrate -- --target test
```

Connected Production status is read-only and prints separate status, apply, and
baseline fingerprints after attesting the connected database. If a separately
approved migration stage is reached, use only the matching operation-bound
fingerprint:

```bash
SIDESTREAM_POSTGRES_URL_NON_POOLING='<approved Production direct URL>' \
  npm run db:migrate -- --status --target production
SIDESTREAM_POSTGRES_URL_NON_POOLING='<approved Production direct URL>' \
  npm run db:migrate -- --target production \
    --confirm-operation APPLY_PRODUCTION_POSTGRES_MIGRATIONS \
    --confirm-target pg-<apply-target-fingerprint>
```

Use `--baseline` only for a separately reviewed recognized legacy schema without
a ledger, with `BASELINE_PRODUCTION_POSTGRES_MIGRATIONS` and the status command's
baseline fingerprint. The runner rejects weak remote TLS and wrong/ambiguous
namespaces, takes a global advisory lock, verifies ledger SHA-256 values, and
commits each migration plus its ledger row atomically. The command shape is not
authorization or evidence that a Production migration occurred; preserve
before/after connected status and follow `docs/customer-360.md`.

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

To report dedicated organic Instagram ManyChat landing visitor-days from the private Blob store, use an ignored environment file with Blob credentials:

```bash
SIDESTREAM_ENV_FILE='<ignored-env-file-with-blob-credentials>' \
  npm run analytics:referrals -- --source manychat-instagram --days 7
```

Use `--source manychat` only for the legacy generic ManyChat routes. The report separates likely-human and likely-scanner daily visitor counts. It does not identify people or prove downloads, installs, activations, or purchases.

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

The Postgres aggregate covers identity/merge, currency-partitioned commerce,
once-daily telemetry sync and rolling-window decay, protected list/detail reads,
the protected acquisition/retention funnel, dry-run backfill recovery,
cross-namespace isolation, single-device separation, and end-to-end replay. It
scrubs ambient runtime database selectors and blocks all network destinations
except the approved disposable Postgres endpoint.

`test:api` discovers every `tests/*.test.mjs` suite and fails if a Postgres suite is not explicitly classified. `test:postgres-integration` never silently skips: it requires `SIDESTREAM_TEST_POSTGRES_URL`, rejects a normalized host/port/database match with any runtime URL even when credentials/query options differ, runs serially in a random schema, and drops that schema in `finally`. After a human runs `npx vercel@latest build`, run `npm run verify:vercel-build` to inspect `.vercel/output`; that verifier deliberately fails when no Vercel build artifact exists.

Check the source-owned paid sequence without contacting Stripe, Google, Vercel,
or Postgres:

```bash
npm run verify:checkout-contract
```

Regenerate and verify the isolated paid mobile landing after changing the
canonical HTML or paid offer:

```bash
node scripts/build-paid-landing.mjs
node scripts/build-paid-landing.mjs --check
```

Run all deterministic paid-acquisition fixtures without contacting Stripe,
Resend, Vercel Blob, or Postgres:

```bash
npm run test:paid-acquisition-e2e
node scripts/verify-paid-acquisition-e2e-fixtures.mjs
node --experimental-strip-types --test tests/paid-onboarding-claim.test.mjs
```

These checks prove only the local contract. They do not enable `/mc`, apply the
namespaced migration, send paid email, publish artifacts, make a payment, or
prove a deployed surface.

The owner-only emergency Production command requires a clean local commit equal to remote
`origin/main`, reads the Git SHA currently served by canonical Production
`/version.json`, and requires that live SHA to be an ancestor of the candidate.
It then verifies the immutable checkout baselines and exact linked Vercel
project, runs the focused entitlement suite, builds the Production artifact,
checks its bundled Google/Stripe handlers, root-page allowlist, and embedded
SHA, deploys that prebuilt artifact, verifies the default Vercel Production
alias reports that SHA through an authenticated protected-deployment read,
promotes that exact deployment to `sidestream.tv`, and
then verifies that canonical Production reports the candidate SHA and redirects
Checkout directly to Google or Stripe. The final readback retries a bounded six
times at two-second intervals for alias propagation, then fails closed:

```bash
npm run deploy:production
```

Agent sessions must not run that CLI command. They publish by fast-forwarding
the verified change to `origin/main`; the Vercel Git integration tracks only
`main` for Production and treats every other branch as Preview. Local Vercel CLI
authentication is intentionally absent from the shared agent machine so an old
checkout cannot bypass the current repository guard with `vercel deploy --prod`.
The emergency command requires deliberate owner reauthentication.

Integrate an intended feature onto the current `origin/main` before any
Production release. Feature and release branches are not Production sources. A candidate
that diverged before the live Production SHA fails before build. The one
reviewed recovery from the pre-marker deployment is bound to its exact Vercel
deployment ID; after the first marker-bearing deployment replaces it, that
bootstrap condition cannot match again.

After a separately authorized Production deployment, use the manual paid-claim
smoke checklist in `docs/paid-acquisition-runbook.md`. That checklist verifies
the canonical alias, an ordinary Free account's unchanged
`/api/activation/claim` → `/api/checkout/start` → Stripe boundary, the exact
paid source's support-only inactive-entitlement page, and an already-active
account's existing reconnect/transfer decision. It deliberately does not visit
`/mc`, change either paid-acquisition switch, apply a migration, send email,
publish an artifact, or complete a payment. A successful build or Vercel Ready
deployment is not a substitute for those canonical-surface checks.

The build copies the valid undated sitemap template, then `scripts/generate-sitemap.mjs` writes `dist/sitemap.xml` with an ISO `<lastmod>` derived from `index.html`. A clean Git checkout uses the latest commit that changed the page; a dirty local page uses its filesystem modification time. If Git history is unavailable, the build omits `<lastmod>` instead of inventing a build-time date. Do not put a manual `<lastmod>` back into `public/sitemap.xml`.

## Git / Publishing

This folder is a git repository for `git@github.com:alexgmov/Sidestream-Website.git`.

`origin/main` is the only canonical branch and the default source for all work. Existing `codex/*`, `orch/*`, release, detached, and worktree branches are historical/non-canonical: ignore them unless Alex explicitly names one. Agents must not search those branches for newer code, start from them, merge them, create another branch/worktree, push them, or deploy them by default. Start every task by fetching `origin/main`, checking out local `main`, fast-forwarding it with `git pull --ff-only origin main`, and reporting `git status --short --branch`. Work directly on synchronized local `main`, commit there, and push only `main:main`. If `main` cannot fast-forward or unrelated local changes are present, stop and ask Alex rather than switching branches.

Relevant tracked files are the canonical root HTML page, legacy static redirect, React shader entry/component files, Vite/Tailwind/shadcn config, README, `.thumbnail`, generated WebM/MP4 demo assets, and reference screenshots. Finder `.DS_Store`, `node_modules/`, `dist/`, raw demo source renders, Premiere/After Effects project files, and local auto-save/download folders are ignored.

The generated MacBook mockup video in `mockups/mockup1_2.webm` is tracked. Raw mockup production files in `mockups/` are intentionally ignored because they can be hundreds of megabytes.

The project is linked to Vercel project `alex-3685s-projects/sidestream`. `.vercel/`, `.env.local`, and other `.env*` files are ignored. Publish Mac metadata with `npm run release:publish-manifest -- --platform macos --version <x.y.z> --artifact <local dmg> --pathname sidestream/<x.y.z>/Sidestream-<x.y.z>-Mac-Installer.dmg --signed --verified --uploaded --smoke-tested`. Publish an intentionally unsigned Windows beta with `--platform win32-x64`, an EXE/pathname, and `--unsigned-beta-approved --verified --uploaded --smoke-tested`; never lie by passing `--signed` for an unsigned build. Agent releases fast-forward verified commits onto `origin/main` and rely on the Git-linked Production deployment; `npm run deploy:production` is owner-only emergency recovery after deliberate human reauthentication. Keep bare `/api/download` on the native/base Mac DMG and keep `.vercelignore` aligned with tracked publishable media so Vercel CLI deploys do not upload raw local `demos/` and `mockups/` production assets.

`vercel.json` deliberately pins `installCommand`, `buildCommand`, and `devCommand` to npm. The dev command must pass Vercel's `$PORT` into Vite; otherwise `vercel dev` can accept connections on its proxy port and hang. If the Vercel dashboard still has an old package-manager preference, the repo config should win. Vercel's host-based `has` matching works after deployment but not in `vercel dev`, so use a preview/production deployment plus `curl -I` to prove the `www` redirects and the non-API `sidestream-xi.vercel.app` redirects. The old host intentionally continues to serve `/api/*` in place because installed Sidestream 1.0.12 panels POST to that origin and do not follow Vercel's `308` response.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and check that the first fold intentionally places the hero copy lower than the older `Sidestream front end 2/screenshots/01-scan.png` reference.
- Run `npm run test:api` after any API, shared helper, migration, cron, or handler-contract change. Run `npm run test:postgres-integration` with a disposable `SIDESTREAM_TEST_POSTGRES_URL` after any database/concurrency change; it must never target production or a deployed Test database.
- Run `npm run verify:checkout-contract` and `npm run test:entitlement` after checkout, authentication, activation-claim, account, or Stripe fulfillment changes. The source verifier proves the exact Upgrade, Google authentication, and Stripe sequence, the root-page allowlist, and both valid zero-total Stripe statuses.
- Run `node --experimental-strip-types --test tests/checkout-offers.test.mjs tests/checkout-abuse.test.mjs` after regional catalog, trusted-country, Checkout-intent snapshot, Price reuse, or fulfillment-approval changes. The focused suites cover global and India purchases, ignored browser-forged regional inputs, cross-region Price mismatches, catalog changes during an open Session, concurrent/reused Sessions, failed Stripe verification, exact account metadata, and zero-total promotions.
- Run `npm run pricing:check` after any offer edit. It checks generated website, JSON-LD, crawler, and paid-landing fallbacks against `config/pricing-contract.mjs`, verifies Free/global/India/Brazil definitions, and simulates a different global price to prove stale public surfaces are detected. Use `npm run pricing:sync` to regenerate those derived files before review.
- Run `node --test tests/reset-alex-upgrade-state.test.mjs` after changing `scripts/reset-alex-upgrade-state.mjs`. The reset inventories Alex-linked paid-acquisition claims and email jobs, deletes them before their paid/core Checkout parents, and includes each table in its final zero-state verification. Paid-acquisition tables are optional only as an all-or-none migration set so an older Test schema remains supported without allowing a partial schema to bypass cleanup.
- After changing the mobile handoff, run the focused `tests/download-leads.test.mjs` suite, then verify at a realistic phone width that the inline form replaces both platform buttons, invalid email stays local, success is announced, and lower download CTAs scroll back to the form. At desktop width, confirm the form is hidden and both direct platform downloads remain unchanged.
- Run `node scripts/assert-no-runtime-ddl.mjs` and `node scripts/validate-vercel-contract.mjs` after API/migration/routing work. For a human Vercel build, follow `npx vercel@latest build` with `npm run verify:vercel-build`.
- At `430×932`, confirm both feature cards select their hashed 1200×720 mobile MP4s; above `900px`, confirm they select the hashed 1800×1080 desktop MP4s. In both cases the lossless poster must be visible before playback, disappear only after `playing`, and remain visible if `play()` is rejected. Confirm each video prewarms before it enters the viewport, starts playing when scrolled into view, and pauses again after leaving view.
- At `430×932` and a short-height mobile viewport, confirm `pryt.png` remains centered in the open hero space above the headline, uses the exact standard `min(79.488vw, 311.04px)` and short-height `min(70.848vw, 276.48px)` widths, stays hidden above `900px`, and does not push the handoff below the first fold.
- Run `TZ=America/Los_Angeles node --experimental-strip-types --test tests/customer-360/core.test.mjs` after Customer 360 identity or profile-merge changes, then run `node --experimental-strip-types --test tests/customer-360/core-postgres.test.mjs` for the database total-order contract.
- Run `node --experimental-strip-types --test tests/customer-360/commerce.test.mjs` after commerce normalization changes, then run `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' node --experimental-strip-types --test tests/customer-360/commerce-postgres.test.mjs` after payment-group, identity-link trigger, allocation-edge, or totals changes. The Postgres suite proves partial capture authority, Checkout-only and paid-Invoice fallback replacement, paid InvoicePayment overlap deduplication with an unrelated-Checkout negative control, fully and partially off-Stripe totals, verified fallback dates, modern paid/open InvoicePayment shapes, many-to-many allocations, refund-first late attachment, product scope, and whole-group quarantine.
- Run `npm run test:customer-360`, then `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres`, after any Customer 360 contract, identity, commerce, usage, query, migration, or backfill change. Confirm the harness rejects runtime/telemetry endpoint collisions, protected list/detail fields match `docs/customer-360.md`, dry-run makes no connection or checkpoint write, and the complete pipeline leaves entitlement/single-device state unchanged.
- Run `npm run test:customer-360` after acquisition/retention documentation or report-contract changes. For query or aggregation behavior, also run the unmodified `npm run test:customer-360-postgres` against its approved disposable database and confirm first-install cohort bounds remain separate from the completed UTC-day observation end, immature profiles are excluded from return/one-and-done denominators, exact `session_started` open days and day-zero accepted attempts stop at that boundary, activation numerators are first-open subsets, post-install attribution candidates cannot rewrite acquisition, unknown coverage remains complete, and privacy exclusions plus journey ordering remain deterministic.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- Run `npm run test:download-referral` after changing installer attribution or `/api/download`. It verifies that tagged `GET`s are recorded only after a successful redirect, while `HEAD`, `304`, bad platforms, fulfillment errors, database errors, and database timeouts cannot create a false successful event or block delivery.
- Run `npm run test:referral-visits` after changing `/manychat-instagram`, `/m`, `/mc`, `/api/referral-visit`, the ManyChat browser hook, private-Blob referral storage, or its report. It verifies the dedicated and legacy route forms, both allowlisted sources, bounded request body, response-before-storage behavior, source-separated daily anonymous dedupe inputs, scanner separation, and hash-free aggregate output.
- After changing paid `/mc` routing, the generated paid landing, paid Checkout/email/artifact/claim handlers, the entitlement bridge, or the paid schema, run `node --experimental-strip-types --test tests/paid*.test.mjs`, `npm run test:paid-acquisition-e2e`, `node scripts/verify-paid-acquisition-e2e-fixtures.mjs`, `npm run test:entitlement`, and `npm run typecheck`. The paid-onboarding suite must prove exact raw-source selection, server-side stored-source revalidation, support-only no-entitlement HTML, and reuse of the existing CSRF/device policy. Recheck that ordinary signed-in Free-account Checkout still redirects directly to Stripe, uses its server-selected stored offer and full request fingerprint, and that `/m`, root, free download, account, activation, and all non-exact `/mc` redirects are unchanged.
- After SEO/GEO metadata changes, run `npm run build`, confirm `dist/robots.txt`, `dist/sitemap.xml`, `dist/llms.txt`, and the current versioned social-card asset exist, validate both source and built sitemap XML, confirm the built sitemap contains a generated ISO `<lastmod>` while the source contains only the generator marker, and spot-check the built HTML for the absolute canonical URL, meta description, Open Graph/Twitter image tags, and valid JSON-LD. When replacing a social card, publish it under a new filename and use a new share-query value because X may cache both the fetched page metadata and image URL.
- Run `npx vercel@latest build` after routing/header changes, then `npm run verify:vercel-build`. Inspect `.vercel/output/config.json`, then verify a deployed response: `www`, the old-host root/non-API paths, `/index.html`, and `/Sidestream%20front%20end%202/Sidestream.html` must return `308` with `Location: https://sidestream.tv/`; old-host `/api/activation/start` must execute instead of redirecting; `/api/auth/session`, `HEAD /api/download`, `/account.html`, and `/thank-you.html` must return `X-Robots-Tag: noindex, nofollow`. Do not issue `GET /api/download` just to test headers.
- After publishing analytics changes, visit the deployed site without a content blocker and allow roughly 30 seconds before checking the Vercel Analytics dashboard for page-view data.
- Confirm the dark Paper shader renders behind the header, hero, cards, pricing, footer, and toast.
- Confirm the Sidestream wordmark and desktop hero copy share the viewport-left `24px` first-fold gutter, and the Features/Account header cluster sits at the viewport's top-right with a `15px` top offset and `24px` right gutter. Confirm each link has its own compact rounded glass frame, turns white with black text on hover, shows a visible keyboard focus ring, and does not introduce a Pricing or download header CTA.
- Confirm the brand wordmark, white pill-rounded download CTAs with the black Apple platform mark, black text, red hover fill/white hover text, check icons, and rotating noun gradient use the red accent palette without leftover orange accents.
- Confirm the background uses the pasted demo's black/charcoal/gray `MeshGradient` branch with the 20%-darker `#151515`, `#292929`, and `#a3a3a3` non-black stops, with no custom red CSS fog, extra overlay gradients, or mounted `EnergyRing`.
- Confirm moving the mouse across the desktop hero does not change the background. The backdrop should remain the plain Paper `MeshGradient` with one visible canvas, no wake/ripple artifacts, no whole-background jiggle, and no CTA hit-target interference.
- Confirm the final CTA panel stays clean above the pricing MacBook mockup and does not render the old top-right red radial glow.
- Confirm the pricing MacBook Pro mockup video autoplays, loops, stays muted, sits centered below the two pricing panels plus final CTA, and does not create horizontal overflow. If browser autoplay is fussy, confirm the inline `.macbook-mockup-video` playback helper kicks it after load or visibility return.
- Confirm the desktop hero copy still uses the wider left-anchored first-fold shell while staying aligned with the fixed Sidestream wordmark, sitting near the bottom-left corner of the first viewport, and rendering the "in Premiere Pro" subline in italic.
- Confirm both desktop hero platform links use the visible label `Download`, matching white pills, and their respective Apple and Windows marks; expose explicit platform-specific accessible names, start the correct installers without opening either historical modal, and retain the shared red hover treatment. At `900px` and below, confirm those links are replaced by the optional email handoff plus the no-email secure computer-link action instead of stacked installer buttons.
- Watch the pricing MacBook rotation long enough to confirm the laptop stays centered and the alpha edges are not clipped by the pricing wrapper.
- Confirm the Search demo group starts below the first fold with a deliberate gap between the hero download CTAs and the "Search for YouTube videos." heading on desktop and mobile.
- Confirm the "Start free. Unlock when you need more." headline sits centered in the vertical space between the bottom of the `.feature-glass` band and the pricing cards.
- Confirm "Unlock when you need more." renders as the lighter-weight `.pricing-line`, while "Start free." stays heavier.
- Scroll down to pricing and confirm both pricing cards begin animating before the section feels empty, with the Unlimited card following the Free card by a slight stagger, both cards using visibly rounder 28px corners, and the Unlimited card using a white outline with no drop shadow.
- Confirm the Free card says "3 free downloads every day."
- Confirm the Unlimited card says `$19.99 once` globally, `₹499 once` from genuine India egress, and `R$25 once` from genuine Brazil egress, while always linking to `/api/checkout/start`. Verify `/api/checkout/offer` is private/no-store, browser query parameters cannot select a region, and the browser sequence remains Upgrade button, Google authentication, Stripe payment. Use a Free account without an already-open locked Checkout intent when comparing the landing price to a newly created Stripe Session.
- Confirm the feature demo videos are paused before they enter the viewport, start playing when scrolled into view, and pause again after leaving view.
- Confirm accessibility audits do not report prohibited ARIA attributes: named `.shot` and `.pricing-mockup` visuals use `role="img"`, and the named Unlimited plan card uses `role="group"`.
- Confirm the Search and Preview feature sections have no inline download buttons, while the heading and subtext blocks stay vertically centered beside their demo videos on desktop and mobile.
- Confirm the `.feature-glass` backdrop spans the full x-axis behind the Search and Preview demo sections, blurs/darkens the shader behind it, and stays in its normal post-hero position.
- Confirm the decorative `.feature-corner-demo-video` keeps the visible Premiere panel's compensated top-left anchor within `1px` of `45vw 25vh` at multiple desktop window sizes, revealing more of the recording's lower and right edges while playing with `screen` blend and `0.9` opacity, keeping `.feature-glass` unmoved, and remaining hidden and paused at `900px` and below.
- Confirm the top and bottom `.feature-glass` separator lines leave enough vertical breathing room around the first Search demo video and last Preview demo video.
- Confirm hovering each feature demo video tilts the frame subtly from its center, with the top-right pointer position pushing the top-right corner away from the camera, no top-left corner-entry jitter, a smooth S-curve reset on exit, and no hover tilt on reduced-motion or coarse-pointer devices.
- Confirm bare `/api/download` responds to `HEAD` with the current Mac attachment and `/api/releases/latest` returns the matching Mac manifest. Confirm `?platform=win32-x64` returns the Windows EXE/manifest, both Windows manifest links point at the platform route for v1.0.12 compatibility, and an unknown platform returns `404`. Confirm `GET` returns a temporary redirect to a signed private Blob URL; when testing the deployed route, use a ranged follow such as `curl -L -r 0-0` to avoid downloading the full installer.
- Confirm a tagged Gmail Windows `GET` using `utm_campaign=windows_beta_1_0_13` and a real `utm_content` batch creates one referral row after redirect, while the equivalent `HEAD` creates none. Use a separate smoke-test campaign or remove the exact smoke row afterward so verification does not inflate launch reporting.
- Confirm Mac and Windows download CTA clicks start their platform-specific public installers immediately without opening either historical email modal.
- In a disposable/local database, confirm `npm run leads:dump` includes seeded historical Windows waitlist submissions with `cta_source` equal to `windows-waitlist`. Do not use the current unauthenticated-TLS dump client to inspect Production; that check waits for the runbook's authenticated export-tool prerequisite.
- With Vercel dev and account env configured, confirm signed-out `GET /api/checkout/start` redirects to Google authentication and the authenticated return redirects to Stripe Checkout. Confirm the Stripe Session uses invoice creation and persists the activation's exact Session before redirect, successful Checkout passes through `/api/checkout/complete` to `/thank-you.html`, cancellation returns to `/account.html`, receipt and Customer Portal work, the webhook only records/queues signed Stripe events, and account/session reads never process queue backlog.
- On the signed-in desktop account page, confirm every row action shares the panel's right edge, including wrapped receipt and refund controls; below `680px`, confirm the controls remain full-width.
- From a signed-out browser, confirm the landing-page Account link and a direct `/account.html` visit enter Google OAuth without rendering the account headline or an empty sign-in panel. Confirm Google's `redirect_uri` is exactly `https://sidestream.tv/api/auth/google/callback`, stale or mismatched OAuth state renders the flat retry page instead of raw JSON, and a real Google round trip returns to the signed-in account page. From a browser with a valid `sidestream_session` cookie, confirm the Account link skips Google and opens the account page. Confirm Sign out clears the session and returns to `/`, and confirm the account background is a flat near-black with no red gradient.
- Run `npm run test:entitlement`. Confirm `/api/activation/start` rejects a missing device ID and returns `activationKey`, 24-hour `expiresAt`, `upgradeUrl`, and `restoreUrl`; status rejects a wrong device, stays pending before payment, and returns one seven-day access token plus a rotating 365-day refresh token only after exact Stripe verification. Confirm a webhook-delayed paid Session self-reconciles, an unpaid Session never binds, a repeated current-client status call returns the same credential family only inside the 10-minute completion replay window, and status cannot mint after that window or activation expiry. Separately confirm legacy clients through 1.0.13 receive `active` throughout the unexpired activation window, their access expiry rolls forward on verify, and old-host Checkout without an activation redirects to the non-purchasing `activation_required` state before Stripe.
- Run `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:single-device`, then `npm run typecheck` and `npm run build`, for the complete account-device contract. The aggregate must prove production/Test namespace isolation, two-seat database races, observe/enforce behavior, same-device reconnect, unlimited confirmed moves, per-device `device_replaced`/`device_deactivated` revocation, refresh replay, download authorization, read-only status, explicit deactivation, legacy compatibility, and exact Checkout support-state preservation.
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

- A Vercel Production deployment can be Ready while originating from stale source. Production source is only the fast-forwarded `origin/main` lineage linked to `alex-3685s-projects/sidestream`. Agent sessions must not retain Vercel CLI authentication or run direct Production deployments; push verified `main`, then require canonical `/version.json` to report that exact SHA and verify the live Checkout redirect. `npm run deploy:production` is owner-only emergency recovery after deliberate human reauthentication.
- The paid `/mc` foundation is default-off, unlinked, and additive. Missing `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` must continue to fall back to the canonical ManyChat destination, and paid provider delivery must remain off unless `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=1`. Do not configure either setting, apply the paid migration, publish paid artifacts, or deploy from this documentation alone. Paid Checkout must use the same trusted-country offer selection and immutable snapshot as ordinary Checkout; never restore a separate paid-acquisition amount or currency assumption.
- Paid activation `source` is only a strict UX selector. Exact `paid-acquisition-mc-v1` returns `/api/activation/paid-claim`; whitespace, casing, or any other source remains on `/api/activation/claim`. The dedicated handler also requires that exact stored source, but only the authenticated account's active Unlimited entitlement and existing device policy can authorize connection.
- `/mc-preview` is the deterministic desktop review surface for the otherwise phone-only 50/50 `/mc` experiment. Keep it unlinked and noindex; it intentionally replaces an existing control assignment with a signed paid assignment so the same browser can exercise the real paid Checkout boundary.
- Customer 360 captured money authority is the PaymentIntent `amount_received`, or `amount_captured` on a standalone Charge when no PaymentIntent exists. A paid Checkout or Invoice is a fallback only while its related settled instrument is absent, and refresh must replace rather than add that fallback when stronger truth arrives. Before instrument arrival, suppress a Checkout fallback only when a paid Invoice fact in the same namespace, profile, and currency has a paid InvoicePayment edge resolving to that Checkout payment key; prefer the Invoice and leave unrelated Checkout fallbacks countable. Checkout authorization must never re-inflate a partial capture. Invoice `amount_paid` is full gross customer money; `amount_paid_off_stripe` is a nonnegative subset of gross, not a deduction or an amount to add twice. Paid InvoicePayment rows are allocation edges keyed by `invoice_payment.id`; open/canceled rows do not attribute money, and an invoice/instrument many-to-many graph must not become alias equivalence.
- Customer 360 identity safety is a payment-group invariant. If any retained alias, trusted identity evidence, or already-safe owner resolves one canonical payment group to different live profiles, the namespace advisory lock must clear `profile_id` and set `identity_conflict=true` on every materialization in that group before totals refresh. This whole-group quarantine is sticky across replay, later one-owner rows, and identity-link triggers; only an explicit group-wide recomputation after a deterministic profile merge may clear it. A Stripe customer link alone never scopes unrelated product money.
- Customer 360 database `created_at` values reach TypeScript as fixed-width six-microsecond UTC timestamps without a timezone suffix. Compare two canonical values lexically before `Date.parse`; parsing first treats them as local time, can reverse order across a DST gap, and violates the database trigger's `(created_at, id)` total-order contract. ISO inputs from pure callers still use parsed instant ordering, and equal timestamps still use the UUID tie-breaker.
- Customer 360 currently has no deletion or aggregate-expiry job. Daily usage buckets, canonical profiles/identity, and commerce materializations persist; merge and identity-review audits are immutable. Do not claim a retention period until a separately reviewed implementation enforces one. Stripe payload redaction and the 90-day installer-referral policy are separate domains.
- Customer 360 route code and guarded operators are present, but this code-only run did not establish current Production configuration or behavior. The live dashboard database was previously observed with the required schema and materialized identity/commerce rows, while Production runtime database selection, backfill completeness, protected API behavior, historical rescan, and usage sync remain unverified. The repository contract allows only the human-gated Preview/Test-first sequence in `docs/customer-360.md`; no route response, database row, dry-run, local test, build, or documentation result is Production approval.
- Customer 360 local or fixture-backed FlowState consumers may implement the audited contract before website deployment, but live upstream Preview/Test integration and QA remain gated on separately approved migration, configuration, deployment, protected API, freshness, and scheduling evidence. Vercel cannot enable only the usage job: use a separately approved protected manual/non-Production scheduler or review all four jobs before the project-wide switch.
- Source-segmented retention is an attribution subset, not the overall customer base. Exact paid Checkout wins over exact anonymous browser-to-install claim, which wins over exact verified-account/profile-email evidence; every other install remains unknown. Never infer source from timing, IP, user agent, referrer, nearby events, or approximate identity, and never remove unknown installs from overall stickiness, which uses all install IDs.
- Historical usage rows created under the former broad non-installer activity rule do not become exact merely because the code changed. The normal overlap cannot rewrite all of them. Historical retention remains unqualified until the guarded full append/update rescan completes with its source/target-bound checkpoint and no-delete evidence. The repository's TLS-safe sync/rescan tools are capabilities, not authority; `docs/customer-360.md` owns the exact commands and human gate, and no migration, configuration, rescan, scheduler change, deployment, or release occurred in this documentation step.
- Anonymous acquisition has four distinct identities: signed browser token, locally verified install/receipt hashes, sparse Customer 360 profile, and later verified account/contact. Do not put UTM/email/hashes into handoff or claim URLs, personalize packages, treat email as merge authority, or let tracking failure block installer delivery. Missing Production configuration must remain fail-closed for association and protected reads.
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
- Mac and Windows download CTAs use `[data-download]` and `[data-windows-download]` button overrides that win over primary/secondary button classes: white capsule backgrounds, black platform marks and text, and red hover fills with white text while preserving existing sizing. The desktop hero and Free pricing card use matching visible `Download` labels with platform-specific accessible labels and URLs; the Free card’s platform pair is hidden at `900px` and below because the hero email handoff already sends both installers. The closing `.final` panel and header intentionally have no download CTA. All visible Mac download CTAs should point at `https://sidestream.tv/api/download`, while Windows CTAs use `?platform=win32-x64`, unless the fulfillment host intentionally changes. Do not reintroduce the email modal as a blocking step without explicitly revisiting the unblocked installer strategy.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav. Keep `.nav-links` anchored from the full viewport rather than the centered first-fold shell, or the control cluster drifts inward on wider screens.
- The desktop Features/Pricing/Account links use individual compact glass pills with a `10px` gap. Keep them visually quieter than the solid white download CTAs, retain the white-fill hover and focus treatment, and remember that the entire nav remains hidden at `900px` and below.
- Desktop hero-to-feature spacing is tuned with `.hero-pad` filling `100svh`, bottom-aligning content, and using `padding: 112px 0 clamp(72px, 9vh, 104px)`, plus `.feature-start { margin-top: 0; padding-top: clamp(96px, 12vh, 136px); }`. Keep `.feature-glass` in normal post-hero flow; if the right-side demo needs to fill more space, resize or reposition `.feature-corner-demo-video` instead of moving the frosted feature band. The mobile override uses `.hero-pad { padding: 128px 0 72px; }` and `.feature-start { padding-top: 84px; }`, with a narrower override of `64px`/`72px` at `520px`; that breakpoint also makes both hero platform CTAs full width. Adjust those first-feature entries before changing shared `.sec-pad` rhythm, but keep the Search copy grid-centered beside its demo video.
- `.feature-corner-demo` is a non-interactive decorative layer after `#hero` and before `.feature-glass`. Its clipping wrapper starts at `40vw` and spans `60vw`; the video sits another `5vw` into that wrapper, placing its source-space anchor at `45vw`. The paired `translate(-4.75%, -13.7%)` and `transform-origin: 4.75% 13.7%` values compensate for the WebM's transparent padding before the `scale(0.7)` transform, locking the visible Premiere panel's compensated top-left anchor to `45vw 25vh`. Keep those percentages paired if the source crop changes, and do not add background fills or box-shadow mattes because the alpha WebM will reveal them.
- Pricing headline placement is tuned independently from shared `.sec-pad`: `#pricing { padding-top: 92px; }`, `.pricing-head { margin-bottom: 92px; }`, and the mobile override uses matching `74px` top and bottom spacing. `.pricing-line` is intentionally `font-weight: 300`. The Unlimited card links to `/api/checkout/start`; `$19.99 once` remains the static global/SEO fallback, while the page replaces only `[data-checkout-offer-price]` from the private/no-store `/api/checkout/offer` response. Checkout truth still comes independently from `api/_lib/checkout-offers.ts` plus the stored intent snapshot, and no value returned to the browser is accepted back as a Checkout selector. The compatibility-named async `getSidestreamProPriceId()` resolves the global catalog's exact `1999` USD amount by validating configured/default Price IDs as non-authoritative hints, then checking the expanded Product `default_price`, exact `sidestream_pro_once_1999` lookup key, and any other active matching Product Price before its idempotent create fallback. India and Brazil use only their configured regional Price IDs and require exact Product/currency/amount/one-time validation; they never create Prices. A stale or deleted global configured Price may fall through; an explicitly configured invalid regional Price fails closed. The public tier name is Sidestream Unlimited, while existing `SIDESTREAM_PRO_*`, `sidestream_pro`, and historical lookup-key identifiers remain stable for purchase compatibility. Change the canonical contract, run `npm run pricing:sync`, provision new immutable Stripe Prices, update regional environment IDs, and run the pricing/checkout/entitlement gates together. The pricing-card motion should stay scoped to `#pricing .plan.reveal`, use an early positive bottom `IntersectionObserver` margin, and avoid re-enabling global `.reveal` because it was previously disabled for environment fill-mode issues.
- Desktop first-fold horizontal placement is tuned with `--hero-shell-maxw: 1280px` and `--first-fold-gutter: 24px`. `#hero > .wrap` is left-anchored above `900px` so the hero copy shares the same viewport-left guide as the fixed Sidestream wordmark. The MacBook mockup is no longer part of the hero; it is centered below `.plans` and the `.final` CTA in `.pricing-mockup`.
- Feature heading sublines use `.feature-subtext` with the SF Pro system stack at a light weight; `.feat-copy > h2:last-child` removes the trailing heading margin when there is no CTA so the heading/subtext block stays centered beside the demo. Avoid restoring the old serif treatment unless the whole feature-heading direction changes.
- The large footer `.wordmark` intentionally uses a Helvetica-first bold stack instead of the global SF Pro stack.
- The rotating noun should stay on matched keyframe animations for both enter and exit. Mixing CSS transitions with keyed enter animations or adding overshoot makes the headline feel choppy.
- The rotating noun gradient should animate only `background-position` and color/filter values. Do not animate the word transform for the gradient drift or it will fight the roll keyframes.
- Text tokens are tuned for a dark shader background, with `--ink` and `--white` set to `#E2E8F0` and `--ink-soft`/`--ink-faint` using translucent `#E2E8F0`. If the page returns to a light background, retune `--ink`, `--ink-soft`, `--ink-faint`, surfaces, and button states together.
- If the MacBook mockup is resized, keep enough vertical room in `.pricing-mockup` and preserve the bottom mask on `.macbook-mockup-video`; a too-short wrapper, unmasked video edge, or video-level CSS drop shadow can create a hard line around or below the laptop.
- Keep `mockups/mockup1_2.webm` checked after background changes; dark backgrounds can make transparent alpha edges more visible if the `.macbook-mockup-video` mask or shadow is changed.
- Mobile split sections must override both `.split` and `.split.flip`; otherwise the more-specific desktop flipped grid can leave feature cards half-width on narrow screens.
- `.mobile-hero-logos` is the mobile-only replacement for the hidden hero recording. Keep its wrapper flexible and its square `pryt.png` child absolutely centered at `min(79.488vw, 311.04px)`, with the `720px`-height override at `min(70.848vw, 276.48px)`; putting the padded image in normal flow would reserve its full 500×500 canvas height and move the conversion form below the first fold.
- Feature demo cards use paired 1200×720 mobile and 1800×1080 desktop H.264 MP4s plus a lossless 1200×720 PNG poster in a chrome-free `.shot` frame with a `5 / 3` aspect ratio. Keep every MP4 at 30 fps, `yuv420p`, one-second keyframes, and `moov` before `mdat`; repacking the desktop files with `-c copy -movflags +faststart` must not re-encode them. The mobile renditions currently use Lanczos scaling, x264 High Level 4.0, slow preset, and CRF 21, which measured about 0.995 SSIM against the 1200×720-scaled desktop exports.
- Feature demo prewarming, playback, poster handoff, and pointer tilt all live in the bottom inline script. Keep `.demo-video` elements without `autoplay`; otherwise they can start before the user scrolls to the feature cards. Keep the fallback poster above the video until the `playing` event, keep the prewarm and playback observers separate, and keep the tilt on `.shot`, not `.demo-video`, so the border, shadow, poster, and video plane move together. The tilt handler intentionally uses a stable layout rect instead of `getBoundingClientRect()` for live hover math because transformed hit boxes can cause corner-entry jitter.
- The final CTA uses the shared dark glass panel only and lives above the pricing MacBook mockup. Do not restore the old `.final::after` red radial glow unless the design intentionally calls for a decorative flare.
- Plain `npm run dev`/Vite does not run Vercel Functions. Use `npx vercel@latest dev` when testing `/api/download` or `/api/download-lead`.
- Vercel compiles TypeScript API routes to Node ESM. Keep relative imports between API route files extension-explicit, such as `../_lib/account.js`; extensionless helper imports can pass local typecheck but fail in production with `ERR_MODULE_NOT_FOUND`.
- Vercel's function builder reads the root `tsconfig.json` directly instead of following only the local project-reference settings. Keep its API-compatible ES target and strictness in the root config as well as `tsconfig.node.json`; otherwise local `tsc -b` can pass while the deployment compiler falls back to older, non-strict defaults and rejects modern API code.
- Local account/billing testing requires Vercel dev plus local/test Postgres and Stripe configuration. `SIDESTREAM_LICENSE_HASH_SECRET` must be stable and server-only; when absent, device hashing falls back to the first configured runtime URL after selection and URL normalization. The repository has no byte-safe Production continuity launcher or canary procedure, so any URL/pool change remains blocked until a separately reviewed mechanism preserves those exact bytes and proves the same real device/token across promotion. `SIDESTREAM_PRO_PRODUCT_ID` defaults to `prod_UpwXh6oO1OmPyQ`; global runtime Price discovery treats `SIDESTREAM_PRO_PRICE_ID`, the empty code default, and compatible Unlimited ID as validated hints, then checks Product `default_price`, exact `sidestream_pro_once_1999` lookup key, and any other active matching Product Price against the catalog's exact USD `1999` amount. Stale/missing global hints fall through to discovery or idempotent creation instead of causing a customer-facing 500. Regional truth is explicit: `SIDESTREAM_PRO_INDIA_PRICE_ID` must be active one-time INR `49900`, and `SIDESTREAM_PRO_BRAZIL_PRICE_ID` must be active one-time BRL `2500`, both attached to the same Product. Invalid configured regional truth fails closed; absence safely uses the global fallback. Runtime compatibility is not Production approval. Use placeholders for local Stripe testing and rotate any secret pasted into chat.
- Production currently lacks `sidestream_licenses.entitlement_status`. Customer-facing reads must use `LICENSE_ENTITLEMENT_STATUS_SQL`; a direct `l.entitlement_status` reference fails at PostgreSQL parse time before fallback logic can run. Do not repair that incident with runtime DDL, a manual column addition, or an unreviewed lifecycle migration. The compatibility expression prefers canonical stored state when present and otherwise recognizes only the exact one-time paid rows the pending migration would backfill.
- License environment resolution fails closed unless deployment state, trusted host, and selected database agree. Production uses `SIDESTREAM_POSTGRES_URL`; preview/development/test require exact `SIDESTREAM_TEST_API_HOSTS` plus a distinct `SIDESTREAM_TEST_POSTGRES_URL`. Client `buildChannel` is diagnostic only and cannot select a namespace.
- The guarded Postgres migration runner has a checksummed ledger and advisory lock. Database-backed `npm run db:migrate -- --status --target test|production` is authoritative for complete applied/pending filenames and rejects ledger/local checksum drift. It enforces exact selectors, authenticated remote TLS, connected database/port/namespace attestation, and operation-bound fingerprints; Production baseline/apply require exact confirmations. `--validate` and `--dry-run` are local-only and cannot prove a Production target or state. The separate legacy audit/apply, device, campaign-report, lead-dump, and standalone baseline-verifier paths retain their documented restrictions and must not be treated as substitutes for the guarded runner.
- Current env-file ingestion is not a Production-safe launcher: the migration runner loads `SIDESTREAM_ENV_FILE` before `SIDESTREAM_DB_ENV_FILE`, Node env files can apply startup options before inline validation, and inherited selectors survive. A future pinned and integrity-attested launcher must validate raw bytes and exact keys before Node, reject NUL/unknown/duplicate/empty/malformed entries, start from an empty environment, and keep secrets out of argv. No current command surface closes this blocker.
- Migration `20260714200000_remove_redundant_download_lead_key_unique.sql` is not compatible with the pre-hardening `c34ef25` lead writer: that code uses `ON CONFLICT (lead_key)` after the required unique constraint has been removed, so an otherwise-valid capture that reaches Postgres fails and can enter Blob fallback without consuming the database limiter. No runtime-distinct, full-chain-qualified fallback artifact is recorded yet: `git diff --name-only c93bc09..HEAD` contains only these documentation files, so `c93bc09` is the same hardened runtime, not an application rollback. Production mutation is blocked until a different runtime artifact is built, preserved, and proved against the complete migration chain; never treat an arbitrary prior deployment or a docs-only commit difference as rollback-safe.
- Vercel Preview/Test remains the only Stripe test-mode lifecycle proof. No staged Production artifact, actual-runtime-selector attestation, signed qualification, or promotion proof exists. A future reviewed plan needs pinned provider tooling or an owner-authenticated API that proves exact immutable release/fallback identities, project/team, target, commit/build, aliases, protection, metadata, and actual selector overrides including explicit empty values.
- The current repository has no Production maintenance rule or operator bypass. A future reviewed plan needs a complete effective firewall/hostname/order export and a tested exact rule matrix; custom-rule bypasses skip later custom and managed WAF rules, and tagged download GETs can schedule referral writes. Until those controls exist, no Production firewall mutation or operator route invocation is authorized.
- Any future maintenance or fallback plan must keep the live Stripe event destination enabled, complete an exact pre-drain, and preserve its earliest boundary/timers. Every future main and fallback path must freeze a provisional historical scan after pre-drain but before boundary/deny activation, then consume its exact manifest/checksum/watermark in a post-deny full/delta reconciliation after old writes drain and before migration, promotion, fallback, or reopening. Queue terminality is not canonical-state proof. Live automatic retries last at most three days, Dashboard/Workbench resend at most 15 days, and Stripe CLI resend at most 30 days; events created while a destination is disabled do not auto-resend.
- Vercel cron scheduling is a project-wide disable/enable control for the four routes in `vercel.json`; the repo has no one-job toggle, per-job kill switch, approved operator bypass, or secret-safe launcher. That gap blocks Production operation until a separately reviewed control and invocation design exists.
- Switching a deployment from sandbox/test Stripe keys to live Stripe keys can leave existing account rows with customer IDs from the old mode. `findOrCreateStripeCustomer()` validates a saved customer against the currently configured Stripe mode before Checkout reuse and creates a fresh customer if Stripe returns `resource_missing`.
- Checkout Sessions currently pin `payment_method_types: ["card"]` so live Checkout works even before Stripe Dynamic Payment Methods are configured in the dashboard. Revisit this once the live Stripe account has the desired payment methods enabled.
- If a successful purchase still shows Free in the account page or plugin, check `/api/stripe/webhook`, `/api/checkout/complete`, activation logs, and Stripe queue evidence; use guarded connected migration status only under the documented target approval. Runtime routes intentionally do not execute DDL, account/session reads do not drain the queue, and status cannot repair a missing migration, unattached Session, refund, dispute, or poisoned event.
- A complete zero-total Stripe order can have `payment_intent=null` while `payment_status` is either `paid` or `no_payment_required`. Preserve the exact-zero amount, valid-currency, completed Session, Price, Product, activation, and attachment checks together; never generalize this exception to a nonzero or incomplete Checkout.
- Regional Checkout code requires `20260729120000_add_regional_checkout_offer_snapshots.sql` before it can create or fulfill one-time Checkout intents. Do not deploy the code ahead of that migration: the runtime inserts and selects the new snapshot columns and intentionally fails rather than falling back to today's catalog. The repository's current Production migration tooling remains blocked as documented above, so applying this migration needs a separately authorized, authenticated database procedure before `main` is pushed to the Git-linked Production deployment.
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
- `CRON_SECRET` is the one 16-512 character scheduler secret for all four internal routes, but the common denominator is stricter: every character must be printable non-space ASCII (`U+0021`-`U+007E`) because lead replay rejects spaces and non-ASCII even though the other routes compare the whole header. Generate a 64-character hexadecimal token from 32 random bytes in the approved secret manager. Missing configuration must produce `503`, wrong/missing bearer auth must produce `401`, and the value must never appear in commands captured by logs or in committed files.
- Checkout and lead rate limits are atomic Postgres controls, not a substitute for edge protection. The Blob fallback cannot consume the database lead limiter. Vercel Pro WAF uses per-region fixed windows. Only one shared rule/counter domain spanning all reachable hosts keeps the trailing-boundary estimate at approximately `2 * L * R`, plus regional reconciliation risk. If host-specific or duplicated rules create `H` independent counter domains, the estimate is approximately `2 * L * R * H`; cross-host boundary tests must measure that larger exposure. Require an explicit rejecting action plus security approval, or a durable shared fallback limiter; if the counter domain or bound cannot be proved, cutover is blocked.
- Stripe lifecycle cutover is blocked until `refund.failed` has a tested recovery transition (or an explicitly approved permanent-revocation policy plus tested manual customer recovery) and every current Dispute status, including terminal `warning_closed` and `prevented`, has a tested mapping or approved conservative policy. Current code has neither approval path and must not be described as complete canonical Stripe truth.
- No executable live one-time Unlimited catalog proof exists. A future owner-authenticated provider/runtime proof must bind every enabled catalog entry's exact configured/default Product and Price to the immutable deployed artifact, mirror runtime precedence, create nothing, and retain exact-ID, live/active, linkage, one-time currency/amount, country-selection, and checksum evidence. The recurring legacy proof is not a substitute.
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

- 2026-08-01: Registered the focused Customer 360 operator-safety suite and consolidated the guarded migration, identity-backfill, usage-sync, and historical-rescan contracts. Documented exact named selectors, connected operation-bound fingerprints, Production confirmations, mode-`0600` checkpoints, replay/idempotency, no-delete boundaries, protected APIs, and Preview/Test-first verification. This code-only run performed no provider call, migration, backfill, sync, rescan, deployment, scheduler change, or release.
- 2026-08-01: Published the standard Windows `1.0.16` installer to its immutable private Blob pathname and advanced the `win32-x64` manifest to `Sidestream-1.0.16-Windows-Installer.exe` at 100% rollout; the Mac manifest and bare download route remain unchanged.
- 2026-07-31: Reduced the ordinary Checkout thank-you page to the payment confirmation, return-to-Premiere instruction, and one no-second-charge recovery path. Device limits, receipt storage, and billing-history explanations remain available in the account experience instead of competing with the immediate next action.
- 2026-07-31: Consolidated the anonymous acquisition contract around four separate identities and the exact signed-cookie -> static download/mobile handoff -> one-time install claim -> sparse profile -> optional later account flow. Documented bounded source/experiment rules, paid-over-anonymous-over-email attribution, protected funnel denominators/coverage, privacy and nonblocking failure behavior, TLS-safe sync/rescan commands with no-delete checkpoints, required Vercel variable names, and the remaining human migration/configuration/rescan/scheduler/deploy/release/rollback/smoke gates. This documentation change performed no external operation.
- 2026-07-31: Increased the global Sidestream Unlimited one-time offer from `$14.99` to `$19.99` through the canonical pricing contract and a new immutable Stripe Price. India remains `₹499`, Brazil remains `R$25`, both ordinary Free-account Upgrade and paid acquisition continue through the same server-owned catalog, and already-open Checkout intent snapshots keep their original prices.

- 2026-07-31: Changed new global Sidestream Unlimited intents to `$14.99`, India intents to `₹499`, and added trusted-country Brazil pricing at `R$25`. The canonical contract now owns all three offers; India and Brazil require new immutable regional Stripe Prices through `SIDESTREAM_PRO_INDIA_PRICE_ID` and `SIDESTREAM_PRO_BRAZIL_PRICE_ID`, while already-open Checkout intents preserve their stored prior snapshots.
- 2026-07-31: Centralized Free, global USD, and India INR pricing in `config/pricing-contract.mjs`. Ordinary Upgrade, paid acquisition, Stripe lookup resolution, website/JSON-LD/crawler fallbacks, and the generated paid page now consume or synchronize from that contract. `npm run pricing:sync` regenerates derived public surfaces, while `npm run pricing:check` blocks drift and includes a hypothetical `$14.99` mutation proof without changing the live `$24.99`/`₹799` offers.
- 2026-07-30: Separated the protected acquisition report's first-install cohort window from a required later completed UTC-day `observationEnd`. Added auditable aggregate and per-group first-open, activation, return, and one-and-done metrics; excluded immature profiles from return/one-and-done denominators; capped the full observation span at 730 days; bounded activation and usage facts to observation; and rejected paid/email first touches captured after install so later visits cannot rewrite acquisition.
- 2026-07-30: Added the protected first-install acquisition/retention report contract with exact `session_started` open days, accepted day-zero download attempts, completed-activation/first-open ratios, paid-over-verified-email attribution precedence, explicit paid/freemium experiment dimensions, complete unknown coverage, and bounded privacy-safe journeys. Documented that source-segmented retention covers only exact server-side links, installer packages carry no browser acquisition token, overall stickiness retains all install IDs, and historical broad activity buckets require a separately approved one-time full append/update rescan without raw telemetry deletion. No Production migration, backfill, configuration, rescan, deployment, or route invocation was authorized.
- 2026-07-30: Added `https://sidestream.tv/manychat-instagram` as the canonical organic Instagram ManyChat referral link with its own `manychat-instagram` private-Blob reporting bucket, while preserving `/m` and `/mc` behavior for legacy generic and paid-experiment traffic.
- 2026-07-30: Advanced only the receipt-gated paid Mac manifest to the notarized `Sidestream Unlimited` artifact from FlowState `61e768b`. The refreshed installer keeps the public filename `Sidestream-Unlimited.dmg`, uses a new immutable private Blob pathname, exposes `Install Sidestream Unlimited.pkg`, and removes the redundant paid panel-intro branding/status copy without changing the standard Mac release or paid Windows manifest.
- 2026-07-30: Bound normalized paid-landing attribution to an internal signed rewrite header so valid UTM-tagged `/mc` and `/mc-preview` visits no longer fail when Vercel forwards the original query alongside the private landing rewrite.
- 2026-07-30: Removed the redundant green “Payment complete” badge from the paid-acquisition thank-you header, leaving the Sidestream wordmark as the only header element.
- 2026-07-30: Removed the redundant red “Do not download Sidestream to this phone” warning card from the paid-acquisition thank-you page while preserving its computer inbox and installation steps.
- 2026-07-30: Reduced the paid-acquisition email to the Sidestream Unlimited name, one sentence describing the Premiere Pro extension, and Mac/Windows download buttons. Removed setup, recovery, entitlement, refund, and dispute copy from that email; aligned the phone handoff subject and renamed only the customer-visible paid artifact filenames to `Sidestream-Unlimited.dmg` and `Sidestream-Unlimited.exe`, leaving the installer bytes and installed app unchanged.
- 2026-07-30: Added a separate phone-first paid-acquisition thank-you page with explicit computer inbox, receipt-gated installer, Premiere, and same-Google-email steps. Only Checkout Sessions carrying the server-owned paid-acquisition marker reach it after exact fulfillment; the original `thank-you.html` and ordinary Upgrade/Restore flow remain unchanged.
- 2026-07-30: Changed the approved India offer from `₹999` (`99900` minor units) to `₹799` (`79900` minor units) using a new immutable one-time INR Stripe Price on the existing Sidestream Unlimited Product. Existing Checkout intents keep their stored offer snapshots, while newly created India intents use the updated catalog and Production Price ID.
- 2026-07-29: Published the notarized Sidestream `1.0.16` paid-onboarding Mac installer at its private versioned Blob pathname, advanced the paid manifest from the stale standard `1.0.14` artifact, and made only the dedicated paid activation claim request Google's account chooser. Ordinary Google authentication, Free-account Checkout, standard installers, and app behavior remain unchanged.
- 2026-07-29: Unified landing-page and Checkout regional pricing behind the same trusted Vercel-country catalog. The catalog now owns exact USD `2499` and India INR `99900` amounts, Checkout validates Stripe against those approved amounts, and the private/no-store `/api/checkout/offer` endpoint updates only the visible card to `₹999` for India while forged browser country/price inputs remain inert.
- 2026-07-29: Documented the sanitized, read-only Customer 360 readiness command. Canonical route code is present, but the Production admin and usage-sync routes remain inactive and unconfigured; database rows alone do not establish backfill completeness or operational readiness.
- 2026-07-29: Published the canonical Mac release pointer for Sidestream `1.0.16` at `sidestream/1.0.16/Sidestream-1.0.16-Mac-Installer.dmg`; `/api/download` and `/api/releases/latest` continue to share this one manifest so installer fulfillment and in-panel update notifications cannot drift.
- 2026-07-29: Added the server-owned global USD and India INR Checkout offer catalog, trusted Vercel-country selection, immutable offer snapshots on locked Checkout intents, snapshot-only fulfillment approval, and focused regional/forgery/reuse/price-change/zero-total tests without changing website presentation or creating an India Stripe Price. The append-only snapshot migration must be applied through a separately authorized authenticated procedure before this runtime can deploy.
- 2026-07-29: Renamed the customer-facing one-time paid tier from Sidestream Pro to Sidestream Unlimited across the website, account and activation surfaces, emails, crawler copy, paid landing, tests, and Stripe Product display name while preserving existing Product/Price IDs, `sidestream_pro` plan metadata, lookup keys, environment variables, and historical purchases.
- 2026-07-29: Fixed the identity-scoped Production/Test upgrade reset after paid acquisition added restrictive foreign keys. It now inventories and removes matching paid email jobs, claims, and paid Checkout records in child-first order before core Checkout/account deletion, with final zero-state verification and a regression for the exact dependency chain.
- 2026-07-28: Expanded Sidestream Pro from one to two active production devices and removed the rolling device-move limit. Added concurrency-safe active slots, preserved the unaffected device and its credentials during replacement, exposed both coarse devices in Account status, synchronized public copy, and retained confirmed replacement only when both slots are occupied.
- 2026-07-28: Published the canonical Mac release pointer for Sidestream `1.0.15` at `sidestream/1.0.15/Sidestream-1.0.15-Mac-Installer.dmg`; `/api/download` and `/api/releases/latest` continue to share this one manifest so installer fulfillment and in-panel update notifications cannot drift.
- 2026-07-28: Made Checkout Session replacement provider-idempotent after the `$24.99` rollover exposed an already-expired Stripe Session: replacement now retrieves Stripe truth first, expires only `open` Sessions, treats `expired` Sessions as already terminal, and routes `complete` Sessions to fulfillment instead of creating a second charge opportunity.
- 2026-07-28: Fixed activation Checkout replacement after the `$24.99` Price rollover: when a new Stripe Session replaces an older Session, `attachCheckoutSessionToActivation()` now clears the prior Session's reconciliation-attempt timestamp in the same update. This preserves `sidestream_activation_reconciliation_requires_checkout`, prevents a timestamp-order `23514` from surfacing as an Upgrade `500`, and leaves exact Session/Product/Price attachment checks unchanged.
- 2026-07-28: Removed the Mac `Free Download` button and its leftover paragraph-to-CTA gap from the closing "Stop using sketchy websites to download music" panel while preserving its headline, supporting copy, and the download controls in the hero and Free pricing card.
- 2026-07-28: Made one-time price changes resilient after the `$24.99` rollout exposed a stale Production `SIDESTREAM_PRO_PRICE_ID`: configured Price IDs are now validated hints that fall through when stale or deleted, while live provider failures still fail closed; exact Product/currency/one-time/amount checks remain mandatory. Added regression coverage and an append-only migration that makes paid-acquisition storage amount-agnostic after server-side Stripe verification, removing the need for a database constraint migration on future price changes.
- 2026-07-28: Declared `origin/main` the only canonical branch, instructed agents to ignore all historical feature/Orchestra/worktree branches unless Alex explicitly names one, made synchronized local `main` the default work/push target, and documented the repository boundary: website frontend, Vercel server/API, and website migrations stay together here while the Premiere extension remains in FlowState.
- 2026-07-27: Replaced the paid-email download route's dormant fixture manifests with the current Production Mac 1.0.14 and Windows 1.0.13 installer metadata and private Blob pathnames, restoring receipt-gated downloads without exposing those pathnames through the public paid manifest response.
- 2026-07-27: Enabled `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=1` in Vercel Production. Confirmed paid-acquisition fulfillment now claims its unique outbox row and submits the paid installer email to Resend with a Checkout-session-derived provider idempotency key; Test/Preview remain disabled and no historical outbox row was manually replayed.
- 2026-07-27: Removed the decorative gradients from the Checkout thank-you page so its page background is solid black; content and panel styling are unchanged.
- 2026-07-27: Added Stripe Checkout submit-area guidance that the Sidestream download link will be emailed to the address entered above, while retaining the one-time-payment and no-subscription reassurance.
- 2026-07-27: Made paid-acquisition fulfillment promotion-aware: different Stripe-managed discount amounts now reconcile from the immutable $14.99 subtotal through Stripe's aggregate discount to the exact captured total, treating Stripe's nullable shipping amount as zero when absent. Exact 100% promotions use Stripe's verified zero-total/no-PaymentIntent shape and the Checkout Session as the settlement reference; other unpaid, tax/shipping, currency, subtotal, and payment mismatches continue to fail closed.
- 2026-07-27: Enabled Stripe's promotion-code field for the pay-first paid-acquisition Checkout Session; ordinary Checkout already exposed the same field, and the complete request fingerprint continues to rotate idempotency when Checkout parameters change.
- 2026-07-27: Closed the stale-branch deployment bypass by making agent publishing Git-linked and `main`-only, reserving the guarded Vercel CLI release for deliberate owner reauthentication, and removing shared local Vercel CLI authentication after restoring canonical Production.
- 2026-07-27: Removed the Pricing link from the top-right desktop header while retaining the in-page pricing section, Features and Account glass pills, and the current direct Checkout flow.
- 2026-07-27: Updated the transitive PostCSS dependency to `8.5.23` (and its Nano ID dependency to `3.3.16`) to remove the high-severity `GHSA-r28c-9q8g-f849` advisory without forcing a Vite major upgrade. `npm audit` still reports the separate low-severity esbuild development-server advisory, which requires a controlled Vite upgrade.
- 2026-07-27: Compiled the deterministic paid landing as its own Vite entry and bundled the resulting HTML into the server landing function, restoring the canonical shader and hashed media assets on `/mc` and `/mc-preview` while retaining server-side Checkout-token injection.
- 2026-07-27: Added the unlinked, noindex `/mc-preview` maintainer route so the complete pay-first landing and its real Checkout CTA can be reviewed deterministically in a desktop browser without weakening the mobile-only 50/50 rules on `/mc`.
- 2026-07-27: Consolidated paid-onboarding release documentation and local regression evidence. Added the future manual Production smoke boundary for the exact paid claim, support-only inactive branch, unchanged ordinary Free-account direct Checkout, and existing active-account reconnect/transfer behavior while keeping `/mc` unlinked and default-off. This gate performed no deployment, Google login, environment change, migration, email, payment, artifact publication, or `/mc` visit.
- 2026-07-27: Added the exact-source `/api/activation/paid-claim` onboarding surface. It preserves Google OAuth, same-origin CSRF, activation replay/expiry, device-bound reconnect, and confirmed transfer behavior while replacing inactive-account Checkout with a polished noindex support-only page. Ordinary `/api/activation/claim` behavior is unchanged; no migration, provider write, `/mc` switch, or deployment occurred.
- 2026-07-27: Reconciled the audited default-off paid `/mc` acquisition foundation onto current Production `main` while retaining the signed-in Free-account direct Stripe path, full Checkout request fingerprint, then-current `$14.99` Product/Price, `/m` family redirects, root/free/account/ordinary activation behavior, zero-total fulfillment support, and guarded Production deployment. Paid email remains disabled by default; no environment, database-apply, external provider, or deployment action occurred.
- 2026-07-28: Increased the worldwide USD Sidestream Pro one-time price from `$14.99` to `$24.99` across the immutable Stripe Price resolver, visible landing and paid-acquisition offers, structured data, crawler copy, sandbox promotion tooling, verification fixtures, operator documentation, and an append-only paid-checkout constraint migration. Existing completed one-time entitlements remain unchanged; new Checkout Sessions resolve `sidestream_pro_once_2499`.
- 2026-07-27: Increased the worldwide USD Sidestream Pro one-time price from `$9.99` to `$14.99` across the immutable Stripe Price resolver, visible landing-page offer, structured data, crawler copy, sandbox promotion tooling, verification fixtures, and operator documentation. Existing completed one-time entitlements remain unchanged; new Checkout Sessions resolve `sidestream_pro_once_1499`.
- 2026-07-27: Checkout reuse now compares every open account or activation Session's persisted Product and Price with the currently selected catalog before redirecting. A stale pre-change Session is expired and replaced under the existing locked intent instead of preserving its former amount; completed purchases remain resumable.
- 2026-07-27: Restored `/m` and `/m/` as temporary ManyChat aliases beside `/mc` and `/mc/`, all redirecting to the canonical landing page with `utm_source=manychat`, and expanded the route contract test so future deployments cannot silently drop either short-link family.
- 2026-07-27: Locked Production deployment to clean remote `main` and the exact Sidestream Vercel project, added source and built-artifact checks for the Upgrade, Google authentication, and Stripe contract, retained both exact zero-total Stripe completion statuses, and documented `npm run deploy:production` as the supported release path.
- 2026-07-27: Added canonical `/version.json` Git identity, fail-closed live-Production ancestry enforcement, an exact one-time legacy-deployment bootstrap boundary, built-artifact SHA verification, and post-deploy canonical SHA plus direct-Checkout verification so a small change cannot redeploy an older full-site lineage.
- 2026-07-27: Made the guarded release explicitly promote only the Ready default Vercel Production deployment whose `/version.json` matches `HEAD` to the custom `sidestream.tv` alias before final live verification; a successful default-alias deploy can no longer be mistaken for a canonical-domain release.
- 2026-07-27: Added a bounded post-promotion retry for Vercel custom-domain propagation; canonical SHA or direct-Checkout mismatches still fail after six attempts instead of producing a false failure during the first stale edge read.
- 2026-07-27: Fixed Production version generation to consume Vercel's commit metadata before attempting local Git discovery, so Git-linked builds still emit `/version.json` after `.vercelignore` removes `.git`.
- 2026-07-26: Accepted Stripe's current completed no-cost order shape (`payment_status=paid`, zero total, and no PaymentIntent) under the existing exact Session/Price/Product/activation safeguards, while retaining the older `no_payment_required` shape and rejecting every nonzero or incomplete Checkout.
- 2026-07-27: Bound Checkout Session idempotency to the complete canonical Stripe request so valid historical Upgrade paths cannot collide with stale request parameters after catalog or checkout-flow changes.
- 2026-07-26: Removed the default "One email. No account required." mobile handoff note while preserving the hidden live region for validation and delivery feedback.
- 2026-07-26: Replaced the Free pricing card’s Mac-only “Free Download” CTA with matching Mac and Windows download buttons on desktop, and hid that card’s download controls on mobile where the hero email handoff already provides both installers.
- 2026-07-26: Simplified the mobile computer-handoff helper to "Enter your email and receive a download link" without changing the form behavior or desktop installer choices.
- 2026-07-26: Added a tiny paint-only lower buffer to the animated hero nouns so the `g` descender in “songs” renders fully without changing the headline layout or animation.
- 2026-07-26: Made Upgrade a single server-owned sequence: Upgrade button, Google authentication, Stripe payment. `/api/checkout/start` now creates the locked Checkout intent and redirects the authenticated Free account to Stripe; activation claims route Free accounts into the same endpoint.
- 2026-07-26: Restored the exact transparent mobile hero Premiere Pro/YouTube artwork, including its previously deployed centered position and `311.04px`/`276.48px` responsive caps, without changing the responsive feature-video implementation.
- 2026-07-26: Added fast-start 1200×720 mobile and preserved 1800×1080 desktop Search/Preview demo tiers, lossless first-frame poster fallbacks, near-viewport prewarming, visibility-gated playback, lazy pricing-MacBook media, and immutable caching for Vite's hashed assets so embedded mobile browsers do not show black or prioritize far-below media.
- 2026-07-26: Restored the screenshot-matched computer-handoff buttons as white Mac and Windows platform capsules inside a dark panel, including the red hover state and CID Windows mark, while retaining the `STREAM20` offer and all surrounding email content.
- 2026-07-26: Added the short `https://sidestream.tv/mc` ManyChat link and first-party landing-referral attribution through a privacy-limited API, daily private-Blob dedupe, likely-scanner separation, and a read-only aggregate report.
- 2026-07-19: Reintegrated the guarded account backend onto `main` after a frontend-only Production deployment regressed v1.0.14 Upgrade requests. Activation creation once again treats the unapplied Customer 360 schema as optional, customer-facing license reads retain pre-entitlement-lifecycle compatibility, the root TypeScript config now matches the API compiler contract used by Vercel, and the Production `SIDESTREAM_BASE_URL` is restored to `https://sidestream.tv` so current clients receive same-origin checkout and restore handoffs. No Production migration or entitlement mutation was performed.
- 2026-07-17: Restored the live landing-page recording anchor from `50vw 50vh` to `45vw 25vh`, matching the previously approved higher and farther-left desktop placement while preserving the `900px` mobile hide behavior.
- 2026-07-17: Swapped the generated v2 social card for the exact supplied Sidestream landing-page screenshot as `sidestream-social-card-v3.png`, with `?card=v3` documented as the fresh X scrape URL.
- 2026-07-17: Replaced the nearly blank Open Graph/Twitter screenshot with a cache-busted 1200×630 Sidestream product card and updated every social and JSON-LD image reference.
- 2026-07-17: Restored Production activation polling, license verification, refresh, and download authorization against the pre-entitlement-lifecycle database. Every customer-facing license read now shares the fail-closed JSON-based lifecycle compatibility expression instead of directly referencing the absent column; targeted source regressions prevent any route from drifting back to the parse-time `42703` failure. No Production schema or entitlement row was mutated.
- 2026-07-17: Added the mobile computer handoff: phone-width visitors see one inline email form instead of choosing Mac or Windows, lower mobile download CTAs return to that form, and the new fail-closed `/api/send-download-links` route stores bounded campaign context in the existing private replay queue before sending one idempotent Resend email with both installers from the existing `alexg.mov` domain. Its hashed email/IP limits use private Blob compare-and-swap writes so the MVP does not require the currently unapplied Postgres hardening tables. Desktop downloads remain direct.
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
- 2026-07-15: Corrected the Customer 360 contract after semantic audit: distinguished trusted write namespace from authorized admin read selection, documented one-time/subscription/comped/mixed history without implying current subscription state, preserved observe-by-default single-device status, separated local FlowState work from live Preview/Test QA, exhaustively inventoried stored/derivable telemetry versus the compact API, defined null/zero success-rate behavior, corrected the cron response/log split, and accounted for Vercel's four-job project-wide scheduling control. Production remained operationally inactive, unmigrated, and unbackfilled.
- 2026-07-15: Published the durable cross-repo Customer 360 field/privacy/identity/commerce/usage contract and human-gated Preview/Test-first rollout guide. Documented the protected API, `SIDESTREAM_CRM_ADMIN_SECRET`, separate `SIDESTREAM_TELEMETRY_POSTGRES_URL`, disposable `SIDESTREAM_TEST_POSTGRES_URL` harness, `installIdHash` versus single-device separation, money minor units, first-attempt/success and rolling-window semantics, retention gap, observability, dry-run backfill, and non-Production rollback. Production remained operationally inactive, unmigrated, and unbackfilled.
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
- Added a Supabase RLS hardening migration for server-owned Sidestream public tables, revoking direct `anon` and `authenticated` Data API table access while preserving the server-only Postgres route contract.
- 2026-07-28: Updated the Free pricing card, crawler summary, and paid-landing regression check to reflect the current limit of 3 free downloads every day.
- Retired the first-week-unlimited free-trial offer, which was never implemented in the entitlement backend: the Free pricing card and `llms.txt` use the plugin's actual free-tier daily cap. Only backend-issued Sidestream Pro license tokens bypass the cap.
- Replaced the inline hero Windows email box with a matching Windows platform pill that opens a centered waitlist modal.
- Added a hero Windows waitlist capture that posts emails to `/api/download-lead` with `source: "windows-waitlist"` while leaving Mac download CTAs unblocked.
- Promoted the public installer pointer to the private Blob `1.0.11` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.11-Mac-Installer.dmg`.
- Removed the account/subscription bullet from the Pro pricing card.
- Changed the Free pricing card copy from "Unlimited free downloads" to "Unlimited downloads for your first week."
- Added invoice creation for future one-time Stripe Checkout payments, a direct `/api/billing/receipt` route for existing one-time charge receipts, and account-page receipt/refund request controls so Customer Portal is not treated as the only purchase-history surface.
- Historical: Sidestream Pro was temporarily corrected from `$9.99` to `$4.99` for Price `price_1TqGeBDFKjeGlioXlV8fBGK8`; the 2026-07-13 `$9.99` change above supersedes this state.
- Historical: Checkout temporarily pinned `price_1TqGeBDFKjeGlioXlV8fBGK8`; the active `$9.99` lookup-key resolver now supersedes that default.
- Fixed Checkout customer reuse after sandbox-to-live Stripe key switches by validating saved Stripe customer IDs before passing them to Checkout.
- Renamed the paid one-time Checkout tier from Sidestream Unlimited to Sidestream Pro, switched new Checkout metadata to `sidestream_pro`, and resolved the `$9.99` Stripe Price from Product `prod_UpwXh6oO1OmPyQ` with legacy Unlimited webhook compatibility.
- Pinned one-time Stripe Checkout Sessions to card payments while the live Stripe account payment-method dashboard setup is incomplete.
- Removed the account page lede sentence so `account.html` goes straight from the account headline into the sign-in or account-management panel.
- Added a sandbox-guarded Stripe maintainer utility for creating/verifying the `FREEDEV` 100% off promotion code used to test no-cost Sidestream Pro Checkout.
- Promoted the public installer pointer to the private Blob `1.0.10` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.10-Mac-Installer.dmg`.
- Changed the paid plan from a monthly subscription path to a `$9.99` one-time Stripe Checkout payment with webhook fulfillment for one-time Checkout Session IDs.
- Moved the canonical landing page to the clean root URL, `https://sidestream.tv/`, and changed the old exported `Sidestream%20front%20end%202/Sidestream.html` path into a noindex compatibility redirect.
- Changed the $0 pricing card from Beta to Free and removed beta-tester wording from the free-plan copy, structured data, and `llms.txt`.
- Fixed Vercel API route helper imports to use explicit `.js` extensions so auth, activation, checkout, billing, and webhook functions resolve `api/_lib/account.ts` after production compilation.
- Added the MVP SaaS account flow: unblocked download CTAs, noindex `account.html`, Google OAuth, Stripe Checkout, Customer Portal redirects, webhook-owned entitlement tables, plugin activation endpoints, short-lived license tokens, and a generic Postgres migration runner.
- Added support for Sidestream Supabase/Vercel connector database env names across account/billing APIs, download-lead capture, and Postgres maintainer scripts, with `SIDESTREAM_POSTGRES_URL` preferred over older generic `POSTGRES_URL` fallbacks.
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

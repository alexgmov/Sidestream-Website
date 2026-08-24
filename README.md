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
- `docs/api-hardening-runbook.md` - Exact hardened API/release contract, canonical acquisition/Checkout operator stops, shared Postgres and migration model, Stripe/lead/maintenance facts, bounded configuration, metrics, alerts, guarded Customer 360 operator commands, and the remaining full-service Production blockers. It does not claim Production was changed.
- `docs/customer-360.md` - Durable cross-repo Customer 360 and acquisition-integrity contract: immutable acquisition UUID roots, ten-stage ledger, exact Checkout/Stripe linkage, first-install/first-purchase reporting, exact Stripe-reference lookup, four separate customer identities, one-time claim continuity, guarded operators, privacy/no-delete rules, environment-variable names, and the Preview/Test-first rollout sequence.
- `thank-you.html` - Minimal noindex Checkout success page on a solid black background. Stripe success URLs land here after purchase with a direct return-to-Premiere instruction and one concise recovery path if the panel still shows Free.
- `paid-thank-you.html` - Phone-first noindex success page used only by verified paid-acquisition Checkout. Its primary “Send download to your computer” action opens the native share sheet, or copies a secure fallback link, for the receipt-gated Sidestream Unlimited installer; the numbered fallback steps still cover the separate setup email, installation, and same-Google-email authentication. The original `thank-you.html` remains the ordinary Upgrade/Restore destination.
- `data/release-manifest.json` and `data/release-manifest.windows.json` - Sidestream-owned stable release manifests. The default file keeps the public Mac artifact; the Windows file is selected by the explicit `win32-x64` platform query used by the public Windows download CTA. Private Blob pathnames are never returned by the public manifest API.
- `api/download.ts` and `api/_lib/installer-delivery.ts` - Provider-neutral installer fulfillment. `HEAD` returns manifest-bound attachment metadata; `GET` validates the selected artifact and redirects to a five-minute provider URL. `SIDESTREAM_INSTALLER_PROVIDER=hetzner` signs the immutable pathname for `downloads.sidestream.tv`; `blob` is the explicit rollback. Anonymous acquisition and Gmail attribution still happen only after a successful redirect and cannot block delivery. Bare requests remain Mac; `?platform=win32-x64` selects Windows.
- `api/_lib/installer-referral.ts` - Server-only Gmail installer-request attribution. It validates bounded UTM tags, accepts only `pilot` or `main` batch content, creates a campaign/day-scoped HMAC from request identity, discards the raw IP and user agent, flags likely link scanners, and inserts the privacy-limited event into Postgres without delaying installer delivery.
- `api/referral-visit.ts` and `api/_lib/referral-visits.ts` - First-party landing-referral attribution for the dedicated `https://sidestream.tv/manychat-instagram` organic Instagram ManyChat link and the legacy generic ManyChat routes. A real page load posts the allowlisted `manychat-instagram` or `manychat` source, receives `204` without waiting for storage, and writes at most one private Blob record per anonymous request fingerprint/day/classification. Daily HMACs reuse the installer-analytics secret; raw IP and user-agent values are never stored.
- `api/releases/latest.ts` and `api/_lib/release-manifest.ts` - Sidestream-owned update manifest endpoint for the CEP panel. It selects the Mac or Windows manifest by platform and serves public metadata without exposing the private Blob pathname.
- `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/_lib/download-lead-blob.ts` - Bounded JSON lead ingestion, canonical `(email, cta_source)` convergence, idempotency receipts, atomic Postgres email/IP rate limits, deterministic private-Blob fallback, and the private compare-and-swap Blob limiter used by the mobile email handoff. `api/internal/download-leads/replay.ts` replays mapped fallback records and deletes only after a committed database write plus ETag match.
- `api/send-download-links.ts`, `api/_lib/acquisition-handoff.ts`, and `api/_lib/download-link-email.ts` - Mobile computer continuity. The email path requires idempotency, stores the bounded `mobile-download-handoff` lead, enforces durable hashed 3/email and 10/IP per-hour limits, and sends separate signed Mac/Windows links. The no-email path accepts only `{"handoffOnly":true}` and returns one shareable secure link. Both links contain exactly one opaque encrypted/signed seven-day `handoff`; computer GET restores the acquisition cookie and redirects to the unchanged installer route. Forged, expired, duplicated, or identity-augmented handoffs return `404`. Provider errors and logs never return or print the recipient address.
- `api/_lib/acquisition-cookie.ts`, `api/_lib/acquisition-integrity.ts`, `api/_lib/anonymous-acquisition.ts`, `api/_lib/anonymous-install-claim.ts`, `api/installation/claim*.ts`, `db/migrations/20260731120000_add_anonymous_acquisition_sessions.sql`, and `db/migrations/20260803120000_add_acquisition_integrity.sql` - Private browser-to-install continuity plus the canonical acquisition UUID root. The signed v2 cookie carries the UUID and immutable bounded first touch; Postgres owns the immutable root, append-only trusted delivery evidence, conflicts, and ten-stage canonical-grain ledger. After local receipt verification, the panel posts only `installIdHash` plus `installerReceiptIdHash`, receives a 15-minute nonce and opaque acknowledgment handle, and connects the signed browser session to a sparse Customer 360 profile exactly once. Missing configuration fails association closed without blocking the page or installer.
- `api/_lib/renamed-launcher-attribution.mjs`, `scripts/run-renamed-launcher-proof-server.mjs`, and `tests/renamed-launcher-attribution.test.mjs` - Isolated Test/local renamed-launcher proof. A loopback-only, Production-disabled server issues one opaque filename claim for one synthetic Test acquisition, stores only its SHA-256, enforces one release/platform/redemption/binding lifecycle, and accepts body-only installer-receipt and install identities. It is not a Vercel route and owns no public fulfillment, email, Checkout, or Production behavior.
- `api/_lib/postgres.ts` and `api/_lib/rate-limit.ts` - Shared attached runtime Postgres pool/transaction ownership and atomic HMAC-dimension rate limiting. Production runtime requires a pooled URL; direct URLs are reserved for reviewed migrations/backfills and development/test fallback.
- `api/_lib/customer-profiles.ts` and `tests/customer-360/core*.test.mjs` - Server-only Customer 360 identity/profile primitives, transactional merge planning, privacy-contract proof, and disposable-Postgres coverage. Merge survivors follow the database's immutable `(created_at, id)` total order within one license namespace.
- `api/_lib/customer-commerce.ts`, `db/migrations/20260715122000_add_customer_commerce_ledger.sql`, and `tests/customer-360/commerce*.test.mjs` - Stripe-verified Customer 360 money projection. A settled PaymentIntent, or a captured standalone Charge without one, is canonical when present. Until then, paid Checkout and Invoice facts remain fallbacks; a paid InvoicePayment edge suppresses only the Checkout fallback for the same absent instrument, namespace, profile, and currency, preferring the related Invoice without collapsing their payment keys. Both fallbacks are atomically suppressed when the related instrument arrives. Gross includes all settled customer money, while `off_stripe_paid_minor` is an explicit subset in each profile/namespace/currency total. Current InvoicePayment objects persist as many-to-many allocation edges without unioning invoices and instruments into one payment key. Namespace-locked reconciliation attaches or quarantines a whole canonical payment group before currency totals refresh and never reads or mutates entitlement/device state.
- `api/_lib/customer-usage.ts`, `api/_lib/customer-query.ts`, `api/_lib/customer-summary.ts`, `api/_lib/customer-admin.ts`, `api/internal/customer-usage/sync.ts`, and `api/internal/customers/*` - Once-daily privacy-limited telemetry aggregation plus private Customer 360 list/detail and license-backed summary reads. Exact Stripe-reference lookup prioritizes the acquisition attached to the requested Checkout Session, or the Checkout Session alias sharing the requested payment key, before older profile-linked candidates; absent an exact Checkout acquisition, it retains deterministic `first_observed_at`/UUID fallback. Ownership ambiguity or conflict still fails closed. The compact APIs intentionally omit email addresses, total accepted attempts, current subscription status, and Stripe IDs. The summary separates active Unlimited accounts and unique paid users from Stripe's all-time successful-transaction total without inferring access from Customer 360 money. `SIDESTREAM_TELEMETRY_POSTGRES_URL` is a separate read-only source, while `SIDESTREAM_CRM_ADMIN_SECRET` protects POST-only non-browser reads and signs namespace/filter-bound cursors. Raw telemetry, identity values, `installIdHash`, search text, and merged tombstones stay excluded.
- `api/_lib/acquisition-funnel.ts` and `api/internal/customers/funnel.ts` - Protected, read-only acquisition and retention report with independent first-install/default and first-purchase cohort selectors, a separately selected completed UTC-day observation boundary, and signed keyset journey pagination. Within paid candidates for one live profile, one exact immutable paid-telemetry binding outranks historical receipt, Checkout Session, activation, and account edges; profiles without a binding retain the prior deterministic fallback, while multiple exact bindings fail to unknown rather than choosing a row. It reports canonical roots plus deterministic legacy exact links, all ten distinct stage grains, integrity alerts, complete attributed and unknown groups, auditable ratios, and capped privacy-safe source/journey output without exposing email, browser tokens, install/receipt/assignment hashes, Stripe IDs, or identity-link values.
- `scripts/sync-customer-usage.mjs` and `scripts/rescan-customer-usage.mjs` - Human-gated usage operators. Dry-run never connects; apply uses named selectors only, verified remote TLS, one connection, source/target fingerprints and collision rejection, source-freshness limits, append/update-only aggregate writes, and no deletes. Rescan persists a source/target/version-bound mode-`0600` checkpoint after committed batches and requires an additional exact confirmation for deliberate from-zero replay.
- `scripts/backfill-customer-360.mjs`, `scripts/verify-customer-360-backfill.mjs`, and `tests/customer-360/backfill*.test.mjs` - Offline identity-only Customer 360 backfill planning. Dry-run never opens Postgres or writes a checkpoint; connected status emits an operation-bound fingerprint; Test and separately confirmed Production apply are append-only, batch-atomic, resumable, idempotent, conflict-preserving, checkpointed, and restricted to their exact named selectors.
- `scripts/check-customer-360-readiness.mjs` - Sanitized, read-only Customer 360 readiness report for repository source, non-Production configuration, optional unauthenticated HTTPS route probes, and optional disposable-Test database inspection. It loads no `.env` file, performs no network or database access by default, and cannot prove Production migration, backfill, customer data, or operational readiness.
- `api/_lib/paid-telemetry-handoff-repair.ts`, `scripts/reconcile-paid-telemetry-handoff.mjs`, and `scripts/replay-paid-telemetry-handoff.mjs` - One-acquisition, fail-closed Meta-paid telemetry repair. Starting only from the canonical acquisition UUID and trusted namespace, it supports the original direct/simple split, the single pending verified-account-review path, the narrower dual-active-path case where exactly one disjoint reviewed bridge selects the current activation while a direct-account path remains historical, one exact legacy entitlement snapshot, one exact recoverable commerce fact, and one exact current Stripe Customer link on that fully verified path. The sixth boundary requires the locked Checkout intent and claimed account to share one bounded `cus_` value, accepts only zero links before repair or one link on the deterministic live survivor afterward, and refuses matching reviews, aliases, different owners, or any competing value link. Split profiles merge before insertion; an already-converged deployment inserts only this link. It never fetches Stripe, infers by email, creates commerce aliases/events, rewrites prior repair state, or changes historical customer links. Any mismatch rolls back and replay is a no-op.
- `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, and `api/_lib/license-environment.ts` - Shared server-only account/Stripe/Postgres implementation plus dependency-free entitlement primitives. They own exact Checkout verification, account-device transactions, two-active-device decisions, unlimited confirmed moves, production/Test isolation from trusted deployment state, short-lived access tokens, rotating refresh credentials, legacy compatibility through 1.0.13, safe OAuth return paths, and restore CSRF validation. Account-session, activation-status, verification, refresh, and download-authorization reads tolerate the pre-entitlement-lifecycle Production schema through one fail-closed JSON-based lifecycle expression, granting legacy compatibility only to the same exact one-time paid rows that the pending migration would backfill. Serverless route imports intentionally use `.js` extensions so Vercel's Node ESM runtime resolves compiled helpers.
- `api/credits/*`, `api/_lib/download-credits.ts`, `api/_lib/download-credit-response.ts`, `api/_lib/download-credit-pack.ts`, and `db/migrations/20260814120000_add_server_download_credits.sql` - Server-authoritative Free download credits. A channel-specific HMAC-hashed installation wallet receives one 1,000-credit starter grant, imports prior v1.0.19 usage only on first creation, and uses atomic 100-credit video/audio reservations with commit, release, and seven-day expiry. The append-only ledger makes retries idempotent; the client receives only balance/cost/pack presentation data. A fully configured one-time Stripe pack can add credits after exact signed Checkout fulfillment. Unlimited remains the separate database-backed account/license entitlement and consumes no Free credits.
- `api/_lib/checkout-offers.ts` - Server-owned regional Checkout catalog, trusted-country selector, and formatted presentation helper. It allowlists the global USD `$19.99`, India INR `₹499`, Brazil BRL `R$25`, and South Korea KRW `₩24,900` offers, reads only Vercel's server-side `x-vercel-ip-country` signal, and ignores browser query/body price, currency, country, and offer values. Regional offers activate only when their matching Price IDs are configured; otherwise the approved global offer remains the fallback.
- `config/upgrade-pricing-experiment.mjs`, `api/_lib/upgrade-pricing-experiment.ts`, `db/migrations/20260812120000_add_upgrade_pricing_experiment.sql`, and `docs/upgrade-pricing-experiment.md` - Authenticated `upgrade-pricing-v1` contract. The 50/50 test concluded on 2026-08-21 with one-time retained for future unassigned accounts; a source-level closure now overrides stale enabled/rollout environment values. Historical `monthly_half` assignments, subscriptions, Checkout Sessions, entitlements, lifecycle processing, and audit evidence remain supported and unchanged.
- `api/_lib/upgrade-pricing-report.ts`, `api/internal/upgrade-pricing-report.ts`, `scripts/report-upgrade-pricing-experiment.mjs`, and `tests/upgrade-pricing-report*.test.mjs` - Protected read-only experiment measurement. The shared admin guard keeps the route POST-only, no-CORS, and no-store; repeatable-read SQL reports exact assignment/exposure, mature non-conversion, entitlement activation, lifecycle/retention, currency-isolated realized money and MRR, integrity defects, and exact activation client versions. The local operator uses only `127.0.0.1`, privacy-safe IDs, bounded signed pagination, and explicitly separate modeled-LTV assumptions.
- `config/pricing-contract.mjs` - Canonical dependency-free pricing contract for Free, global USD, India INR, Brazil BRL, and South Korea KRW. It owns one-time and recurring amounts, currencies, display locales, country order, the global Stripe lookup key, and regional Price environment-variable names. `api/_lib/checkout-offers.ts`, the global Stripe resolver, the Upgrade pricing experiment, and paid landing generator consume it directly; `npm run pricing:sync` updates derived landing-page, structured-data, crawler, and generated paid-page fallbacks.
- `scripts/sync-pricing-contract.mjs` and `tests/pricing-contract.test.mjs` - Pricing drift guard and hypothetical-change proof. `npm run pricing:check` fails the build when public derived surfaces or the paid artifact do not match the canonical contract and proves ordinary Upgrade plus paid acquisition still enter the shared resolver. Change pricing in the contract, run `npm run pricing:sync`, provision the required immutable Stripe Price, then run the checkout and entitlement gates.
- `api/checkout/offer.ts` - Public read-only regional price-presentation endpoint used by the landing page. It selects from the same catalog and trusted Vercel country as Checkout, returns only the formatted price and currency, varies by the trusted country header, and is private/no-store so regional responses cannot leak through a shared cache. It never accepts country, amount, currency, offer, Product, or Price input from the browser.
- `api/auth/google/start.ts` and `api/auth/google/callback.ts` - Google OAuth redirect/callback handlers. They require the configured callback to share the browser-facing start origin before setting a short-lived HTTP-only state cookie, upsert `sidestream_accounts`, issue a server-side session cookie, and render a retryable noindex HTML error instead of raw JSON when sign-in state is stale.
- `api/auth/session.ts` and `api/auth/logout.ts` - Account-session JSON and logout endpoints used by `account.html`.
- `api/checkout/start.ts` and `api/checkout/complete.ts` - Authenticated Sidestream Unlimited Checkout flow. Start sends signed-out users through Google authentication, rejects active paid owners under the same account eligibility lock used by entitlement grants, resolves an approved offer from the trusted edge country, persists the permanent experiment assignment when enabled, and stores the complete Product/Price/billing/assignment/acquisition/activation snapshot on the locked intent before creating or reusing Stripe Checkout. Control retains the exact one-time request contract and customer copy; `monthly_half` uses only subscription-valid parameters, enables Stripe's promotion-code entry field, and copies the immutable metadata onto the Subscription. Checkout Session idempotency fingerprints every Stripe request parameter plus the logical attempt, so historical/open intents never reprice. Completion verifies exact Stripe and database truth before either variant grants the same entitlement. A complete zero-total one-time order may omit its PaymentIntent while reporting either `paid` or `no_payment_required`; an exactly discounted subscription invoice may likewise settle at zero only when its Checkout, line-item discount, Invoice totals, and empty Invoice Payments ledger reconcile.
- `middleware.ts`, `api/paid-acquisition/*`, `api/_lib/paid-acquisition.ts`, and `api/_lib/paid-landing-attribution.ts` - Paid mobile acquisition boundary. Exact unlinked `/meta-default` and `/meta-paid` are the fixed destinations for the parallel Meta-ad test: the first always redirects to the existing default site and the second always renders the paid page. Both create a canonical `source=meta`, `experiment=meta-direct-links-v1`, `campaign=sidestream_direct_offer_test` journey with `freemium/default` or `paid/paid` cohort/content dimensions; the same variant preserves its journey, while clicking the other ad begins a new one so Checkout and verified payment follow the most recent explicit experiment link without rewriting older database history. The routes are noindex and unlinked, not access-controlled. The older default-off `/mc` ManyChat 50/50 boundary and `/mc-preview` maintainer surface remain available but are not Meta campaign links. Middleware passes normalized campaign attribution to the private landing through a proof-bound internal header, and the shared parser accepts only the two server-owned `manychat` and `meta` sources. The paid Checkout POST reuses the server-owned regional Sidestream Unlimited catalog and durable core intent worker, including Stripe's promotion-code entry field, without changing ordinary signed-in Free-account Checkout. Fulfillment accepts Stripe-managed promotions only when the stored offer subtotal and currency match exactly, Stripe's aggregate discount reconciles to the Session total, tax and shipping remain zero, and the canonical captured payment matches that discounted total and currency. A 100% promotion follows Stripe's exact zero-total/no-PaymentIntent settlement shape and uses the verified Checkout Session as its idempotent settlement reference.
- `api/_lib/paid-installer-email.ts`, `api/_lib/paid-release-manifest.ts`, `api/_lib/paid-download.ts`, `api/paid-acquisition/artifact.ts`, `api/releases/paid-latest.ts`, and `data/release-manifest.paid*.json` - Receipt-gated Sidestream Unlimited email, phone-to-computer handoff, and installer surfaces. Provider delivery requires `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=1`; Production enables it so an exactly verified paid-acquisition Checkout creates one idempotent Resend delivery to Stripe's verified Checkout email. Checkout completion also installs the signed HttpOnly seven-day paid receipt cookie used only to mint the secure share link. The artifact route's exact POST accepts `{"handoffOnly":true}` from that browser receipt, returns one opaque link without email or attribution fields, and its one-parameter GET selects Mac or Windows from the computer before returning to the same exact receipt-gated delivery check. Paid metadata and fulfillment use an independent platform-specific pointer so the paid flow can serve the required `paid-onboarding` build without replacing the standard public release. After the final verified artifact redirect succeeds, it records the canonical `installer_requested` stage plus `installer_redirect` evidence without delaying delivery. The old anonymous `/api/paid-download` handler was removed; the signer now lives only under `_lib`. Public responses expose only bounded metadata, and the installer never grants entitlement by itself.
- `tests/acquisition-route-coverage.test.mjs` - Complete public API handler inventory. Every route is classified by its acquisition role, only `/api/download` and `/api/paid-acquisition/artifact` may deliver installer bytes, and both must retain canonical installer-request tracking. A new API file fails the suite until its attribution responsibility is explicit.
- `db/migrations/20260727010000_add_paid_acquisition_experiment.sql`, `docs/paid-acquisition-contract.md`, `docs/paid-acquisition-runbook.md`, and `tests/paid*.test.mjs` - Namespaced paid-acquisition schema, normative attribution/diagnostic contract, operator runbook, and deterministic provider-free evidence. The docs define the bounded activation-linkage outcomes, exact Checkout acquisition-priority rule, and one-lineage live Meta-paid release qualification. Fixture success is not live-provider, artifact, installation, Premiere, telemetry, deployment, or Production proof.
- `db/migrations/20260729120000_add_regional_checkout_offer_snapshots.sql` - Append-only checkout-intent extension for the server-selected offer ID, trusted country, currency, amount in minor units, Stripe Product, and Stripe Price, plus currency-agnostic bounds for already server-verified paid-acquisition receipts. The all-or-none snapshot constraint prevents partial intent truth; committing this migration does not apply it to any database.
- `db/migrations/20260812120000_add_upgrade_pricing_experiment.sql` - Permanent authenticated-account assignment, immutable complete experiment-intent snapshots, append-only opened-Session exposure evidence, exact lineage foreign keys/triggers, reporting indexes, RLS, and direct-role revocation. Historical intents stay nullable/readable. Apply only through the checksummed migration operator; runtime DDL remains forbidden.
- `api/billing/portal.ts` - Authenticated Stripe Customer Portal redirect creator for customer billing details and invoice history where Stripe has actual Invoice objects to show.
- `api/billing/receipt.ts` - Authenticated one-time purchase receipt helper. It finds the signed-in account's latest Sidestream license PaymentIntent and returns the Stripe charge receipt URL, covering older Checkout payments that did not create invoices.
- `api/stripe/webhook.ts`, `api/_lib/stripe-events.ts`, and `api/internal/stripe-events/process.ts` - Signature verification, durable event recording, leased `SKIP LOCKED` claims, retry/backoff/dead-letter isolation, and watermark-protected entitlement reconciliation. Customer/account reads do not process this queue.
- `api/_lib/maintenance.ts` and `api/internal/maintenance.ts` - Advisory-locked, bounded retention for expired sessions/credentials/limits/intents and Stripe payload redaction without deleting canonical leads or active entitlements.
- `api/activation/start.ts`, `api/activation/status.ts`, `api/activation/claim.ts`, and `api/activation/paid-claim.ts` - CEP-facing activation plus authenticated account routing. Ordinary Free accounts continue to Checkout through the unchanged claim route. Only exact `paid-acquisition-mc-v1` activation source receives the dedicated paid claim URL; that route requests Google's account chooser, requires server-side active entitlement truth, renders support-only recovery when no active entitlement exists, and reuses the same CSRF-protected reconnect/confirmed-transfer engine. Its GET remains read-only. After the authenticated CSRF POST succeeds, a valid HTTP-only paid-download receipt may bind that Checkout to the paid activation. The operational log records only one of the bounded linkage outcomes under `[sidestream paid activation] attribution linkage`; only `installation_claimed_recorded` proves both canonical `installation_claimed` and `verified_installation_claim` were written. Attribution failure remains additive and cannot undo a valid reconnect or transfer. The local installer receipt is never compared with or substituted for the distinct browser paid receipt.
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
- `scripts/verify-postgres-transfer.mjs`, `scripts/verify-postgres-port-closed.mjs`, `tests/postgres-transfer.test.mjs`, `docs/hetzner-database-handoff.md`, and `docs/hetzner-production-cutover.md` - Provider-neutral read-only parity, external public-5432 refusal proof, the historical copy-only handoff, and the active two-database Production cutover architecture/writer inventory. Parity covers public catalog structure, exposed browser-role grants, migration checksums, whole-table count/content fingerprints, sequences, and loopback/SCRAM target posture without returning credentials or row contents.
- `middleware.ts`, `server/hetzner-api.ts`, and `tsconfig.server.json` - Three-state `source`/`fenced`/`target` API routing and loopback-only Hetzner execution for the existing Website handlers. The server also validates signed `/v1/<immutable artifact>` requests and hands authorized bytes to Nginx through an internal `X-Accel-Redirect`; Node never streams installer bodies. Unknown/invalid target configuration fails closed to a retryable no-store 503.
- `ops/nginx/downloads.sidestream.tv*.conf` and `ops/nginx/sidestream-download-limits.conf` - HTTP bootstrap, TLS download host, internal static-file boundary, range-capable byte serving, conservative per-client controls, and privacy-minimal transfer logging with no client IP, query, signature, or full path.
- `scripts/upload-hetzner-artifact.mjs`, `scripts/finalize-hetzner-artifact.mjs`, `scripts/copy-blob-artifact-to-hetzner.mjs`, and `scripts/set-installer-provider.mjs` - Atomic immutable artifact upload/finalization, one-time Blob seeding, exact size/SHA verification, and a dry-run-first provider cutover or rollback with a protected runtime backup.
- `docs/installer-delivery-cutover.md` - Installer architecture, production setup, same-SHA deployment, security probes, rollback, and the 14-day Blob/CDN validation window.
- `scripts/run-api-tests.mjs`, `scripts/run-postgres-integration.mjs`, `scripts/validate-vercel-contract.mjs`, `scripts/verify-production-source.mjs`, `scripts/generate-production-version.mjs`, `scripts/promote-canonical-production.mjs`, `scripts/verify-production-live.mjs`, and `scripts/verify-vercel-build.mjs` - Aggregate handler/state-machine test discovery, disposable-Postgres concurrency proof with runtime-target rejection, static Vercel route/cron validation, clean remote-main/project/checkout/live-ancestry deployment validation, build-time `version.json` generation, verified custom-domain promotion, canonical post-deploy verification, and the post-`vercel build` bundle verifier.
- `scripts/audit-legacy-subscriptions.mjs` - Read-only-by-default Stripe/Product/Price inventory plus explicitly confirmed direct-database backfill/quarantine for exact allowlisted legacy subscriptions. Its current remote database connection is not Production-safe, so neither audit nor apply is authorized there.
- `scripts/audit-license-devices.mjs` - Read-only-by-default pseudonymous fleet audit plus an explicitly confirmed direct-connection backfill mode. Its current environment selection and remote TLS path block every Production mode.
- `scripts/manage-license-device.mjs` - Account/namespace-scoped support view, binding clear, and bounded expiring move-limit override. Its current environment selection and remote TLS path block every Production mode, including read-only view.
- `scripts/ensure-freedev-promo.mjs` - Maintainer utility that creates or verifies the sandbox-only Stripe `FREEDEV` 100% off promotion code used to test no-cost Sidestream Unlimited Checkout.
- `scripts/reset-alex-upgrade-state.mjs`, `scripts/reset-local-production-for-paid-test.mjs`, and `scripts/check-fresh-paid-test-handoff.mjs` - Dry-run-first fresh Meta-paid Production workflow. The remote operator requires an explicit deployed non-`main` Neon branch/direct endpoint, connected target fingerprint, verified child recovery branch, and exact Alex-only confirmations; reports contain only counts and safe fingerprints. Its Customer 360 inventory follows merged ancestors/descendants with one PostgreSQL-legal recursive reference, then closes over profile-owned historical activation/Customer links and every Checkout intent on the exact canonical acquisition. During apply, the exact paid-telemetry binding table joins the existing transaction-scoped immutable-audit trigger suspension and restoration, allowing only the already-inventoried binding deletion while rollback preserves normal immutability. Anonymous paid-acquisition events have no exact lineage key, are never selected or deleted, and remain a global preservation invariant. Disposable-Postgres coverage lives in `tests/customer-360/fresh-paid-reset-postgres.test.mjs`. The reversible local operator backs up only Production CEP/receipt/state; its Premiere blocker requires the actual `/Applications` executable or exact process name at command start, so an AdobeIPCBroker command with a later `-launchedbyvulcan` Premiere argument is preserved. The read-only post-auth preflight gates the first in-panel download plus its exact-install telemetry follow-up. The canonical procedure and stop conditions are in `docs/paid-acquisition-runbook.md`.
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
- Download and upgrade actions - `[data-download]`, `[data-windows-download]`, `[data-purchase]`, `#mobile-download-handoff`, and `#toast`; desktop Mac/Windows CTAs retain their direct installers, while viewports at or below `900px` replace the hero platform choice with two actions: “Enter your email” reveals the existing email form, and “Send it directly to your computer” opens the no-email secure-link share flow. Lower-page download taps reveal and return to the email form. Successful share or copy feedback replaces the secure-link button label instead of adding a status line; the empty `aria-live` status remains available for validation, email delivery, and share errors. The Sidestream Unlimited sequence remains Upgrade button, Google authentication, Stripe payment.
- Installer and update fulfillment - `data/release-manifest.json` is the default Mac release pointer and `data/release-manifest.windows.json` is the Windows release pointer. `api/download.ts` and `api/releases/latest.ts` resolve the same platform-specific manifest so artifact and update truth cannot drift. The provider switch changes only the byte host: Hetzner uses a five-minute HMAC URL, current-manifest allowlist, loopback authorization, and Nginx internal static serving; Blob remains the one-command rollback. Bare requests remain Mac, `win32-x64` selects Windows, and unknown platforms return `404` instead of silently serving the wrong OS.
- Anonymous acquisition continuity - `middleware.ts`, `api/_lib/acquisition-cookie.ts`, `api/_lib/acquisition-handoff.ts`, `api/_lib/anonymous-acquisition.ts`, `api/_lib/anonymous-install-claim.ts`, `api/download.ts`, `api/send-download-links.ts`, and `api/installation/claim*.ts` keep browser token, install/receipt hashes, Customer 360 profile, and later verified account/email separate. A signed 30-day first-touch cookie survives direct desktop download, optional email, or no-email seven-day mobile handoff; a locally verified installation connects it to a sparse profile through one 15-minute opaque claim. Missing configuration or tracking failures never block the page/static installer, but association fails closed.
- Test/local renamed-launcher attribution - `api/_lib/renamed-launcher-attribution.mjs` owns the file-backed claim/binding state machine, and `scripts/run-renamed-launcher-proof-server.mjs` exposes it only on `127.0.0.1`. The raw claim appears only in the operator issue response, unique launcher filename, and redemption request body; the ledger keeps only its hash. Invalid, expired, reused, wrong-filename, release/platform-mismatched, receipt-mismatched, and install-mismatched attempts fail closed. The paired FlowState proof supplies the signed launcher, native receipt, and first-open client.
- Canonical acquisition integrity - `api/acquisition/*`, `api/_lib/acquisition-integrity.ts`, Checkout/auth/fulfillment helpers, `api/internal/customers/lookup.ts`, and `api/_lib/acquisition-funnel.ts` make one private acquisition UUID the durable root from first website or signed delivery entry through Google, Checkout, payment, refund/dispute, install claim, and Customer 360 reporting. `website`, `manychat_email`, and `facebook_lead_form` are server-owned immutable entry channels; `website_direct_or_unknown` means the website entry is exact but the external origin was unavailable. It never hides missing internal linkage. Every new Checkout intent requires the UUID, Stripe Session/Invoice/PaymentIntent metadata must agree, and operator reads expose privacy-safe stage summaries, integrity alerts, signed journey pagination, and exact `cus_`/`cs_`/`pi_`/`ch_` lookup without returning those identifiers.
- Installer referral attribution - Gmail launch URLs use `utm_source=gmail`, `utm_medium=email`, a bounded campaign ID, and optional `utm_content=pilot` or `utm_content=main` batch ID. Only a successful tagged installer `GET` creates `public.sidestream_installer_requests`; `HEAD`, `304`, invalid tags, and failed fulfillment create nothing. The event stores no email, raw IP, or raw user agent. Scanner-like `GET`s remain visible with `likely_scanner = true` so reports can separate them instead of pretending they never happened.
- Landing referral attribution - `/manychat-instagram` and `/manychat-instagram/` are the dedicated organic Instagram ManyChat routes and reach the canonical root with `utm_source=manychat-instagram`, `utm_medium=dm`, and `utm_campaign=organic-instagram`. Legacy `/m`, `/m/`, `/mc/`, and exact `/mc` when the paid experiment is default-off/control/ineligible retain the generic `utm_source=manychat` bucket. The loaded page POSTs either allowlisted source to `/api/referral-visit`; private Blob pathnames dedupe repeated visits from the same anonymous request fingerprint on the same UTC day and separate likely-human from likely-scanner traffic. This measures landing visitor-days, not downloads, installs, activations, purchases, or durable identities.
- Download lead capture and replay - `api/download-lead.ts`, `api/_lib/download-leads.ts`, and `api/internal/download-leads/replay.ts` validate at most 8 KiB of JSON, converge repeated `(email, cta_source)` submissions, enforce 5/email and 20/IP per ten minutes, and fall back to deterministic private Blob records when Postgres fails. Scheduled replay processes 25 mapped records and deletes only after commit plus ETag match; manual replay is bounded to 100 and defaults to preserving records. Historical `windows-waitlist` rows remain queryable.
- Account/auth/billing/device entitlement - `account.html`, `thank-you.html`, `api/_lib/checkout-offers.ts`, `api/_lib/account.ts`, `api/_lib/entitlement.ts`, `api/_lib/device-policy.ts`, `api/_lib/license-environment.ts`, `api/auth/*`, `api/checkout/*`, `api/billing/*`, `api/stripe/webhook.ts`, `api/activation/*`, `api/account/device.ts`, and `api/license/*` own Google account management, the server-owned global USD, India INR, Brazil BRL, and South Korea KRW one-time Sidestream Unlimited offers, immutable Checkout snapshots, namespace-separated active-device rows, restricted Test isolation, refund/dispute lifecycle, confirmed transfers, download authorization, deactivation, and device-bound access/refresh credentials. Every valid approved regional purchase grants the same `sidestream_pro` entitlement. Device mismatch policy defaults to `observe`; only explicit `enforce` blocks, and Customer 360 does not change that mode. The API/operator contract is `docs/api-hardening-runbook.md`; device/support details are in `docs/single-device-entitlements.md`.
- Download credit ledger - `api/credits/sync.ts`, `api/credits/reserve.ts`, `api/credits/finalize.ts`, `api/credits/purchase.ts`, `api/_lib/download-credits.ts`, and the credit migration own server balance truth for Free installations. The routes remain inert unless `SIDESTREAM_DOWNLOAD_CREDITS_ENABLED=1`; sync, reservation, and terminal transitions are rate-limited and fail closed; duplicate request keys converge without double spend or double grant. Raw installation identity and Stripe secrets are never stored in the ledger. Purchase-pack presentation is omitted unless all required pack settings are valid.
- Paid mobile acquisition - Exact `/mc` is an unlinked, default-off experiment entry owned by `middleware.ts`; `/m`, `/m/`, and `/mc/` retain their existing redirects. Eligible paid-cohort navigation is internally rendered from deterministic `generated/mobile-paid-prototype.html`, generated from the current canonical root. Vite compiles that page as a dedicated entry so its shader and media use deployable hashed assets, then `scripts/stage-paid-landing-runtime.mjs` stages the compiled page at `runtime/mobile-paid-prototype.html` for the serverless bundle. The paid landing function injects its bounded Checkout token into that compiled runtime artifact. Paid Checkout uses the same trusted-country offer catalog and immutable snapshot as ordinary Checkout. After exact fulfillment, `paid-thank-you.html` can share the same verified Unlimited receipt to the customer's computer without routing through the public Free installer. Verified email, installer receipt, claim, artifact, and lifecycle records remain namespaced and cannot be selected by browser-supplied price, product, amount, currency, country, offer, cohort, or environment.
- Customer 360 commerce ledger - `api/_lib/customer-commerce.ts`, `20260715122000_add_customer_commerce_ledger.sql`, and `tests/customer-360/commerce*.test.mjs`; settled money comes from one canonical PaymentIntent or standalone Charge per payment group. Before that instrument exists, a paid InvoicePayment edge makes the related Invoice the preferred fallback and suppresses only the Checkout view resolving to the same namespace/profile/currency payment key. Gross and its `off_stripe_paid_minor` subset stay currency-separated, unrelated Checkout fallbacks remain independent, paid InvoicePayment edges never collapse many-to-many allocations into alias equivalence, and contradictory live identity evidence triggers sticky whole-group quarantine.
- Customer 360 usage and private reads - `api/_lib/customer-usage.ts`, `api/_lib/customer-query.ts`, `api/_lib/customer-summary.ts`, `api/internal/customer-usage/sync.ts`, and `api/internal/customers/*`; schema-versioned telemetry becomes replaceable UTC daily aggregates with exhaustive stored/derivable first/last use and attempt timestamps, outcome counts, lifetime and rolling activity, attempts-per-active-day frequency, coarse client summaries, and source/materialization freshness. The compact list/detail projection exposes only its documented subset. The separate summary counts active exact-plan Unlimited accounts, distinct exact-plan accounts with a fulfilled positive-payment PaymentIntent, their overlap, and Stripe's live all-time succeeded-PaymentIntent total. All reads require an authenticated admin body to select the deployment-matching namespace; list cursors bind that namespace and filters. The full cross-repo field/privacy/rollout contract is `docs/customer-360.md`.
- Acquisition and retention report - `api/_lib/acquisition-funnel.ts` and `api/internal/customers/funnel.ts`; an authenticated non-browser caller selects a namespace, independent `first_install` or `first_purchase` cohort basis, bounded cohort, and later completed UTC-day observation boundary. The response contains canonical-root and deterministic legacy attribution groups, distinct counts for all ten stage grains, explicit integrity alerts, source totals capped at 100, and signed `(cohortAt, customerId)` journey pages capped at 100. Every first-open/activation/return/one-and-done and attribution-coverage value exposes its exact numerator and denominator; overall stickiness continues to use all install IDs rather than only attributable profiles.
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

The parallel Meta-ad test uses two separate, unlinked, noindex destinations:

```text
https://sidestream.tv/meta-default
https://sidestream.tv/meta-paid
```

`/meta-default` always enters the existing default site. `/meta-paid` always
enters the pay-first landing and fails closed with `503` if its server signing
boundary is unavailable; it never silently contaminates the default cohort.
The server fixes both links to `source=meta`, `medium=social`,
`campaign=sidestream_direct_offer_test`, and experiment
`meta-direct-links-v1`, with `freemium/default` or `paid/paid` cohort/content.
Do not add browser-supplied UTM parameters to select or relabel these variants.
No page, sitemap, or crawler asset links to either path. This makes the links
private-by-distribution, not secret or access-controlled after someone shares
one.

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
| `/api/download` | `GET`, `HEAD` | GET `302` to a five-minute signed provider URL or `304` for a matching ETag; HEAD `200` attachment metadata |
| `https://downloads.sidestream.tv/v1/<artifact>` | `GET`, `HEAD` | Valid unexpired signatures receive Nginx-served immutable bytes with Range support; missing, expired, changed, unknown, or traversal-shaped requests fail closed |
| `/api/referral-visit` | `POST` | `204` after accepting the allowlisted `manychat-instagram` or legacy `manychat` source and scheduling a private, daily-deduped anonymous Blob write |
| `/api/releases/latest` | `GET`, `HEAD`, `OPTIONS` | GET `200` public manifest, HEAD matching metadata without a body, OPTIONS `204` |
| `/api/download-lead` | `POST` | `200 {"ok":true}` after Postgres or `200 {"ok":true,"queued":true}` after private-Blob fallback |
| `/api/send-download-links` | `POST`, `GET` | Email POST returns `200 {"ok":true}` after durable lead/rate-limit storage and Resend acceptance and uses signed handoffs when anonymous continuity is configured; no-email `{"handoffOnly":true}` POST returns one opaque `handoffUrl`; GET accepts exactly that signed envelope, restores the acquisition cookie, and redirects to the same platform installer. Invalid handoffs return `404` |
| `/api/auth/google/start`, `/api/auth/google/callback` | `GET` | Existing-session account redirect or Google OAuth redirect and server session creation |
| `/api/auth/session` | `GET` | Read-only account/license session JSON; it never drains Stripe events |
| `/api/auth/logout` | `POST` | Clears the server session |
| `/api/checkout/start` | `GET` | `302` to Google authentication when signed out; `303` to Stripe Checkout for a signed-in Free account |
| `/api/checkout/complete` | `GET` | Exact Stripe re-verification then `303` to the ordinary thank-you page or, for server-verified paid acquisition, the phone-first paid thank-you page; not-ready is `409` |
| `/api/credits/sync` | `POST` | `200` with the authoritative installation-wallet balance, reserved/granted/spent totals, fixed costs, and optional public pack presentation; first creation may import bounded legacy usage |
| `/api/credits/reserve` | `POST` | `200` with an idempotent `reserved` or terminal/`insufficient` decision and the updated authoritative snapshot |
| `/api/credits/finalize` | `POST` | `200` after an idempotent `committed` or `released` transition, including an already-terminal or `not_found` result for safe client dequeue |
| `/api/credits/purchase` | `POST` | `200` with an exact Stripe Checkout URL only when the requested server-advertised pack is fully configured; otherwise `503 credit_purchases_unavailable` |
| `/api/paid-acquisition/landing` | `GET` (internal rewrite only) | Private no-store paid landing after an exact signed paid `/mc`, `/mc-preview`, or `/meta-paid` proof |
| `/mc-preview` | `GET` | Unlinked maintainer review entry that deterministically renders the paid landing on desktop with the real Checkout boundary |
| `/meta-default` | `GET`, `HEAD` | Unlinked noindex fixed Meta control link; GET `307` to the canonical default page with server-owned Meta dimensions |
| `/meta-paid` | `GET`, `HEAD` | Unlinked noindex fixed Meta paid link; GET renders the paid landing with a signed paid entry, while HEAD is state-free metadata and unavailable signing fails closed |
| `/api/paid-acquisition/checkout` | `POST` | Idempotent paid-cohort Checkout start using only the current server-owned Product/Price and a durable core intent |
| `/api/paid-acquisition/artifact` | `GET`, `POST` | Exact signed-receipt POST mints the paid computer handoff; one-parameter handoff GET selects the computer platform; exact receipt/platform GET re-verifies fulfillment then redirects to the short-lived paid artifact URL |
| `/api/paid-acquisition/claim` | `GET` | Receipt-cookie and Google-auth claim/recovery boundary without browser-selected payment or environment truth |
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
| `/api/internal/customer-summary` | `POST` | Same protected non-browser boundary; returns deployment-matched decimal-string totals for current Unlimited access, paid users, their current overlap, and successful exact-plan payments |
| `/api/internal/customers/funnel` | `POST` | Same protected non-browser boundary; returns a read-only first-install/default or first-purchase cohort report through an explicit completed UTC-day observation end, with ten stage counts, integrity alerts, auditable ratios, capped source totals, and signed privacy-safe journey pagination |

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

Customer 360 completed its human-authorized Production qualification on
2026-08-01. A protected pre-change Neon branch was retained; all 29 checksummed
migrations were applied to the attested Production target; runtime, direct
operator, and read-only telemetry roles were kept separate; both identity
backfills completed and no-op reruns proved idempotency; and the complete
version-2 history rescan processed `1,403,633` eligible source rows into
`2,673` UTC daily rows for `802` installs. A guarded
normal sync followed the rescan, and the source remained read-only while target
writes stayed limited to append/update-only Customer 360 aggregates.

The Git-linked Production deployment exposes authenticated, `no-store`
list/detail/funnel reads, while unauthenticated calls remain `401`. The rendered
FlowState Customers view was verified against the live Production API without
email addresses, raw hashes, Stripe IDs, search text, or provider payloads. A
public 1.0.17 Mac installation then completed the one-time browser claim and
attached the installation to its existing profile without changing Checkout,
entitlement, device, or payment ownership. Money remains Stripe-verified,
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

The reusable rollout path remains the human-gated sequence in
`docs/customer-360.md`: Preview/Test qualification, protected backup and target
attestation, migration/configuration, idempotent backfills, guarded rescan and
sync, authenticated API/privacy checks, canonical `origin/main` deployment,
real-product smoke, four-job scheduler review, and signed release. The
2026-08-01 run executed that sequence with explicit failure stops, no-delete
evidence, and canonical-surface verification. Vercel cron control remains
project-wide across all four declared jobs; Customer 360 usage sync is scheduled
once daily at `05:27` UTC.

#### Measurable acquisition and retention funnel

`POST /api/internal/customers/funnel` uses the same
`SIDESTREAM_CRM_ADMIN_SECRET`, POST-only, no-browser-origin, no-store boundary as
the Customer 360 list/detail routes. Its body is exactly `licenseNamespace`,
optional `cohortBasis`, `cohortStart`, `cohortEnd`, required `observationEnd`,
optional `journeyLimit`, and optional `journeyCursor`. `cohortBasis` is
independently `first_install` (the default) or `first_purchase`. The cohort
timestamps must be UTC `Z` values and `cohortEnd` is the exclusive bound for
the selected basis. `observationEnd` must be an
exclusive completed UTC-day boundary at `00:00:00Z`, at or after `cohortEnd`.
The cohort window remains capped at 366 days and the full
`cohortStart`-to-`observationEnd` span is capped at 730 days. `journeyLimit`
defaults to 50 and is bounded from 1 to 100. The query is a read-only
repeatable-read transaction.

The report uses these definitions:

- **Install / purchase cohort:** `first_install` uses the earliest
  `sidestream_customer_installs.first_seen_at` across a live profile's current
  install memberships. `first_purchase` uses its earliest verified
  `first_paid_at` across current currency totals and can include a purchaser
  with no installation. Membership is `cohortStart <= cohortAt < cohortEnd`;
  groups include every profile in the selected cohort, including unknown
  source.
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
- **Paid customer:** a cohort profile counts once when a verified payment
  occurred before `observationEnd` and at least one current currency total has
  positive net paid after refunds and disputes. This is distinct people, not
  transactions, revenue, entitlement, or paid-acquisition attribution.
- **Return / one-and-done:** `laterOpenDays` contains distinct UTC open dates
  after the first-open date and before `observationEnd`. A profile is return
  eligible only after first open and when at least one complete later UTC day
  exists before the observation boundary. Only an eligible profile with no
  later open day has `oneAndDone=true`; an immature profile is not labeled
  one-and-done.

Top-level `paidCustomerPercentage` and top-level/per-group
`firstOpenPercentage`, `activationPercentage`, `returnPercentage`, and
`oneAndDonePercentage` expose numerator, denominator, and percentage; zero
denominators produce `percentage: null`. `totals` exposes the corresponding
profile counts. `dateWindow` names `first_install_at` or `first_purchase_at`
and keeps that inclusive/exclusive selection window separate from the completed
UTC-day observation boundary. `groups` cover the complete cohort. `journeys`
add explicit return eligibility and returned/one-and-done state, remain ordered
by `cohortAt` then customer UUID, and use an opaque HMAC-signed
`nextJourneyCursor`. The cursor binds namespace, basis, limit, and every time
boundary; changing a filter invalidates it. The page limit is 1-100 and a null
next cursor marks the final page.

Attribution is deterministic and deliberately narrow. Precedence is:

1. `exact_paid_checkout`: an active completed paid-acquisition Checkout joined
   to its exact server record and exact receipt, Checkout Session, or claimed
   activation/account profile edge. When one immutable paid-telemetry binding
   resolves that Checkout plus its canonical acquisition and exact current live
   profile/install membership, it outranks every broader paid edge. With no
   binding, the historical first-touch/entry/Checkout fallback remains stable;
   multiple exact bindings select no attribution and fail the profile to the
   complete unknown group.
2. `exact_anonymous_claim`: an immutable browser first touch with a recorded
   installer request, completed one-time install/receipt claim, and exact
   claimed profile.
3. `exact_verified_email`: a `mobile-download-handoff` lead whose normalized
   email exactly equals both verified account and profile contact email.
4. A canonical `sidestream_acquisitions` root with a deterministic account,
   activation, Checkout Session, or commerce-materialization profile edge.
5. `unattributed`: the complete remaining `source=unknown` cohort with
   `missing_internal_linkage` integrity state.

Paid wins over anonymous claim and verified email; anonymous claim wins over
verified email, and those compatibility classes precede a canonical-root
candidate. Every candidate first touch must be at or before the selected cohort
landmark, and a verified-email row's first and last capture must both
predate/equal that landmark. Within paid candidates, immutable-binding
precedence is evaluated before the existing stable first-touch tie-breakers;
the other classes retain earliest exact evidence with stable database
tie-breakers. Repeated leads may fill only a previously
null UTM field and may
retain only a valid signed `mc-mobile-paid-v1` assignment. There is no matching
by timing, IP, user agent, referrer, fuzzy email, or approximate identity.

`attributionCoverage` divides every non-unattributed result by every profile in
the selected cohort. Its named paid, anonymous, and freemium counts retain the
three deterministic legacy exact classes; canonical-root confidence remains in
the attributed total and grouped output. The parallel `coverage` object exposes
total attributed/unknown and each legacy exact class against that same cohort
denominator. Unknown installs remain in product-wide install/open/return
denominators.

`sourceTotals` is capped at 100 groups and reports truncation. `stageCounts`
counts distinct stage deduplication keys in `[cohortStart, observationEnd)` for
all ten canonical stage/grain pairs. `integrityAlerts` counts canonical roots
first observed in `[cohortStart, cohortEnd)` whose state is
`missing_internal_linkage`, `historical_unlinked`, or `quarantined`; these are
internal integrity states and must not be relabeled external unknown origin.

Installer packages remain static and are never personalized. The locally
generated receipt hash is association evidence only; the exact anonymous claim
is what joins immutable browser first touch to the profile. Unlinked sessions
remain `source=unknown`.

The exact `session_started` rule replaced historical broad non-installer
activity buckets. The normal sync rereads only its bounded overlap, so a
one-time full append/update rescan of the source telemetry history is required
to rebuild older open, accepted-download, and outcome buckets before historical
usage or retention is trusted. Historical install identities are materialized
first through the identity backfill; rescan then remains usage-aggregate-only.
`scripts/rescan-customer-usage.mjs` now provides dry-run plus guarded
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

`/api/download` serves the object named by the selected manifest at `artifact.pathname`. `HEAD` returns attachment metadata without exposing a storage URL. `GET` first verifies provider metadata, honors a matching `If-None-Match` with `304`, then redirects to a five-minute signed URL. With `SIDESTREAM_INSTALLER_PROVIDER=hetzner`, the HMAC covers the exact immutable pathname and expiry; `downloads.sidestream.tv` accepts only current manifest artifacts, and Nginx serves the body from `/srv/sidestream/artifacts` only after the loopback Node authorizer emits an internal redirect. The signed URL carries no account, email, license, payment, receipt, or acquisition identity. `SIDESTREAM_INSTALLER_PROVIDER=blob` retains the previous Vercel Blob signing path as the explicit rollback, while `@vercel/blob` remains required for referral, rate-limit, and replay records. Full setup, security probes, and rollback are in `docs/installer-delivery-cutover.md`.

After a tagged Gmail redirect is sent, the bounded writer gets at most one second to save a privacy-limited request event; a missing secret, database failure, or timeout cannot change delivery. Set `SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET` to at least 32 characters everywhere that records referrals. `/api/releases/latest` serves the same selected manifest's public update metadata without its storage pathname. Bare and Mac-platform requests use `data/release-manifest.json`; `platform=win32-x64` uses `data/release-manifest.windows.json`; unknown platforms return `404`. Receipt-gated paid delivery uses `data/release-manifest.paid.json` or `data/release-manifest.paid.windows.json`; `/api/releases/paid-latest` exposes only bounded public metadata. The independent paid Mac pointer selects the exact-public-`1.0.17`-baseline paid-onboarding build. Its immediate behavior rollback is the original stable `1.0.17` Mac artifact at `sidestream/1.0.17/Sidestream-1.0.17-Mac-Installer.dmg`. The Mac manifest keeps `1.0.12` as the minimum supported version; clients below that floor are critical-update eligible regardless of rollout, while 1.0.19 is also critical. Future publishing defaults to the same floor unless `--min-supported-version` is supplied. The current public Mac pathname is:

```text
sidestream/1.0.19/Sidestream-1.0.19-Mac-Installer.dmg
```

The current public Windows pathname is:

```text
sidestream/1.0.16/Sidestream-1.0.16-Windows-Installer.exe
```

The current receipt-gated paid Mac pathname is:

```text
sidestream/1.0.17/e941f79f7332e9b7/Sidestream-1.0.17-Unlimited-Mac-Installer.dmg
```

An isolated paid Mac pointer may advance only after its FlowState source commit
is recorded and verified as the intended Production release boundary. The paid
Production builder consumes the current FlowState source; matching the stable
application version does not prove matching stable behavior, and a Test menu or
staged Test version does not constrain a later paid Production build. Do not
advance the paid pointer from a post-release source checkout without an explicit
Production promotion decision and loaded-Premiere qualification.

The rollback store is the private `sidestream-release-105` Vercel Blob store in project `sidestream`, store id `store_9KFjHEkmxI6IIWNi`, region `iad1`. Do not delete installer objects during the 14-day post-cutover validation window. Blob access still uses Vercel OIDC plus `BLOB_STORE_ID` or the protected legacy token because non-installer Blob records remain live. Installer pathnames live only in manifests; `.env.local` stays ignored. Bare website downloads must keep selecting the native/base Mac DMG.

### Vercel Blob And CDN Usage Guardrails

Limits and the live team plan were rechecked on 2026-07-13; re-check [Vercel pricing](https://vercel.com/docs/pricing), [Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), and [CDN usage](https://vercel.com/docs/manage-cdn-usage) before making quota-sensitive changes. Production currently runs on Vercel Pro with usage billing active. The private store held about 1.406 GiB before the Windows `1.0.13` upload, so it was already beyond the old Hobby allowance without being blocked.

The current public Mac artifact, `Sidestream-1.0.19-Mac-Installer.dmg`, is 227,135,707 bytes, about 217 MiB. The current Windows artifact, `Sidestream-1.0.16-Windows-Installer.exe`, is 61,707,154 bytes, about 59 MiB. Use the live Vercel Usage view rather than stale plan math before adding artifacts or estimating a launch's transfer cost. During the first 14 days on Hetzner, compare that baseline with Nginx transfer totals rather than assuming a drop proves correct delivery.

Flag any change that increases installer size, stores multiple release DMGs, uploads raw demo/video assets, makes `/api/download` easier for bots to hit, removes attachment/cache safeguards, proxies the installer through extra functions, or changes the email gate/CTA flow in a way that materially increases downloads. Estimate `artifact bytes * expected downloads` and verify Vercel Usage after publish.

Download CTAs are intentionally unblocked in the canonical HTML. Mac anchors point at `https://sidestream.tv/api/download`, while the hero Windows anchor points at `https://sidestream.tv/api/download?platform=win32-x64`, so local static previews and adjacent static hosts do not 404 on a relative API path. The old download-email and Windows-waitlist modal markup remains for historical compatibility, but visible download clicks no longer require an email before starting either installer; prior Windows leads remain queryable through `cta_source = "windows-waitlist"`.

The SaaS/account flow is server-owned. The landing-page Account link enters `/api/auth/google/start`: a valid server session goes directly to `account.html`, while a signed-out visitor enters Google OAuth and the callback creates or reconnects the account. Direct signed-out visits to `account.html` use the same entry instead of rendering an empty account panel. The Google callback origin must exactly match the browser-facing OAuth start origin; Production uses `https://sidestream.tv/api/auth/google/callback` in Google Auth Platform, keeps `SIDESTREAM_BASE_URL=https://sidestream.tv`, and requires any optional `GOOGLE_REDIRECT_URI` override to use that same callback. The start route checks this before setting state cookies, so a stale deployment setting cannot send users through Google only to fail the callback on another hostname. The session is remembered for up to 30 days by the existing HTTP-only, `SameSite=Lax` `sidestream_session` cookie; do not add a browser-readable identity cookie. While Production intentionally remains on the pre-entitlement-lifecycle schema, every customer-facing license read uses the shared `LICENSE_ENTITLEMENT_STATUS_SQL` expression to detect the missing column without runtime DDL and treats only exact one-time paid `active`/`trialing` rows as compatible Unlimited access; after the column exists, its canonical stored value always wins. Sign out clears the server session and returns to the landing page so the automatic account entry cannot immediately sign the user back in.

The paid sequence is exactly:

1. The user clicks Upgrade.
2. Google authentication establishes the Sidestream account session.
3. The browser opens Stripe Checkout for payment.

`GET /api/checkout/start` owns that sequence. It sends signed-out users to Google with an allowlisted return path. For a signed-in Free account, it applies the account/IP rate limit, normalizes only Vercel's trusted `x-vercel-ip-country` header, selects an approved server-owned offer, validates its immutable Stripe Price, and stores the offer ID, observed country (`ZZ` when unavailable), currency, amount in minor units, Product ID, and Price ID on the 24-hour database intent before Checkout creation. Browser query/body country, offer, currency, amount, Product, or Price values are never selectors. The locked/idempotent worker creates or reuses Stripe Checkout from that stored Price; a catalog or environment change while the Session remains open cannot reprice the intent. The Stripe idempotency key is derived from the logical intent, attempt, and a canonical fingerprint of the complete Session-create request; identical retries converge, while any request change receives a distinct key.

Acquisition resolution happens before either the Google redirect or Checkout
intent insert. A valid signed acquisition cookie wins; otherwise an exact
encrypted/signed server delivery handoff may restore its UUID and immutable
`manychat_email` or `facebook_lead_form` channel. Bounded browser UTM input,
including a source name resembling a trusted integration, remains an ordinary
`website` channel and cannot select either trusted channel. With neither a
valid cookie nor a valid handoff, Checkout creates a fresh `website` root with
source `website_direct_or_unknown`. That fallback means Sidestream observed the
exact website entry while no external origin was available. It is not
permission to hide a missing account, Checkout, Stripe, installation, or
reporting join.

The Google start route sets a separate short-lived HttpOnly OAuth acquisition
cookie so the exact UUID survives Upgrade -> Google authentication -> Stripe.
Every new
`sidestream_checkout_intents` row must have `acquisition_id`. Checkout creation
copies it to `sidestream_acquisition_id` metadata, and fulfillment requires the
stored intent, Checkout Session, any Invoice, and any PaymentIntent to agree on
that UUID before entitlement or stage writes commit. A verified zero-total
Session without a PaymentIntent uses the Session as the settlement reference;
it does not waive any other acquisition, offer, amount, currency, Product,
Price, account, activation, or attachment check. Any mismatch fails closed:
the completion route returns `409` with the bounded reason and writes no
entitlement or success stages. The webhook queue retains its existing bounded
outcome behavior; operators must alert on acquisition mismatch/owner conflict
outcomes rather than inventing linkage or manually editing the ledger.

The global catalog entry owns the approved USD `1999` minor-unit amount and uses the existing Sidestream Unlimited Price resolver. India owns INR `49900` (`₹499`) through `SIDESTREAM_PRO_INDIA_PRICE_ID`; Brazil owns BRL `2500` (`R$25`) through `SIDESTREAM_PRO_BRAZIL_PRICE_ID`; South Korea owns KRW `24900` (`₩24,900`) through `SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID`. All use the same Sidestream Product. Checkout accepts a regional Price only when Stripe reports the catalog's exact Product, currency, amount, active state, and one-time billing shape. A missing regional Price ID safely falls back to the approved global offer.

`GET /api/checkout/offer` applies that same trusted-country selection without creating an intent or calling Stripe. It returns only `{ formattedPrice, currency }`, sets `Cache-Control: private, no-store`, and ignores query/body inputs. The canonical and generated paid HTML render `$19.99` as a resilient global/SEO fallback, then replace only elements marked `[data-checkout-offer-price]` with the endpoint response. Checkout still resolves and snapshots its offer independently on the server, so changing or forging the displayed text cannot select a country, Price, currency, or amount.

Fulfillment first loads all intent rows attached to the requested Session, then fetches the completed Stripe Session and selects only the intent ID embedded by the server at creation. `isApprovedPurchase` becomes true only after the stored snapshot exactly matches the Session's plan, intent/account/offer metadata, activation metadata, one line item, quantity, Product, Price, currency, original subtotal, discounts, shipping, tax, total, settlement state, PaymentIntent/Charge customer, captured amount, and currency. It never resolves today's catalog or reads a current Price environment variable. A valid global, India, or Brazil purchase writes the same `sidestream_pro` entitlement. Stripe may represent a complete 100%-discounted order as `payment_status=paid` or `payment_status=no_payment_required` with no PaymentIntent; both remain valid only when the stored subtotal reconciles through the exact discount to zero and every other snapshot check succeeds.

Monthly Checkout exposes Stripe's promotion-code field. An open activation-attached Session is reused only after Stripe confirms that capability; an older open Session without it is expired and replaced under the existing exact intent/attempt contract. Subscription fulfillment keeps the immutable recurring Price as list-price truth, then requires the Checkout total, Invoice line discount, aggregate Invoice discount, Invoice total, and Invoice Payments ledger to reconcile exactly. A legitimate 100%-discounted first Invoice may have a zero total and no Invoice Payment; later Invoices are independently checked, so a `once` coupon returns to the stored monthly Price while `repeating` or `forever` coupons must continue to carry their provider-owned discount amounts. Coupon duration is Stripe billing truth and must match the customer-facing promise.

Canonical paid access requires `entitlement_status=active` on `sidestream_pro` or compatible `sidestream_unlimited`, but the current lifecycle implementation is not complete Stripe truth. Partial refund remains `active/partial_refund`; full refund becomes irreversible `revoked/full_refund`; open inquiry/dispute statuses suspend; `won` may reactivate unless a prior `lost` was persisted; and `lost` is irreversible. Production is blocked because `refund.failed` is not handled and a failed full refund cannot restore access, while current Stripe terminal statuses `warning_closed` and `prevented` are incorrectly treated as open. A separately owned implementation/test change or an explicitly approved conservative policy plus tested customer recovery is required. The Stripe-created-at plus event-ID watermark still prevents stale Checkout, refund, dispute, or subscription events from resurrecting a later state. Legacy recurring access remains default-deny and requires an exact Product and Price in the two reviewed allowlists.

`POST /api/stripe/webhook` verifies the signature, durably records the event, and acknowledges it; it does not perform customer-state work inline. Leased workers transition `received` to `processing`, then terminal `processed`/`ignored` or bounded `retryable`/`dead_letter`. Account/session/activation reads never drain this backlog. Required event subscriptions and queue operations live in `docs/api-hardening-runbook.md`.

Plugin activation rows are device-bound. `/api/activation/status` issues one deterministic, retry-safe credential family only after verified payment or an explicit restore. Current clients may recover that family for 10 minutes after completion; legacy clients through 1.0.13 receive the same `active` response throughout the activation's 24-hour lifetime because they do not understand the terminal `completed` state. Current-client access tokens last seven days. Tokens whose database-linked activation records are from legacy clients through 1.0.13 receive a 365-day access lifetime and `/api/license/verify` rolls that expiry forward, because those clients cannot retain or rotate the paired refresh credential; this decision never trusts a spoofable request user agent. The paired opaque refresh token is hashed at rest, bound to the same device, rotates atomically through `/api/license/refresh`, and has a rolling 365-day expiry. A two-minute predecessor-hash window returns the same derived rotated pair after one lost response or concurrent retry without accepting the old credential indefinitely.

`/api/license/verify` and `/api/license/refresh` return 401 codes `invalid_token`, `revoked`, `device_mismatch`, `device_replaced`, or `device_deactivated`, and 403 `license_inactive`; callers retain credentials on transient 5xx failures. `/api/activation/claim` authenticates first. A signed-in Free account continues to `/api/checkout/start`; an active owner may use the no-store restore or transfer decision and its same-origin, CSRF-valid POST to CAS-bind a fresh activation whose account is still null or identical. `/api/activation/paid-claim` is selected only when activation start receives exact raw source `paid-acquisition-mc-v1`, rechecks that source on the activation row for both GET and POST, and never treats source or either receipt as entitlement truth. An active owner receives the same reconnect/transfer policy; an inactive owner sees only signed-in identity and the existing `alex@alexg.mov` support destination, never Checkout or Upgrade. GET is read-only. After a successful POST, the separately signed browser paid receipt can bind the paid Checkout and activation, while the activation-linked local install and installer-receipt identities provide the verified installation evidence. Missing or conflicting attribution evidence cannot undo valid entitlement recovery. An active Unlimited owner is routed to claim/account instead of starting another purchase. Do not store Stripe secrets, Google client secrets, raw payment data, activation keys, license tokens, refresh tokens, or permanent paid-state in browser code or logs.

### API data ownership and migration model

`api/_lib/postgres.ts` owns one attached pool for every runtime API feature. Production chooses a pooled URL in this order: `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, then `POSTGRES_PRISMA_URL`; direct/non-pooling fallback is forbidden in production runtime. `POSTGRES_POOL_MAX` defaults to 4 and is bounded 2-20, with bounded idle, connection, query, and statement timeouts. Guarded migration and Customer 360 backfill operators accept only `SIDESTREAM_TEST_POSTGRES_URL` for Test or `SIDESTREAM_POSTGRES_URL_NON_POOLING` for Production.

`scripts/apply-postgres-migrations.mjs` owns an advisory-locked SHA-256 ledger in `public.sidestream_schema_migrations`. Database-backed `--status` is authoritative for every applied/pending filename in the complete chain and fails on tracked ledger/local checksum mismatch. Connected modes enforce exact named selectors, authenticated remote TLS, one connection, database/port/namespace attestation, and operation-bound fingerprints; Production baseline/apply also require exact operation and target confirmations. `--validate` and `--dry-run` are strictly local file checks and are not Production-state evidence. A non-empty legacy schema requires a separately reviewed explicit `--baseline`; `scripts/verify-migration-baseline.mjs` is only the narrower known-catalog/conditional-RLS guard. Applying commits each pending SQL file and ledger row together. Runtime handlers never create or alter schema. The ordered tail includes `20260729120000_add_regional_checkout_offer_snapshots.sql`, `20260731120000_add_anonymous_acquisition_sessions.sql`, `20260803120000_add_acquisition_integrity.sql`, `20260812120000_add_upgrade_pricing_experiment.sql`, and `20260814120000_add_server_download_credits.sql`. Credit code may deploy inert, but `SIDESTREAM_DOWNLOAD_CREDITS_ENABLED=1` must not be set before the final migration is applied and checksummed. The private wallet/reservation/append-only-ledger tables keep RLS enabled and revoke direct public/`anon`/`authenticated` access.

Key hardened environment/configuration ownership:

| Area | Contract |
| --- | --- |
| Cron | One stable `CRON_SECRET`, 16-512 printable non-space ASCII characters (`U+0021`-`U+007E`), protects Stripe process, lead replay, maintenance, and Customer 360 usage-sync routes; use a secret-manager-generated 64-character hexadecimal token |
| Pool | `POSTGRES_POOL_MAX` defaults to 4 (2-20); idle/connection/query/statement timeout variables are bounded and documented in the runbook |
| Limiter/lead | `SIDESTREAM_RATE_LIMIT_HASH_SECRET` and `SIDESTREAM_LEAD_HASH_SECRET` are stable server-only HMAC values of at least 32 characters; `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX` selects the private fallback prefix. Pro WAF is a per-region fixed-window counter. With exactly one shared rule/counter domain spanning every reachable host, the trailing boundary burst is approximately `2 * L * R` for regional limit `L` across reachable regions `R`, plus reconciliation risk. With `H` independent host/rule counter domains it grows to approximately `2 * L * R * H`. Require `H=1` with cross-host evidence, or measure/test/approve the larger bound; otherwise use a durable shared limiter. |
| Checkout intent | Database intent TTL is 24 hours. `SIDESTREAM_PRO_PRODUCT_ID` selects the shared Product; the global USD Price uses the existing validated resolver, while optional `SIDESTREAM_PRO_INDIA_PRICE_ID` and `SIDESTREAM_PRO_BRAZIL_PRICE_ID` activate their regional catalog entries only after exact Product/currency/amount/one-time validation. The resulting offer snapshot, not current environment, is fulfillment truth. |
| Credit wallet | `SIDESTREAM_DOWNLOAD_CREDITS_ENABLED=1` activates the routes only after the migration gate. The starter grant and video/audio costs are fixed at 1,000 and 100/100. `SIDESTREAM_CREDIT_PACK_PRICE_ID`, `SIDESTREAM_CREDIT_PACK_CREDITS`, and optional `SIDESTREAM_CREDIT_PACK_LABEL` must describe the approved pack before the API advertises `Buy credits`; missing/malformed pack settings keep purchases unavailable. Do not enable a Production pack until its exact price, credits, terms, and refund/dispute adjustment policy are approved and qualified. |
| Stripe lifecycle | Caught processing failures use fixed backoff and dead-letter at attempt 8, but process termination followed by lease reclaim has no claim-side attempt cap and can increment/reclaim indefinitely. A tested total-attempt terminal cap is a Production blocker. Legacy recurring access requires exact comma-separated `SIDESTREAM_LEGACY_SUBSCRIPTION_PRODUCT_IDS` and `SIDESTREAM_LEGACY_SUBSCRIPTION_PRICE_IDS`; `refund.failed` handling/recovery and complete current dispute-status mapping are separate blockers. |
| License continuity | When `SIDESTREAM_LICENSE_HASH_SECRET` is absent, device hashing falls back to the first configured value from `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `POSTGRES_URL`, or `POSTGRES_PRISMA_URL`; the runtime trims/selects and URL-normalizes that connection value first. The Hetzner cutover uses an expiring bearer-protected RSA/AES export to capture those exact normalized bytes and an HMAC proof into a mode-0600 server file without returning plaintext in logs. The target must reproduce the proof before traffic moves; after stabilization the source database password is rotated/revoked so the explicit identity key is not an active database credential. |
| Hetzner API origin | `DATABASE_CUTOVER_MODE` is the reviewed `source`/`fenced`/`target` switch. Target mode requires `SIDESTREAM_HETZNER_ORIGIN_URL` with HTTPS and a path prefix plus `SIDESTREAM_ORIGIN_AUTH_SECRET`; the Node service requires the same secret, `HOST=127.0.0.1` or `::1`, a bounded `PORT`, and `SIDESTREAM_DEPLOYED_SHA`. `npm run build:hetzner-api` compiles the server tree and copies both imported pricing `.mjs` contracts into `.server-dist/config`. Production Postgres still resolves through `SIDESTREAM_POSTGRES_URL`, but only inside the Hetzner service and with a loopback URL plus `POSTGRES_SSL=0`. See `docs/hetzner-production-cutover.md`. |
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

The pricing headline intentionally sits halfway between the bottom of the `.feature-glass` band and the pricing cards: `#pricing` overrides the shared section top padding to `92px`, while `.pricing-head` uses a matching `92px` bottom margin so the cards stay in place. The mobile override uses a matching `74px` top padding and bottom margin. `.pricing-line` keeps "Unlock when you need more." on its own lighter-weight line. The two pricing cards use a larger `28px` corner radius and a pricing-only `IntersectionObserver` that adds `html.pricing-motion-ready` plus `.is-visible` so the cards glide up once before they fully enter the viewport; no global `.reveal` behavior is restored. The $0 card is labeled "Free" and says "3 free downloads every day." The Unlimited plan renders `$19.99 once` as its global fallback and updates to `₹499 once` for trusted India traffic, `R$25 once` for trusted Brazil traffic, or `₩24,900 once` for trusted South Korea traffic; its link still opens `/api/checkout/start`, authenticates the user, and opens Stripe Checkout.

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

For the protected experiment report, start the local Vercel server with the
same explicit Test or Production Postgres target and
`SIDESTREAM_CRM_ADMIN_SECRET`, then call only its loopback boundary:

```bash
npm run report:upgrade-pricing -- \
  --operator alex.ops --namespace test --port 3000
```

Add `--from`, `--through`, and `--as-of` to freeze an observation window. Add
modeled LTV flags only with explicit churn, fee, refund, horizon, and
currency-specific fixed-fee assumptions; modeled values remain separate from
observed realized money.

The renamed-launcher attribution service is deliberately separate from Vercel and public routes. Run its focused test with `npm run test:renamed-launcher-attribution`. For the paired signed-artifact proof, the FlowState harness starts this server with generated local-only secrets and an isolated mode-`0600` ledger. Manual operation requires absolute `SIDESTREAM_LAUNCHER_PROOF_LEDGER`, signing and operator secrets, then `npm run launcher-attribution:server`; never configure or deploy it in Preview or Production.

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

For a private Neon-to-Hetzner copy, follow
`docs/hetzner-database-handoff.md`. After the source is stable and a copy has
been restored to a loopback-only target, compare them without mutation:

```bash
SIDESTREAM_TRANSFER_SOURCE_POSTGRES_URL='<source direct URL with authenticated TLS>' \
SIDESTREAM_TRANSFER_TARGET_POSTGRES_URL='<localhost target URL>' \
  npm run verify:database-transfer
```

Run the same command from the local target to a fresh restore-check database to
prove the backup can be restored. The target must use localhost, SCRAM password
encryption, and the same public schema/data/sequence state. Separately run
`npm run verify:database-port-closed -- --host <public-host-or-ip>` from outside
Hetzner. A parity pass and unreachable public port still do not prove API,
authentication, webhook, scheduled-job, telemetry-routing, or Production
cutover behavior.

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
npm run test:credits
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:postgres-integration
npm run typecheck
npm run build
node scripts/assert-no-runtime-ddl.mjs
node scripts/validate-vercel-contract.mjs
```

Run the complete Customer 360 contract. The Postgres aggregate starts and
removes its own disposable loopback PostgreSQL cluster when no test URL is
selected. A caller may instead provide an approved disposable URL explicitly:

```bash
npm run test:customer-360
npm run test:customer-360-postgres
SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:customer-360-postgres
```

The Postgres aggregate covers identity/merge, currency-partitioned commerce,
once-daily telemetry sync and rolling-window decay, protected list/detail reads,
the protected acquisition/retention funnel, dry-run backfill recovery,
cross-namespace isolation, the fresh Meta-paid bidirectional profile closure,
single-device separation, and end-to-end replay. It scrubs ambient runtime
database selectors and blocks all network destinations except the approved
disposable Postgres endpoint. Local self-provisioning requires `initdb` and
`pg_ctl` on `PATH`; an explicit URL retains the runtime-target collision guard.

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

For paid activation linkage and Customer 360 exact-Checkout selection, run the
focused integration gate:

```bash
node --experimental-strip-types --test \
  tests/paid-onboarding-claim.test.mjs \
  tests/paid-acquisition-integration.test.mjs \
  tests/customer-360/query-api.test.mjs
npm run verify:checkout-contract
```

These checks prove only source and deterministic fixture contracts. They do
not enable `/mc`, apply a migration, contact a live provider, send or deliver
paid email, publish or retrieve an installer, make a payment, authenticate
Google, load Premiere, query live Customer 360 or telemetry, deploy, or prove
Production. Final release qualification must follow one fresh Meta-paid
acquisition only after the guarded live zero-state, Production-only local reset,
and clean-browser gates pass. It must continue through the receipt-gated paid-onboarding artifact, a loaded
Premiere panel showing `onboardingChannel=paid-onboarding`, authenticated
Google restore, Customer 360 `installation_claimed=1` with
`verified_installation_claim`, and a later telemetry event on that same install
identity. Evidence from separate journeys cannot be combined.

The fresh Meta-paid operator commands are:

```bash
npm run fresh-paid:reset -- --branch-name '<deployed-name>' --branch-id '<br-id>' --endpoint-id '<direct-ep-id>'
npm run fresh-paid:reset-local
npm run fresh-paid:preflight -- --branch-name '<deployed-name>' --branch-id '<br-id>' --endpoint-id '<direct-ep-id>' --connected-target-fingerprint '<sha256>'
```

All three fail closed and the first two are dry-run-first. The remote reset is
Production-only, requires a separately created verified child recovery branch
and exact apply confirmations, and reports counts/fingerprints rather than live
identifiers. Its endpoint inventory uses the authenticated Neon
`api /projects/<project-id>/endpoints` surface because CLI 2.37.1 has no
supported `endpoints list` command; only `{id, branchId}` is retained for
matching. The local reset discovers exact
`PPRO_<version>_com.sidestream.downloader.panel` caches under the original
user's `~/Library/Caches/CSXS/cep_cache`, preserves all other cache names and
both `Sidestream Test` / `com.sidestream.downloader.test` bundle forms, and
moves only Production CEP, receipt, license, onboarding, and telemetry state
into a mode-`0700` recovery backup. Administrator apply must run through
`sudo` from the original non-root login: an attested non-root `SUDO_USER` home
owns user paths, and direct root or root-home fallback fails closed. Apply asks
Premiere to quit normally, then may terminate only a remaining exact Production
`CEPHtmlEngine` for `com.sidestream.downloader.panel`; a surviving exact blocker
stops before backup creation. The post-auth preflight is read-only and must
return `GO` / `download-may-begin`
before the first in-panel media download; its separate raw-telemetry mode runs
after exactly one download. Do not infer the apply forms or order from these
short examples. Follow `docs/paid-acquisition-runbook.md`, which owns the exact
recovery, confirmation, zero-state, browser-rotation, and telemetry procedure.

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

The project is linked to Vercel project `alex-3685s-projects/sidestream`. `.vercel/`, `.env.local`, and other `.env*` files are ignored. A release must first run `npm run release:upload-hetzner -- --artifact <local file> --pathname sidestream/<version>/<filename>`; the root-only finalizer hashes the uploaded temporary file, verifies size/SHA, atomically renames it, and refuses different bytes at an existing immutable pathname. Only then run `npm run release:publish-manifest` with the normal platform/version/signing gates. Publishing defaults to `--provider hetzner` and machine-verifies the remote filename, size, and SHA before changing the manifest; the explicit Blob rollback path additionally requires `--provider blob --uploaded`. Never lie by passing `--signed` for an unsigned Windows build. Agent releases fast-forward verified commits onto `origin/main` and rely on the Git-linked Production deployment; `npm run deploy:production` is owner-only emergency recovery after deliberate human reauthentication. Keep bare `/api/download` on the native/base Mac DMG and keep `.vercelignore` aligned with tracked publishable media.

`vercel.json` deliberately pins `installCommand`, `buildCommand`, and `devCommand` to npm. The dev command must pass Vercel's `$PORT` into Vite; otherwise `vercel dev` can accept connections on its proxy port and hang. If the Vercel dashboard still has an old package-manager preference, the repo config should win. Vercel's host-based `has` matching works after deployment but not in `vercel dev`, so use a preview/production deployment plus `curl -I` to prove the `www` redirects and the non-API `sidestream-xi.vercel.app` redirects. The old host intentionally continues to serve `/api/*` in place because installed Sidestream 1.0.12 panels POST to that origin and do not follow Vercel's `308` response.

## Testing Guide

- Run `npm run test:renamed-launcher-attribution` after changing the local claim ledger or proof server. It proves exact acquisition-to-claim-to-binding-to-receipt/install continuity, idempotent same-attempt retries, raw-claim exclusion from the ledger, durable expiry, and fail-closed reuse/filename/release/platform/receipt/install mismatches. Then run FlowState's `npm run proof:renamed-launcher-attribution` for the signed launcher, Gatekeeper, stapling, byte-identity, handoff, isolated package-postinstall, and first-open transport boundaries. Neither harness proves a privileged system install, a Premiere-loaded panel, public delivery, or Production.

Use the narrowest relevant check after edits:

- Open the HTML page and check that the first fold intentionally places the hero copy lower than the older `Sidestream front end 2/screenshots/01-scan.png` reference.
- Run `npm run test:api` after any API, shared helper, migration, cron, or handler-contract change. Run `npm run test:postgres-integration` with a disposable `SIDESTREAM_TEST_POSTGRES_URL` after any database/concurrency change; it must never target production or a deployed Test database.
- Run `npm run test:postgres-transfer` after changing the Hetzner handoff, source/target selector guards, parity catalog, content fingerprints, target network/password posture, or external-port probe. Before any real database cutover, require a live `npm run verify:database-transfer` PASS for the stable source/localhost target, a second PASS for target/restore-check, source-matching checksummed Website migration status with every pending file called out, and an outside-Hetzner `npm run verify:database-port-closed` PASS. None authorizes traffic changes or provider shutdown.
- Run `npm run test:credits` after changing credit pack configuration parsing, the credit helper, routes, Stripe fulfillment, or schema. Pair it with `npm run test:license-entitlement` in FlowState for client sync/reserve/finalize/purchase and fail-closed rendering contracts. The source-level suite is not a live database, Stripe payment, migration, or Premiere proof.
- Run `npm run verify:checkout-contract` and `npm run test:entitlement` after checkout, authentication, activation-claim, account, or Stripe fulfillment changes. The source verifier proves the exact Upgrade, Google authentication, and Stripe sequence, the root-page allowlist, and both valid zero-total Stripe statuses.
- Run `node --experimental-strip-types --test tests/checkout-offers.test.mjs tests/checkout-abuse.test.mjs` after regional catalog, trusted-country, Checkout-intent snapshot, Price reuse, or fulfillment-approval changes. The focused suites cover global and India purchases, ignored browser-forged regional inputs, cross-region Price mismatches, catalog changes during an open Session, concurrent/reused Sessions, failed Stripe verification, exact account metadata, and zero-total promotions.
- Run `node --experimental-strip-types --test tests/upgrade-pricing-experiment.test.mjs tests/upgrade-pricing-checkout.test.mjs tests/upgrade-pricing-lifecycle.test.mjs tests/upgrade-pricing-report.test.mjs tests/upgrade-pricing-integration.test.mjs` after authenticated Upgrade experiment changes. Then run the disposable-Postgres report, Checkout abuse/concurrency, Customer 360 Upgrade, and aggregate Postgres suites. These prove account stickiness/balance, exact recurring catalog amounts and lookup terms, shared paid-eligibility locking, immutable snapshot/exposure lineage, first-class subscription truth and lifecycle, activation-over-exposure denominators, currency isolation, privacy, acquisition continuity, and exact v1.0.11 activation lineage. They do not prove a provider payment, deployed webhook, installed CEP root, or rendered dashboard.
- Run `npm run pricing:check` after any offer edit. It checks generated website, JSON-LD, crawler, and paid-landing fallbacks against `config/pricing-contract.mjs`, verifies Free/global/India/Brazil/South Korea definitions, and simulates a different global price to prove stale public surfaces are detected. Use `npm run pricing:sync` to regenerate those derived files before review.
- Run `node --test tests/reset-alex-upgrade-state.test.mjs tests/reset-local-production-for-paid-test.test.mjs tests/fresh-paid-test-handoff.test.mjs` after changing any fresh Meta-paid reset/handoff operator. The suite must prove the explicit non-`main` Production branch/direct-endpoint fingerprint, separate child recovery prerequisite, exact apply confirmations, sanitized reports, one legal bidirectional recursive profile reference, complete fixed-QA closure and ownership refusals, anonymous paid-event preservation, financial/unrelated-data invariants, second-inventory zero state, reversible Production-only local backup including the system installer receipt, and exact post-auth/raw-telemetry STOP/GO decisions. Also run `npm run test:customer-360-postgres`; its isolated-schema regression executes the real inventory and apply paths, proving ancestor/descendant closure, profile-owned historical activation/deleted-Customer license closure, exact-acquisition retry-intent closure, foreign-account refusal, unrelated-row and anonymous-event preservation, and stable replay. These fixtures neither touch nor prove live state.
- Because the fresh Meta-paid operator crosses authentication, payment, identity, deletion, Customer 360, and telemetry boundaries, every change to it requires the focused suite above plus `tests/paid-acquisition-integration.test.mjs`, `npm run test:paid-acquisition-e2e`, both acquisition journey matrix modes, `npm run test:customer-360-postgres`, `npm run verify:checkout-contract`, `npm run test:entitlement`, `npm run test:api`, `npm run test:migrations`, `npm run typecheck`, `npm run build`, and `git diff --check`. The Customer 360 Postgres aggregate self-provisions loopback PostgreSQL when its test URL is absent. Supply only a disposable loopback `SIDESTREAM_TEST_POSTGRES_URL` to other Postgres-requiring aggregates or when overriding that default; never use Production or deployed Test. Passing this matrix proves repository/fixture behavior only, not a live reset or readiness to begin Checkout/download.
- After changing the mobile handoff, run the focused `tests/download-leads.test.mjs` suite, then verify at a realistic phone width that the two initial actions replace both platform buttons, “Enter your email” reveals and focuses the inline form, invalid email stays local, successful share/copy feedback replaces the direct-send button label without adding a line, and lower download CTAs reveal and scroll back to the email form. At desktop width, confirm the handoff is hidden and both direct platform downloads remain unchanged.
- Run `node scripts/assert-no-runtime-ddl.mjs` and `node scripts/validate-vercel-contract.mjs` after API/migration/routing work. For a human Vercel build, follow `npx vercel@latest build` with `npm run verify:vercel-build`.
- At `430×932`, confirm both feature cards select their hashed 1200×720 mobile MP4s; above `900px`, confirm they select the hashed 1800×1080 desktop MP4s. In both cases the lossless poster must be visible before playback, disappear only after `playing`, and remain visible if `play()` is rejected. Confirm each video prewarms before it enters the viewport, starts playing when scrolled into view, and pauses again after leaving view.
- At `430×932` and a short-height mobile viewport, confirm `pryt.png` remains centered in the open hero space above the headline, uses the exact standard `min(79.488vw, 311.04px)` and short-height `min(70.848vw, 276.48px)` widths, stays hidden above `900px`, and does not push the handoff below the first fold.
- Run `TZ=America/Los_Angeles node --experimental-strip-types --test tests/customer-360/core.test.mjs` after Customer 360 identity or profile-merge changes, then run `node --experimental-strip-types --test tests/customer-360/core-postgres.test.mjs` for the database total-order contract.
- Run `node --experimental-strip-types --test tests/customer-360/commerce.test.mjs` after commerce normalization changes, then run `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' node --experimental-strip-types --test tests/customer-360/commerce-postgres.test.mjs` after payment-group, identity-link trigger, allocation-edge, or totals changes. The Postgres suite proves partial capture authority, Checkout-only and paid-Invoice fallback replacement, paid InvoicePayment overlap deduplication with an unrelated-Checkout negative control, fully and partially off-Stripe totals, verified fallback dates, modern paid/open InvoicePayment shapes, many-to-many allocations, refund-first late attachment, product scope, and whole-group quarantine.
- Run `npm run test:customer-360`, then `npm run test:customer-360-postgres`, after any Customer 360 contract, identity, commerce, usage, query, migration, or backfill change. Confirm the self-provisioned loopback cluster is removed, an explicit test URL still rejects runtime/telemetry endpoint collisions, protected list/detail fields match `docs/customer-360.md`, dry-run makes no connection or checkpoint write, and the complete pipeline leaves entitlement/single-device state unchanged.
- Run `npm run test:customer-360`, `npm run test:acquisition-journey-matrix`, `npm run verify:checkout-contract`, and `npm run test:entitlement` after acquisition/retention documentation or contract changes. For schema/query/concurrency behavior, also run `npm run test:customer-360-postgres` and `SIDESTREAM_TEST_POSTGRES_URL='<disposable-postgres-url>' npm run test:acquisition-journey-matrix-postgres` against disposable databases. Confirm first-install and first-purchase selectors remain independent, signed cursor filters cannot be changed between pages, all ten stage grains deduplicate, exact Stripe lookup stays privacy-safe, historical nulls are never inferred, and deterministic first-write contention converges without quarantine.
- Keep `tests/acquisition-route-coverage.test.mjs` in the API suite. It must inventory every public handler, fail on an unclassified new route, and prove that the free installer and receipt-gated paid artifact are the only HTTP installer-delivery boundaries. The internal paid Blob signer must remain under `api/_lib/`; do not recreate an anonymous `/api/paid-download` route.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- Run `npm run test:download-referral` after changing installer attribution or `/api/download`. It verifies that tagged `GET`s are recorded only after a successful redirect, while `HEAD`, `304`, bad platforms, fulfillment errors, database errors, and database timeouts cannot create a false successful event or block delivery.
- Run `npm run test:installer-delivery`, the download and paid suites, `npm run build:hetzner-api`, and an Nginx configuration test after changing installer providers, signing, manifests, byte serving, release upload/finalization, or rollback. Live qualification must cover valid free and receipt-gated paid flows, one-byte Range, expired/changed/unsigned/traversal rejection, full-file SHA, exact Vercel/Hetzner SHA parity, and privacy-minimal logs.
- Run `npm run test:referral-visits` after changing `/manychat-instagram`, `/m`, `/mc`, `/api/referral-visit`, the ManyChat browser hook, private-Blob referral storage, or its report. It verifies the dedicated and legacy route forms, both allowlisted sources, bounded request body, response-before-storage behavior, source-separated daily anonymous dedupe inputs, scanner separation, and hash-free aggregate output.
- After changing paid `/mc`, `/meta-default`, or `/meta-paid` routing, the generated paid landing, paid Checkout/email/artifact/claim handlers, the entitlement bridge, or the paid schema, run `node --experimental-strip-types --test tests/paid*.test.mjs`, `npm run test:paid-acquisition-e2e`, `node scripts/verify-paid-acquisition-e2e-fixtures.mjs`, the focused Customer 360 acquisition-funnel tests, `npm run test:entitlement`, and `npm run typecheck`. For activation-linkage diagnostics or exact Stripe-reference acquisition selection, also run `node --experimental-strip-types --test tests/paid-onboarding-claim.test.mjs tests/paid-acquisition-integration.test.mjs tests/customer-360/query-api.test.mjs` plus `npm run verify:checkout-contract`. The Meta routing proof must show deterministic default/paid selection, fixed server-owned Meta dimensions, a fresh journey when the selected variant changes, and no random assignment on either Meta path. The paid-onboarding suite must prove exact raw-source selection, server-side stored-source revalidation, support-only no-entitlement HTML, reuse of the existing CSRF/device policy, bounded outcome-only diagnostic logging, and no reusable identity material. Recheck that ordinary signed-in Free-account Checkout still redirects directly to Stripe, uses its server-selected stored offer and full request fingerprint, and that `/m`, root, free download, account, activation, and all non-exact `/mc` redirects are unchanged.
- After changing the guarded paid-telemetry selector, run the default, pending-review, reviewed-path, legacy-entitlement, unowned-commerce, and `npm run replay:paid-telemetry-handoff -- --expect-missing-current-customer-repaired` disposable modes. The fifth replay must prove exactly one verified zero/unowned Checkout fact becomes the one positive attached survivor fact with paid/upgrade timing from paid completion and refreshed totals. The sixth must prove the exact Checkout/account `cus_` link alone is inserted on the already-proven survivor, exact Customer lookup converges, older customer history remains, prior merge/stage/claim/binding/commerce rows do not change, and replay is a no-op. Mismatched/invalid Customer values, competing links/owners/reviews/aliases, and every earlier identity, commerce, lifecycle, binding, and path conflict must refuse atomically.
- After changing paid funnel selection, run both focused acquisition-funnel suites plus all six paid-telemetry replays. The seventh boundary must prove one immutable exact binding selects Meta/social/`sidestream_direct_offer_test`, `exact_paid_checkout`, `intact`, `paidCustomer=true`, attributed `1/1`, exact paid `1/1`, and unknown `0/1`; older paid candidates remain unchanged, no-binding profiles keep the established stable fallback, and multiple exact bindings fail to unknown.
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
- Confirm both desktop hero platform links use the visible label `Download`, matching white pills, and their respective Apple and Windows marks; expose explicit platform-specific accessible names, start the correct installers without opening either historical modal, and retain the shared red hover treatment. At `900px` and below, confirm those links are replaced by the “Enter your email” and “Send it directly to your computer” choices instead of stacked installer buttons.
- Watch the pricing MacBook rotation long enough to confirm the laptop stays centered and the alpha edges are not clipped by the pricing wrapper.
- Confirm the Search demo group starts below the first fold with a deliberate gap between the hero download CTAs and the "Search for YouTube videos." heading on desktop and mobile.
- Confirm the "Start free. Unlock when you need more." headline sits centered in the vertical space between the bottom of the `.feature-glass` band and the pricing cards.
- Confirm "Unlock when you need more." renders as the lighter-weight `.pricing-line`, while "Start free." stays heavier.
- Scroll down to pricing and confirm both pricing cards begin animating before the section feels empty, with the Unlimited card following the Free card by a slight stagger, both cards using visibly rounder 28px corners, and the Unlimited card using a white outline with no drop shadow.
- Confirm the Free card says "3 free downloads every day."
- Confirm the Unlimited card says `$19.99 once` globally, `₹499 once` from genuine India egress, `R$25 once` from genuine Brazil egress, and `₩24,900 once` from genuine South Korea egress, while always linking to `/api/checkout/start`. Verify `/api/checkout/offer` is private/no-store, browser query parameters cannot select a region, and the browser sequence remains Upgrade button, Google authentication, Stripe payment. Use a Free account without an already-open locked Checkout intent when comparing the landing price to a newly created Stripe Session.
- Confirm the feature demo videos are paused before they enter the viewport, start playing when scrolled into view, and pause again after leaving view.
- Confirm accessibility audits do not report prohibited ARIA attributes: named `.shot` and `.pricing-mockup` visuals use `role="img"`, and the named Unlimited plan card uses `role="group"`.
- Confirm the Search and Preview feature sections have no inline download buttons, while the heading and subtext blocks stay vertically centered beside their demo videos on desktop and mobile.
- Confirm the `.feature-glass` backdrop spans the full x-axis behind the Search and Preview demo sections, blurs/darkens the shader behind it, and stays in its normal post-hero position.
- Confirm the decorative `.feature-corner-demo-video` keeps the visible Premiere panel's compensated top-left anchor within `1px` of `45vw 25vh` at multiple desktop window sizes, revealing more of the recording's lower and right edges while playing with `screen` blend and `0.9` opacity, keeping `.feature-glass` unmoved, and remaining hidden and paused at `900px` and below.
- Confirm the top and bottom `.feature-glass` separator lines leave enough vertical breathing room around the first Search demo video and last Preview demo video.
- Confirm hovering each feature demo video tilts the frame subtly from its center, with the top-right pointer position pushing the top-right corner away from the camera, no top-left corner-entry jitter, a smooth S-curve reset on exit, and no hover tilt on reduced-motion or coarse-pointer devices.
- Confirm bare `/api/download` responds to `HEAD` with the current Mac attachment and `/api/releases/latest` returns the matching Mac manifest. Confirm `?platform=win32-x64` returns the Windows EXE/manifest, both Windows manifest links point at the platform route for v1.0.12 compatibility, and an unknown platform returns `404`. Confirm `GET` redirects to `downloads.sidestream.tv`, the signed URL contains only expiry/signature authorization, and `curl -L -r 0-0` returns one byte with `206`. A full transfer and SHA check are still required before declaring the new byte path live.
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

- The renamed-launcher server and ledger are Test/local fixtures, not deployable APIs. They bind loopback only and reject Production environment markers. Do not move these routes under `api/`, configure them in Vercel, place claims in URLs/logs/receipts, or treat automated isolated-root postinstall as a macOS administrator-authorized install or real Premiere first open.
- A Vercel Production deployment can be Ready while originating from stale source. Production source is only the fast-forwarded `origin/main` lineage linked to `alex-3685s-projects/sidestream`. Agent sessions must not retain Vercel CLI authentication or run direct Production deployments; push verified `main`, then require canonical `/version.json` to report that exact SHA and verify the live Checkout redirect. `npm run deploy:production` is owner-only emergency recovery after deliberate human reauthentication.
- Disposable local tests prove source behavior only. They do not prove a live Google redirect/callback, Stripe object metadata or payment lifecycle, Neon migration/role state, Resend delivery, Vercel deployment/configuration, browser cookie continuity, or loaded Premiere behavior. Verify each requested live surface separately before claiming it passed.
- The paid `/mc` foundation is default-off, unlinked, and additive. Missing `SIDESTREAM_PAID_ACQUISITION_ASSIGNMENT_SECRET` must continue to fall back to the canonical ManyChat destination, and paid provider delivery must remain off unless `SIDESTREAM_PAID_ACQUISITION_EMAIL_ENABLED=1`. Do not configure either setting, apply the paid migration, publish paid artifacts, or deploy from this documentation alone. Paid Checkout must use the same trusted-country offer selection and immutable snapshot as ordinary Checkout; never restore a separate paid-acquisition amount or currency assumption.
- Paid activation `source` is only a strict UX selector. Exact `paid-acquisition-mc-v1` returns `/api/activation/paid-claim`; whitespace, casing, or any other source remains on `/api/activation/claim`. The dedicated handler also requires that exact stored source, but only the authenticated account's active Unlimited entitlement and existing device policy can authorize connection.
- `/mc-preview` is the deterministic desktop review surface for the otherwise phone-only 50/50 `/mc` experiment. Keep it unlinked and noindex; it intentionally replaces an existing control assignment with a signed paid assignment so the same browser can exercise the real paid Checkout boundary.
- `/meta-default` and `/meta-paid` are deterministic ad destinations, not an on-site randomizer. Keep both unlinked and noindex. A valid journey from either path deliberately supersedes the browser's previous acquisition cookie unless it already belongs to the same Meta variant; switching variants starts a new canonical acquisition UUID so the latest explicit ad click owns a later Checkout while prior roots remain immutable. `/meta-paid` must fail closed rather than show the default page when signing is unavailable.
- Keep every `middleware.ts` `config.matcher` entry as a literal string. Vercel's middleware compiler rejects identifier references there even when the standard TypeScript/Vite build succeeds; `npx vercel@latest build` is the regression check.
- Customer 360 captured money authority is the PaymentIntent `amount_received`, or `amount_captured` on a standalone Charge when no PaymentIntent exists. A paid Checkout or Invoice is a fallback only while its related settled instrument is absent, and refresh must replace rather than add that fallback when stronger truth arrives. Before instrument arrival, suppress a Checkout fallback only when a paid Invoice fact in the same namespace, profile, and currency has a paid InvoicePayment edge resolving to that Checkout payment key; prefer the Invoice and leave unrelated Checkout fallbacks countable. Checkout authorization must never re-inflate a partial capture. Invoice `amount_paid` is full gross customer money; `amount_paid_off_stripe` is a nonnegative subset of gross, not a deduction or an amount to add twice. Paid InvoicePayment rows are allocation edges keyed by `invoice_payment.id`; open/canceled rows do not attribute money, and an invoice/instrument many-to-many graph must not become alias equivalence.
- Customer 360 identity safety is a payment-group invariant. If any retained alias, trusted identity evidence, or already-safe owner resolves one canonical payment group to different live profiles, the namespace advisory lock must clear `profile_id` and set `identity_conflict=true` on every materialization in that group before totals refresh. This whole-group quarantine is sticky across replay, later one-owner rows, and identity-link triggers; only an explicit group-wide recomputation after a deterministic profile merge may clear it. A Stripe customer link alone never scopes unrelated product money.
- Customer 360 database `created_at` values reach TypeScript as fixed-width six-microsecond UTC timestamps without a timezone suffix. Compare two canonical values lexically before `Date.parse`; parsing first treats them as local time, can reverse order across a DST gap, and violates the database trigger's `(created_at, id)` total-order contract. ISO inputs from pure callers still use parsed instant ordering, and equal timestamps still use the UUID tie-breaker.
- Customer 360 currently has no deletion or aggregate-expiry job. Daily usage buckets, canonical profiles/identity, and commerce materializations persist; merge and identity-review audits are immutable. Do not claim a retention period until a separately reviewed implementation enforces one. Stripe payload redaction and the 90-day installer-referral policy are separate domains.
- Customer 360 Production qualification is current as of 2026-08-01 and is recorded in `docs/customer-360.md`. Future changes still require the same Preview/Test-first, protected-backup, fingerprinted-operator, no-delete, authenticated-API, rendered-dashboard, and canonical-deployment proof; a route response, row, dry-run, build, or Ready Preview alone is never enough.
- FlowState's live Customers tab consumes the protected Production API only through its loopback Node proxy. Vercel cannot enable only the usage job: the deployed schedule is a reviewed four-job set, with Customer 360 usage sync at `05:27` UTC.
- Source-segmented retention is an attribution subset, not the overall customer base. Exact paid Checkout wins over exact anonymous browser-to-install claim, which wins over exact verified-account/profile-email evidence; every other install remains unknown. Never infer source from timing, IP, user agent, referrer, nearby events, or approximate identity, and never remove unknown installs from overall stickiness, which uses all install IDs.
- Historical usage rows created under the former broad non-installer activity rule do not become exact merely because code changed. The 2026-08-01 version-2 full rescan is the qualification baseline; future aggregator changes must run the same source/target-bound, mode-`0600`, append/update-only replay and prove its no-op rerun before historical retention is trusted again.
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
- Pricing headline placement is tuned independently from shared `.sec-pad`: `#pricing { padding-top: 92px; }`, `.pricing-head { margin-bottom: 92px; }`, and the mobile override uses matching `74px` top and bottom spacing. `.pricing-line` is intentionally `font-weight: 300`. The Unlimited card links to `/api/checkout/start`; `$19.99 once` remains the static global/SEO fallback, while the page replaces only `[data-checkout-offer-price]` from the private/no-store `/api/checkout/offer` response. Checkout truth still comes independently from `api/_lib/checkout-offers.ts` plus the stored intent snapshot, and no value returned to the browser is accepted back as a Checkout selector. The compatibility-named async `getSidestreamProPriceId()` resolves the global catalog's exact `1999` USD amount by validating configured/default Price IDs as non-authoritative hints, then checking the expanded Product `default_price`, exact `sidestream_pro_once_1999` lookup key, and any other active matching Product Price before its idempotent create fallback. India, Brazil, and South Korea use only their configured regional Price IDs and require exact Product/currency/amount/one-time validation; they never create Prices. A stale or deleted global configured Price may fall through; an explicitly configured invalid regional Price fails closed. The public tier name is Sidestream Unlimited, while existing `SIDESTREAM_PRO_*`, `sidestream_pro`, and historical lookup-key identifiers remain stable for purchase compatibility. Change the canonical contract, run `npm run pricing:sync`, provision new immutable Stripe Prices, update regional environment IDs, and run the pricing/checkout/entitlement gates together. The pricing-card motion should stay scoped to `#pricing .plan.reveal`, use an early positive bottom `IntersectionObserver` margin, and avoid re-enabling global `.reveal` because it was previously disabled for environment fill-mode issues.
- Authenticated Upgrade assignment is account-permanent, not browser-sticky. The 50/50 rollout ended on 2026-08-21; `UPGRADE_PRICING_EXPERIMENT_CONFIG.closedAt` now forces the observable one-time `kill_switch` fallback for every future unassigned account even if stale Production environment values still say enabled/`5000`. Existing assignments, open Sessions, subscriptions, entitlements, and audit history remain immutable and supported. The historical global recurring offer is `$4.99` (`499`) via `sidestream_pro_monthly_usd_499`, and the legacy `monthly_half` variant name remains stable for persisted history and lifecycle handling. Reopening assignment requires a reviewed source change and new Production deployment; environment changes alone cannot restart the test. See `docs/upgrade-pricing-experiment.md` before changing this closure, Price IDs, webhooks, or lifecycle.
- Stripe experiment metadata uses the stable `sidestream_upgrade_*` key namespace; every key must remain at most Stripe's 40-character limit. Database snapshot column names are intentionally longer and are not provider metadata names.
- Current Stripe invoice resources put subscription ancestry under typed `parent.subscription_details` and `parent.subscription_item_details` objects and replace the Invoice `paid` boolean with the Invoice Payments ledger. The experiment validator supports that provider shape plus the historical top-level fields, but never accepts an untyped or wrong-parent subscription reference; current settlement additionally requires one exact paid Invoice Payment and successful expanded PaymentIntent with matching Invoice, Customer, namespace, currency, and amounts.
- Maintenance never deletes a Checkout intent with an Upgrade pricing snapshot. Assignment, opened-Session exposure, immutable commerce terms, activation/acquisition lineage, and reporting denominators are permanent experiment audit evidence even after the ordinary Checkout-intent retention window.
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
- Local account/billing testing requires Vercel dev plus local/test Postgres and Stripe configuration. `SIDESTREAM_LICENSE_HASH_SECRET` must be stable and server-only; when absent, device hashing falls back to the first configured runtime URL after selection and URL normalization. The guarded Hetzner workflow in `docs/hetzner-production-cutover.md` now provides the byte-preserving encrypted capture and proof boundary for that one migration; it does not authorize an arbitrary URL/pool change or replace a real device/token canary before promotion. `SIDESTREAM_PRO_PRODUCT_ID` defaults to `prod_UpwXh6oO1OmPyQ`; global runtime Price discovery treats `SIDESTREAM_PRO_PRICE_ID`, the empty code default, and compatible Unlimited ID as validated hints, then checks Product `default_price`, exact `sidestream_pro_once_1999` lookup key, and any other active matching Product Price against the catalog's exact USD `1999` amount. Stale/missing global hints fall through to discovery or idempotent creation instead of causing a customer-facing 500. Regional truth is explicit: `SIDESTREAM_PRO_INDIA_PRICE_ID` must be active one-time INR `49900`, and `SIDESTREAM_PRO_BRAZIL_PRICE_ID` must be active one-time BRL `2500`, both attached to the same Product. Invalid configured regional truth fails closed; absence safely uses the global fallback. Runtime compatibility is not Production approval. Use placeholders for local Stripe testing and rotate any secret pasted into chat.
- Free credits are installation-wallet scoped because the Free CEP flow does not require account sign-in. The server stores only the HMAC-hashed channel-specific device identity; the high-entropy raw device ID acts as the wallet credential over TLS and must never be logged or placed in Stripe metadata. Clearing/replacing that identity creates a distinct starter wallet, so this model centralizes balance truth and cross-launch durability but is not an account-level anti-abuse boundary. Unlimited remains account-scoped and database-backed. The service flag and pack settings are intentionally absent by default; do not enable Production before the migration or add a pack before the exact refund/dispute adjustment policy is approved.
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
- Hosted Checkout only accepts promotion codes that already exist in the same Stripe account and mode as `STRIPE_SECRET_KEY`. The field appears only on newly created Sessions whose request includes `allow_promotion_codes`; an already-open Session does not gain it after deployment. For subscriptions, the underlying coupon's `once`, `repeating`, or `forever` duration controls whether only the first Invoice or later renewals are discounted. The repo utility `npm run billing:ensure-freedev` creates or verifies the sandbox `FREEDEV` 100% off promotion code and refuses live keys unless `--allow-live` is passed intentionally. If Stripe Checkout says `FREEDEV` is invalid, first confirm the Checkout page is in sandbox mode, then run the utility with the same env file that powers that deployment. Vercel protected env pulls can return `STRIPE_SECRET_KEY=""`; in that case, use an ignored local env file through `SIDESTREAM_STRIPE_ENV_FILE`.
- Plain static servers such as `python -m http.server` do not compile `/src/main.tsx`, so the static HTML route can appear to lose the Paper shader background even though the markup is correct. Static servers also cannot serve local Vercel Functions; the visible download CTAs use the public Vercel download URL so static preview clicks still start the installer instead of hitting a local `/api/download` 404. Use Vite on the active preview port when visual-checking the background, and Vercel dev when testing the API routes themselves.
- Vercel Analytics depends on the compiled React entry in `src/main.tsx`. If analytics stops appearing, confirm the shader root still exists in the canonical HTML, the deployed bundle includes `@vercel/analytics/react`, the page was visited on the deployed Vercel URL, and content blockers are disabled for the check.
- Vercel CLI versions before the current `54.x` line can report stale Blob auth/token errors. Prefer `npx vercel@latest ...` for Blob store checks.
- `/api/download` never streams installer bodies. In Hetzner mode it signs a manifest-selected pathname and Nginx performs the internal static transfer; in rollback mode it uses Blob control-plane signing. A broken `GET` can still look healthy if only `HEAD` is checked, so always follow a signed redirect with Range and complete-file verification.
- Installer attribution deliberately measures successful signed-redirect requests, not completed Blob transfers. Email security scanners can issue `GET`; keep their rows and use `likely_scanner` as a transparent heuristic. Do not label request counts as downloads, installs, first opens, or active users.
- `SIDESTREAM_INSTALLER_ANALYTICS_HASH_SECRET` is a stable server-only HMAC secret for privacy-limited daily request deduplication. Preserve it across database credential rotations, never expose it in browser or CEP code, and never store the raw request IP or user agent in `sidestream_installer_requests`.
- Keep per-request installer attribution only as long as launch analysis needs it. Preserve aggregate campaign totals if useful, then delete the request rows after 90 days so the anonymous HMACs do not become an indefinite behavioral history.
- Without `vercel.json`, `vercel dev` may inherit a Yarn command from the Vercel project settings and hang on machines without Yarn.
- Vercel's path redirect patterns do not match the bare `/` request. Keep the explicit host-conditioned `/` rules for `www.sidestream.tv` and `sidestream-xi.vercel.app` ahead of the path-preserving catchalls; keep the old-host path rule narrowed with `/:path((?!api/).*)` so static pages canonicalize while legacy CEP POST APIs execute without a `308`.
- `.vercelignore` deliberately strips `.git` before Git-linked builds. The sitemap generator therefore resolves `index.html`'s most recent commit through Vercel's `VERCEL_GIT_*` metadata and GitHub's public commits API; it fails the build instead of publishing an invented date when that provenance lookup is unavailable.
- The private Blob store currently has OIDC/env wired for Preview and Production. Development has `BLOB_STORE_ID` and the installer pathname, but local Blob reads still need Development OIDC enabled in Vercel Blob settings or a `BLOB_READ_WRITE_TOKEN`.
- Check the Vercel Blob/CDN usage guardrails and live Pro usage before changing installer artifacts, `/api/download`, CTA/email-gate volume, or demo media. The current Mac artifact is about 217 MiB. After a Hetzner cutover, keep the Blob artifacts intact for 14 days and compare daily Blob/CDN usage with Nginx bytes, status, latency, disk, CPU, and memory before considering any installer-object cleanup.
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

- 2026-08-24: Added provider-neutral installer delivery with a five-minute manifest-bound Hetzner HMAC path, loopback authorization plus Nginx internal static serving, exact immutable upload/finalization and pre-manifest verification, privacy-minimal transfer logs, focused tamper/expiry/traversal tests, dry-run-first Blob rollback, and a 14-day migration runbook. Public, updater, mobile-email, paid receipt, and acquisition boundaries remain on their existing Sidestream routes.
- 2026-08-24: Reconciled the static Vercel route validator with the already-completed removal of the one-time Hetzner secret-export route, so the protected-route inventory again matches the ten deployable internal routes.
- 2026-08-22: Completed the Website and telemetry database cutover to private Hetzner PostgreSQL, removed the temporary encrypted runtime-export handler after capture, and retained Neon only as a credential-rotated rollback source.

- 2026-08-22: Promoted Website API routing to the authenticated Hetzner target only after the fenced direct-Neon snapshot and an independent target backup/restore-check both matched all 13 schema sections, all 32 source-applied migration checksums, all 52 tables, and all 1,437,816 rows. The source-matching download-credits migration remains intentionally pending; no migration was applied or baselined during cutover.

- 2026-08-22: Added the documented two-database Hetzner cutover boundary: complete writer inventory, source/fence/target Vercel routing, protected loopback Website API service, expiring encrypted runtime-secret transfer with exact license-hash continuity proof, focused routing/security tests, fail-closed target configuration, and a server build that carries the two imported pricing `.mjs` contracts.

- 2026-08-22: Added the copy-only Hetzner database handoff plus provider-neutral, read-only source/localhost-target parity verification. The verifier compares public catalog structure, exposed browser-role grants, migration checksums, order-independent whole-table content fingerprints/counts, sequences, and loopback/SCRAM target posture; a separate outside-server probe fails if public PostgreSQL accepts a connection. Neon `channel_binding=require` URLs enable the Node PostgreSQL client's native channel-binding option, and long read-only snapshots use the direct non-pooler endpoint because transaction-pooler startup options are incompatible. Focused tests and a real disposable PostgreSQL dump/restore pass prove the tooling contract. No Production data, traffic, DNS, telemetry routing, provider configuration, or server state changed.

- 2026-08-21: Ended the authenticated recurring-versus-one-time Upgrade experiment and retained one-time for every future unassigned account. A source-level closure now forces the existing observable `kill_switch` fallback even if stale Production environment values still request the former 50/50 rollout; existing assignments, Checkout Sessions, paid subscriptions, entitlements, lifecycle processing, and permanent experiment evidence remain unchanged.

- 2026-08-19: Published the signed, notarized, and stapled standard Mac `1.0.19` emergency YouTube-download hotfix to `sidestream/1.0.19/Sidestream-1.0.19-Mac-Installer.dmg`. The shared public download/update manifest now exposes it as a critical 100% notice with SHA-256 `c3beeec06b7ba3c636d224f92c42a1a2c293916be2da5f227c95cb85c6c81c56` and 227,135,707 bytes; Windows and receipt-gated paid pointers remain unchanged.

- 2026-08-18: Enabled Stripe's customer-entered promotion-code field for the `$4.99/month` Upgrade Checkout and made activation retries replace older open Sessions that lack it. Subscription fulfillment now reconciles partial and 100% Checkout discounts against the immutable recurring Price, exact Invoice line and aggregate discount amounts, actual Invoice total, and current Invoice Payments ledger; zero-total first Invoices are accepted only with paid provider truth and no fabricated payment, while `once`, `repeating`, and `forever` renewal behavior remains Stripe-owned and independently verified.

- 2026-08-16: Added default-off server-authoritative Free credits for v1.0.19: one 1,000-credit installation wallet per channel, atomic 100-credit reservations, legacy-usage import, an append-only ledger, fail-closed routes, optional Stripe packs, and unchanged database-backed Unlimited. Production activation remains blocked on the migration; pack sales remain blocked on exact terms/refund policy. No migration, deployment, payment, or public plugin release is claimed.

- 2026-08-16: Reduced the global recurring Upgrade experiment offer from `$9.99/month` to `$4.99/month` while keeping the future-account assignment at its configured 50/50 split. The canonical pricing contract now stores each recurring amount explicitly, the global resolver uses the new immutable `sidestream_pro_monthly_usd_499` lookup key, regional recurring amounts remain unchanged, persisted account assignments remain intact, and open Checkout snapshots, subscriptions, and entitlements retain their recorded terms.

- 2026-08-14: Completed the standard Mac Sidestream `1.0.18` updater-notice rollout from 50% to 100%. The signed installer, version, checksum, direct public download, noncritical status, Windows release, and receipt-gated paid release remain unchanged.

- 2026-08-12: Added the verified Meta-paid payment-received CTA to send Sidestream Unlimited directly to the customer's computer. Exact paid Checkout fulfillment now installs the signed HttpOnly receipt cookie; the existing receipt-gated artifact route mints one secure share link, selects Mac or Windows on the receiving computer, and still re-verifies active payment and entitlement before artifact delivery. The ordinary website handoff and public Free installer remain unchanged.

- 2026-08-12: Added the server-owned authenticated `upgrade-pricing-v1` foundation, immutable account assignment and opened-Session exposure schema, audited half-price monthly rounding, currency-specific recurring Price contract, shared payment/subscription Checkout worker, exact first-class Stripe subscription fulfillment/lifecycle, protected currency-isolated report/CLI, disposable-Postgres and cross-domain regressions, and FlowState Upgrade Experiment dashboard contract. Real Stripe Test qualification then fixed provider metadata keys above Stripe's 40-character limit and added exact typed-parent support for the current invoice-line API shape; both failures stayed fail-closed without granting entitlement. Production rollout and remaining provider/UI qualification remain separate evidence until their migration, regional Price, webhook, Premiere v1.0.11, pushed-main, live-SHA, and rendered-dashboard gates are recorded in the experiment evidence section.

- 2026-08-10: Added a loopback-only, Production-disabled renamed-launcher attribution proof that issues a single opaque filename claim for one synthetic Test acquisition, stores only the claim hash, enforces an exact one-time binding lifecycle, and accepts only body-carried receipt/install identities. The paired FlowState signed-artifact harness covers the launcher and installation boundaries. No Vercel route, migration, provider, customer delivery, email, public pointer, deployment, or Production state changed.
- 2026-08-10: Tightened the local Production reset's Premiere blocker to the actual `/Applications` app executable or exact process name at the start of the process command. AdobeIPCBroker is no longer treated as Premiere merely because its later `-launchedbyvulcan` argument contains the Premiere executable path; real Premiere 2025/2026 and exact Production CEP processes remain blockers, while non-Production CEP processes remain preserved. This change ran no reset apply, touched no live local state, contacted no provider, deployed nothing, and pushed nothing.

- 2026-08-10: Fixed guarded fresh Meta-paid reset deletion for exact immutable paid-telemetry bindings. Apply now suspends and restores that table's user triggers inside the same serializable transaction as the other immutable audit tables. The isolated full-schema regression creates a validator-approved exact binding, proves ordinary deletion still fails with SQLSTATE `55000`, proves guarded apply deletes the selected binding and complete fixed-QA closure, preserves unrelated rows and anonymous paid events, and leaves the second inventory empty. This change contacted no provider, created or deleted no provider branch, applied no live reset, touched no local CEP/browser state, deployed nothing, and pushed nothing.

- 2026-08-10: Closed the fresh Meta-paid reset over server-owned Customer 360 history exposed by the sanitized live dry-run: fixed-QA profiles now contribute historical unbound activation and deleted-provider-Customer identity roots, retained licenses must still belong only to fixed-QA accounts, and all Checkout intents on the exact canonical acquisition enter the closure. Foreign live account/provider email and cross-profile/acquisition ownership still refuse. Anonymous paid-acquisition events no longer use a time-window selector or overlap stop, are never deleted, and are now a global before/after invariant. The isolated Postgres regression executes apply and proves unrelated account/profile/acquisition data plus anonymous events stay unchanged and replay is empty/stable. This change contacted no provider, created no backup, applied no live reset, touched no local CEP/browser state, deployed nothing, and pushed nothing.

- 2026-08-10: Corrected the fresh Meta-paid Customer 360 inventory after a live dry-run exposed PostgreSQL SQLSTATE `42P19`. The recursive closure now has one legal recursive term/reference while retaining Production-only ancestor and descendant traversal, `UNION` convergence, ownership/limit/preservation gates, and sanitized reporting. A network-guarded regression applies the complete schema, proves the full Alex merge family and unrelated/Test exclusion, and proves replay is stable; its aggregate now self-provisions and removes disposable loopback PostgreSQL when no test URL is supplied. This change contacted no provider, created no backup, applied no reset, touched no local CEP/browser state, deployed nothing, and pushed nothing.

- 2026-08-10: Corrected the fresh Meta-paid live target documentation and regression gates. Endpoint discovery now names the authenticated Neon project endpoints API and privacy-safe `{id, branchId}` projection. Local reset documentation now names the real CSXS cache root and exact Production cache pattern, preserves both Test bundle forms, requires sudo to resolve the attested original non-root home, and limits termination fallback to the exact Production CEP process after a normal Premiere quit. Repository gates do not prove that a live reset, provider backup, Checkout, installation, authentication, download, deployment, or push occurred.

- 2026-08-10: Published the signed, notarized, and stapled standard Mac `1.0.18` installer to `sidestream/1.0.18/Sidestream-1.0.18-Mac-Installer.dmg` and advanced the shared public download/update manifest as a noncritical 50% in-panel notification rollout. The artifact remains directly downloadable by everyone; the persisted local updater bucket limits automatic notices until the manifest advances to 100%. Windows and the receipt-gated paid pointers remain unchanged.
- 2026-08-10: Replaced the obsolete two-environment/Keychain Alex reset with a Production-only fresh Meta-paid workflow. The remote operator now binds a sanitized dry-run to an explicit deployed non-`main` Neon branch/direct endpoint, connected target fingerprint, exact verified child recovery branch, fixed QA identity, Production namespace, and destructive confirmation; it follows the complete server-owned Alex lineage while preserving financial objects, provider event history, and unrelated customer/analytics state, then proves an idempotent zero state. Added a reversible Production-only local CEP/state/installer-receipt backup, a clean-browser stop, one post-auth exact binding `STOP`/`GO` gate before the first panel download, and a separate same-install raw telemetry follow-up after one download. Fixture gates passed but did not query or mutate live state, contact providers, start Checkout, install, authenticate, download media, deploy, or push.

- 2026-08-10: Added the seventh Meta-paid integrity boundary at the read-only acquisition-funnel selector. For one live profile, a single immutable paid-telemetry binding now outranks older receipt, Checkout Session, activation, and broad account edges; no-binding profiles retain the deterministic first-touch/entry/Checkout fallback, while multiple exact bindings fail to unknown instead of silently choosing one. The disposable first-purchase regression and paid-handoff report converge on Meta/social/`sidestream_direct_offer_test`, `exact_paid_checkout`, `intact`, `paidCustomer=true`, attributed `1/1`, exact paid `1/1`, and unknown `0/1`, with the older ManyChat candidate unchanged. Deployed `5a4cf55` returned the same correct `1/1` and `0/1` counts but dimensionally selected ManyChat/`historical_unlinked`. This snapshot did not query or mutate Production, call providers, deploy, push, add a migration, or touch FlowState.

- 2026-08-10: Added the sixth fail-closed Meta-paid handoff boundary for the exact current Stripe Customer link. The locked completed Checkout intent and claimed authenticated account must share one bounded `cus_` value, with no identity link, exact review, or commerce alias owning that value. Split journeys attach only after deterministic merge; the deployed post-repair shape takes a customer-link-only branch that does not repeat stages, claims, merge/audit, commerce recovery, or immutable binding. It inserts exactly one survivor link, requires exact Customer lookup and rediscovery to converge to `already_repaired`, preserves older customer links, and replays as a no-op. Deployed `19c242d` had repaired exact Checkout Session/PaymentIntent commerce ownership but left this legacy exact Customer lookup absent. This snapshot did not query or mutate Production, call Stripe or another provider, deploy, push, or touch FlowState.

- 2026-08-10: Added the fifth fail-closed Meta-paid handoff boundary for one exact recoverable commerce pre-state: a single verified Checkout payment fact on one canonical payment key may move from null owner and zero gross/net to the already verified positive paid amount only when currency, Checkout and canonical-payment identity evidence, paid completion, account, entitlement, activation, reviewed install/receipt, and every conflict/lifecycle gate are exact. The serializable apply merges profiles first, updates only the locked fact without rewriting provider identifiers or provenance, refreshes existing commerce totals, requires one positive attached owner, and rolls back on any mismatch; replay is a no-op. Deployed `6118a87` rejected this shape read-only without mutation. This integration snapshot did not query or repair Production, call providers, deploy, push, or qualify a live journey.

- 2026-08-10: Added the fourth fail-closed Meta-paid handoff boundary for the exact historical entitlement placeholder: null entitlement Product and Price plus zero entitlement amount may defer to a strictly positive verified paid snapshot only while every canonical Checkout/payment/account/install/lifecycle/commerce/stage/binding invariant remains exact. A null claim email is accepted only behind exact account, entitlement, activation, and Checkout-email ownership; partial or mismatched tuples still refuse. The disposable replay proves `repair_ready`, atomic `already_repaired`, no-op replay, and no entitlement/email backfill. Deployed `812cf96` rejected this exact shape read-only without mutation; this snapshot did not query or repair Production, deploy, or qualify a live journey.

- 2026-08-10: Added the third fail-closed Meta-paid handoff boundary: when direct historical and reviewed active paths coexist, exactly one verified-server `account_identity` review from `activation_claim` selects the reviewed path without timestamp, row-order, provider, email, hash, receipt-input, activation-input, or operator selectors. Duplicate reviews/owners, overlap, root mismatch, and every existing downstream conflict still refuse; the disposable dual-path replay proves `repair_ready`, `already_repaired`, and no-op replay. The earlier read-only Production dry-run on deployed `a4be35d` rejected this shape without mutation; this integration snapshot did not query or repair Production, deploy, or qualify a live journey.

- 2026-08-09: Extended the fixture-proved Meta-paid telemetry handoff from a simple install-profile split to the exact pending verified-account-review shape: multi-attempt selection follows the active activation/receipt, matching Checkout/claim state converges atomically, and replay remains privacy-safe and idempotent. The earlier `aa5a604` Production dry-run rejected that live shape without mutation; this integration snapshot did not deploy, migrate, repair Production, or qualify a live journey.

- 2026-08-09: Advanced the receipt-gated paid Mac pointer to the signed, notarized, and stapled `1.0.17` artifact built from exact public source baseline `40c0adeb2ede134d97b11aa0712aaa5d942481aa` with only `sidestreamBuild.onboardingChannel = "paid-onboarding"` changed. Its immutable Blob pathname includes digest prefix `e941f79f7332e9b7`; the original stable `1.0.17` Mac artifact remains the documented rollback target. The public Mac and both Windows pointers remain unchanged.
- 2026-08-09: Made paid activation attribution failures diagnosable with nine bounded, identity-free linkage outcomes and made Customer 360 exact Stripe lookup prefer the acquisition attached to the requested Checkout Session or its exact payment aliases before deterministic profile-linked fallback. Documented the final one-lineage Meta-paid live gate separately from provider-free fixture proof; this integration step did not contact providers, pay, email, install, load Premiere, query live Customer 360/telemetry, deploy, or change Production.
- 2026-08-09: Rolled the receipt-gated paid Mac pointer back from the isolated `1.0.17` artifact rebuilt after preview clipping commits to the original stable `1.0.17` Mac artifact published at the release boundary. This keeps Unlimited downloads on version `1.0.17` while removing the later Test-intended clipping behavior. Both Windows pointers remain unchanged. Paid releases now require an explicit FlowState source-commit/release-boundary check before their pointer advances.
- 2026-08-09: Removed the introductory setup-email reminder beneath the paid-acquisition payment confirmation so the page proceeds directly from its heading into the numbered computer setup steps.
- 2026-08-08: Restored the paid flow's independent platform manifests after a live audit showed the receipt-gated Mac route was serving the standard build, which cannot load paid onboarding. Published the signed, notarized, and stapled 1.0.17 Unlimited Mac installer at an immutable private pathname and advanced only the paid Mac pointer; the public Mac and Windows manifests remain unchanged.
- 2026-08-08: Fixed paid-onboarding installation attribution at the authenticated confirmation boundary. The dedicated paid activation POST now uses the signed HTTP-only paid-download receipt to bind Checkout to the exact paid-source activation, then records canonical `installation_claimed` only when that activation has one install identity and one locally verified installer-receipt identity. Removed the invalid comparison between the per-checkout browser receipt hash and the unrelated local installer receipt hash; GET stays read-only and attribution failure cannot revoke a valid entitlement reconnect or transfer.
- 2026-08-08: Removed the paid flow's independent Mac and Windows release pointers. Receipt-gated paid metadata and fulfillment now derive directly from each platform's canonical stable manifest, so stable publishing advances ordinary downloads, updates, and paid onboarding together while retaining payment verification and artifact-integrity checks.
- 2026-08-08: Removed the redundant green “You are finished on this phone” card from the paid-acquisition setup page, including its Stripe-receipt and separate-email reminder, while preserving the computer setup steps and support link.
- 2026-08-05: Added two deterministic, unlinked Meta ad destinations: `/meta-default` always enters the existing default site and `/meta-paid` always enters the pay-first page. Both start or preserve a canonical `meta-direct-links-v1` journey with fixed Meta source/campaign and distinct default/paid dimensions; switching ad variants starts a new immutable acquisition UUID. Verified paid reporting now prefers the exact canonical acquisition joined through the Checkout intent instead of hard-coding legacy ManyChat attribution, while historical rows without that linkage retain the legacy fallback.
- 2026-08-04: Audited every public API handler against an explicit acquisition role, removed the anonymous `/api/paid-download` installer bypass, and moved its Blob signer under `api/_lib`. Successful receipt-gated paid artifact redirects now record the canonical `installer_requested` stage plus `installer_redirect` evidence after the response, so tracking failure cannot delay delivery. The paid `/mc` journey matrix now requires that installer stage, and a route-inventory regression prevents future product-delivery endpoints from shipping without an attribution decision.
- 2026-08-03: Published the durable acquisition-integrity contract and operator stops for the immutable acquisition UUID, truthful `website_direct_or_unknown` fallback, signed trusted-delivery channels, ten canonical stage grains, mandatory Checkout/Stripe linkage, claim acknowledgment states, exact Stripe lookup, first-install/first-purchase pagination, integrity alerts, deterministic-only history, privacy exclusions, ordered migration, local gates, and main-only Production verification. This documentation run did not migrate, backfill, deploy, call providers, complete a payment, send email, open a live browser, or load Premiere.
- 2026-08-03: Added a private Customer summary at the unambiguous `/api/internal/customer-summary` route. It separates current Unlimited access from unique paid users, exposes their overlap, and reads the successful-payment total directly from Stripe so the card matches Transactions > Succeeded instead of undercounting from fulfilled license rows. Access still uses the production-safe pre-lifecycle entitlement expression rather than Customer 360 money.
- 2026-08-03: Added the protected Customer 360 `paidCustomerPercentage` metric and auditable `totals.paidCustomers` count. A cohort profile counts once only when verified payment predates the observation boundary and its current materialized net paid remains positive after refunds and disputes; this is separate from activation and paid-attribution coverage.

- 2026-08-01: Preserved PostgreSQL microseconds in Customer 360 usage high-water cursors so bulk telemetry sharing one millisecond cannot repeat a terminal rescan batch. Checkpoint normalization/resume now retains fixed-width six-digit UTC precision, and the guarded manual normal-sync batch ceiling is 5,000 for large overlap catch-up while its default remains 250; Production measurement showed 10,000-row overlap batches were slower.

- 2026-08-01: Completed the authorized Customer 360 Production rollout: protected Neon backup and 29-migration verification, least-privilege runtime/operator/telemetry roles, idempotent identity backfills, full version-2 historical usage rescan plus normal sync, protected API/privacy checks, the daily four-job schedule, rendered live FlowState dashboard, and a signed/notarized/published 1.0.17 Mac install and real-Premiere one-time claim. Raw telemetry was read-only and no canonical identity, commerce, entitlement, device, audit, or telemetry row was deleted.

- 2026-08-01: Published the signed, notarized, and stapled standard Mac `1.0.17` installer to `sidestream/1.0.17/Sidestream-1.0.17-Mac-Installer.dmg` and advanced the shared public download/update manifest at 100% rollout; the Windows manifest remains on its independently qualified `1.0.16` artifact.

- 2026-08-01: Shortened the expanded mobile email handoff button from “Send me the links” to “Email it to me.”

- 2026-08-01: Reworked the mobile download handoff into two initial actions: “Enter your email” now reveals and focuses the existing email form, while “Send it directly to your computer” opens the secure share flow. Successful share/copy feedback now replaces the direct-send button label instead of adding a status line below the controls.

- 2026-08-01: Expanded the guarded Customer 360 historical rescan from session-only replay to the complete exact daily usage aggregator. Version-2 checkpoints now reconsider every valid historical telemetry row, rebuilding open, accepted-download, terminal-outcome, platform, and version buckets before profile materialization while preserving the read-only source and append/update-only target boundary. Rescan-only batches may be raised to 10,000 rows for high-volume remote history while normal daily sync retains its tighter bound.
- 2026-08-01: Removed verified email addresses from the protected Customer 360 list/detail response shape while retaining server-side verified-account attachment and the boolean `hasEmail` filter. Added unit and disposable-Postgres privacy assertions that seeded addresses never cross the API boundary.
- 2026-08-01: Registered the focused Customer 360 operator-safety suite and consolidated the guarded migration, identity-backfill, usage-sync, and historical-rescan contracts. Documented exact named selectors, connected operation-bound fingerprints, Production confirmations, mode-`0600` checkpoints, replay/idempotency, no-delete boundaries, protected APIs, and Preview/Test-first verification. This code-only run performed no provider call, migration, backfill, sync, rescan, deployment, scheduler change, or release.
- 2026-08-01: Added trusted-country South Korea pricing at `₩24,900` for new Sidestream Unlimited intents through `SIDESTREAM_PRO_SOUTH_KOREA_PRICE_ID`. The server-owned catalog continues to fall back to global `$19.99` when the regional Price is unavailable, and already-open Checkout intent snapshots retain their original offer.

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

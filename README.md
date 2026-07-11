# Sidestream Landing Page

## Product Overview

Sidestream is an HTML-first landing page for a Premiere Pro panel that lets editors search, preview, and download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The main page remains a single canonical HTML document with embedded layout CSS and vanilla JavaScript, plus a small React/Tailwind layer mounted only for the full-page Paper shader background.

## File Map

- `Sidestream front end 2/Sidestream.html` - Legacy compatibility redirect for the old exported page URL. It is `noindex` and immediately sends visitors back to `/`.
- `index.html` - Canonical page implementation served at `/`. Contains the shader mount root, header, hero, Windows waitlist modal trigger, feature sections, pricing, final CTA, footer, styles, rotating-word script, toast behavior, crawler metadata, and structured data.
- `public/robots.txt` - Public crawler policy copied to `/robots.txt` by Vite. Allows search and AI discovery crawlers while keeping installer and lead-capture API routes out of crawl targets.
- `public/sitemap.xml` - Public XML sitemap for the current canonical Sidestream landing URL.
- `public/llms.txt` - Concise AI-readable product summary and canonical-source guide for LLM/search agents. It is additive and does not replace normal SEO metadata or visible page content.
- `public/sidestream-og.jpg` - Small Open Graph/Twitter preview image copied from the existing hero screenshot so link previews and crawlers have a stable public image asset.
- `components/ui/demo.tsx` - Adapted Paper demo component mounted as the page background. The active default effect keeps the original simple `MeshGradient` look with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`, with demo install/clipboard overlay text removed and no background mouse interaction.
- `components/ui/background-paper-shaders.tsx` - Exact pasted React Three Fiber shader primitives from the provided reference. They are kept as optional reference code and are not mounted by default.
- `account.html` - Minimal noindex account bridge with a headline-only intro. Uses the server auth session to show plan status, latest installer, sign out, and a Manage Billing button that creates a Stripe Customer Portal session.
- `thank-you.html` - Minimal noindex Checkout success page. Stripe success URLs land here after purchase, while legacy `/upgrade.html?checkout=success` links redirect here and preserve optional activation/session query values.
- `upgrade.html` - Minimal noindex checkout/cancel fallback page. Main upgrade entry points redirect directly to Stripe Checkout through `/api/checkout/start`, while this page preserves optional plugin activation keys for retry links.
- `api/download.ts` - Vercel Node Function for installer fulfillment. `HEAD` returns attachment metadata for the configured private Vercel Blob installer, and `GET` validates the Blob then redirects to a short-lived signed private Blob URL. Supports `GET` and `HEAD` only.
- `api/download-lead.ts` - Vercel Node Function that accepts landing-page lead captures, including the Windows waitlist and historical download email gate, and stores each lead in server-side Postgres through the Sidestream Supabase/Vercel connector's `SIDESTREAM_POSTGRES_URL`, with generic `POSTGRES_URL` fallback if the connector env is unavailable.
- `api/_lib/account.ts` - Shared server-only account, Google OAuth, Stripe, Postgres, activation, license-token, cookie, and response helpers for the SaaS flow. Serverless route imports intentionally reference this helper with a `.js` extension so Vercel's Node ESM runtime can resolve the compiled helper file.
- `api/auth/google/start.ts` and `api/auth/google/callback.ts` - Google OAuth redirect/callback handlers. They set a short-lived HTTP-only state cookie, upsert `sidestream_accounts`, and issue a server-side session cookie.
- `api/auth/session.ts` and `api/auth/logout.ts` - Account-session JSON and logout endpoints used by `account.html` and `upgrade.html`.
- `api/checkout/start.ts` - Public Stripe Checkout redirect for the Sidestream Pro one-time payment. It resolves the server-owned `$4.99` Price from `SIDESTREAM_PRO_PRICE_ID` or the checked-in default `price_1TqGeBDFKjeGlioXlV8fBGK8`, carries optional plugin activation metadata, and redirects directly to Stripe without requiring Google sign-in.
- `api/checkout/create.ts` - Backward-compatible authenticated JSON Checkout Session creator for account-page callers. It creates the same one-time Checkout payment for an existing account customer.
- `api/billing/portal.ts` - Authenticated Stripe Customer Portal redirect creator for customer billing details and invoice history where Stripe has actual Invoice objects to show.
- `api/billing/receipt.ts` - Authenticated one-time purchase receipt helper. It finds the signed-in account's latest Sidestream license PaymentIntent and returns the Stripe charge receipt URL, covering older Checkout payments that did not create invoices.
- `api/stripe/webhook.ts` - Stripe webhook endpoint. Verifies signatures, stores idempotency rows, and updates Sidestream license state from completed one-time Checkout payments, while keeping legacy subscription event handling.
- `api/activation/start.ts`, `api/activation/status.ts`, and `api/license/verify.ts` - CEP-facing activation and short-lived license verification endpoints. The plugin stores only an opaque token and entitlement summary, not billing truth.
- `db/migrations/20260626120000_add_sidestream_download_leads.sql` - Postgres schema for the private `public.sidestream_download_leads` table used by the download email gate.
- `db/migrations/20260703120000_add_sidestream_accounts_billing.sql` - Postgres schema for accounts, sessions, Stripe licenses/events, plugin activation sessions, and short-lived license tokens.
- `db/migrations/20260704120000_add_sidestream_billing_resources.sql` - Legacy Postgres schema for persisted Stripe subscription billing resources from the retired monthly-price flow.
- `db/migrations/20260704130000_allow_stripe_first_accounts.sql` - Postgres schema adjustment that allows Stripe-first account rows without a Google subject so Checkout can create/link Sidestream entitlements from webhook customer data.
- `db/migrations/20260704150000_allow_one_time_checkout_licenses.sql` - Postgres schema adjustment that lets `sidestream_licenses` store one-time Checkout Session and PaymentIntent IDs instead of requiring a Stripe subscription ID.
- `db/migrations/20260707120000_enable_sidestream_server_table_rls.sql` - Supabase hardening migration that enables RLS on server-owned Sidestream public tables and revokes direct `anon` / `authenticated` Data API access. The Vercel API routes continue to use the server-only Postgres connection.
- `scripts/apply-postgres-migrations.mjs` - Generic Postgres migration runner for all SQL files under `db/migrations/`.
- `scripts/ensure-freedev-promo.mjs` - Maintainer utility that creates or verifies the sandbox-only Stripe `FREEDEV` 100% off promotion code used to test no-cost Sidestream Pro Checkout.
- `scripts/migrate-download-leads-to-postgres.mjs` - One-shot utility that applies the Postgres schema and migrates existing private Vercel Blob lead JSON records into Postgres.
- `scripts/dump-download-leads.mjs` - Maintainer utility that dumps captured Sidestream download leads from Postgres for quick audits.
- `src/main.tsx` - React entry that mounts `DemoOne` into `#shader-background-root` and renders Vercel Analytics through `@vercel/analytics/react`.
- `src/paper-shaders-compat.d.ts` - Local TypeScript compatibility declarations for the pasted prop names that the installed Paper package does not type directly.
- `src/index.css` - Tailwind v4 theme/utilities import, `tw-animate-css`, shadcn theme tokens, and source paths for the background component. It avoids Tailwind preflight so the static HTML styles are not reset.
- `components.json` - shadcn configuration with aliases rooted at the repository root.
- `vite.config.ts` - Vite React/Tailwind build config with the canonical root page, legacy redirect, account page, and upgrade page as HTML inputs.
- `vercel.json` - Vercel deployment config. Forces npm install/build/dev commands and `dist` as the output directory so Vercel does not fall back to a stale Yarn project setting. The dev command passes Vercel's `$PORT` to Vite.
- `mockups/mockup1_2.webm` - Browser-sized autoplay alpha WebM generated from the cleaner local MacBook Pro mockup source and mounted below the pricing panels.
- `demos/search demo.mp4` and `demos/preview demo.mp4` - Autoplaying feature demo videos showing the Tudor Place search and preview workflow.
- `demos/sidestream-panel-corner.webm` - Square VP9-alpha WebM generated from the ProRes source `sidestream demo Linked Comp 01_2.mov` using the full-plugin/timeline top-left crop. Mounted as an opaque decorative Premiere/Sidestream corner on the right side of the hero/main page, visually scaled to 70% from the Premiere top-left corner, and positioned so real video content covers the right and bottom areas without moving the frosted feature band.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`
- Shader background - `#shader-background-root`, `src/main.tsx`, `components/ui/demo.tsx`, the active Paper `MeshGradient`, `components/ui/background-paper-shaders.tsx`, and `src/paper-shaders-compat.d.ts`
- Vercel Analytics - `src/main.tsx` imports `Analytics` from `@vercel/analytics/react` and renders it alongside the shader component
- SEO/GEO metadata - `<head>` metadata in `index.html` provides the title, description, robots directive, absolute canonical root URL, Open Graph/Twitter tags, sitemap hint, public OG image, and JSON-LD `Organization`, `WebSite`, `SoftwareApplication`, and `Product` graph for the product surface. Keep this crawler-readable layer aligned with visible product claims. The legacy nested HTML path only redirects back to `/`.
- Hero - `#hero`, `.hero-split`, `.hero-copy`, `.hero-title-line`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, `.hero-description`
- Windows waitlist - `[data-windows-waitlist-open]` lives beside the hero Mac download CTA as a matching white platform pill with a Windows mark. It opens `#windows-waitlist-gate`, whose centered modal form posts valid emails to `POST /api/download-lead` with `source: "windows-waitlist"` and stores a local `sidestream.windows.email` value only to prefill the modal on repeat visits.
- Feature sections - `#features` anchor, `.feature-glass` full-bleed frosted backdrop band, the two `.sec-pad` feature blocks, `.feature-subtext` heading sublines, `.shot` video frames, `.demo-video` MP4 embeds, the bottom inline viewport-playback observer, and the pointer-driven `.shot` 3D tilt handler
- Pricing - `#pricing`, `.pricing-head`, `.plans`, `.plan`, `.plan.featured`, `.beta-coming`, `.plan-beta-content`, `.beta-overlay`, `.final`, `.pricing-mockup`, `.macbook-mockup-video`, the MacBook playback helper, and the pricing-panel scroll reveal observer
- Final CTA - `.final` sits inside `#pricing` between the pricing cards and laptop mockup, with a single public installer download button
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download, waitlist, and upgrade actions - `[data-download]`, `[data-windows-waitlist-open]`, `[data-purchase]`, and `#toast`; download CTAs point directly at the public `https://sidestream-xi.vercel.app/api/download` URL with the CSS Apple platform mark from `.btn[data-download]::before`, the Windows waitlist CTA uses the same pill treatment with a Windows mark and opens `#windows-waitlist-gate`, while Sidestream Pro entry points open `/api/checkout/start` so the browser lands directly on Stripe Checkout.
- Installer fulfillment - `api/download.ts` reads `SIDESTREAM_INSTALLER_BLOB_PATHNAME`; `HEAD` returns attachment headers and `GET` redirects to a 5-minute signed private Blob download URL
- Download lead capture - `api/download-lead.ts` accepts `POST /api/download-lead` JSON with an email, optional page, and optional source, captures the request IP from proxy headers, then writes to Postgres table `public.sidestream_download_leads` through a server-only Postgres connection string. The hero Windows waitlist uses `cta_source = "windows-waitlist"` so its count can be queried separately from historical download emails. Accepted env names are `SIDESTREAM_POSTGRES_URL`, `SIDESTREAM_POSTGRES_PRISMA_URL`, `SIDESTREAM_POSTGRES_URL_NON_POOLING`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, and `POSTGRES_URL_NON_POOLING`, in that order; if Postgres is not configured or the write fails, it falls back to the private Vercel Blob prefix `SIDESTREAM_DOWNLOAD_LEADS_BLOB_PREFIX` or `sidestream/download-leads`
- Account/auth/billing - `account.html`, `thank-you.html`, `upgrade.html`, `api/_lib/account.ts`, `api/auth/*`, `api/checkout/start.ts`, `api/checkout/create.ts`, `api/billing/portal.ts`, `api/stripe/webhook.ts`, `api/activation/*`, and `api/license/verify.ts` own optional Google account management, the server-owned Sidestream Pro Product/Price resolution, direct one-time Checkout redirects, Customer Portal redirects, webhook-owned entitlements, plugin activation, and license-token verification

## Routes and Assets

There is no client router. Use Vite for local development so the TypeScript shader entry is compiled and served.

Vercel Analytics is initialized from the same compiled React entry as the shader background. It records deployed page visits after the site is built and visited on Vercel; local Vite previews are for integration/build checks, not production analytics confirmation.

When using a local preview server, the root URL serves the canonical page:

```text
http://localhost:5173/
```

The current canonical public landing URL for crawlers is:

```text
https://sidestream-xi.vercel.app/
```

The old exported static page path, `/Sidestream%20front%20end%202/Sidestream.html`, is kept only as a compatibility redirect back to `/`.

Vite copies public crawler assets to the site root:

```text
GET /robots.txt
GET /sitemap.xml
GET /llms.txt
GET /sidestream-og.jpg
```

`robots.txt` explicitly allows normal search discovery plus OpenAI `OAI-SearchBot`, `GPTBot`, and `ChatGPT-User` access to content while disallowing `/api/download` and `/api/download-lead` as crawl targets. The sitemap contains the current canonical landing page only. `llms.txt` is an additive AI-readable summary for agents; do not use it as a place for claims that are absent from the landing page.

Vercel serves these serverless API routes:

```text
GET /api/download
HEAD /api/download
POST /api/download-lead
GET /api/auth/google/start
GET /api/auth/google/callback
GET /api/auth/session
POST /api/auth/logout
GET /api/checkout/start
POST /api/checkout/create
POST /api/billing/portal
POST /api/billing/receipt
POST /api/stripe/webhook
POST /api/activation/start
POST /api/activation/status
POST /api/license/verify
```

`/api/download` serves the private Vercel Blob object named by `SIDESTREAM_INSTALLER_BLOB_PATHNAME`. `HEAD /api/download` returns attachment metadata without exposing the private Blob URL. `GET /api/download` first verifies the Blob metadata, honors a matching `If-None-Match` with `304`, then returns a temporary redirect to a 5-minute signed private Blob URL so the browser downloads from Blob/CDN instead of proxying the full DMG through the serverless function. The current configured pathname is:

```text
sidestream/1.0.12/Sidestream-1.0.12-Mac-Installer.dmg
```

The Blob store is the private `sidestream-release-105` store in Vercel project `sidestream`, store id `store_9KFjHEkmxI6IIWNi`, region `iad1`. Vercel Blob access is authenticated through either `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`, or a legacy `BLOB_READ_WRITE_TOKEN` if one is configured. `BLOB_STORE_ID` and `SIDESTREAM_INSTALLER_BLOB_PATHNAME` are set in the Vercel project environments; `.env.local` is generated by `vercel env pull` and must stay ignored. The website download should point at the native/base Mac installer DMG, not the older ZXP-helper DMG path.

### Vercel Blob And CDN Usage Guardrails

Limits were last verified against Vercel docs on 2026-06-25; re-check [Vercel pricing](https://vercel.com/docs/pricing), [Vercel Blob pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing), and [CDN usage](https://vercel.com/docs/manage-cdn-usage) before making quota-sensitive changes. Current Hobby allowances to keep visible are 1 GB Blob storage, 10 GB Blob Data Transfer, 10,000 Blob simple operations, 2,000 Blob advanced operations, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer, and 1,000,000 Edge Requests per month. Hobby Blob access can stop until the 30-day window resets if limits are exceeded.

The current public installer artifact, `Sidestream-1.0.12-Mac-Installer.dmg`, is 226,402,945 bytes locally, about 216 MiB / 0.226 GB. At that size, 10 GB of Blob Data Transfer is only about 44 full downloads; use 80% of the allowance as the stop-and-ask threshold, roughly 35 full downloads/month unless the Vercel plan changes. Keeping more than four current-size DMGs in the active Blob store can approach the 1 GB storage allowance.

Flag any change that increases installer size, stores multiple release DMGs, uploads raw demo/video assets, makes `/api/download` easier for bots to hit, removes attachment/cache safeguards, proxies the installer through extra functions, or changes the email gate/CTA flow in a way that materially increases downloads. Estimate `artifact bytes * expected downloads` and verify Vercel Usage after publish.

Download CTAs are intentionally unblocked in the canonical HTML. Their anchors point at the canonical public Vercel download URL, `https://sidestream-xi.vercel.app/api/download`, so local static previews and adjacent static hosts do not 404 on a relative `/api/download` path. The old `#download-email-gate` markup remains for historical compatibility, but visible download clicks no longer require an email before starting the installer. The active visible lead capture is the hero Windows waitlist button, which opens a centered modal and posts to `/api/download-lead` with `source: "windows-waitlist"`; count those leads through the `cta_source` column.

The SaaS/account flow is server-owned. Google OAuth uses `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, optional `GOOGLE_REDIRECT_URI`, and `SIDESTREAM_BASE_URL`; successful sign-in stores an HTTP-only `sidestream_session` cookie backed by `public.sidestream_account_sessions`, but Google sign-in is not required before checkout. Stripe Checkout uses `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the Sidestream Pro Product ID from `SIDESTREAM_PRO_PRODUCT_ID` or the default `prod_UpwXh6oO1OmPyQ`, optional `SIDESTREAM_PRO_PRICE_ID`, and the checked-in live default Price `price_1TqGeBDFKjeGlioXlV8fBGK8`. In live mode, that default Price must exist and validate as the active `$4.99` one-time Price for the configured Product; sandbox/test keys can fall back to the Product's valid default Price, an active Product Price, or a newly created lookup-key Price so local checkout tests do not depend on the live Price object. The old `SIDESTREAM_UNLIMITED_PRICE_ID` is only a migration fallback when it points at the same Pro Product. Direct upgrade links call `GET /api/checkout/start`, which creates a hosted `mode: "payment"` Checkout Session for a $4.99 one-time purchase, creates a Stripe Customer when no web session exists, adds the Stripe-page custom text `One-time payment. No subscription.`, enables Checkout invoice creation for future invoice history, sends successful Checkout returns to `thank-you.html`, and carries optional plugin activation metadata. Stripe-created customers are linked to existing Sidestream accounts by customer ID or normalized checkout email; otherwise the webhook creates a Stripe-first account row with no Google subject. One-time access is granted only from verified `checkout.session.completed` webhooks with `payment_status` of `paid` or `no_payment_required`; new sessions use the `sidestream_pro` plan key while legacy `sidestream_unlimited` sessions remain accepted for webhook compatibility. Legacy subscription webhook handling remains only for older events. Customer Portal sessions are still created from authenticated web sessions for customer billing details and invoice history, but Stripe Portal is not a refund-request surface and older one-time Checkouts can have only charge receipts instead of Invoice objects. `/api/billing/receipt` returns the latest one-time charge receipt URL for the signed-in account. Plugin activation sessions are short-lived rows in `public.sidestream_activation_sessions`; the CEP panel receives an opaque 7-day license token from `/api/activation/status` and revalidates it through `/api/license/verify`. The webhook records Stripe event payloads before fulfillment, but unprocessed duplicate events must be retried rather than skipped; account/session and activation-status reads process any pending unprocessed Stripe events so a failed webhook can recover after schema/env fixes. Do not store Stripe secrets, Google client secrets, raw payment data, or permanent paid-state in browser code or the CEP plugin.

The MacBook mockup media is a native autoplaying, muted, looping `<video>` that loads `mockups/mockup1_2.webm` from the canonical root HTML file. The generated VP9-alpha WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally. The mockup lives below the two pricing panels and the `.final` CTA inside `.pricing-mockup`, with the "Stop using sketchy websites to download music" panel now positioned above the laptop. It remains centered with a wide responsive video width and a soft bottom mask fade. It intentionally has no CSS drop shadow because filtering the alpha video can reveal a rectangular compositing edge during rotation. The bottom inline script keeps `.macbook-mockup-video` muted and calls `play()` on load/visibility return so the laptop continues spinning in normal browser viewing.

The feature cards are chrome-free video frames that use native muted, looping MP4s from `demos/`. The active demos are `search demo.mp4` and `preview demo.mp4`, both recorded around the Tudor Place workflow. The Search and Preview feature sections sit inside `.feature-glass`, a full-bleed dark translucent band with heavy `backdrop-filter` blur that separates the demo proof area from the continuous shader without changing the individual `.shot` card treatment. `.feature-corner-demo` mounts `demos/sidestream-panel-corner.webm` as a decorative VP9-alpha video on the right side of the hero/main page, starts its clipping wrapper at `40vw` with `width: 60vw`, keeps `.feature-glass` in normal post-hero flow, and positions the square full-plugin crop with a responsive `left` offset, `bottom: calc(clamp(-330px, -18.4vw, -230px) - 36vh)`, `width: max(1000px, 90vw)`, `opacity: 0.9`, `mix-blend-mode: screen`, `transform: scale(0.7)`, and `transform-origin: 4.75% 13.7%` so the visible Premiere placement sits lower and left while the actual WebM content, not a matte or zoomed crop, still overfills the right edge of the first viewport. The screen blend plus lowered opacity lets darker areas of the recording breathe into the shader without adding a fake background matte. Its `<source>` is desktop-gated with `media="(min-width: 901px)"`, and the bottom inline playback helper pauses it whenever `.feature-corner-demo` is hidden. The band spans the full feature wrapper vertically so the top and bottom separator lines have clear breathing room around the first and last demo videos. The Search and Preview feature copy blocks intentionally do not include inline download CTAs; each keeps the heading plus `.feature-subtext` as the centered copy block beside its demo video. They intentionally do not use the `autoplay` attribute; the bottom inline script uses `IntersectionObserver` to play each `.demo-video` only while it is visible and pause it when it leaves the viewport. On fine-pointer hover, the same script tilts the parent `.shot` from its midpoint with CSS variables capped at 15 degrees on X/Y and a tiny Z-axis twist, so the video frame reads as one subtle 3D plane. The hover math tracks against the card's untransformed layout box and resets with an S-curve transition to prevent corner-entry jitter. Raw Screen Studio project folders, ProRes `.mov` renders, and Premiere/After Effects project files should stay out of git; export compact MP4s or alpha WebMs for the site instead.

The page background should preserve the provided Paper demo's shader direction without keeping its demo-site UI. The canonical HTML keeps a black CSS fallback on `body`; `#shader-background-root` is a fixed full-viewport mount, and `src/main.tsx` renders the adapted `DemoOne` component from `components/ui/demo.tsx`. The demo's default `activeEffect` is `"mesh"`, so the visible background keeps the original simple black/charcoal/gray `MeshGradient` branch with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`. The active mesh branch is the plain Paper `MeshGradient`; it must not listen to pointer movement, add wake/ripple uniforms, jiggle the canvas, or layer extra mouse-driven overlays. Keep the background to the single Paper shader canvas with no drawn ripple outlines, extra canvases, new colors, CSS filters, or red fog. Page text tokens use the off-white `#E2E8F0` and translucent off-white variants for contrast, while cards and pricing surfaces are dark translucent glass.

The header is a fixed transparent overlay with no scroll divider so the shader remains uninterrupted behind the nav. The `.hero-pad` section fills the first viewport and aligns the hero headline, description, and primary Free Download CTA to the lower-left first-fold gutter. The Sidestream wordmark and hero copy share the viewport-left `24px` first-fold gutter, and the Features/Pricing/Free Download control cluster is absolutely anchored to the viewport's top-right corner with a `15px` top offset and matching `24px` right gutter.

On desktop, `.feature-start` keeps the Search demo group below the hero with positive top padding, creating a clear margin between the hero Free Download button and the "Search for YouTube videos." heading without changing the shared lower-page `.sec-pad` rhythm.

The pricing headline intentionally sits halfway between the bottom of the `.feature-glass` band and the pricing cards: `#pricing` overrides the shared section top padding to `92px`, while `.pricing-head` uses a matching `92px` bottom margin so the cards stay in place. The mobile override uses a matching `74px` top padding and bottom margin. `.pricing-line` keeps "Unlock when you need more." on its own lighter-weight line. The two pricing cards use a larger `28px` corner radius and a pricing-only `IntersectionObserver` that adds `html.pricing-motion-ready` plus `.is-visible` so the cards glide up once before they fully enter the viewport; no global `.reveal` behavior is restored. The $0 card is labeled "Free" and says "5 free downloads every day." The Pro plan is a visible `$4.99 once` one-time upgrade that links straight to `/api/checkout/start` with no account requirement before Stripe Checkout.

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
curl -i -X POST http://127.0.0.1:3000/api/download-lead \
  -H 'Content-Type: application/json' \
  --data '{"email":"test@example.com","page":"/","source":"/api/download"}'
curl -i -X POST http://127.0.0.1:3000/api/download-lead \
  -H 'Content-Type: application/json' \
  --data '{"email":"windows@example.com","page":"/","source":"windows-waitlist"}'
```

If Vercel Blob OIDC is disabled for the Development environment, local `/api/download` returns a Blob auth/config error even though Preview and Production have Blob env attached. Fix that in the Vercel Blob store settings, or add a valid `BLOB_READ_WRITE_TOKEN` for local development. `/api/download-lead` prefers Postgres when `POSTGRES_URL` or a supported `SIDESTREAM_POSTGRES_*` connection string is available and only needs Blob auth for the fallback path.

Apply the Postgres download-lead schema and migrate existing Blob leads:

```bash
SIDESTREAM_ENV_FILE=.env.local \
SIDESTREAM_DB_ENV_FILE=/Users/alexgarrett/alexg.mov/website/alexg/.env.local \
npm run leads:migrate
```

Apply all Postgres migrations, including account/billing tables:

```bash
SIDESTREAM_ENV_FILE=.env.local npm run db:migrate
```

The `20260707120000_enable_sidestream_server_table_rls.sql` migration is required for Supabase-hosted copies of the Sidestream SaaS tables. It locks down direct Supabase Data API access to leads, accounts, sessions, activation rows, license rows, license-token hashes, Stripe event payloads, and billing resource rows. Re-run the Supabase Security Advisor after applying it and smoke-test the Vercel API routes, because the app should keep using the server-only Postgres connection rather than browser-side Supabase policies.

Create or verify the sandbox-only `FREEDEV` Stripe promotion code for no-cost checkout testing:

```bash
SIDESTREAM_ENV_FILE=.env.local npm run billing:ensure-freedev
```

If Vercel protects the Stripe secret from local pulls, put the sandbox `STRIPE_SECRET_KEY` in a separate ignored env file and run:

```bash
SIDESTREAM_STRIPE_ENV_FILE=/path/to/stripe-sandbox.env npm run billing:ensure-freedev
```

Dump captured Sidestream download leads from Postgres:

```bash
SIDESTREAM_DB_ENV_FILE=/Users/alexgarrett/alexg.mov/website/alexg/.env.local \
npm run leads:dump
```

Build before publishing or after shader, TypeScript, Tailwind, static HTML, layout, or Vite config changes:

```bash
npm run build
```

## Git / Publishing

This folder is a git repository for `git@github.com:alexgmov/Sidestream-Website.git`.

Relevant tracked files are the canonical root HTML page, legacy static redirect, React shader entry/component files, Vite/Tailwind/shadcn config, README, `.thumbnail`, generated WebM/MP4 demo assets, and reference screenshots. Finder `.DS_Store`, `node_modules/`, `dist/`, raw demo source renders, Premiere/After Effects project files, and local auto-save/download folders are ignored.

The generated MacBook mockup video in `mockups/mockup1_2.webm` is tracked. Raw mockup production files in `mockups/` are intentionally ignored because they can be hundreds of megabytes.

The project is linked to Vercel project `alex-3685s-projects/sidestream`. `.vercel/`, `.env.local`, and other `.env*` files are ignored. The installer download pointer should be updated by changing the `SIDESTREAM_INSTALLER_BLOB_PATHNAME` Vercel env var after publishing a new private Blob artifact. Keep this pointer on the normal native/base `Mac-Installer.dmg` flow unless the product intentionally returns to the legacy ZXP-helper handoff. Keep `.vercelignore` aligned with the tracked publishable media files so Vercel CLI deploys do not upload raw local `demos/` and `mockups/` production assets.

`vercel.json` deliberately pins `installCommand`, `buildCommand`, and `devCommand` to npm. The dev command must pass Vercel's `$PORT` into Vite; otherwise `vercel dev` can accept connections on its proxy port and hang. If the Vercel dashboard still has an old package-manager preference, the repo config should win.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and check that the first fold intentionally places the hero copy lower than the older `Sidestream front end 2/screenshots/01-scan.png` reference.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- After SEO/GEO metadata changes, run `npm run build`, confirm `dist/robots.txt`, `dist/sitemap.xml`, `dist/llms.txt`, and `dist/sidestream-og.jpg` exist, and spot-check the built HTML for the absolute canonical URL, meta description, Open Graph/Twitter image tags, and valid JSON-LD.
- After publishing analytics changes, visit the deployed site without a content blocker and allow roughly 30 seconds before checking the Vercel Analytics dashboard for page-view data.
- Confirm the dark Paper shader renders behind the header, hero, cards, pricing, footer, and toast.
- Confirm the Sidestream wordmark and desktop hero copy share the viewport-left `24px` first-fold gutter, and the Features/Pricing/Free Download header cluster sits at the viewport's top-right with a `15px` top offset and `24px` right gutter.
- Confirm the brand wordmark, white pill-rounded download CTAs with the black Apple platform mark, black text, red hover fill/white hover text, check icons, and rotating noun gradient use the red accent palette without leftover orange accents.
- Confirm the background uses the pasted demo's black/charcoal/gray `MeshGradient` branch with the 20%-darker `#151515`, `#292929`, and `#a3a3a3` non-black stops, with no custom red CSS fog, extra overlay gradients, or mounted `EnergyRing`.
- Confirm moving the mouse across the desktop hero does not change the background. The backdrop should remain the plain Paper `MeshGradient` with one visible canvas, no wake/ripple artifacts, no whole-background jiggle, and no CTA hit-target interference.
- Confirm the final CTA panel stays clean above the pricing MacBook mockup and does not render the old top-right red radial glow.
- Confirm the pricing MacBook Pro mockup video autoplays, loops, stays muted, sits centered below the two pricing panels plus final CTA, and does not create horizontal overflow. If browser autoplay is fussy, confirm the inline `.macbook-mockup-video` playback helper kicks it after load or visibility return.
- Confirm the desktop hero copy still uses the wider left-anchored first-fold shell while staying aligned with the fixed Sidestream wordmark, sitting near the bottom-left corner of the first viewport, and rendering the "in Premiere Pro" subline in italic.
- Confirm the hero Windows waitlist button visually matches the Mac Free Download pill, uses a Windows mark instead of the Apple mark, opens a centered modal, validates invalid emails inline, submits valid emails to `/api/download-lead` with `source: "windows-waitlist"` under Vercel dev or deployment, and does not block the Mac download CTA.
- Watch the pricing MacBook rotation long enough to confirm the laptop stays centered and the alpha edges are not clipped by the pricing wrapper.
- Confirm the Search demo group starts below the first fold with a deliberate gap between the hero Free Download CTA and the "Search for YouTube videos." heading on desktop and mobile.
- Confirm the "Start free. Unlock when you need more." headline sits centered in the vertical space between the bottom of the `.feature-glass` band and the pricing cards.
- Confirm "Unlock when you need more." renders as the lighter-weight `.pricing-line`, while "Start free." stays heavier.
- Scroll down to pricing and confirm both pricing cards begin animating before the section feels empty, with the Pro card following the Free card by a slight stagger, both cards using visibly rounder 28px corners, and the Pro card using a white outline with no drop shadow.
- Confirm the Free card says "5 free downloads every day."
- Confirm the Pro card says `$4.99 once`, links directly to `/api/checkout/start`, and does not route users through the old Google-first upgrade interstitial.
- Confirm the feature demo videos are paused before they enter the viewport, start playing when scrolled into view, and pause again after leaving view.
- Confirm the Search and Preview feature sections have no inline download buttons, while the heading and subtext blocks stay vertically centered beside their demo videos on desktop and mobile.
- Confirm the `.feature-glass` backdrop spans the full x-axis behind the Search and Preview demo sections, blurs/darkens the shader behind it, and stays in its normal post-hero position.
- Confirm the decorative `.feature-corner-demo-video` starts from the `40vw` desktop wrapper, plays with `screen` blend and `0.9` opacity, renders at 70% scale from the visible Premiere top-left corner, uses real oversized WebM content to avoid right/bottom shader gaps after the down-left placement shift, keeps `.feature-glass` unmoved, and stays hidden and paused on mobile.
- Confirm the top and bottom `.feature-glass` separator lines leave enough vertical breathing room around the first Search demo video and last Preview demo video.
- Confirm hovering each feature demo video tilts the frame subtly from its center, with the top-right pointer position pushing the top-right corner away from the camera, no top-left corner-entry jitter, a smooth S-curve reset on exit, and no hover tilt on reduced-motion or coarse-pointer devices.
- Confirm `/api/download` responds to `HEAD` with `200`, `Content-Disposition: attachment`, `Content-Length`, and a private cache policy after Blob auth is available in the tested environment. Confirm `GET /api/download` returns a temporary redirect to a signed private Blob URL; when testing the deployed route, use a ranged follow such as `curl -L -r 0-0` to avoid downloading the full installer.
- Confirm download CTA clicks start the public installer immediately without opening the historical email modal.
- Confirm `npm run leads:dump` includes Windows waitlist submissions with `cta_source` equal to `windows-waitlist` when the checked environment has captured leads.
- With Vercel dev and account env configured, confirm `/api/checkout/start` redirects directly to Stripe Checkout in one-time payment mode with invoice creation enabled, successful Checkout returns to `/thank-you.html`, `/upgrade.html?checkout=cancelled` renders the retry fallback, `/account.html` can still sign in with Google for optional Customer Portal access, `/api/billing/receipt` returns the latest receipt URL for a signed-in one-time purchaser, `/api/stripe/webhook` accepts signed Stripe CLI events, and `/api/billing/portal` opens Customer Portal for a signed-in customer when Stripe has a customer to manage.
- Confirm `/api/activation/start` returns an activation URL, `/api/activation/status` stays pending before checkout, and returns a short-lived license token only after Stripe webhooks create an active one-time license.
- Scrub or watch the pricing MacBook rotation long enough to confirm hard alpha edges and video-plane edges do not show as dark lines.
- Let the hero rotating noun run through a full cycle and confirm each word swap stays smooth without bounce, clipping, or layout shift.
- Confirm the rotating noun gradient stays subtle, remains readable on "songs" and "overlays", and pauses under reduced-motion settings.
- Scroll from the hero through pricing and footer to confirm the background reads as one continuous fixed shader field without horizontal seams.
- Confirm `#E2E8F0` off-white and translucent off-white text remains readable over the dark shader on desktop and mobile.
- Confirm the background canvases are nonblank on desktop and mobile and continue rendering after scroll.
- Check desktop at `1280x748`, because all supplied reference screenshots use that size.
- Check mobile around `390x844` for text wrapping, CTA sizing, and image-card overflow.

## Known Gotchas

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
- The hero explanation lives in `.hero-description` below `.hero-subline`; keep it short, light, outside the animated H1, and explicit that Sidestream is a Premiere Pro panel for searching, previewing, and downloading YouTube videos without leaving the app.
- Download CTAs use a `[data-download]` button override that wins over primary/secondary button classes: white capsule background, a black Apple platform mark, black `Free Download` label, and red hover fill with white hover text while preserving existing sizing. Each download CTA should keep `aria-label="Free Download for Mac"` because the platform mark is visual-only, and should point at `https://sidestream-xi.vercel.app/api/download` unless the fulfillment host intentionally changes. Do not reintroduce the email modal as a blocking step without explicitly revisiting the unblocked installer strategy.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav. Keep `.nav-links` anchored from the full viewport rather than the centered first-fold shell, or the control cluster drifts inward on wider screens.
- Desktop hero-to-feature spacing is tuned with `.hero-pad` filling `100svh`, bottom-aligning content, and using `padding: 112px 0 clamp(72px, 9vh, 104px)`, plus `.feature-start { margin-top: 0; padding-top: clamp(96px, 12vh, 136px); }`. Keep `.feature-glass` in normal post-hero flow; if the right-side demo needs to fill more space, resize or reposition `.feature-corner-demo-video` instead of moving the frosted feature band. The mobile override uses `.hero-pad { padding: 128px 0 72px; }` and `.feature-start { padding-top: 84px; }`, with a narrower override of `64px`/`72px` at `520px`. Adjust those first-feature entries before changing shared `.sec-pad` rhythm, but keep the Search copy grid-centered beside its demo video.
- `.feature-corner-demo` is a non-interactive decorative layer after `#hero` and before `.feature-glass`. The wrapper currently starts at `40vw` and spans `60vw` so the recording can sit 10vw farther left while the clipping layer still ends at the viewport's right edge. Account for the WebM's transparent alpha padding before judging the visible Premiere corner. The current treatment uses a square full-plugin/timeline WebM crop, a responsive `left` offset, `bottom: calc(clamp(-330px, -18.4vw, -230px) - 36vh)`, `width: max(1000px, 90vw)`, `opacity: 0.9`, `mix-blend-mode: screen`, and a `scale(0.7)` transform around the visible Premiere top-left corner on `.feature-corner-demo-video`. That deliberately uses more source video, not a larger zoom of the old crop, to fill right/bottom gaps while keeping `.feature-glass` in normal flow; do not add background fills or box-shadow mattes because the alpha WebM will reveal them.
- Pricing headline placement is tuned independently from shared `.sec-pad`: `#pricing { padding-top: 92px; }`, `.pricing-head { margin-bottom: 92px; }`, and the mobile override uses matching `74px` top and bottom spacing. `.pricing-line` is intentionally `font-weight: 300`. The Pro card links to `/api/checkout/start`; server checkout price truth comes from async `getSidestreamProPriceId()` in `api/_lib/account.ts`, which validates `SIDESTREAM_PRO_PRICE_ID` when present, otherwise prefers the checked-in live default `price_1TqGeBDFKjeGlioXlV8fBGK8` before using the default Stripe Product `prod_UpwXh6oO1OmPyQ` and lookup key `sidestream_pro_once` for sandbox fallback. If the amount changes, create/switch to a new Stripe Price ID or update the helper constants, then update visible copy, JSON-LD, `llms.txt`, and README together. The pricing-card motion should stay scoped to `#pricing .plan.reveal`, use an early positive bottom `IntersectionObserver` margin, and avoid re-enabling global `.reveal` because it was previously disabled for environment fill-mode issues.
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
- Local account/billing testing also requires Vercel dev plus env vars: a server-only Postgres connection string (`SIDESTREAM_POSTGRES_URL` preferred, `POSTGRES_URL` fallback), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `SIDESTREAM_BASE_URL`. `SIDESTREAM_PRO_PRODUCT_ID` defaults to `prod_UpwXh6oO1OmPyQ`; `SIDESTREAM_PRO_PRICE_ID` overrides the checked-in default `price_1TqGeBDFKjeGlioXlV8fBGK8`, while sandbox/test keys can fall back to a valid `$4.99` Product Price through lookup key `sidestream_pro_once` if that live Price is missing. `SIDESTREAM_UNLIMITED_PRICE_ID` is only a legacy migration fallback when it points at the Pro Product. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are only needed when testing the optional account/Customer Portal sign-in path. Use environment placeholders for Stripe keys and obtain real values from the Stripe Dashboard; rotate any secret key that has been pasted into chat before using live mode.
- Switching a deployment from sandbox/test Stripe keys to live Stripe keys can leave existing account rows with customer IDs from the old mode. `findOrCreateStripeCustomer()` validates a saved customer against the currently configured Stripe mode before Checkout reuse and creates a fresh customer if Stripe returns `resource_missing`.
- Checkout Sessions currently pin `payment_method_types: ["card"]` so live Checkout works even before Stripe Dynamic Payment Methods are configured in the dashboard. Revisit this once the live Stripe account has the desired payment methods enabled.
- If a successful purchase still shows Free in the account page or the plugin keeps polling as limited, check Vercel production logs for `/api/stripe/webhook` and `/api/activation/status` before blaming the UI. A one-time Checkout deployment can fail if production DB migrations have not added `stripe_checkout_session_id` / `stripe_payment_intent_id`, or if `sidestream_accounts.google_sub` is still `NOT NULL`; `api/_lib/account.ts` now retries unprocessed duplicate events and self-heals the Stripe-first account nullability plus one-time license columns before writing a one-time license. Its one-time license constraint recovery must tolerate both `duplicate_object` and `duplicate_table`, because Postgres reports an existing constraint-backed unique index relation with `42P07`.
- Hosted Checkout only accepts promotion codes that already exist in the same Stripe account and mode as `STRIPE_SECRET_KEY`. The repo utility `npm run billing:ensure-freedev` creates or verifies the sandbox `FREEDEV` 100% off promotion code and refuses live keys unless `--allow-live` is passed intentionally. If Stripe Checkout says `FREEDEV` is invalid, first confirm the Checkout page is in sandbox mode, then run the utility with the same env file that powers that deployment. Vercel protected env pulls can return `STRIPE_SECRET_KEY=""`; in that case, use an ignored local env file through `SIDESTREAM_STRIPE_ENV_FILE`.
- Plain static servers such as `python -m http.server` do not compile `/src/main.tsx`, so the static HTML route can appear to lose the Paper shader background even though the markup is correct. Static servers also cannot serve local Vercel Functions; the visible download CTAs use the public Vercel download URL so static preview clicks still start the installer instead of hitting a local `/api/download` 404. Use Vite on the active preview port when visual-checking the background, and Vercel dev when testing the API routes themselves.
- Vercel Analytics depends on the compiled React entry in `src/main.tsx`. If analytics stops appearing, confirm the shader root still exists in the canonical HTML, the deployed bundle includes `@vercel/analytics/react`, the page was visited on the deployed Vercel URL, and content blockers are disabled for the check.
- Vercel CLI versions before the current `54.x` line can report stale Blob auth/token errors. Prefer `npx vercel@latest ...` for Blob store checks.
- `/api/download` uses the Blob SDK control-plane calls (`head`, `issueSignedToken`, `presignUrl`) and redirects on `GET`. Do not switch it back to SDK `get()` proxy streaming unless you have verified private object fetches in the deployed Vercel runtime; a broken `GET` can still look healthy if only `HEAD` is checked.
- Without `vercel.json`, `vercel dev` may inherit a Yarn command from the Vercel project settings and hang on machines without Yarn.
- The private Blob store currently has OIDC/env wired for Preview and Production. Development has `BLOB_STORE_ID` and the installer pathname, but local Blob reads still need Development OIDC enabled in Vercel Blob settings or a `BLOB_READ_WRITE_TOKEN`.
- Check the Vercel Blob/CDN usage guardrails above before changing the installer artifact, `/api/download`, CTA/email-gate volume, or demo media. The current ~216 MiB installer means the Hobby 10 GB Blob transfer allowance is small enough that a real launch can exhaust it.
- Production, Preview, and Development `SIDESTREAM_INSTALLER_BLOB_PATHNAME` should resolve to the uploaded native/base `sidestream/1.0.12/Sidestream-1.0.12-Mac-Installer.dmg` artifact. The `Mac-ZXP-Installer.dmg` path is the retired ZXP-helper handoff and should not be used for the public website download.
- The email gate is a website CTA gate, not hard security. A direct request to `/api/download` still serves the installer; true server-enforced lead capture would require issuing download tokens or moving `/api/download` behind a verified lead/session check.
- The Windows waitlist reuses `/api/download-lead` and stores its segment in `cta_source`; do not create a separate client-only endpoint or table unless the lead product needs a different data model. Keep the visible waitlist entry as the matching hero platform pill plus centered modal, not as a large inline email box.
- Download-lead capture and SaaS entitlement storage use a server-only Postgres pooler connection. Prefer `SIDESTREAM_POSTGRES_URL`; the code also accepts `SIDESTREAM_POSTGRES_PRISMA_URL`, `SIDESTREAM_POSTGRES_URL_NON_POOLING`, and generic Postgres variants as fallbacks. Do not expose a Postgres password, service-role key, or any private database URL to `Sidestream.html`, React browser code, or the CEP plugin.
- Supabase-hosted Sidestream SaaS tables must keep RLS enabled with no direct `anon` or `authenticated` table access. If a future feature needs browser-side Supabase reads or writes, add the narrow policy for that feature intentionally and document the public data shape; do not make the private account, session, activation, license, license-token, Stripe event, or lead tables broadly API-readable.
- The canonical URL is the deployed root, `https://sidestream-xi.vercel.app/`. Keep every crawler-facing URL in the HTML head, sitemap, `llms.txt`, and README pointed at `/`; the old `Sidestream%20front%20end%202/Sidestream.html` path should stay a noindex compatibility redirect.
- Keep structured data conservative and matched to visible page claims. Do not add FAQ, review, rating, or price claims unless the same facts are present in the visible landing page.
- `llms.txt` is useful as an AI-readable summary, but it is not a substitute for crawlable HTML, normal metadata, structured data, sitemap hygiene, or external citations/backlinks.

## Recent Change Log

- Promoted the public installer pointer to the private Blob `1.0.12` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.12-Mac-Installer.dmg`.
- Added a Supabase RLS hardening migration for server-owned Sidestream public tables, revoking direct `anon` and `authenticated` Data API table access while preserving the server-only Postgres route contract.
- Retired the first-week-unlimited free-trial offer, which was never implemented in the entitlement backend: the Free pricing card and `llms.txt` now say "5 free downloads every day," matching the plugin's actual free-tier daily cap. Only backend-issued Sidestream Pro license tokens bypass the cap.
- Replaced the inline hero Windows email box with a matching Windows platform pill that opens a centered waitlist modal.
- Added a hero Windows waitlist capture that posts emails to `/api/download-lead` with `source: "windows-waitlist"` while leaving Mac download CTAs unblocked.
- Promoted the public installer pointer to the private Blob `1.0.11` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.11-Mac-Installer.dmg`.
- Removed the account/subscription bullet from the Pro pricing card.
- Changed the Free pricing card copy from "Unlimited free downloads" to "Unlimited downloads for your first week."
- Sent successful Stripe Checkout returns to `thank-you.html`, kept cancelled Checkout on `upgrade.html`, and redirected legacy `upgrade.html?checkout=success` links to the new thank-you page.
- Added invoice creation for future one-time Stripe Checkout payments, a direct `/api/billing/receipt` route for existing one-time charge receipts, and account-page receipt/refund request controls so Customer Portal is not treated as the only purchase-history surface.
- Hardened Stripe webhook recovery so unprocessed duplicate events are retried, account/activation checks drain pending Stripe events, and Stripe-first account plus one-time checkout license columns/constraints self-heal when production missed migrations.
- Corrected Sidestream Pro checkout validation and visible pricing from `$9.99` to `$4.99` for Price `price_1TqGeBDFKjeGlioXlV8fBGK8`.
- Set the checked-in Sidestream Pro Checkout default to Stripe Price `price_1TqGeBDFKjeGlioXlV8fBGK8`, with sandbox fallback when local keys cannot see that live Price.
- Fixed Checkout customer reuse after sandbox-to-live Stripe key switches by validating saved Stripe customer IDs before passing them to Checkout.
- Renamed the paid one-time Checkout tier from Sidestream Unlimited to Sidestream Pro, switched new Checkout metadata to `sidestream_pro`, and resolved the `$9.99` Stripe Price from Product `prod_UpwXh6oO1OmPyQ` with legacy Unlimited webhook compatibility.
- Pinned one-time Stripe Checkout Sessions to card payments while the live Stripe account payment-method dashboard setup is incomplete.
- Removed the account page lede sentence so `account.html` goes straight from the account headline into the sign-in or account-management panel.
- Added a sandbox-guarded Stripe maintainer utility for creating/verifying the `FREEDEV` 100% off promotion code used to test no-cost Sidestream Pro Checkout.
- Promoted the public installer pointer to the private Blob `1.0.10` native/base DMG and redeployed production so `/api/download` serves `Sidestream-1.0.10-Mac-Installer.dmg`.
- Fixed `/api/checkout/start` and `/api/checkout/create` so one-time Checkout no longer depends on a stale hardcoded Stripe Price ID; the server now resolves the `$9.99` Product-backed Price before redirecting to Stripe.
- Changed the paid plan from a monthly subscription path to a `$9.99` one-time Stripe Checkout payment with webhook fulfillment for one-time Checkout Session IDs and no Google sign-in requirement before purchase.
- Moved the canonical landing page to the clean root URL, `https://sidestream-xi.vercel.app/`, and changed the old exported `Sidestream%20front%20end%202/Sidestream.html` path into a noindex compatibility redirect.
- Changed the $0 pricing card from Beta to Free and removed beta-tester wording from the free-plan copy, structured data, and `llms.txt`.
- Added direct Stripe-first checkout: `/api/checkout/start` now redirects public upgrade and plugin activation links straight to hosted Stripe Checkout, shows `Cancel anytime. Refund your last month at any time.` on the Stripe page, and lets webhooks create/link Stripe-first Sidestream accounts without requiring Google sign-in first.
- Removed `managed_payments[enabled]=true` from Checkout Sessions because Stripe rejects `custom_text` with Managed Payments; keeping the refund/cancel promise on the hosted Stripe page is the chosen product behavior.
- Changed the Stripe Basic subscription checkout source of truth from `$10/month` to `$4.99/month`, keyed persisted billing resources by Stripe mode, and made Checkout replace stale saved Prices instead of blindly reusing the old amount.
- Added Stripe subscription resource bootstrap: Checkout creates/reuses a persisted Basic subscription Product/default monthly Price through `public.sidestream_billing_resources` and uses the preview request version where required. Checkout Sessions no longer set `managed_payments[enabled]=true` because Stripe rejects that option when `custom_text` is present.
- Fixed Vercel API route helper imports to use explicit `.js` extensions so auth, activation, checkout, billing, and webhook functions resolve `api/_lib/account.ts` after production compilation.
- Added the MVP SaaS account flow: unblocked download CTAs, noindex `account.html` and `upgrade.html`, Google OAuth, Stripe Checkout, Customer Portal redirects, webhook-owned entitlement tables, plugin activation endpoints, short-lived license tokens, and a generic Postgres migration runner.
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

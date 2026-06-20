# Sidestream Landing Page

## Product Overview

Sidestream is an HTML-first landing page for a Premiere Pro panel that lets editors search, preview, and download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The main page remains a single canonical HTML document with embedded layout CSS and vanilla JavaScript, plus a small React/Tailwind layer mounted only for the full-page Paper shader background.

## File Map

- `Sidestream front end 2/Sidestream.html` - Canonical page implementation. Contains the shader mount root, header, hero, feature sections, pricing, final CTA, footer, styles, rotating-word script, and toast behavior.
- `index.html` - Root redirect so `http://localhost:5173/` and other local server roots open the canonical page instead of a directory listing.
- `components/ui/demo.tsx` - Adapted Paper demo component mounted as the page background. The active default effect keeps the original `MeshGradient` look with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`, with demo install/clipboard overlay text removed and hover currents plus soft circular pressure ripples implemented through the active shader uniforms.
- `components/ui/background-paper-shaders.tsx` - Exact pasted React Three Fiber shader primitives from the provided reference. They are kept as optional reference code and are not mounted by default.
- `api/download.ts` - Vercel Node Function that streams the configured private Vercel Blob installer to the browser through `/api/download`. Supports `GET` and `HEAD` only.
- `src/main.tsx` - React entry that mounts `DemoOne` into `#shader-background-root`.
- `src/paper-shaders-compat.d.ts` - Local TypeScript compatibility declarations for the pasted prop names that the installed Paper package does not type directly.
- `src/index.css` - Tailwind v4 theme/utilities import, `tw-animate-css`, shadcn theme tokens, and source paths for the background component. It avoids Tailwind preflight so the static HTML styles are not reset.
- `components.json` - shadcn configuration with aliases rooted at the repository root.
- `vite.config.ts` - Vite React/Tailwind build config with the root redirect and canonical Sidestream page as HTML inputs.
- `vercel.json` - Vercel deployment config. Forces npm install/build/dev commands and `dist` as the output directory so Vercel does not fall back to a stale Yarn project setting. The dev command passes Vercel's `$PORT` to Vite.
- `mockups/mockup1_2.webm` - Browser-sized autoplay alpha WebM generated from the cleaner local MacBook Pro mockup source and mounted below the pricing panels.
- `demos/search demo.mp4` and `demos/preview demo.mp4` - Autoplaying feature demo videos showing the Tudor Place search and preview workflow.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`
- Shader background - `#shader-background-root`, `src/main.tsx`, `components/ui/demo.tsx`, the active `InteractiveMeshGradient`/`usePointerCurrents` implementation, `components/ui/background-paper-shaders.tsx`, and `src/paper-shaders-compat.d.ts`
- Hero - `#hero`, `.hero-split`, `.hero-copy`, `.hero-title-line`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, `.hero-description`
- Feature sections - `#features` anchor, `.feature-glass` full-bleed frosted backdrop band, the two `.sec-pad` feature blocks, `.feature-subtext` heading sublines, `.shot` video frames, `.demo-video` MP4 embeds, the bottom inline viewport-playback observer, and the pointer-driven `.shot` 3D tilt handler
- Pricing - `#pricing`, `.pricing-head`, `.plans`, `.plan`, `.plan.featured`, `.final`, `.pricing-mockup`, `.macbook-mockup-video`, the MacBook playback helper, and the pricing-panel scroll reveal observer
- Final CTA - `.final` sits inside `#pricing` between the pricing cards and laptop mockup, with a single `/api/download` button
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download and purchase feedback - bottom inline `<script>` with `[data-download]`, `[data-purchase]`, and `#toast`; download CTAs now point at `/api/download` and use the CSS Apple platform mark from `.btn[data-download]::before`
- Installer fulfillment - `api/download.ts` reads `SIDESTREAM_INSTALLER_BLOB_PATHNAME` and streams the private Blob object with attachment headers

## Routes and Assets

There is no client router. Use Vite for local development so the TypeScript shader entry is compiled and served.

When using a local preview server, the root URL redirects to the canonical page:

```text
http://localhost:5173/
```

Vercel serves one serverless API route:

```text
GET /api/download
HEAD /api/download
```

`/api/download` streams the private Vercel Blob object named by `SIDESTREAM_INSTALLER_BLOB_PATHNAME`. The current configured pathname is:

```text
sidestream/latest/Sidestream-Mac-Installer.dmg
```

The Blob store is the private `products` store in Vercel project `sidestream`, store id `store_kuOwnXqAPvwc1sVU`, region `iad1`. Vercel Blob access is authenticated through either `VERCEL_OIDC_TOKEN` plus `BLOB_STORE_ID`, or a legacy `BLOB_READ_WRITE_TOKEN` if one is configured. `BLOB_STORE_ID` and `SIDESTREAM_INSTALLER_BLOB_PATHNAME` are set in the Vercel project environments; `.env.local` is generated by `vercel env pull` and must stay ignored. The website download should point at the native/base Mac installer DMG, not the older ZXP-helper DMG path.

The MacBook mockup media is a native autoplaying, muted, looping `<video>` that loads `../mockups/mockup1_2.webm` from the canonical HTML file. The generated VP9-alpha WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally. The mockup lives below the two pricing panels and the `.final` CTA inside `.pricing-mockup`, with the "Stop leaving Premiere to grab footage." panel now positioned above the laptop. It remains centered with a wide responsive video width and a soft bottom mask fade. It intentionally has no CSS drop shadow because filtering the alpha video can reveal a rectangular compositing edge during rotation. The bottom inline script keeps `.macbook-mockup-video` muted and calls `play()` on load/visibility return so the laptop continues spinning in normal browser viewing.

The feature cards are chrome-free video frames that use native muted, looping MP4s from `demos/`. The active demos are `search demo.mp4` and `preview demo.mp4`, both recorded around the Tudor Place workflow. The Search and Preview feature sections sit inside `.feature-glass`, a full-bleed dark translucent band with heavy `backdrop-filter` blur that separates the demo proof area from the continuous shader without changing the individual `.shot` card treatment. The band spans the full feature wrapper vertically so the top and bottom separator lines have clear breathing room around the first and last demo videos. The Search and Preview feature copy blocks intentionally do not include inline download CTAs; each keeps the heading plus `.feature-subtext` as the centered copy block beside its demo video. They intentionally do not use the `autoplay` attribute; the bottom inline script uses `IntersectionObserver` to play each `.demo-video` only while it is visible and pause it when it leaves the viewport. On fine-pointer hover, the same script tilts the parent `.shot` from its midpoint with CSS variables capped at 15 degrees on X/Y and a tiny Z-axis twist, so the video frame reads as one subtle 3D plane. The hover math tracks against the card's untransformed layout box and resets with an S-curve transition to prevent corner-entry jitter. Raw Screen Studio project folders should stay out of git; export compact MP4s for the site instead.

The page background should preserve the provided Paper demo's shader direction without keeping its demo-site UI. The canonical HTML keeps a black CSS fallback on `body`; `#shader-background-root` is a fixed full-viewport mount, and `src/main.tsx` renders the adapted `DemoOne` component from `components/ui/demo.tsx`. The demo's default `activeEffect` is `"mesh"`, so the visible background keeps the original black/charcoal/gray `MeshGradient` branch with non-black stops darkened 20% to `#151515`, `#292929`, and `#a3a3a3`. The active mesh branch uses `ShaderMount` with the Paper mesh fragment shader structure plus `u_pointer`, `u_pointerVelocity`, `u_hover`, and six decaying `u_ripple*` uniforms, making fine-pointer hovering steer the existing swirls with a broad curl-current field and soft circular pressure ripples. The ripples use UV displacement plus subtle same-shader monochrome normal shading so the circles read without adding colors. Keep this inside the single shader canvas; do not add drawn ripple outlines, overlays, extra canvases, new colors, or CSS filters. Page text tokens use the off-white `#E2E8F0` and translucent off-white variants for contrast, while cards and pricing surfaces are dark translucent glass.

The header is a fixed transparent overlay with no scroll divider so the shader remains uninterrupted behind the nav. The `.hero-pad` section fills the first viewport and aligns the hero headline, description, and primary Free Download CTA to the lower-left first-fold gutter. The Sidestream wordmark and hero copy share the viewport-left `24px` first-fold gutter, and the Features/Pricing/Free Download control cluster is absolutely anchored to the viewport's top-right corner with a `15px` top offset and matching `24px` right gutter.

On desktop, `.feature-start` keeps the Search demo group below the hero with positive top padding, creating a clear margin between the hero Free Download button and the "Search for YouTube videos." heading without changing the shared lower-page `.sec-pad` rhythm.

The pricing headline intentionally sits halfway between the bottom of the `.feature-glass` band and the pricing cards: `#pricing` overrides the shared section top padding to `92px`, while `.pricing-head` uses a matching `92px` bottom margin so the cards stay in place. The mobile override uses a matching `74px` top padding and bottom margin. `.pricing-line` keeps "Unlock when you need more." on its own lighter-weight line. The two pricing cards use a larger `28px` corner radius and a pricing-only `IntersectionObserver` that adds `html.pricing-motion-ready` plus `.is-visible` so the cards glide up once before they fully enter the viewport; no global `.reveal` behavior is restored. The Unlimited plan currently displays a `$19` one-time price across the card, purchase CTA, and final CTA copy.

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

To test the Vercel Function route locally, use the Vercel dev server instead of plain Vite:

```bash
npx vercel@latest dev --listen 127.0.0.1:3000
```

Then check:

```bash
curl -I http://127.0.0.1:3000/api/download
```

If Vercel Blob OIDC is disabled for the Development environment, local `/api/download` returns a Blob auth/config error even though Preview and Production have Blob env attached. Fix that in the Vercel Blob store settings, or add a valid `BLOB_READ_WRITE_TOKEN` for local development.

Build before publishing or after shader, TypeScript, Tailwind, static HTML, layout, or Vite config changes:

```bash
npm run build
```

## Git / Publishing

This folder is a git repository for `git@github.com:alexgmov/Sidestream-Website.git`.

Relevant tracked files are the root redirect, canonical static HTML page, React shader entry/component files, Vite/Tailwind/shadcn config, README, `.thumbnail`, the generated hero WebM, and reference screenshots. Finder `.DS_Store`, `node_modules/`, and `dist/` are ignored.

The generated MacBook mockup video in `mockups/mockup1_2.webm` is tracked. Raw mockup production files in `mockups/` are intentionally ignored because they can be hundreds of megabytes.

The project is linked to Vercel project `alex-3685s-projects/sidestream`. `.vercel/`, `.env.local`, and other `.env*` files are ignored. The installer download pointer should be updated by changing the `SIDESTREAM_INSTALLER_BLOB_PATHNAME` Vercel env var after publishing a new private Blob artifact. Keep this pointer on the normal native/base `Mac-Installer.dmg` flow unless the product intentionally returns to the legacy ZXP-helper handoff.

`vercel.json` deliberately pins `installCommand`, `buildCommand`, and `devCommand` to npm. The dev command must pass Vercel's `$PORT` into Vite; otherwise `vercel dev` can accept connections on its proxy port and hang. If the Vercel dashboard still has an old package-manager preference, the repo config should win.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and check that the first fold intentionally places the hero copy lower than the older `Sidestream front end 2/screenshots/01-scan.png` reference.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- Confirm the dark Paper shader renders behind the header, hero, cards, pricing, footer, and toast.
- Confirm the Sidestream wordmark and desktop hero copy share the viewport-left `24px` first-fold gutter, and the Features/Pricing/Free Download header cluster sits at the viewport's top-right with a `15px` top offset and `24px` right gutter.
- Confirm the brand wordmark, white pill-rounded download CTAs with the black Apple platform mark, black text, red hover fill/white hover text, check icons, and rotating noun gradient use the red accent palette without leftover orange accents.
- Confirm the background uses the pasted demo's black/charcoal/gray `MeshGradient` branch with the 20%-darker `#151515`, `#292929`, and `#a3a3a3` non-black stops, with no custom red CSS fog, extra overlay gradients, or mounted `EnergyRing`.
- Confirm moving or hovering the mouse across the desktop hero smoothly bends/pushes the existing shader bands like a broad current and emits soft circular pressure ripples that distort and subtly shade the background. Confirm the rings dissipate without harsh edges or line artifacts, this remains one visible canvas, and it does not block CTA hit targets.
- Confirm the final CTA panel stays clean above the pricing MacBook mockup and does not render the old top-right red radial glow.
- Confirm the pricing MacBook Pro mockup video autoplays, loops, stays muted, sits centered below the two pricing panels plus final CTA, and does not create horizontal overflow. If browser autoplay is fussy, confirm the inline `.macbook-mockup-video` playback helper kicks it after load or visibility return.
- Confirm the desktop hero copy still uses the wider left-anchored first-fold shell while staying aligned with the fixed Sidestream wordmark, sitting near the bottom-left corner of the first viewport, and rendering the "in Premiere Pro" subline in italic.
- Watch the pricing MacBook rotation long enough to confirm the laptop stays centered and the alpha edges are not clipped by the pricing wrapper.
- Confirm the Search demo group starts below the first fold with a deliberate gap between the hero Free Download CTA and the "Search for YouTube videos." heading on desktop and mobile.
- Confirm the "Start free. Unlock when you need more." headline sits centered in the vertical space between the bottom of the `.feature-glass` band and the pricing cards.
- Confirm "Unlock when you need more." renders as the lighter-weight `.pricing-line`, while "Start free." stays heavier.
- Scroll down to pricing and confirm both pricing cards begin animating before the section feels empty, with the Unlimited card following the Free card by a slight stagger, both cards using visibly rounder 28px corners, and the Unlimited card using a white outline with no drop shadow.
- Confirm the feature demo videos are paused before they enter the viewport, start playing when scrolled into view, and pause again after leaving view.
- Confirm the Search and Preview feature sections have no inline download buttons, while the heading and subtext blocks stay vertically centered beside their demo videos on desktop and mobile.
- Confirm the `.feature-glass` backdrop spans the full x-axis behind the Search and Preview demo sections, blurs/darkens the shader behind it, and does not overlap the hero, pricing headline, or mobile content.
- Confirm the top and bottom `.feature-glass` separator lines leave enough vertical breathing room around the first Search demo video and last Preview demo video.
- Confirm hovering each feature demo video tilts the frame subtly from its center, with the top-right pointer position pushing the top-right corner away from the camera, no top-left corner-entry jitter, a smooth S-curve reset on exit, and no hover tilt on reduced-motion or coarse-pointer devices.
- Confirm `/api/download` responds to `HEAD` with `200`, `Content-Disposition: attachment`, `Content-Length`, and a private cache policy after Blob auth is available in the tested environment.
- Confirm a browser click on any `/api/download` CTA starts a same-origin download navigation instead of only showing the old placeholder toast.
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
- The desktop hover current and circular pressure ripples live inside `components/ui/demo.tsx` as `InteractiveMeshGradient` plus `usePointerCurrents`. Keep them as shader UV displacement plus subtle monochrome same-shader ripple shading, not CSS blur/filter, particle decoration, drawn outlines, or a second visible overlay. They are intentionally gated to fine pointers, avoid a first-hover impulse, and are disabled under reduced motion.
- The current `@paper-design/shaders-react` types do not include the pasted `backgroundColor`, `wireframe`, `dotColor`, `orbitColor`, or `intensity` prop names. Keep `src/paper-shaders-compat.d.ts` so the copied component can remain unchanged.
- `components/ui/background-paper-shaders.tsx` is copied exactly from the reference and is excluded from app typechecking because the pasted `THREE.Mesh` generic is broader than this repo's strict TypeScript settings.
- Do not mount the optional React Three Fiber `ShaderPlane` or `EnergyRing` primitives in the active background unless the design intentionally calls for visible flares/rings.
- No Alphanica font asset exists in this folder. The hero headline uses the SF Pro system stack to match the cleaner non-serif section style without adding a font dependency. The "in Premiere Pro" `.hero-subline` intentionally uses the same stack in italic.
- The hero explanation lives in `.hero-description` below `.hero-subline`; keep it short, light, outside the animated H1, and explicit that Sidestream is a Premiere Pro panel for searching, previewing, and downloading YouTube videos without leaving the app.
- Download CTAs use a `[data-download]` button override that wins over primary/secondary button classes: white capsule background, a black Apple platform mark, black `Free Download` label, and red hover fill with white hover text while preserving existing sizing. Each `/api/download` CTA should keep `aria-label="Free Download for Mac"` because the platform mark is visual-only.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav. Keep `.nav-links` anchored from the full viewport rather than the centered first-fold shell, or the control cluster drifts inward on wider screens.
- Desktop hero-to-feature spacing is tuned with `.hero-pad` filling `100svh`, bottom-aligning content, and using `padding: 112px 0 clamp(72px, 9vh, 104px)`, plus `.feature-start { margin-top: 0; padding-top: clamp(96px, 12vh, 136px); }`. The mobile override uses `.hero-pad { padding: 128px 0 72px; }` and `.feature-start { padding-top: 84px; }`, with a narrower override of `64px`/`72px` at `520px`. Adjust those first-feature entries before changing shared `.sec-pad` rhythm, but keep the Search copy grid-centered beside its demo video.
- Pricing headline placement is tuned independently from shared `.sec-pad`: `#pricing { padding-top: 92px; }`, `.pricing-head { margin-bottom: 92px; }`, and the mobile override uses matching `74px` top and bottom spacing. `.pricing-line` is intentionally `font-weight: 300`. The Unlimited card uses a white border and no drop shadow. The pricing-card motion should stay scoped to `#pricing .plan.reveal`, use an early positive bottom `IntersectionObserver` margin, and avoid re-enabling global `.reveal` because it was previously disabled for environment fill-mode issues.
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
- Plain `npm run dev`/Vite does not run Vercel Functions. Use `npx vercel@latest dev` when testing `/api/download`.
- Vercel CLI versions before the current `54.x` line can report stale Blob auth/token errors. Prefer `npx vercel@latest ...` for Blob store checks.
- Without `vercel.json`, `vercel dev` may inherit a Yarn command from the Vercel project settings and hang on machines without Yarn.
- The private Blob store currently has OIDC/env wired for Preview and Production. Development has `BLOB_STORE_ID` and the installer pathname, but local Blob reads still need Development OIDC enabled in Vercel Blob settings or a `BLOB_READ_WRITE_TOKEN`.
- Production, Preview, and Development `SIDESTREAM_INSTALLER_BLOB_PATHNAME` should resolve to the stable native/base `sidestream/latest/Sidestream-Mac-Installer.dmg` artifact. The `Mac-ZXP-Installer.dmg` path is the legacy ZXP-helper handoff and should not be used for the public website download.

## Recent Change Log

- Switched the documented Vercel download pathname from the ZXP-helper DMG to the stable native/base Mac installer DMG and clarified that website fulfillment should stay on the normal DMG flow.
- Changed the visible Unlimited one-time price from `$29` to `$19` across the pricing card, purchase CTA, and final CTA copy.
- Increased the hero rotating noun slot's lower paint buffer so descenders like the `g` in `songs` no longer clip during the word cycle.
- Lowered the pricing headline by equalizing the space above and below it, centering it between the `.feature-glass` band and pricing cards without moving the cards.
- Moved the `.feature-glass` bottom separator to the end of the feature wrapper so the Preview demo video has more buffer above the lower line.
- Moved the `.feature-glass` top separator to the start of the feature wrapper so the Search demo video has more buffer below the line.
- Tuned the pricing-card reveal to trigger earlier with a shorter upward glide and tighter Unlimited-card stagger so the pricing section no longer feels empty while scrolling.
- Wrapped the Search and Preview demo sections in a single full-bleed `.feature-glass` dark frosted backdrop so that proof area is visually separated from the continuous shader background.
- Added back soft circular pressure ripples on top of the hover-controlled curl-current field, preserving the same colors, timing, and single-canvas mount while keeping ring edges broad and liquid instead of harsh.
- Added a black Apple platform mark inside the visible `Free Download` CTAs and accessible `Free Download for Mac` labels for `/api/download` links.
- Reworded the hero description to explicitly call Sidestream a panel inside Premiere Pro for searching, previewing, and downloading YouTube videos without leaving the app.
- Changed every visible `/api/download` CTA label from `Download` to `Free Download`.
- Moved the "Stop leaving Premiere to grab footage." final CTA panel above the rotating pricing MacBook mockup.
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
- Removed the red radial corner glow from the final "Stop leaving Premiere to grab footage." CTA panel.
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

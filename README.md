# Sidestream Landing Page

## Product Overview

Sidestream is an HTML-first landing page for a Premiere Pro plugin that lets editors download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The main page remains a single canonical HTML document with embedded layout CSS and vanilla JavaScript, plus a small React/Tailwind layer mounted only for the full-page Paper shader background.

## File Map

- `Sidestream front end 2/Sidestream.html` - Canonical page implementation. Contains the shader mount root, header, hero, feature sections, pricing, final CTA, footer, styles, rotating-word script, and toast behavior.
- `index.html` - Root redirect so `http://localhost:5173/` and other local server roots open the canonical page instead of a directory listing.
- `components/ui/demo.tsx` - Adapted Paper demo component mounted as the page background. The active default effect is the original `MeshGradient` branch with `["#000000", "#1a1a1a", "#333333", "#ffffff"]`, with demo install/clipboard overlay text removed.
- `components/ui/background-paper-shaders.tsx` - Exact pasted React Three Fiber shader primitives from the provided reference. They are kept as optional reference code and are not mounted by default.
- `src/main.tsx` - React entry that mounts `DemoOne` into `#shader-background-root`.
- `src/paper-shaders-compat.d.ts` - Local TypeScript compatibility declarations for the pasted prop names that the installed Paper package does not type directly.
- `src/index.css` - Tailwind v4 theme/utilities import, `tw-animate-css`, shadcn theme tokens, and source paths for the background component. It avoids Tailwind preflight so the static HTML styles are not reset.
- `components.json` - shadcn configuration with aliases rooted at the repository root.
- `vite.config.ts` - Vite React/Tailwind build config with the root redirect and canonical Sidestream page as HTML inputs.
- `mockups/mockup1_2.webm` - Browser-sized autoplay hero video generated from the cleaner local alpha MacBook Pro mockup source.
- `demos/search demo.mp4` and `demos/preview demo.mp4` - Autoplaying feature demo videos showing the Tudor Place search and preview workflow.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`
- Shader background - `#shader-background-root`, `src/main.tsx`, `components/ui/demo.tsx`, `components/ui/background-paper-shaders.tsx`, and `src/paper-shaders-compat.d.ts`
- Hero - `#hero`, `.hero-split`, `.hero-copy`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, `.hero-media`, `.hero-mockup-video`
- Feature sections - `#features` anchor, the two `.sec-pad` feature blocks, `.feature-subtext` heading sublines, `.shot` video frames, and `.demo-video` MP4 embeds
- Pricing - `#pricing`, `.plans`, `.plan`, `.plan.featured`
- Final CTA - `.final`
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download and purchase feedback - bottom inline `<script>` with `[data-download]`, `[data-purchase]`, and `#toast`

## Routes and Assets

There is no client router. Use Vite for local development so the TypeScript shader entry is compiled and served.

When using a local preview server, the root URL redirects to the canonical page:

```text
http://localhost:5173/
```

The hero media is a native autoplaying, muted, looping `<video>` that loads `../mockups/mockup1_2.webm` from the canonical HTML file. The generated VP9-alpha WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally.

The hero media wrapper intentionally uses a tall `24 / 25` aspect ratio while the video itself is wider than the wrapper. This lets the MacBook render large without clipping through the video plane. The video uses a soft bottom mask fade but no CSS drop shadow because filtering the alpha video can reveal a rectangular compositing edge during rotation.

The feature cards are chrome-free video frames that use native autoplaying, muted, looping MP4s from `demos/`. The active demos are `search demo.mp4` and `preview demo.mp4`, both recorded around the Tudor Place workflow. Raw Screen Studio project folders should stay out of git; export compact MP4s for the site instead.

The page background should preserve the provided Paper demo's shader direction without keeping its demo-site UI. The canonical HTML keeps a black CSS fallback on `body`; `#shader-background-root` is a fixed full-viewport mount, and `src/main.tsx` renders the adapted `DemoOne` component from `components/ui/demo.tsx`. The demo's default `activeEffect` is `"mesh"`, so the visible background is the original black/charcoal/gray/white `MeshGradient` branch. Page text tokens are white or translucent white for contrast, while cards and pricing surfaces are dark translucent glass.

The header is a fixed transparent overlay with no scroll divider so the shader remains uninterrupted behind the nav. The `.hero-pad` top padding leaves room below the 72px nav while keeping first-fold spacing tight.

On desktop, `.hero-pad` uses more bottom padding than top padding so the hero copy and MacBook mockup sit visually centered in a 14-inch MacBook browser viewport without changing the section height.

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

Build before publishing or after shader, TypeScript, Tailwind, static HTML, layout, or Vite config changes:

```bash
npm run build
```

## Git / Publishing

This folder is a git repository for `git@github.com:alexgmov/Sidestream-Website.git`.

Relevant tracked files are the root redirect, canonical static HTML page, React shader entry/component files, Vite/Tailwind/shadcn config, README, `.thumbnail`, the generated hero WebM, and reference screenshots. Finder `.DS_Store`, `node_modules/`, and `dist/` are ignored.

The generated hero video in `mockups/mockup1_2.webm` is tracked. Raw mockup production files in `mockups/` are intentionally ignored because they can be hundreds of megabytes.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and compare the first fold against `Sidestream front end 2/screenshots/01-scan.png`.
- Run `npm run build` after shader, TypeScript, Tailwind, HTML mount, Vite config, or package changes.
- Confirm the dark Paper shader renders behind the header, hero, cards, pricing, footer, and toast.
- Confirm the brand bug, CTA buttons, active pricing state, check icons, and rotating noun gradient use the red accent palette without leftover orange accents.
- Confirm the background uses the exact pasted demo's default black/charcoal/gray/white `MeshGradient` branch, with no custom red CSS fog, extra overlay gradients, or mounted `EnergyRing`.
- Confirm the hero MacBook Pro mockup video autoplays, loops, stays muted, and does not create horizontal overflow.
- Scrub or watch the hero MacBook rotation long enough to confirm hard alpha edges and video-plane edges do not show as dark lines.
- Let the hero rotating noun run through a full cycle and confirm each word swap stays smooth without bounce, clipping, or layout shift.
- Confirm the rotating noun gradient stays subtle, remains readable on "songs." and "overlays.", and pauses under reduced-motion settings.
- Scroll from the hero through pricing and footer to confirm the background reads as one continuous fixed shader field without horizontal seams.
- Confirm white and translucent-white text remains readable over the dark shader on desktop and mobile.
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
- The current `@paper-design/shaders-react` types do not include the pasted `backgroundColor`, `wireframe`, `dotColor`, `orbitColor`, or `intensity` prop names. Keep `src/paper-shaders-compat.d.ts` so the copied component can remain unchanged.
- `components/ui/background-paper-shaders.tsx` is copied exactly from the reference and is excluded from app typechecking because the pasted `THREE.Mesh` generic is broader than this repo's strict TypeScript settings.
- Do not mount the optional React Three Fiber `ShaderPlane` or `EnergyRing` primitives in the active background unless the design intentionally calls for visible flares/rings.
- No Alphanica font asset exists in this folder. The hero headline uses the SF Pro system stack to match the cleaner non-serif section style without adding a font dependency.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav.
- Desktop hero vertical placement is tuned with `.hero-pad { padding: 112px 0 176px; }`; keep the top and bottom padding total stable when nudging the hero so the first feature spacing does not drift.
- Feature heading sublines use `.feature-subtext` with the SF Pro system stack at a light weight; avoid restoring the old serif treatment unless the whole feature-heading direction changes.
- The large footer `.wordmark` intentionally uses a Helvetica-first bold stack instead of the global SF Pro stack.
- The rotating noun should stay on matched keyframe animations for both enter and exit. Mixing CSS transitions with keyed enter animations or adding overshoot makes the headline feel choppy.
- The rotating noun gradient should animate only `background-position` and color/filter values. Do not animate the word transform for the gradient drift or it will fight the roll keyframes.
- Text tokens are tuned for a dark shader background. If the page returns to a light background, retune `--ink`, `--ink-soft`, `--ink-faint`, surfaces, and button states together.
- If the MacBook mockup is resized, keep enough vertical room in `.hero-media` and preserve the bottom mask on `.hero-mockup-video`; a too-short 16:9 wrapper, unmasked video edge, or video-level CSS drop shadow can create a hard line around or below the laptop.
- Keep `mockups/mockup1_2.webm` checked after background changes; dark backgrounds can make transparent alpha edges more visible if the `.hero-mockup-video` mask or shadow is changed.
- Mobile split sections must override both `.split` and `.split.flip`; otherwise the more-specific desktop flipped grid can leave feature cards half-width on narrow screens.
- Feature demo cards use 1800 x 1080 MP4 exports and a chrome-free `.shot` frame with a `5 / 3` aspect ratio, matching the videos without crop. Keep future feature demos muted, looping, and compressed before committing.

## Recent Change Log

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

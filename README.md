# Sidestream Static Landing Page

## Product Overview

Sidestream is a static landing page for a Premiere Pro plugin that lets editors download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The page is a single HTML document with embedded CSS and JavaScript.

## File Map

- `Sidestream front end 2/Sidestream.html` - Canonical page implementation. Contains the header, hero, CSS light-ray background, feature sections, pricing, final CTA, footer, styles, and toast behavior.
- `index.html` - Root redirect so `http://localhost:8000/` and other local server roots open the canonical page instead of a directory listing.
- `mockups/mockup1_2.webm` - Browser-sized autoplay hero video generated from the cleaner local alpha MacBook Pro mockup source.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`
- Hero - `#hero`, `#hero::before`, `#hero::after`, `.hero-split`, `.hero-copy`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, `.hero-media`, `.hero-mockup-video`
- Feature sections - `#features` anchor, the three `.sec-pad` feature blocks, and `.feature-subtext` heading sublines
- Pricing - `#pricing`, `.plans`, `.plan`, `.plan.featured`
- Final CTA - `.final`
- Footer - `footer`, `.wordmark`, `.foot-top`, `.foot-bottom`
- Hero rotating noun - bottom inline `<script>` with `[data-rotating-word]`
- Download and purchase feedback - bottom inline `<script>` with `[data-download]`, `[data-purchase]`, and `#toast`

## Routes and Assets

There is no router or framework. Open `index.html` or `Sidestream front end 2/Sidestream.html` directly in a browser.

When using a local preview server, the root URL redirects to the canonical page:

```text
http://localhost:8000/
```

The hero media is a native autoplaying, muted, looping `<video>` that loads `../mockups/mockup1_2.webm` from the canonical HTML file. The generated WebM keeps the page publishable; source mockup files such as `.mov`, `.aep`, `.exr`, and `.usdz` are ignored so large production assets do not get committed accidentally.

The hero media wrapper intentionally uses a tall `24 / 25` aspect ratio while the video itself is wider than the wrapper. This lets the MacBook render large without clipping through the video/shadow plane. The video uses a soft bottom mask fade and lighter drop shadow so alpha-matte edges do not read as dark shader lines over the pale page background.

The feature screenshot cards are CSS-built placeholders that reference future image paths in their labels, such as `assets/screens/hero-panel.png`; those files are not present in this folder.

The Aurora-style page glow is implemented as one continuous fixed background field on `body` and `main::before`. It is intentionally tuned as a mostly white, low-opacity wash so the gradient stays subtle behind the hero and sections. Section backgrounds should stay transparent unless the section is intentionally framed, because separate section fills, borders, or repeated ray layers make the page look broken into bands. Do not add React, shadcn, Tailwind, or framer-motion just to change that background in this static page.

The header is a fixed transparent overlay with no scroll divider so the Aurora/light-ray hero background remains uninterrupted behind the nav. The `.hero-pad` top padding includes the 72px nav height to preserve the first-fold spacing.

The hero rotating-word effect is also static-page native: `.rotating-copy` provides the stable text slot, `.rotating-word` animates the current noun, and the bottom inline script cycles `[data-rotating-word]`. Incoming words always roll up from below with a subtle Bezier-style overshoot before settling. The active noun also uses a clipped orange/white/teal text gradient that drifts by animating `background-position` only. Do not add React or animation dependencies for this effect.

## Development Commands

No install or build command is required.

For a local preview server if needed:

```bash
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## Git / Publishing

This folder is a git repository for `git@github.com:alexgmov/Sidestream-Website.git`.

Relevant tracked files are the root redirect, canonical static HTML page, README, `.thumbnail`, the generated hero WebM, and reference screenshots. Finder `.DS_Store` files are ignored.

The generated hero video in `mockups/mockup1_2.webm` is tracked. Raw mockup production files in `mockups/` are intentionally ignored because they can be hundreds of megabytes.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and compare the first fold against `Sidestream front end 2/screenshots/01-scan.png`.
- Confirm the hero MacBook Pro mockup video autoplays, loops, stays muted, and does not create horizontal overflow.
- Scrub or watch the hero MacBook rotation long enough to confirm hard alpha edges and bottom shadow-plane edges do not show as dark lines.
- Confirm the rotating noun gradient stays subtle, remains readable on "songs." and "overlays.", and pauses under reduced-motion settings.
- Scroll from the hero through pricing and footer to confirm the background reads as one continuous gradient without horizontal seams or repeated shader lines.
- Confirm the page background stays mostly white and does not overpower the hero text, rotating noun gradient, or MacBook mockup.
- Check desktop at `1280x748`, because all supplied reference screenshots use that size.
- Check mobile around `390x844` for text wrapping, CTA sizing, and image-card overflow.

## Known Gotchas

- The project root was missing a README before this restoration.
- The page uses the local Apple/SF Pro system font stack and does not request external web fonts.
- Several screenshot files are duplicates or alternate experiments. Prefer the numbered scan series for the restored hero state.
- The pasted Aurora component references React, Tailwind, and shadcn conventions, but this project is static HTML. Translate those effects into local CSS unless the whole site is intentionally migrated.
- No Alphanica font asset exists in this folder. The hero headline uses the SF Pro system stack to match the cleaner non-serif section style without adding a font dependency.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav.
- Feature heading sublines use `.feature-subtext` with the SF Pro system stack at a light weight; avoid restoring the old serif treatment unless the whole feature-heading direction changes.
- The rotating noun gradient should animate only `background-position` and color/filter values. Do not animate the word transform for the gradient drift or it will fight the roll keyframes.
- Keep the page glow as one non-repeating field. Reintroducing hero-only ray overlays, pricing band backgrounds, section borders, or patterned placeholder fills will create visible seams again.
- Keep the page glow pale by tuning the shared `body` and `main::before` values instead of adding section-level white overlays.
- If the MacBook mockup is resized, keep enough vertical room in `.hero-media` and preserve the bottom mask on `.hero-mockup-video`; a too-short 16:9 wrapper or unmasked video edge creates a hard line below the laptop.
- Keep `mockups/mockup1_2.webm` on a light page background with the `.hero-mockup-video` bottom mask and lighter drop shadow. Dark page backgrounds make transparent alpha edges read as shader artifacts.
- Mobile split sections must override both `.split` and `.split.flip`; otherwise the more-specific desktop flipped grid can leave feature cards half-width on narrow screens.

## Recent Change Log

- Swapped the hero MacBook video to the cleaner `mockup1_2` alpha animation and generated a browser-sized WebM.
- Restored the page to a mostly white background and softened the MacBook video shadow/mask to reduce alpha edge artifacts during rotation.
- Added a subtle orange/white/teal animated gradient to the hero rotating noun.
- Increased the hero MacBook mockup scale by roughly 30% while preserving the taller media frame and bottom fade mask.
- Enlarged the hero headline/subline and MacBook mockup slightly, removed the hero-only shader layer, and made the page glow one continuous non-repeating background field.
- Fixed the mobile flipped-grid override so feature cards use the full mobile width.
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

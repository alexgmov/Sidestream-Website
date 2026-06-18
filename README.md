# Sidestream Static Landing Page

## Product Overview

Sidestream is a static landing page for a Premiere Pro plugin that lets editors download YouTube videos, songs, overlays, b-roll, references, tutorials, or audio without leaving Premiere. The page is a single HTML document with embedded CSS and JavaScript.

## File Map

- `Sidestream front end 2/Sidestream.html` - Canonical page implementation. Contains the header, hero, CSS light-ray background, feature sections, pricing, final CTA, footer, styles, and toast behavior.
- `index.html` - Root redirect so `http://localhost:8000/` and other local server roots open the canonical page instead of a directory listing.
- `Sidestream front end 2/screenshots/` - Reference desktop screenshots for restoring the previous look. The numbered `*-scan.png` files are the canonical before-state for the hero.
- `Sidestream front end 2/.thumbnail` - Export thumbnail that reflects an alternate sans-serif hero state.

## Feature Map

- Header/nav - `header`, `.nav`, `.brand`, `.nav-links`
- Hero - `#hero`, `#hero::before`, `#hero::after`, `.hero-split`, `.hero-copy`, `.rotating-copy`, `.rotating-word`, `.hero-subline`, `.shot`
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

The screenshot cards are CSS-built placeholders that reference future image paths in their labels, such as `assets/screens/hero-panel.png`; those files are not present in this folder.

The Aurora-style page glow is implemented directly in CSS on `main`, `main::before`, `#hero::before`, and `#hero::after`. Do not add React, shadcn, Tailwind, or framer-motion just to change that background in this static page.

The header is a fixed transparent overlay so the Aurora/light-ray hero background remains visible behind the nav. The `.hero-pad` top padding includes the 72px nav height to preserve the first-fold spacing.

The hero rotating-word effect is also static-page native: `.rotating-copy` provides the stable text slot, `.rotating-word` animates the current noun, and the bottom inline script cycles `[data-rotating-word]`. Incoming words always roll up from below with a subtle Bezier-style overshoot before settling. Do not add React or animation dependencies for this effect.

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

Relevant tracked files are the root redirect, canonical static HTML page, README, `.thumbnail`, and reference screenshots. Finder `.DS_Store` files are ignored.

## Testing Guide

Use the narrowest relevant check after edits:

- Open the HTML page and compare the first fold against `Sidestream front end 2/screenshots/01-scan.png`.
- Check desktop at `1280x748`, because all supplied reference screenshots use that size.
- Check mobile around `390x844` for text wrapping, CTA sizing, and image-card overflow.

## Known Gotchas

- The project root was missing a README before this restoration.
- The page uses Google Fonts for Cormorant Garamond and Inter. If fonts are blocked, the hero will fall back to local serif/sans fonts and will not be pixel-identical.
- Several screenshot files are duplicates or alternate experiments. Prefer the numbered scan series for the restored hero state.
- The pasted Aurora component references React, Tailwind, and shadcn conventions, but this project is static HTML. Translate those effects into local CSS unless the whole site is intentionally migrated.
- No Alphanica font asset exists in this folder. The hero headline uses the existing sans-serif stack to match the cleaner non-serif section style without adding a font dependency.
- Because the header is fixed, `html` uses `scroll-padding-top: 72px` so anchor navigation does not hide section headings under the nav.
- Feature heading sublines use `.feature-subtext` with the Helvetica-style sans stack at a light weight; avoid restoring the old serif treatment unless the whole feature-heading direction changes.

## Recent Change Log

- Reduced the hero split, headline, subline, CTA, and hero spacing to make the first-fold hero group about 30% smaller.
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
- Changed feature heading sublines from the old serif accent style to lighter Helvetica-style subtext.
- Increased the hero "in Premiere Pro" subline to a medium Helvetica-style weight.
- Made the header a transparent fixed overlay above the Aurora hero background, preserved hero spacing with extra top padding, and added anchor scroll padding for fixed-nav links.
- Changed the hero rotating noun to always roll upward with a subtle Bezier overshoot.
- Added a root `index.html` redirect so the local server root opens the canonical Sidestream page.
- Replaced the hero rotating noun rebound with smoother directional Bezier-style roll-off motion.
- Lightened the hero "in Premiere Pro" subline with a thinner Helvetica-style treatment.
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

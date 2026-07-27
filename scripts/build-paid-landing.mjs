#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const PAID_LANDING_ENTRY_TOKEN_PLACEHOLDER =
  "__SIDESTREAM_PAID_ENTRY_TOKEN__";
export const PAID_CHECKOUT_PATH = "/api/paid-acquisition/checkout";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const canonicalPath = path.join(repositoryRoot, "index.html");
const paidLandingPath = path.join(repositoryRoot, "mobile-paid-prototype.html");

function replaceOnce(source, search, replacement, label) {
  const firstIndex = source.indexOf(search);
  if (firstIndex === -1) {
    throw new Error(`Unable to build paid landing: missing ${label}.`);
  }
  if (source.indexOf(search, firstIndex + search.length) !== -1) {
    throw new Error(`Unable to build paid landing: duplicate ${label}.`);
  }
  return source.slice(0, firstIndex) + replacement + source.slice(firstIndex + search.length);
}

function replaceRange(source, start, end, replacement, label) {
  const startIndex = source.indexOf(start);
  if (startIndex === -1) {
    throw new Error(`Unable to build paid landing: missing ${label} start.`);
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex === -1) {
    throw new Error(`Unable to build paid landing: missing ${label} end.`);
  }
  return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

const variantStyles = `
  /* Paid /mc render contract: preserve the approved mobile composition. */
  html[data-mobile-paid-variant],
  html[data-mobile-paid-variant] body {
    max-width: 100%;
    overflow-x: clip;
  }

  html[data-mobile-paid-variant] #mobile-paid-checkout .mobile-paid-purchase-button {
    display: inline-flex;
    min-height: 52px;
    width: 100%;
  }

  html[data-mobile-paid-variant] .btn:focus-visible {
    outline: 3px solid #fff;
    outline-offset: 3px;
  }

  html[data-mobile-paid-variant] .mobile-paid-checkout-status {
    min-height: 1.5em;
    margin: 10px 0 0;
    color: rgba(226, 232, 240, 0.88);
    font-size: 0.9rem;
  }

  html[data-mobile-paid-variant] .mobile-paid-checkout-status:empty {
    display: none;
  }

  html[data-mobile-paid-variant] .mobile-paid-checkout-status.is-error {
    color: #ff9b9b;
  }

  @media (max-width: 900px) {
    html[data-mobile-paid-variant] #pricing .plans {
      max-width: 620px;
    }

    html[data-mobile-paid-variant] #pricing .pricing-mockup {
      margin-top: 36px;
    }
  }
`;

const mobilePurchaseCard = `          <form class="mobile-download-handoff" id="mobile-paid-checkout" data-paid-checkout novalidate>
            <p class="mobile-download-handoff-title">Purchase Sidestream</p>
            <p class="mobile-download-handoff-subtext">We’ll email your download link after purchase.</p>
            <div class="mobile-download-handoff-fields">
              <button class="btn btn-primary mobile-download-handoff-submit mobile-paid-purchase-button" type="submit" aria-label="Buy Sidestream Pro now for $9.99, one-time purchase">Buy Now $9.99</button>
            </div>
            <p class="mobile-paid-checkout-status" id="mobile-paid-checkout-status" role="status" aria-live="polite"></p>
          </form>
`;

const paidCheckoutScript = `    // The /mc router replaces the bounded token placeholder before this internal
    // artifact is returned. Rendering never starts Checkout.
    const paidCheckoutForm = document.getElementById("mobile-paid-checkout");
    const paidCheckoutStatus = document.getElementById("mobile-paid-checkout-status");
    const paidCheckoutButtons = Array.from(document.querySelectorAll("[data-paid-checkout-button]"));
    const paidEntryToken = document
      .querySelector('meta[name="sidestream-paid-entry-token"]')
      ?.getAttribute("content") || "";
    let paidCheckoutIdempotencyKey = "";

    function getPaidCheckoutIdempotencyKey() {
      if (paidCheckoutIdempotencyKey) return paidCheckoutIdempotencyKey;
      if (!window.crypto || typeof window.crypto.randomUUID !== "function") return "";
      paidCheckoutIdempotencyKey = window.crypto.randomUUID();
      return paidCheckoutIdempotencyKey;
    }

    function setPaidCheckoutPending(isPending) {
      paidCheckoutForm
        ?.querySelectorAll("button")
        .forEach((button) => {
          button.disabled = isPending;
        });
      paidCheckoutButtons.forEach((button) => {
        button.disabled = isPending;
      });
    }

    async function startPaidCheckout() {
      if (!paidCheckoutForm || !paidCheckoutStatus) return;

      paidCheckoutStatus.classList.remove("is-error");
      const idempotencyKey = getPaidCheckoutIdempotencyKey();
      if (
        paidEntryToken.startsWith("__SIDESTREAM_") ||
        !paidEntryToken ||
        !idempotencyKey
      ) {
        paidCheckoutStatus.textContent = "Checkout is unavailable. Refresh and try again.";
        paidCheckoutStatus.classList.add("is-error");
        return;
      }

      setPaidCheckoutPending(true);
      paidCheckoutStatus.textContent = "Opening secure checkout…";

      try {
        const response = await fetch("${PAID_CHECKOUT_PATH}", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            schemaVersion: 1,
            entryToken: paidEntryToken,
            idempotencyKey
          })
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || typeof result.url !== "string") {
          throw new Error("paid_checkout_unavailable");
        }

        const checkoutUrl = new URL(result.url);
        if (checkoutUrl.protocol !== "https:") {
          throw new Error("paid_checkout_invalid_redirect");
        }
        window.location.assign(checkoutUrl.href);
      } catch (error) {
        paidCheckoutStatus.textContent = "Checkout is unavailable. Try again.";
        paidCheckoutStatus.classList.add("is-error");
        setPaidCheckoutPending(false);
      }
    }

    paidCheckoutForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      startPaidCheckout();
    });
    paidCheckoutButtons.forEach((button) => {
      button.addEventListener("click", startPaidCheckout);
    });
`;

export function buildPaidLanding(canonicalHtml) {
  const sourceHash = createHash("sha256").update(canonicalHtml).digest("hex");
  let output = canonicalHtml;

  output = replaceOnce(
    output,
    "<!DOCTYPE html>\n",
    `<!DOCTYPE html>\n<!-- Generated by scripts/build-paid-landing.mjs from index.html. Do not hand-edit. source-sha256: ${sourceHash} -->\n`,
    "doctype"
  );
  output = replaceOnce(
    output,
    '<html lang="en">',
    '<html lang="en" data-mobile-paid-variant data-mobile-paid-variant-ready="true">',
    "html root"
  );
  output = replaceOnce(
    output,
    "<title>Sidestream - Download YouTube Videos in Premiere Pro</title>",
    "<title>Sidestream Pro — $9.99 one-time</title>",
    "document title"
  );
  output = replaceOnce(
    output,
    '<meta name="robots" content="index, follow, max-image-preview:large" />',
    '<meta name="robots" content="noindex,nofollow" />\n<meta name="sidestream-paid-entry-token" content="' +
      PAID_LANDING_ENTRY_TOKEN_PLACEHOLDER +
      '" />',
    "robots metadata"
  );
  output = output.replace(
    /\n<script type="application\/ld\+json">[\s\S]*?<\/script>/g,
    ""
  );
  output = replaceOnce(
    output,
    "</style>",
    variantStyles + "\n</style>",
    "primary style block"
  );
  output = replaceRange(
    output,
    '  <div class="email-gate" id="download-email-gate" hidden>',
    "  <!-- ===================== HEADER ===================== -->",
    "  <!-- ===================== HEADER ===================== -->",
    "email and waitlist dialogs"
  );
  output = replaceRange(
    output,
    '          <div class="cta-row desktop-download-ctas">',
    '          <form class="mobile-download-handoff" id="mobile-download-handoff" novalidate>',
    "",
    "desktop-only CTA row"
  );
  output = replaceRange(
    output,
    '          <form class="mobile-download-handoff" id="mobile-download-handoff" novalidate>',
    "        </div>\n      </div>\n    </section>",
    mobilePurchaseCard + "        </div>\n      </div>\n    </section>",
    "mobile handoff"
  );
  output = replaceOnce(
    output,
    '<h2>Start free.<span class="pricing-line">Unlock when you need more.</span></h2>',
    '<h2>Get Sidestream Pro.<span class="pricing-line">One payment. Unlimited downloads.</span></h2>',
    "pricing heading"
  );
  output = replaceRange(
    output,
    '          <div class="plan reveal">',
    '          <div class="plan featured reveal"',
    '          <div class="plan featured reveal"',
    "free plan"
  );
  output = replaceOnce(
    output,
    '<p class="plan-name">Pro <span class="pill">One-time</span></p>',
    '<p class="plan-name">Sidestream Pro <span class="pill">One-time</span></p>',
    "Pro plan name"
  );
  output = replaceOnce(
    output,
    '<a class="btn btn-primary" href="/upgrade.html">Upgrade to Pro</a>',
    '<button class="btn btn-primary" type="button" data-paid-checkout-button aria-label="Buy Sidestream Pro for $9.99, one-time purchase">Buy Now</button>',
    "Pro purchase action"
  );
  output = replaceRange(
    output,
    '        <div class="final reveal">',
    '        <div class="pricing-mockup reveal"',
    '        <div class="pricing-mockup reveal"',
    "final free CTA"
  );
  output = replaceOnce(
    output,
    '  <div class="toast" id="toast"><span class="spinner"></span><span id="toast-msg">Starting your download…</span></div>\n\n',
    "",
    "download toast"
  );
  output = replaceRange(
    output,
    "    // Download / purchase actions",
    "  </script>\n</body>",
    paidCheckoutScript + "  </script>\n</body>",
    "download action script"
  );

  if (!output.includes('<link rel="canonical" href="https://sidestream.tv/" />')) {
    throw new Error("Unable to build paid landing: canonical root changed.");
  }
  if (output.includes("/index.html")) {
    throw new Error("Unable to build paid landing: runtime canonical fetch remains.");
  }

  return output;
}

async function run() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new Error("Usage: node scripts/build-paid-landing.mjs [--check]");
  }

  const canonicalHtml = await readFile(canonicalPath, "utf8");
  const expected = buildPaidLanding(canonicalHtml);

  if (args[0] === "--check") {
    const current = await readFile(paidLandingPath, "utf8").catch(() => "");
    if (current !== expected) {
      throw new Error(
        "mobile-paid-prototype.html is stale. Run node scripts/build-paid-landing.mjs."
      );
    }
    console.log("Paid landing artifact is current.");
    return;
  }

  await writeFile(paidLandingPath, expected);
  console.log(`Wrote ${path.relative(repositoryRoot, paidLandingPath)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

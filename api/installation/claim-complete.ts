import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  getBaseUrl,
  methodNotAllowed,
  resolveRequestLicenseEnvironment,
  type AccountRequest,
} from "../_lib/account.js";
import {
  readBrowserAcquisitionCookie,
  verifyBrowserAcquisitionCookie,
} from "../_lib/acquisition-cookie.js";
import {
  ANONYMOUS_INSTALL_CLAIM_SECRET_NAME,
  AnonymousInstallationClaimError,
  completeAnonymousInstallationClaim,
  markAnonymousInstallationClaimBrowserOpened,
} from "../_lib/anonymous-install-claim.js";

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100svh;
    background: #080809;
    color: #f5f5f7;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .shell {
    display: grid;
    grid-template-rows: auto 1fr;
    min-height: 100vh;
    min-height: 100svh;
    max-width: 1120px;
    margin: 0 auto;
    padding: 28px 24px;
  }
  .brand {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  main {
    width: 100%;
    max-width: 520px;
    justify-self: center;
    align-self: center;
    padding: 64px 0 88px;
    text-align: center;
  }
  .confirmation {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    margin: 0 auto 28px;
    border: 1px solid #264a39;
    border-radius: 50%;
    background: #10241a;
  }
  .confirmation::after {
    content: "";
    width: 23px;
    height: 13px;
    margin-top: -6px;
    border-left: 3px solid #6ee7a0;
    border-bottom: 3px solid #6ee7a0;
    transform: rotate(-45deg);
  }
  h1 {
    margin: 0;
    font-size: clamp(32px, 6vw, 46px);
    font-weight: 600;
    letter-spacing: -0.045em;
    line-height: 1.12;
    text-wrap: balance;
  }
  .description {
    margin: 16px 0 0;
    color: #a1a1aa;
    font-size: 17px;
    line-height: 1.6;
  }
  .next-step {
    display: flex;
    align-items: center;
    gap: 16px;
    max-width: 420px;
    margin: 36px auto 0;
    padding: 22px;
    border: 1px solid #2a2a2e;
    border-radius: 16px;
    background: #131315;
    text-align: left;
  }
  .premiere-icon {
    display: grid;
    place-items: center;
    flex: 0 0 48px;
    height: 48px;
    border-radius: 10px;
    background: #00005b;
    color: #9999ff;
    font-size: 25px;
    font-weight: 600;
    letter-spacing: -0.04em;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.5;
  }
  .next-step p {
    margin: 4px 0 0;
    color: #a1a1aa;
    font-size: 14px;
    line-height: 1.6;
  }
  @media (max-width: 380px) {
    .shell { padding: 24px 20px; }
    .next-step { gap: 12px; padding: 18px 16px; }
  }
`;

// Permit only this static stylesheet while keeping scripts and requests blocked.
const STYLE_HASH = createHash("sha256").update(STYLES).digest("base64");
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Sidestream connected</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="shell">
    <header class="brand">Sidestream</header>
    <main aria-labelledby="connected-title">
      <div class="confirmation" aria-hidden="true"></div>
      <h1 id="connected-title">Sidestream connected.</h1>
      <p class="description">You can close this tab now.</p>
      <section class="next-step" aria-labelledby="next-step-title">
        <span class="premiere-icon" aria-hidden="true">Pr</span>
        <div>
          <h2 id="next-step-title">Return to Premiere Pro.</h2>
          <p>Continue in the Sidestream panel.</p>
        </div>
      </section>
    </main>
  </div>
</body>
</html>`;

export default async function handler(
  request: AccountRequest,
  response: ServerResponse,
) {
  setPrivateHtmlHeaders(response);
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") return methodNotAllowed(response, "GET");

  const environment = resolveRequestLicenseEnvironment(request);
  const secret = process.env[ANONYMOUS_INSTALL_CLAIM_SECRET_NAME] || "";
  if (!environment || Buffer.byteLength(secret, "utf8") < 32) {
    return sendConnectedHtml(response, 503);
  }
  const requestUrl = new URL(
    request.url || "/api/installation/claim-complete",
    getBaseUrl(request),
  );
  const nonceValues = requestUrl.searchParams.getAll("nonce");
  if (
    nonceValues.length !== 1 ||
    !nonceValues[0] ||
    [...requestUrl.searchParams.keys()].some((key) => key !== "nonce")
  ) {
    return sendConnectedHtml(response, 400);
  }

  try {
    await markAnonymousInstallationClaimBrowserOpened({ nonce: nonceValues[0] }, {
      environment,
      secret,
    });
  } catch (error) {
    if (error instanceof AnonymousInstallationClaimError) {
      if (error.code === "claim_expired") return sendConnectedHtml(response, 410);
      if (error.code === "invalid_claim" || error.code === "invalid_request") {
        return sendConnectedHtml(response, 400);
      }
    }
    return sendConnectedHtml(response, 503);
  }

  let acquisition: Readonly<{ acquisitionId: string; token: string }>;
  try {
    const cookieValue = readBrowserAcquisitionCookie(request.headers.cookie);
    acquisition = verifyBrowserAcquisitionCookie(cookieValue, {
      secret,
    });
  } catch {
    // Missing or forged browser state is deliberately indistinguishable from a
    // successful optional association and never consumes the one-time claim.
    return sendConnectedHtml(response, 200);
  }

  try {
    const completed = await completeAnonymousInstallationClaim({
      nonce: nonceValues[0],
      acquisitionId: acquisition.acquisitionId,
      acquisitionToken: acquisition.token,
    }, {
      environment,
      secret,
    });
    return sendConnectedHtml(
      response,
      completed.outcome === "expired"
        ? 410
        : completed.outcome === "conflict"
          ? 409
          : 200,
    );
  } catch (error) {
    if (error instanceof AnonymousInstallationClaimError) {
      if (error.code === "claim_expired") return sendConnectedHtml(response, 410);
      if (error.code === "invalid_claim" || error.code === "invalid_request") {
        return sendConnectedHtml(response, 400);
      }
    }
    return sendConnectedHtml(response, 503);
  }
}

function setPrivateHtmlHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function sendConnectedHtml(response: ServerResponse, statusCode: number) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(HTML)));
  response.end(HTML);
}

export function renderMissingPaidEntitlementPage(email: string) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>We’re not seeing your purchase.</title><style>body{margin:0;background:#0b0b0b;color:#e2e8f0;font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;max-width:560px;margin:24px;padding:32px;border:1px solid #333;border-radius:24px;background:#151515}h1{margin:0 0 16px;font-size:30px;line-height:1.05}p{line-height:1.55}.muted{color:#aab2bf}.support{box-sizing:border-box;display:inline-block;min-height:48px;margin-top:18px;border-radius:999px;background:#fff;color:#111;padding:13px 20px;font-weight:650;text-decoration:none}@media(max-width:520px){.card{padding:24px}.support{width:100%;text-align:center}}</style></head><body><main class="card"><h1>We’re not seeing your purchase.</h1><p>If you already upgraded, contact Sidestream support.</p><p class="muted">Signed in as ${escapeHtml(email)}</p><p class="muted">We will help verify the account used for your purchase.</p><a class="support" href="mailto:alex@alexg.mov">Contact Sidestream support</a></main></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

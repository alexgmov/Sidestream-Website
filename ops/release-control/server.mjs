import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const COOKIE = "__Host-sidestream-rollout";
const PUBLIC_MANIFEST = "https://sidestream.tv/api/releases/latest?platform=win32-x64";
const run = promisify(execFile);

export function validateChange(body) {
  if (!body || Object.keys(body).sort().join() !== "artifactSha256,expectedPercent,rolloutPercent,version"
    || !/^\d+\.\d+\.\d+$/.test(body.version || "")
    || !/^[a-f0-9]{64}$/.test(body.artifactSha256 || "")
    || ![body.expectedPercent, body.rolloutPercent].every((value) => Number.isInteger(value) && value >= 0 && value <= 100)) {
    throw new Error("Invalid rollout request.");
  }
  return body;
}

function equal(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function bodyJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 2048) throw new Error("Request too large.");
  }
  return JSON.parse(body);
}

export function createControlServer({ secret, applyChange, fetchManifest, now = Date.now }) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Owner access is not configured.");
  let job = null;
  const attempts = new Map();
  const signature = (value) => createHmac("sha256", secret).update(value).digest("hex");
  const authenticated = (request) => {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
    const [expiry, nonce, sig] = cookie.split(".");
    return /^\d+$/.test(expiry || "") && Number(expiry) > now()
      && Number(expiry) <= now() + 31 * 86400_000 && equal(sig, signature(`${expiry}.${nonce}`));
  };
  return http.createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(data));
    };
    try {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return send(403, { error: "Local gateway only." });
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/status" && request.method === "GET") {
        return send(200, { authenticated: authenticated(request), ...(authenticated(request) ? { job } : {}) });
      }
      if (request.method !== "POST" || !["/login", "/save"].includes(url.pathname)) return send(404, { error: "Not found." });
      // The browser must send a custom header; cross-origin forms cannot do so.
      // No CORS support is exposed, and the cookie is Secure/HttpOnly/Strict.
      if (request.headers["x-sidestream-rollout"] !== "1"
        || !String(request.headers["content-type"] || "").startsWith("application/json")) return send(403, { error: "Use the dashboard control." });
      if (url.pathname === "/login") {
        const key = request.headers["x-real-ip"] || request.socket.remoteAddress;
        const time = now();
        for (const [ip, attempt] of attempts) if (time - attempt.since >= 600_000) attempts.delete(ip);
        const attempt = attempts.get(key) || { since: time, count: 0 };
        if (attempt.count >= 5 || (!attempts.has(key) && attempts.size >= 1000)) return send(429, { error: "Please wait before trying again." });
        attempt.count += 1; attempts.set(key, attempt);
        const body = await bodyJson(request);
        if (!equal(body.key, secret)) return send(401, { error: "Owner access key is incorrect." });
        attempts.delete(key);
        const token = `${time + 30 * 86400_000}.${randomUUID()}`;
        response.setHeader("Set-Cookie", `${COOKIE}=${token}.${signature(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`);
        return send(200, { authenticated: true });
      }
      if (!authenticated(request)) return send(401, { error: "Unlock owner controls first." });
      if (job?.status === "saving") return send(409, { error: "A rollout change is already being saved." });
      let change;
      try { change = validateChange(await bodyJson(request)); } catch { return send(400, { error: "Invalid rollout request." }); }
      job = { id: randomUUID(), status: "saving", rolloutPercent: change.rolloutPercent, startedAt: new Date(now()).toISOString() };
      const currentJob = job;
      // Publication continues even if the browser closes. Only verified live
      // truth turns the job green; an interrupted or failed apply stays visible.
      Promise.resolve().then(async () => {
        const manifest = await fetchManifest();
        if (manifest.version !== change.version || manifest.artifact.sha256 !== change.artifactSha256 || manifest.rolloutPercent !== change.expectedPercent) {
          throw new Error("The live release changed. Refresh before saving.");
        }
        if (change.rolloutPercent !== change.expectedPercent) await applyChange(change);
        const live = await fetchManifest();
        if (live.version !== change.version || live.artifact.sha256 !== change.artifactSha256 || live.rolloutPercent !== change.rolloutPercent) throw new Error("The requested percentage is not live yet. Refresh to verify.");
        Object.assign(currentJob, { status: "saved", completedAt: new Date(now()).toISOString() });
      }).catch((error) => Object.assign(currentJob, { status: "failed", error: error.message === "The live release changed. Refresh before saving." ? error.message : "Save did not finish. Refresh the live percentage before retrying.", completedAt: new Date(now()).toISOString() }));
      return send(202, { job: currentJob });
    } catch {
      return send(400, { error: "The request could not be processed." });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const secret = (await readFile(process.env.SIDESTREAM_ROLLOUT_KEY_FILE || "/etc/sidestream/rollout-owner-key", "utf8")).trim();
  const fetchManifest = async () => {
    const response = await fetch(PUBLIC_MANIFEST, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Public release unavailable.");
    return response.json();
  };
  const applyChange = async (change) => {
    const result = await run("/usr/sbin/runuser", ["-u", "sidestream-dev", "--", "/usr/bin/node", new URL("./apply.mjs", import.meta.url).pathname, JSON.stringify(change)], { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    const sha = result.stdout.trim().split("\n").at(-1);
    if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("Publication did not return a commit.");
    await run("/usr/bin/systemctl", ["restart", "sidestream-website.service"], { timeout: 60000 });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const live = await fetchManifest();
      const versionResponse = await fetch("https://sidestream.tv/version.json", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (versionResponse.ok && (await versionResponse.json()).gitSha === sha
        && live.version === change.version && live.artifact.sha256 === change.artifactSha256 && live.rolloutPercent === change.rolloutPercent) {
        const checkout = await fetch("https://sidestream.tv/api/checkout/start", { redirect: "manual", signal: AbortSignal.timeout(10000) });
        const location = checkout.headers.get("location") || "";
        if (![302, 303, 307, 308].includes(checkout.status) || (!location.includes("/api/auth/google/start") && !location.startsWith("https://checkout.stripe.com/"))) throw new Error("Checkout verification failed.");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new Error("Production verification timed out.");
  };
  createControlServer({ secret, fetchManifest, applyChange }).listen(8790, "127.0.0.1");
}

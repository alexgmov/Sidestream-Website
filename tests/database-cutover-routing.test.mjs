import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
const helperSource = `
  export function next(init = {}) {
    const response = new Response(null, { headers: { "x-test-next": "1" } });
    for (const [name, value] of init.request?.headers || []) {
      response.headers.set("x-request-" + name, value);
    }
    return response;
  }
  export function rewrite(url, init = {}) {
    const response = new Response(null, { headers: { "x-test-rewrite": String(url) } });
    for (const [name, value] of init.request?.headers || []) {
      response.headers.set("x-request-" + name, value);
    }
    return response;
  }
`;
const helperUrl = `data:text/javascript;base64,${Buffer.from(helperSource).toString("base64")}`;
const middleware = await import(
  `data:text/javascript;base64,${Buffer.from(
    source.replace('from "@vercel/functions"', `from "${helperUrl}"`),
  ).toString("base64")}`
);

function request(path = "/api/account", headers = {}) {
  return new Request(`https://sidestream.tv${path}`, { headers });
}

test("database cutover mode rejects unknown values by fencing", () => {
  assert.equal(middleware.databaseApiDecision("source"), "source");
  assert.equal(middleware.databaseApiDecision("fenced"), "fenced");
  assert.equal(middleware.databaseApiDecision("target"), "target");
  assert.equal(middleware.databaseApiDecision("unexpected"), "fenced");
});

test("source mode keeps the Vercel handler authoritative and strips forged origin headers", () => {
  const response = middleware.routeDatabaseApiForTest(request("/api/account", {
    "if-none-match": "trusted-etag",
    "x-sidestream-origin-auth": "forged",
    "x-sidestream-origin-if-none-match": "forged-etag",
    "x-sidestream-original-host": "forged.invalid",
  }), { databaseCutoverMode: "source" });

  assert.equal(response.headers.get("x-test-next"), "1");
  assert.equal(response.headers.get("x-request-x-sidestream-origin-auth"), null);
  assert.equal(response.headers.get("x-request-x-sidestream-origin-if-none-match"), null);
  assert.equal(response.headers.get("x-request-x-sidestream-original-host"), null);
  assert.equal(response.headers.get("x-request-if-none-match"), "trusted-etag");
});

test("fenced mode is retryable, non-cacheable, and does not reach either database", async () => {
  const response = middleware.routeDatabaseApiForTest(request(), {
    databaseCutoverMode: "fenced",
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).code, "database_cutover_in_progress");
});

test("target mode preserves the origin prefix, path, query, and protected headers", () => {
  const secret = "0123456789abcdef0123456789abcdef";
  const response = middleware.routeDatabaseApiForTest(
    request("/api/checkout/start?offer=pro%20once", {
      "if-none-match": '"sha256-trusted"',
      "x-sidestream-origin-if-none-match": "forged-etag",
    }),
    {
      databaseCutoverMode: "target",
      hetznerOriginUrl: "https://static.example.invalid/sidestream/",
      originAuthSecret: secret,
    },
  );

  assert.equal(
    response.headers.get("x-test-rewrite"),
    "https://static.example.invalid/sidestream/api/checkout/start?offer=pro%20once",
  );
  assert.equal(response.headers.get("x-request-x-sidestream-origin-auth"), secret);
  assert.equal(
    response.headers.get("x-request-x-sidestream-origin-if-none-match"),
    '"sha256-trusted"',
  );
  assert.equal(response.headers.get("x-request-x-sidestream-original-host"), "sidestream.tv");
  assert.equal(response.headers.get("x-request-x-forwarded-host"), "sidestream.tv");
  assert.equal(response.headers.get("x-request-x-forwarded-proto"), "https");
});

test("target mode fails closed when its origin or secret is invalid", () => {
  for (const overrides of [
    { hetznerOriginUrl: "http://example.invalid/sidestream", originAuthSecret: "x".repeat(32) },
    { hetznerOriginUrl: "https://example.invalid/sidestream", originAuthSecret: "short" },
  ]) {
    const response = middleware.routeDatabaseApiForTest(request(), {
      databaseCutoverMode: "target",
      ...overrides,
    });
    assert.equal(response.status, 503);
  }
});


test("only the exact CLI signer bypasses Linux and strips forged origin headers", () => {
  for (const mode of ["source", "fenced", "target", "unexpected"]) {
    const response = middleware.routeDatabaseApiForTest(request("/api/download-cli?release=known", {
      "x-sidestream-origin-auth": "forged",
      "x-sidestream-original-host": "forged.invalid",
      "x-sidestream-origin-if-none-match": "forged-etag",
      "x-forwarded-host": "forged.invalid",
      "x-forwarded-proto": "http",
    }), { databaseCutoverMode: mode });
    assert.equal(response.headers.get("x-test-next"), "1");
    assert.equal(response.headers.get("x-test-rewrite"), null);
    for (const name of ["x-sidestream-origin-auth", "x-sidestream-original-host", "x-sidestream-origin-if-none-match", "x-forwarded-host", "x-forwarded-proto"]) {
      assert.equal(response.headers.get(`x-request-${name}`), null);
    }
  }
  for (const url of ["/api/download", "/api/download-cli/", "/api/download-cli/other", "/api/download-cli-extra", "/api/%64ownload-cli", "/api/download-cl%69", "/api/checkout/start"]) {
    const response = middleware.routeDatabaseApiForTest(request(url), {
      databaseCutoverMode: "target",
      hetznerOriginUrl: "https://static.example.invalid/sidestream/",
      originAuthSecret: "x".repeat(32),
    });
    assert.equal(response.headers.get("x-test-next"), null, url);
    assert.ok(response.headers.get("x-test-rewrite"), url);
    assert.equal(middleware.routeDatabaseApiForTest(request(url), { databaseCutoverMode: "fenced" }).status, 503, url);
  }
});

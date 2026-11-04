import assert from "node:assert/strict";
import test from "node:test";
import { loadInjectedHandler } from "./helpers/handler-loader.mjs";
import { invokeHandler } from "./helpers/http.mjs";

test("download authorization capabilities require strict opt-in and preserve installed clients", async () => {
  const calls = [];
  const handler = await loadInjectedHandler(new URL("../api/license/authorize-download.ts", import.meta.url), {
    "../_lib/account.js": {
      cleanString: (value) => typeof value === "string" ? value.trim() : "",
      methodNotAllowed: (response) => response.end(),
      readJsonBody: async (request) => JSON.parse(request.contractBody),
      resolveRequestLicenseEnvironment: () => ({ namespace: "production" }),
      sendJson(response, status, body) { response.statusCode = status; response.end(JSON.stringify(body)); },
      async authorizeLicenseDownload(options) {
        calls.push(options);
        return { active: true, purchasePlan: "pro_monthly", maxVideoHeight: 2160, socialDownloads: false };
      },
    },
  });
  const credentials = { licenseToken: "opaque-token", deviceId: "device" };
  const legacy = await invokeHandler(handler, { method: "POST", body: credentials });
  assert.deepEqual(legacy.response.json, { active: true });
  assert.equal(calls[0].downloadPolicyVersion, undefined);
  const current = await invokeHandler(handler, {
    method: "POST", body: { ...credentials, downloadPolicyVersion: 1 },
  });
  assert.deepEqual(current.response.json, {
    active: true, purchasePlan: "pro_monthly", maxVideoHeight: 2160, socialDownloads: false,
  });
  assert.equal(calls[1].downloadPolicyVersion, 1);
  for (const version of ["1", 0, 2, true, null]) {
    const invalid = await invokeHandler(handler, {
      method: "POST", body: { ...credentials, downloadPolicyVersion: version },
    });
    assert.equal(invalid.response.statusCode, 400);
    assert.deepEqual(invalid.response.json, { active: false, code: "invalid_download_policy_version" });
  }
  assert.equal(calls.length, 2);
});

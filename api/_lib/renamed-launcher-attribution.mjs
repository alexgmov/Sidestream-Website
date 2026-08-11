import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LEDGER_SCHEMA = "sidestream_renamed_launcher_ledger_v1";
const CLAIM_BYTES = 32;
const CLAIM_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PLATFORM = "macos-universal";
const LAUNCHER_PREFIX = "Sidestream-Setup--";
const LAUNCHER_SUFFIX = ".app";

export class LauncherAttributionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "LauncherAttributionError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new LauncherAttributionError(code, status);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function iso(value) {
  return new Date(value).toISOString();
}

function validateReleaseId(value) {
  const releaseId = String(value || "");
  if (!RELEASE_PATTERN.test(releaseId)) {
    fail("release_mismatch");
  }
  return releaseId;
}

function validatePlatform(value) {
  if (value !== PLATFORM) {
    fail("platform_mismatch");
  }
  return value;
}

function validateHash(value, code) {
  const normalized = String(value || "").toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    fail(code || "invalid_install_identity");
  }
  return normalized;
}

function validateBindingId(value) {
  const bindingId = String(value || "").toLowerCase();
  if (!UUID_PATTERN.test(bindingId)) {
    fail("invalid_binding");
  }
  return bindingId;
}

function validateProof(value) {
  const proof = String(value || "");
  if (!PROOF_PATTERN.test(proof)) {
    fail("invalid_binding");
  }
  return proof;
}

function emptyLedger() {
  return {
    schemaVersion: LEDGER_SCHEMA,
    acquisitions: {},
    claims: {},
    bindings: {}
  };
}

function loadLedger(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (
      parsed?.schemaVersion !== LEDGER_SCHEMA ||
      !parsed.acquisitions ||
      !parsed.claims ||
      !parsed.bindings
    ) {
      fail("invalid_local_ledger", 500);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return emptyLedger();
    }
    if (error instanceof LauncherAttributionError) {
      throw error;
    }
    fail("invalid_local_ledger", 500);
  }
}

function saveLedger(filePath, ledger) {
  const parent = path.dirname(filePath);
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

export function launcherFilenameForClaim(claimToken) {
  if (!CLAIM_PATTERN.test(String(claimToken || ""))) {
    fail("invalid_claim");
  }
  return `${LAUNCHER_PREFIX}${claimToken}${LAUNCHER_SUFFIX}`;
}

export function parseLauncherFilename(filename) {
  const original = String(filename || "");
  const name = path.basename(original);
  if (original !== name) {
    fail("invalid_launcher_filename");
  }
  if (!name.startsWith(LAUNCHER_PREFIX) || !name.endsWith(LAUNCHER_SUFFIX)) {
    fail("invalid_launcher_filename");
  }

  const claimToken = name.slice(LAUNCHER_PREFIX.length, -LAUNCHER_SUFFIX.length);
  if (!CLAIM_PATTERN.test(claimToken)) {
    fail("invalid_launcher_filename");
  }

  return claimToken;
}

export function createRenamedLauncherLedger(options) {
  const settings = options || {};
  const filePath = path.resolve(String(settings.filePath || ""));
  const signingSecret = String(settings.signingSecret || "");
  const now = typeof settings.now === "function" ? settings.now : () => Date.now();
  const randomBytes = typeof settings.randomBytes === "function" ? settings.randomBytes : crypto.randomBytes;
  const randomUUID = typeof settings.randomUUID === "function" ? settings.randomUUID : crypto.randomUUID;

  if (!path.isAbsolute(filePath) || !filePath || filePath === path.parse(filePath).root) {
    fail("invalid_local_ledger_path", 500);
  }
  if (Buffer.byteLength(signingSecret, "utf8") < 32) {
    fail("invalid_local_signing_secret", 500);
  }

  function mutate(operation) {
    const ledger = loadLedger(filePath);
    const result = operation(ledger);
    saveLedger(filePath, ledger);
    return result;
  }

  function proofFor(binding) {
    const message = [
      "sidestream_launcher_binding_v1",
      binding.id,
      binding.claimTokenHash,
      binding.releaseId,
      binding.platform,
      binding.bindingExpiresAt
    ].join("\n");

    return crypto.createHmac("sha256", signingSecret).update(message, "utf8").digest("base64url");
  }

  function requireBinding(ledger, input) {
    const bindingId = validateBindingId(input?.bindingId);
    const proof = validateProof(input?.bindingProof);
    const binding = ledger.bindings[bindingId];

    if (!binding || !timingSafeEqualText(proofFor(binding), proof)) {
      fail("invalid_binding", 404);
    }
    if (Date.parse(binding.bindingExpiresAt) <= now()) {
      fail("binding_expired", 410);
    }
    return binding;
  }

  function publicBinding(binding) {
    return {
      schemaVersion: "sidestream_launcher_binding_v1",
      bindingId: binding.id,
      bindingProof: proofFor(binding),
      releaseId: binding.releaseId,
      platform: binding.platform,
      launcherRedeemedAt: binding.launcherRedeemedAt,
      bindingExpiresAt: binding.bindingExpiresAt
    };
  }

  return Object.freeze({
    issue(input) {
      const releaseId = validateReleaseId(input?.releaseId);
      const platform = validatePlatform(input?.platform);
      const lifetimeSeconds = Math.min(3600, Math.max(60, Number(input?.lifetimeSeconds) || 900));
      const issuedAtMs = now();
      const claimToken = base64url(randomBytes(CLAIM_BYTES));
      const claimTokenHash = sha256(claimToken);
      const acquisitionId = String(randomUUID()).toLowerCase();

      if (!CLAIM_PATTERN.test(claimToken) || !UUID_PATTERN.test(acquisitionId)) {
        fail("local_randomness_failure", 500);
      }

      return mutate((ledger) => {
        ledger.acquisitions[acquisitionId] = {
          id: acquisitionId,
          licenseNamespace: "test",
          source: "local_proof",
          releaseId,
          platform,
          createdAt: iso(issuedAtMs)
        };
        ledger.claims[claimTokenHash] = {
          claimTokenHash,
          acquisitionId,
          releaseId,
          platform,
          state: "issued",
          issuedAt: iso(issuedAtMs),
          expiresAt: iso(issuedAtMs + lifetimeSeconds * 1000),
          launcherRedeemedAt: null,
          redemptionAttemptHash: null,
          bindingId: null
        };

        return {
          acquisitionId,
          claimToken,
          claimTokenHash,
          launcherFilename: launcherFilenameForClaim(claimToken),
          releaseId,
          platform,
          issuedAt: iso(issuedAtMs),
          expiresAt: iso(issuedAtMs + lifetimeSeconds * 1000)
        };
      });
    },

    redeem(input) {
      const claimToken = String(input?.claimToken || "");
      const launcherFilename = String(input?.launcherFilename || "");
      const redemptionAttemptId = String(input?.redemptionAttemptId || "");
      const releaseId = validateReleaseId(input?.releaseId);
      const platform = validatePlatform(input?.platform);

      if (!CLAIM_PATTERN.test(claimToken) || parseLauncherFilename(launcherFilename) !== claimToken) {
        fail("invalid_claim", 404);
      }
      if (!ATTEMPT_PATTERN.test(redemptionAttemptId)) {
        fail("invalid_redemption_attempt");
      }

      return mutate((ledger) => {
        const claimTokenHash = sha256(claimToken);
        const claim = ledger.claims[claimTokenHash];
        const attemptHash = sha256(redemptionAttemptId);
        const redeemedAtMs = now();

        if (!claim) {
          fail("invalid_claim", 404);
        }
        if (claim.releaseId !== releaseId) {
          fail("release_mismatch");
        }
        if (claim.platform !== platform) {
          fail("platform_mismatch");
        }
        if (Date.parse(claim.expiresAt) <= redeemedAtMs && claim.state === "issued") {
          claim.state = "expired";
          saveLedger(filePath, ledger);
          fail("claim_expired", 410);
        }
        if (claim.state !== "issued") {
          if (
            ["redeemed", "installer_completed", "bound"].includes(claim.state) &&
            timingSafeEqualText(claim.redemptionAttemptHash || "", attemptHash)
          ) {
            return publicBinding(ledger.bindings[claim.bindingId]);
          }
          fail("claim_reused", 409);
        }

        const bindingId = String(randomUUID()).toLowerCase();
        if (!UUID_PATTERN.test(bindingId)) {
          fail("local_randomness_failure", 500);
        }

        const binding = {
          id: bindingId,
          acquisitionId: claim.acquisitionId,
          claimTokenHash,
          releaseId,
          platform,
          launcherRedeemedAt: iso(redeemedAtMs),
          bindingExpiresAt: iso(redeemedAtMs + 6 * 60 * 60 * 1000),
          installerCompletedAt: null,
          firstPluginOpenAt: null,
          installerReceiptIdHash: null,
          installIdHash: null,
          state: "redeemed"
        };

        ledger.bindings[bindingId] = binding;
        claim.state = "redeemed";
        claim.launcherRedeemedAt = binding.launcherRedeemedAt;
        claim.redemptionAttemptHash = attemptHash;
        claim.bindingId = bindingId;
        return publicBinding(binding);
      });
    },

    recordInstallerCompleted(input) {
      const installerReceiptIdHash = validateHash(
        input?.installerReceiptIdHash,
        "invalid_installer_receipt"
      );
      const releaseId = validateReleaseId(input?.releaseId);
      const platform = validatePlatform(input?.platform);

      return mutate((ledger) => {
        const binding = requireBinding(ledger, input);
        const claim = ledger.claims[binding.claimTokenHash];
        const existingReceiptOwner = Object.values(ledger.bindings).find((candidate) =>
          candidate.id !== binding.id && candidate.installerReceiptIdHash === installerReceiptIdHash
        );

        if (binding.releaseId !== releaseId || claim?.releaseId !== releaseId) {
          fail("release_mismatch");
        }
        if (binding.platform !== platform || claim?.platform !== platform) {
          fail("platform_mismatch");
        }
        if (existingReceiptOwner) {
          fail("installation_already_bound", 409);
        }
        if (binding.installerReceiptIdHash && binding.installerReceiptIdHash !== installerReceiptIdHash) {
          fail("installer_receipt_mismatch", 409);
        }

        if (!binding.installerCompletedAt) {
          binding.installerCompletedAt = iso(now());
          binding.installerReceiptIdHash = installerReceiptIdHash;
          binding.state = "installer_completed";
          claim.state = "installer_completed";
        }

        return {
          ok: true,
          outcome: "installer_completed",
          bindingId: binding.id,
          installerCompletedAt: binding.installerCompletedAt
        };
      });
    },

    bindFirstPluginOpen(input) {
      const installerReceiptIdHash = validateHash(
        input?.installerReceiptIdHash,
        "invalid_installer_receipt"
      );
      const installIdHash = validateHash(input?.installIdHash, "invalid_install_identity");

      return mutate((ledger) => {
        const binding = requireBinding(ledger, input);
        const claim = ledger.claims[binding.claimTokenHash];
        const existingInstallOwner = Object.values(ledger.bindings).find((candidate) =>
          candidate.id !== binding.id && candidate.installIdHash === installIdHash
        );

        if (!binding.installerCompletedAt || binding.installerReceiptIdHash !== installerReceiptIdHash) {
          fail("installer_not_completed", 409);
        }
        if (existingInstallOwner) {
          fail("installation_already_bound", 409);
        }
        if (
          (binding.installIdHash && binding.installIdHash !== installIdHash) ||
          binding.installerReceiptIdHash !== installerReceiptIdHash
        ) {
          fail("installation_binding_mismatch", 409);
        }

        if (!binding.firstPluginOpenAt) {
          binding.firstPluginOpenAt = iso(now());
          binding.installIdHash = installIdHash;
          binding.state = "bound";
          claim.state = "bound";
        }

        return {
          ok: true,
          outcome: "bound",
          acquisitionId: binding.acquisitionId,
          bindingId: binding.id,
          claimIssuedAt: claim.issuedAt,
          launcherRedeemedAt: binding.launcherRedeemedAt,
          installerCompletedAt: binding.installerCompletedAt,
          firstPluginOpenAt: binding.firstPluginOpenAt,
          installIdHash: binding.installIdHash,
          installerReceiptIdHash: binding.installerReceiptIdHash
        };
      });
    },

    status(input) {
      const ledger = loadLedger(filePath);
      const bindingId = validateBindingId(input?.bindingId);
      const binding = ledger.bindings[bindingId];
      if (!binding) {
        fail("invalid_binding", 404);
      }
      const claim = ledger.claims[binding.claimTokenHash];
      return {
        schemaVersion: LEDGER_SCHEMA,
        acquisition: ledger.acquisitions[binding.acquisitionId],
        claim: {
          claimTokenHash: binding.claimTokenHash,
          state: claim.state,
          issuedAt: claim.issuedAt,
          expiresAt: claim.expiresAt
        },
        binding: {
          id: binding.id,
          state: binding.state,
          releaseId: binding.releaseId,
          platform: binding.platform,
          launcherRedeemedAt: binding.launcherRedeemedAt,
          installerCompletedAt: binding.installerCompletedAt,
          firstPluginOpenAt: binding.firstPluginOpenAt,
          installIdHash: binding.installIdHash,
          installerReceiptIdHash: binding.installerReceiptIdHash
        }
      };
    }
  });
}

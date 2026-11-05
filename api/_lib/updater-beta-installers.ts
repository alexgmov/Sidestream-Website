import configured from "../../data/updater-beta-installers.json" with { type: "json" };

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Invalid updater beta installer manifest");
  }
}

export function readUpdaterBetaInstallers() {
  return parseUpdaterBetaInstallers(configured);
}

export function parseUpdaterBetaInstallers(value: unknown) {
  exact(value, ["schemaVersion", "enabled", "candidate"]);
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") throw new Error("Invalid beta controls");
  if (!value.enabled) {
    if (value.candidate !== null) throw new Error("Disabled beta must have no candidate");
    return null;
  }
  const candidate = value.candidate;
  exact(candidate, ["id", "version", "sourceSha", "seedSha256", "install", "restore"]);
  if (typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate.id) ||
      typeof candidate.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.version) ||
      candidate.version.length > 32 || typeof candidate.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(candidate.sourceSha) ||
      typeof candidate.seedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.seedSha256)) {
    throw new Error("Invalid beta candidate binding");
  }
  const artifacts = (["install", "restore"] as const).map(action => {
    const artifact = candidate[action];
    exact(artifact, ["sha256", "sizeBytes"]);
    if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) <= 0 || Number(artifact.sizeBytes) > 2_000_000_000) {
      throw new Error("Invalid beta package metadata");
    }
    const filename = `Sidestream-${candidate.version}-Mac-${action === "install" ? "Install" : "Restore"}.pkg`;
    return Object.freeze({ action, filename, pathname: `sidestream/updater-beta/${candidate.id}/${filename}`,
      sha256: artifact.sha256, sizeBytes: Number(artifact.sizeBytes), contentType: "application/octet-stream",
      platform: "macos" as const, access: "free" as const });
  });
  if (artifacts[0].sha256 === artifacts[1].sha256) throw new Error("Install and Restore must be distinct packages");
  return Object.freeze({ id: candidate.id, version: candidate.version, sourceSha: candidate.sourceSha,
    seedSha256: candidate.seedSha256, artifacts: Object.freeze(artifacts) });
}

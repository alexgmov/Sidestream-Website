import { createHmac } from "node:crypto";
import fs from "node:fs";
import configuredRollout from "../../data/mac-download-rollout.json" with { type: "json" };
import { parseReleaseManifest, type ReleaseManifest } from "./release-manifest.js";

export type MacDownloadRollout = Readonly<{
  rolloutId: string;
  percent: number;
  baselineVersion: string;
  baselineSha256: string;
  candidate: ReleaseManifest;
}>;

export function readMacDownloadRollout(): MacDownloadRollout | null {
  const override = process.env.SIDESTREAM_MAC_DOWNLOAD_ROLLOUT_PATH;
  const source: unknown = override ? JSON.parse(fs.readFileSync(override, "utf8")) : configuredRollout;
  return parseMacDownloadRollout(source);
}

export function parseMacDownloadRollout(source: unknown): MacDownloadRollout | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Invalid Mac download rollout");
  const value = source as Record<string, unknown>;
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean" ||
      !Number.isInteger(value.percent) || Number(value.percent) < 0 || Number(value.percent) > 100) {
    throw new Error("Invalid Mac download rollout controls");
  }
  if (!value.enabled || value.percent === 0) return null;
  if (typeof value.rolloutId !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(value.rolloutId) ||
      typeof value.baselineVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.baselineVersion) ||
      typeof value.baselineSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.baselineSha256)) {
    throw new Error("Invalid Mac download rollout binding");
  }
  const candidate = parseReleaseManifest(value.candidate, "macos", "macos-download-pilot");
  if (!candidate.artifact.pathname.startsWith(`sidestream/manual-beta/${candidate.version}/`) ||
      candidate.critical || candidate.rolloutPercent !== 0 || candidate.version === value.baselineVersion) {
    throw new Error("Invalid isolated Mac download candidate");
  }
  return { rolloutId: value.rolloutId, percent: Number(value.percent), baselineVersion: value.baselineVersion,
    baselineSha256: value.baselineSha256, candidate };
}

// Only call with the token from a verified or newly server-issued acquisition cookie.
// No IP, email, account, receipt or browser fingerprint enters the assignment.
export function selectMacDownloadManifest(
  stable: ReleaseManifest, rollout: MacDownloadRollout | null, token: string | undefined, secret: string,
): ReleaseManifest {
  if (!rollout || stable.platform !== "macos" || stable.channel !== "stable" ||
      stable.version !== rollout.baselineVersion || stable.artifact.sha256 !== rollout.baselineSha256 ||
      !token || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 512) return stable;
  const hash = createHmac("sha256", secret).update(`sidestream-mac-download-cohort-v1\n${rollout.rolloutId}\n${token}`).digest();
  return hash.readUInt32BE(0) / 0x100000000 < rollout.percent / 100 ? rollout.candidate : stable;
}

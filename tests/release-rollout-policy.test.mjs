import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createNextRolloutState,
  evaluateReleaseRollout,
  normalizeRolloutPolicy,
} from "../scripts/release-rollout-policy.mjs";

const ARTIFACT_SHA = "a".repeat(64);
const NOW = new Date("2026-09-03T00:00:00.000Z");
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const POLICY = JSON.parse(readFileSync(new URL("../config/release-rollout-policy.json", import.meta.url), "utf8"));

test("the authoritative policy requires 20 closed intents and 90 percent reliability", () => {
  assert.equal(POLICY.minClosedIntents, 20);
  assert.equal(POLICY.minAdditionalClosedIntents, 20);
  assert.equal(POLICY.minIntentSuccessRate, 0.9);
});

test("a fresh release with no cohort data holds and never proposes a step", () => {
  const evaluation = evaluate({
    analytics: analytics({ closed: 0, failed: 0, pending: 0, successful: 0, users: 0 }),
  });

  assert.equal(evaluation.decision, "hold");
  assert.equal(evaluation.nextRolloutPercent, null);
  assert.deepEqual(
    evaluation.blockers.filter((name) => name.startsWith("minimum_") || name === "additional_closed_intents"),
    [
      "minimum_closed_intents",
      "additional_closed_intents",
      "minimum_intent_users",
      "minimum_intent_success_rate",
    ],
  );
});

test("a mature healthy 25 percent cohort advances exactly one step", () => {
  const evaluation = evaluate({ analytics: analytics({ closed: 20, failed: 2, successful: 18 }) });

  assert.equal(evaluation.decision, "advance");
  assert.equal(evaluation.currentRolloutPercent, 25);
  assert.equal(evaluation.nextRolloutPercent, 50);
  assert.deepEqual(evaluation.blockers, []);

  const nextState = createNextRolloutState({ evaluation, localManifest: manifest() });
  assert.equal(nextState.rolloutPercent, 50);
  assert.equal(nextState.observation.closedDownloadIntents, 20);
  assert.equal(nextState.observation.intentSuccessRate, 0.9);
  assert.equal(nextState.artifactSha256, ARTIFACT_SHA);
});

test("an unexpected failure stage blocks advancement even when headline health passes", () => {
  const evaluation = evaluate({
    analytics: analytics({
      closed: 20,
      failed: 1,
      stages: { postprocess: 1 },
      successful: 19,
    }),
  });

  assert.equal(evaluation.decision, "hold");
  assert.ok(evaluation.blockers.includes("allowed_failure_stages"));
  assert.deepEqual(evaluation.metrics.unexpectedFailureStages, [{ stage: "postprocess", count: 1 }]);
});

test("a later step needs both another 20 closed intents and 24 hours", () => {
  const evaluation = evaluate({
    analytics: analytics({ closed: 30, failed: 2, rollout: 50, successful: 28 }),
    localManifest: manifest({ rollout: 50 }),
    publicManifest: manifest({ rollout: 50 }),
    state: rolloutState({ advancedAt: "2026-09-02T12:00:00.000Z", closed: 20, rollout: 50 }),
  });

  assert.equal(evaluation.decision, "hold");
  assert.ok(evaluation.blockers.includes("additional_closed_intents"));
  assert.ok(evaluation.blockers.includes("minimum_time_at_rollout"));
  assert.equal(evaluation.metrics.additionalClosedDownloadIntents, 10);
  assert.equal(evaluation.metrics.hoursAtCurrentRollout, 12);
});

test("a mature healthy later cohort advances one configured step", () => {
  const evaluation = evaluate({
    analytics: analytics({ closed: 40, failed: 3, rollout: 50, successful: 37 }),
    localManifest: manifest({ rollout: 50 }),
    publicManifest: manifest({ rollout: 50 }),
    state: rolloutState({ advancedAt: "2026-09-01T23:00:00.000Z", closed: 20, rollout: 50 }),
  });

  assert.equal(evaluation.decision, "advance");
  assert.equal(evaluation.nextRolloutPercent, 75);
});

test("the explicit cap stops the controller without evaluating another write", () => {
  const evaluation = evaluate({
    analytics: analytics({ closed: 200, failed: 12, rollout: 50, successful: 188 }),
    localManifest: manifest({ rollout: 50 }),
    maxRollout: 50,
    publicManifest: manifest({ rollout: 50 }),
    state: rolloutState({ advancedAt: "2026-09-01T23:00:00.000Z", closed: 100, rollout: 50 }),
  });

  assert.equal(evaluation.decision, "complete");
  assert.equal(evaluation.nextRolloutPercent, null);
});

test("a missing or stale sidecar fails closed after the initial rollout", () => {
  const evaluation = evaluate({
    analytics: analytics({ closed: 200, failed: 12, rollout: 50, successful: 188 }),
    localManifest: manifest({ rollout: 50 }),
    publicManifest: manifest({ rollout: 50 }),
    state: rolloutState({ closed: 100, rollout: 25 }),
  });

  assert.equal(evaluation.decision, "hold");
  assert.ok(evaluation.blockers.includes("state_matches_rollout"));
});

test("public artifact drift fails closed", () => {
  const evaluation = evaluate({
    analytics: analytics({ closed: 100, failed: 7, successful: 93 }),
    publicManifest: manifest({ sha256: "b".repeat(64) }),
  });

  assert.equal(evaluation.decision, "hold");
  assert.ok(evaluation.blockers.includes("public_manifest_artifact"));
});

test("stale analytics and concentrated failures independently block advancement", () => {
  const evaluation = evaluate({
    analytics: analytics({
      closed: 100,
      failed: 7,
      largestUserFailureShare: 0.6,
      refreshedAt: "2026-09-02T23:00:00.000Z",
      successful: 93,
    }),
  });

  assert.equal(evaluation.decision, "hold");
  assert.ok(evaluation.blockers.includes("analytics_freshness"));
  assert.ok(evaluation.blockers.includes("maximum_failure_concentration"));
});

test("invalid policy steps are rejected before analytics are interpreted", () => {
  assert.throws(
    () => normalizeRolloutPolicy({ ...POLICY, rolloutSteps: [25, 75, 50, 100] }),
    /strictly increasing/,
  );
});

test("apply mode refuses file-backed production evidence", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/advance-release-rollout.mjs",
      "--version",
      "1.0.21",
      "--expected-rollout",
      "25",
      "--max-rollout",
      "50",
      "--apply",
      "--public-manifest-file",
      "data/release-manifest.json",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--apply refuses file-backed public manifest or analytics fixtures/);
});

function evaluate({
  analytics: analyticsPayload = analytics({ closed: 100, failed: 7, successful: 93 }),
  localManifest = manifest(),
  maxRollout = 100,
  publicManifest = manifest(),
  state = rolloutState(),
} = {}) {
  return evaluateReleaseRollout({
    analytics: analyticsPayload,
    localManifest,
    maxRollout,
    now: NOW,
    policy: POLICY,
    publicManifest,
    state,
  });
}

function manifest({ rollout = 25, sha256 = ARTIFACT_SHA, version = "1.0.21" } = {}) {
  return {
    schemaVersion: 1,
    product: "sidestream",
    channel: "stable",
    version,
    minSupportedVersion: "1.0.12",
    critical: false,
    rolloutPercent: rollout,
    publishedAt: "2026-08-31T23:00:00.000Z",
    releaseNotesUrl: "https://sidestream.tv/",
    artifact: {
      type: "dmg",
      url: "https://sidestream.tv/api/download",
      pathname: `sidestream/${version}/Sidestream-${version}-Mac-Installer.dmg`,
      sha256,
      sizeBytes: 123456,
    },
  };
}

function rolloutState({
  advancedAt = "2026-08-31T23:00:00.000Z",
  closed = 0,
  rollout = 25,
  version = "1.0.21",
} = {}) {
  return {
    schemaVersion: 1,
    platform: "macos",
    version,
    rolloutPercent: rollout,
    advancedAt,
    artifactSha256: ARTIFACT_SHA,
    observation: {
      analyticsRefreshedAt: null,
      closedDownloadIntents: closed,
      intentUsers: 20,
      intentSuccessRate: 0.93,
    },
  };
}

function analytics({
  closed,
  failed,
  largestUserFailureShare = failed > 0 ? 0.4 : 0,
  pending = 0,
  refreshedAt = "2026-09-02T23:50:00.000Z",
  rollout = 25,
  stages = { downloader_execution: failed },
  successful,
  users = 20,
  version = "1.0.21",
}) {
  const stageRows = Object.entries(stages).map(([stage, count]) => ({ stage, count }));
  return {
    source: "live",
    dbMode: "postgres",
    profile: "production",
    background_refresh: {
      last_refresh_failed: false,
      refreshed_at: refreshedAt,
    },
    download_success_version_kpis: {
      selection_mode: "released_package",
      released_app_version: version,
      release_version_source: "public_release_manifest",
      release_rollout_percent: rollout,
      current: {
        app_version: version,
        intent_health: {
          download_intents: closed + pending,
          closed_download_intents: closed,
          successful_download_intents: successful,
          failed_download_intents: failed,
          pending_download_intents: pending,
          cancelled_download_intents: 0,
          download_intent_success_rate: closed > 0 ? successful / closed : null,
          delivery_failure_breakdown: { stages: stageRows },
        },
      },
    },
    download_health_by_app_version: [
      {
        app_version: version,
        intent_health: {
          failure_user_context: {
            intent_users: users,
            largest_user_failure_share: largestUserFailureShare,
          },
        },
      },
    ],
  };
}

const KNOWN_FAILURE_STAGES = new Set([
  "resolve_runtime",
  "downloader_execution",
  "postprocess",
  "filesystem",
  "premiere_import",
  "unclassified",
]);

export function normalizeRolloutPolicy(input) {
  const policy = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const rolloutSteps = Array.isArray(policy.rolloutSteps)
    ? policy.rolloutSteps.map((value) => integer(value, "rolloutSteps"))
    : [];

  if (policy.schemaVersion !== 1) throw new Error("release rollout policy schemaVersion must be 1");
  if (policy.platform !== "macos") throw new Error("release rollout policy platform must be macos");
  if (policy.profile !== "production") throw new Error("release rollout policy profile must be production");
  if (!rolloutSteps.length || rolloutSteps.some((value) => value < 1 || value > 100)) {
    throw new Error("release rollout policy steps must be integers between 1 and 100");
  }
  if (new Set(rolloutSteps).size !== rolloutSteps.length) {
    throw new Error("release rollout policy steps must be unique");
  }
  for (let index = 1; index < rolloutSteps.length; index += 1) {
    if (rolloutSteps[index] <= rolloutSteps[index - 1]) {
      throw new Error("release rollout policy steps must be strictly increasing");
    }
  }
  if (rolloutSteps.at(-1) !== 100) throw new Error("release rollout policy must end at 100");

  const allowedFailureStages = Array.isArray(policy.allowedFailureStages)
    ? policy.allowedFailureStages.map((value) => String(value || "").trim())
    : [];
  if (
    allowedFailureStages.some((stage) => !KNOWN_FAILURE_STAGES.has(stage)) ||
    new Set(allowedFailureStages).size !== allowedFailureStages.length
  ) {
    throw new Error("release rollout policy contains an invalid or duplicate failure stage");
  }

  return {
    schemaVersion: 1,
    platform: "macos",
    profile: "production",
    rolloutSteps,
    minClosedIntents: nonnegativeInteger(policy.minClosedIntents, "minClosedIntents"),
    minAdditionalClosedIntents: nonnegativeInteger(
      policy.minAdditionalClosedIntents,
      "minAdditionalClosedIntents",
    ),
    minIntentUsers: nonnegativeInteger(policy.minIntentUsers, "minIntentUsers"),
    minIntentSuccessRate: rate(policy.minIntentSuccessRate, "minIntentSuccessRate"),
    minHoursAtCurrentRollout: nonnegativeNumber(
      policy.minHoursAtCurrentRollout,
      "minHoursAtCurrentRollout",
    ),
    maxPendingIntentRate: rate(policy.maxPendingIntentRate, "maxPendingIntentRate"),
    maxLargestUserFailureShare: rate(
      policy.maxLargestUserFailureShare,
      "maxLargestUserFailureShare",
    ),
    maxAnalyticsAgeMinutes: positiveNumber(
      policy.maxAnalyticsAgeMinutes,
      "maxAnalyticsAgeMinutes",
    ),
    allowedFailureStages,
  };
}

export function evaluateReleaseRollout({
  analytics,
  localManifest,
  maxRollout,
  now = new Date(),
  policy: rawPolicy,
  publicManifest,
  state,
}) {
  const policy = normalizeRolloutPolicy(rawPolicy);
  const evaluatedAt = validDate(now, "evaluation time");
  const manifest = normalizeManifest(localManifest, "local manifest");
  const publicRelease = normalizeManifest(publicManifest, "public manifest");
  const rolloutCap = integer(maxRollout, "maxRollout");

  if (!policy.rolloutSteps.includes(rolloutCap)) {
    throw new Error("maxRollout must be one of the configured rollout steps");
  }
  if (!policy.rolloutSteps.includes(manifest.rolloutPercent)) {
    throw new Error("local manifest rolloutPercent is not a configured rollout step");
  }

  const observation = normalizeAnalyticsObservation(analytics, manifest.version);
  const matchingState = normalizeMatchingState(state, manifest, policy);
  const nextConfiguredStep = policy.rolloutSteps.find(
    (step) => step > manifest.rolloutPercent && step <= rolloutCap,
  ) ?? null;
  const blockers = [];
  const gates = [];

  gate(gates, blockers, "noncritical_release", manifest.critical === false, {
    actual: manifest.critical,
    required: false,
  });
  gate(gates, blockers, "public_manifest_version", publicRelease.version === manifest.version, {
    actual: publicRelease.version,
    required: manifest.version,
  });
  gate(
    gates,
    blockers,
    "public_manifest_rollout",
    publicRelease.rolloutPercent === manifest.rolloutPercent,
    { actual: publicRelease.rolloutPercent, required: manifest.rolloutPercent },
  );
  gate(
    gates,
    blockers,
    "public_manifest_artifact",
    publicRelease.artifactSha256 === manifest.artifactSha256 &&
      publicRelease.artifactSizeBytes === manifest.artifactSizeBytes,
    {
      actual: `${publicRelease.artifactSha256}:${publicRelease.artifactSizeBytes}`,
      required: `${manifest.artifactSha256}:${manifest.artifactSizeBytes}`,
    },
  );
  gate(gates, blockers, "analytics_profile", observation.profile === policy.profile, {
    actual: observation.profile,
    required: policy.profile,
  });
  gate(gates, blockers, "analytics_source", observation.source === "live", {
    actual: observation.source,
    required: "live",
  });
  gate(gates, blockers, "analytics_database", observation.dbMode === "postgres", {
    actual: observation.dbMode,
    required: "postgres",
  });
  gate(gates, blockers, "analytics_refresh_status", observation.lastRefreshFailed === false, {
    actual: observation.lastRefreshFailed,
    required: false,
  });
  gate(
    gates,
    blockers,
    "analytics_release_source",
    observation.selectionMode === "released_package" &&
      observation.releaseVersionSource === "public_release_manifest",
    {
      actual: `${observation.selectionMode}:${observation.releaseVersionSource}`,
      required: "released_package:public_release_manifest",
    },
  );
  gate(gates, blockers, "analytics_release_version", observation.releasedVersion === manifest.version, {
    actual: observation.releasedVersion,
    required: manifest.version,
  });
  gate(
    gates,
    blockers,
    "analytics_release_rollout",
    observation.releaseRolloutPercent === manifest.rolloutPercent,
    { actual: observation.releaseRolloutPercent, required: manifest.rolloutPercent },
  );
  gate(gates, blockers, "analytics_current_version", observation.appVersion === manifest.version, {
    actual: observation.appVersion,
    required: manifest.version,
  });

  const analyticsAgeMinutes = Math.max(
    0,
    (evaluatedAt.getTime() - observation.refreshedAt.getTime()) / 60_000,
  );
  gate(
    gates,
    blockers,
    "analytics_freshness",
    analyticsAgeMinutes <= policy.maxAnalyticsAgeMinutes,
    { actual: round(analyticsAgeMinutes), requiredMaximum: policy.maxAnalyticsAgeMinutes },
  );

  gate(gates, blockers, "state_matches_rollout", matchingState.matched, {
    actual: matchingState.description,
    required: `${manifest.version}@${manifest.rolloutPercent}`,
  });

  const closedIntentIntegrity =
    observation.successfulIntents + observation.failedIntents === observation.closedIntents;
  gate(gates, blockers, "closed_intent_integrity", closedIntentIntegrity, {
    actual: observation.successfulIntents + observation.failedIntents,
    required: observation.closedIntents,
  });

  const classifiedFailureCount = observation.failureStages.reduce(
    (total, stage) => total + stage.count,
    0,
  );
  gate(gates, blockers, "failure_stage_integrity", classifiedFailureCount === observation.failedIntents, {
    actual: classifiedFailureCount,
    required: observation.failedIntents,
  });

  const additionalClosedIntents = observation.closedIntents - matchingState.closedDownloadIntents;
  const hoursAtCurrentRollout = Math.max(
    0,
    (evaluatedAt.getTime() - matchingState.advancedAt.getTime()) / 3_600_000,
  );
  const pendingIntentRate = observation.totalIntents > 0
    ? observation.pendingIntents / observation.totalIntents
    : 0;
  const unexpectedFailureStages = observation.failureStages
    .filter((stage) => stage.count > 0 && !policy.allowedFailureStages.includes(stage.stage));

  gate(gates, blockers, "minimum_closed_intents", observation.closedIntents >= policy.minClosedIntents, {
    actual: observation.closedIntents,
    requiredMinimum: policy.minClosedIntents,
  });
  gate(
    gates,
    blockers,
    "additional_closed_intents",
    additionalClosedIntents >= policy.minAdditionalClosedIntents,
    { actual: additionalClosedIntents, requiredMinimum: policy.minAdditionalClosedIntents },
  );
  gate(gates, blockers, "minimum_intent_users", observation.intentUsers >= policy.minIntentUsers, {
    actual: observation.intentUsers,
    requiredMinimum: policy.minIntentUsers,
  });
  gate(
    gates,
    blockers,
    "minimum_intent_success_rate",
    observation.intentSuccessRate !== null &&
      observation.intentSuccessRate >= policy.minIntentSuccessRate,
    { actual: observation.intentSuccessRate, requiredMinimum: policy.minIntentSuccessRate },
  );
  gate(
    gates,
    blockers,
    "minimum_time_at_rollout",
    hoursAtCurrentRollout >= policy.minHoursAtCurrentRollout,
    { actual: round(hoursAtCurrentRollout), requiredMinimum: policy.minHoursAtCurrentRollout },
  );
  gate(gates, blockers, "maximum_pending_intent_rate", pendingIntentRate <= policy.maxPendingIntentRate, {
    actual: round(pendingIntentRate),
    requiredMaximum: policy.maxPendingIntentRate,
  });
  gate(
    gates,
    blockers,
    "maximum_failure_concentration",
    observation.largestUserFailureShare <= policy.maxLargestUserFailureShare,
    {
      actual: observation.largestUserFailureShare,
      requiredMaximum: policy.maxLargestUserFailureShare,
    },
  );
  gate(gates, blockers, "allowed_failure_stages", unexpectedFailureStages.length === 0, {
    actual: unexpectedFailureStages.map((stage) => stage.stage),
    required: policy.allowedFailureStages,
  });

  const complete = manifest.rolloutPercent >= rolloutCap || nextConfiguredStep === null;
  const decision = complete ? "complete" : blockers.length ? "hold" : "advance";

  return {
    schemaVersion: 1,
    decision,
    evaluatedAt: evaluatedAt.toISOString(),
    version: manifest.version,
    currentRolloutPercent: manifest.rolloutPercent,
    nextRolloutPercent: decision === "advance" ? nextConfiguredStep : null,
    maxRolloutPercent: rolloutCap,
    metrics: {
      analyticsRefreshedAt: observation.refreshedAt.toISOString(),
      analyticsAgeMinutes: round(analyticsAgeMinutes),
      closedDownloadIntents: observation.closedIntents,
      additionalClosedDownloadIntents: additionalClosedIntents,
      successfulDownloadIntents: observation.successfulIntents,
      failedDownloadIntents: observation.failedIntents,
      pendingDownloadIntents: observation.pendingIntents,
      intentUsers: observation.intentUsers,
      intentSuccessRate: observation.intentSuccessRate,
      pendingIntentRate: round(pendingIntentRate),
      largestUserFailureShare: observation.largestUserFailureShare,
      failureStages: observation.failureStages,
      unexpectedFailureStages,
      hoursAtCurrentRollout: round(hoursAtCurrentRollout),
    },
    baseline: {
      advancedAt: matchingState.advancedAt.toISOString(),
      closedDownloadIntents: matchingState.closedDownloadIntents,
      source: matchingState.source,
    },
    gates,
    blockers,
  };
}

export function createNextRolloutState({ evaluation, localManifest }) {
  if (evaluation?.decision !== "advance" || !Number.isInteger(evaluation.nextRolloutPercent)) {
    throw new Error("a passing advance evaluation is required to create rollout state");
  }
  const manifest = normalizeManifest(localManifest, "local manifest");
  return {
    schemaVersion: 1,
    platform: "macos",
    version: evaluation.version,
    rolloutPercent: evaluation.nextRolloutPercent,
    advancedAt: evaluation.evaluatedAt,
    artifactSha256: manifest.artifactSha256,
    observation: {
      analyticsRefreshedAt: evaluation.metrics.analyticsRefreshedAt,
      closedDownloadIntents: evaluation.metrics.closedDownloadIntents,
      intentUsers: evaluation.metrics.intentUsers,
      intentSuccessRate: evaluation.metrics.intentSuccessRate,
    },
  };
}

function normalizeManifest(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} is invalid`);
  }
  const artifact = input.artifact && typeof input.artifact === "object" ? input.artifact : {};
  const version = String(input.version || "").trim();
  const rolloutPercent = integer(input.rolloutPercent, `${label} rolloutPercent`);
  const artifactSha256 = String(artifact.sha256 || input.sha256 || "").trim().toLowerCase();
  const artifactSizeBytes = integer(
    artifact.sizeBytes ?? input.sizeBytes,
    `${label} artifact size`,
  );
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${label} version is invalid`);
  if (rolloutPercent < 0 || rolloutPercent > 100) throw new Error(`${label} rolloutPercent is invalid`);
  if (!/^[0-9a-f]{64}$/.test(artifactSha256)) throw new Error(`${label} artifact sha256 is invalid`);
  if (artifactSizeBytes < 1) throw new Error(`${label} artifact size is invalid`);
  return {
    version,
    rolloutPercent,
    critical: input.critical === true,
    publishedAt: validDate(input.publishedAt, `${label} publishedAt`),
    artifactSha256,
    artifactSizeBytes,
  };
}

function normalizeAnalyticsObservation(input, expectedVersion) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("analytics payload is invalid");
  }
  const versionKpis = object(input.download_success_version_kpis);
  const current = object(versionKpis.current);
  const intentHealth = object(current.intent_health);
  const versionRows = Array.isArray(input.download_health_by_app_version)
    ? input.download_health_by_app_version
    : [];
  const versionRow = versionRows.find((row) => String(row?.app_version || "") === expectedVersion);
  const versionIntentHealth = object(versionRow?.intent_health);
  const failureContext = object(
    versionIntentHealth.failure_user_context ?? intentHealth.failure_user_context,
  );
  const breakdown = object(intentHealth.delivery_failure_breakdown);
  const stages = Array.isArray(breakdown.stages) ? breakdown.stages : [];
  const failureStages = [...KNOWN_FAILURE_STAGES].map((stage) => {
    const matching = stages.find((entry) => entry?.stage === stage);
    return { stage, count: nonnegativeInteger(matching?.count ?? 0, `${stage} failure count`) };
  });

  const closedIntents = nonnegativeInteger(
    intentHealth.closed_download_intents ?? 0,
    "closed download intents",
  );
  const successfulIntents = nonnegativeInteger(
    intentHealth.successful_download_intents ?? 0,
    "successful download intents",
  );
  const failedIntents = nonnegativeInteger(
    intentHealth.failed_download_intents ?? 0,
    "failed download intents",
  );
  const pendingIntents = nonnegativeInteger(
    intentHealth.pending_download_intents ?? 0,
    "pending download intents",
  );
  const cancelledIntents = nonnegativeInteger(
    intentHealth.cancelled_download_intents ?? 0,
    "cancelled download intents",
  );
  const totalIntents = nonnegativeInteger(
    intentHealth.download_intents ?? closedIntents + pendingIntents + cancelledIntents,
    "download intents",
  );
  const successRate = intentHealth.download_intent_success_rate === null ||
      intentHealth.download_intent_success_rate === undefined
    ? null
    : rate(intentHealth.download_intent_success_rate, "download intent success rate");

  return {
    profile: String(input.profile || ""),
    source: String(input.source || ""),
    dbMode: String(input.dbMode || ""),
    lastRefreshFailed: input.background_refresh?.last_refresh_failed,
    refreshedAt: validDate(input.background_refresh?.refreshed_at, "analytics refreshed_at"),
    selectionMode: String(versionKpis.selection_mode || ""),
    releaseVersionSource: String(versionKpis.release_version_source || ""),
    releasedVersion: String(versionKpis.released_app_version || ""),
    releaseRolloutPercent: integer(
      versionKpis.release_rollout_percent,
      "analytics release rollout percent",
    ),
    appVersion: String(current.app_version || ""),
    closedIntents,
    successfulIntents,
    failedIntents,
    pendingIntents,
    cancelledIntents,
    totalIntents,
    intentSuccessRate: successRate,
    intentUsers: nonnegativeInteger(failureContext.intent_users ?? 0, "intent users"),
    largestUserFailureShare: failureContext.largest_user_failure_share === null ||
        failureContext.largest_user_failure_share === undefined
      ? 0
      : rate(failureContext.largest_user_failure_share, "largest user failure share"),
    failureStages,
  };
}

function normalizeMatchingState(input, manifest, policy) {
  const state = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  const matches = state?.schemaVersion === 1 &&
    state.platform === policy.platform &&
    state.version === manifest.version &&
    state.rolloutPercent === manifest.rolloutPercent &&
    state.artifactSha256 === manifest.artifactSha256;
  if (matches) {
    return {
      matched: true,
      description: `${state.version}@${state.rolloutPercent}`,
      advancedAt: validDate(state.advancedAt, "rollout state advancedAt"),
      closedDownloadIntents: nonnegativeInteger(
        state.observation?.closedDownloadIntents ?? 0,
        "rollout state closedDownloadIntents",
      ),
      source: "state",
    };
  }

  if (manifest.rolloutPercent === policy.rolloutSteps[0]) {
    return {
      matched: true,
      description: `${manifest.version}@${manifest.rolloutPercent}:release-baseline`,
      advancedAt: manifest.publishedAt,
      closedDownloadIntents: 0,
      source: "release_manifest",
    };
  }

  return {
    matched: false,
    description: state
      ? `${String(state.version || "unknown")}@${String(state.rolloutPercent ?? "unknown")}`
      : "missing",
    advancedAt: manifest.publishedAt,
    closedDownloadIntents: 0,
    source: "invalid_state",
  };
}

function gate(gates, blockers, name, passed, details) {
  const entry = { name, passed: Boolean(passed), ...details };
  gates.push(entry);
  if (!entry.passed) blockers.push(name);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function integer(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw new Error(`${label} must be an integer`);
  return numeric;
}

function nonnegativeInteger(value, label) {
  const numeric = integer(value, label);
  if (numeric < 0) throw new Error(`${label} must be nonnegative`);
  return numeric;
}

function nonnegativeNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`${label} must be nonnegative`);
  return numeric;
}

function positiveNumber(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`${label} must be positive`);
  return numeric;
}

function rate(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return numeric;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function round(value) {
  return Math.round(Number(value) * 10_000) / 10_000;
}

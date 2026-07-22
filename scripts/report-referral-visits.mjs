#!/usr/bin/env node

import { list } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REFERRAL_BLOB_PREFIX = "sidestream/referrals/v1";
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export function summarizeReferralBlobPathnames(pathnames, options) {
  const { source, fromDay, throughDay } = options;
  const dailySets = new Map();
  const pattern = new RegExp(
    `^${REFERRAL_BLOB_PREFIX}/${escapeRegExp(source)}/(\\d{4}-\\d{2}-\\d{2})/(human|scanner)/([0-9a-f]{64})\\.json$`,
  );

  for (const pathname of pathnames) {
    const match = String(pathname || "").match(pattern);
    if (!match) continue;
    const [, day, classification, visitorHash] = match;
    if (day < fromDay || day > throughDay) continue;
    const sets = dailySets.get(day) || { human: new Set(), scanner: new Set() };
    sets[classification].add(visitorHash);
    dailySets.set(day, sets);
  }

  const daily = [];
  for (const day of enumerateUtcDays(fromDay, throughDay)) {
    const sets = dailySets.get(day) || { human: new Set(), scanner: new Set() };
    const all = new Set([...sets.human, ...sets.scanner]);
    daily.push({
      day,
      uniqueDailyVisitors: all.size,
      uniqueDailyLikelyHumanVisitors: sets.human.size,
      uniqueDailyLikelyScannerVisitors: sets.scanner.size,
    });
  }

  return {
    source,
    fromDay,
    throughDay,
    daily,
    totals: daily.reduce(
      (totals, row) => ({
        uniqueDailyVisitors: totals.uniqueDailyVisitors + row.uniqueDailyVisitors,
        uniqueDailyLikelyHumanVisitors:
          totals.uniqueDailyLikelyHumanVisitors + row.uniqueDailyLikelyHumanVisitors,
        uniqueDailyLikelyScannerVisitors:
          totals.uniqueDailyLikelyScannerVisitors + row.uniqueDailyLikelyScannerVisitors,
      }),
      {
        uniqueDailyVisitors: 0,
        uniqueDailyLikelyHumanVisitors: 0,
        uniqueDailyLikelyScannerVisitors: 0,
      },
    ),
  };
}

export function parseReportArguments(argv, now = new Date()) {
  const source = readOption(argv, "--source") || "manychat";
  if (!SOURCE_PATTERN.test(source)) throw new Error("Invalid referral source");

  const daysText = readOption(argv, "--days") || "7";
  const days = Number(daysText);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error("--days must be an integer from 1 to 365");
  }

  const throughDay = now.toISOString().slice(0, 10);
  const from = new Date(`${throughDay}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return { source, days, fromDay: from.toISOString().slice(0, 10), throughDay };
}

async function runReport(argv = process.argv.slice(2)) {
  loadEnvFile(process.env.SIDESTREAM_ENV_FILE);
  const options = parseReportArguments(argv);
  const prefix = `${REFERRAL_BLOB_PREFIX}/${options.source}/`;
  const pathnames = [];
  let cursor;

  do {
    const page = await list({ prefix, cursor, limit: 1_000 });
    pathnames.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  console.log(JSON.stringify(summarizeReferralBlobPathnames(pathnames, options), null, 2));
}

function enumerateUtcDays(fromDay, throughDay) {
  const days = [];
  const cursor = new Date(`${fromDay}T00:00:00.000Z`);
  const through = new Date(`${throughDay}T00:00:00.000Z`);
  while (cursor <= through) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  return String(argv[index + 1] || "").trim().toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadEnvFile(filePath) {
  if (!filePath) return;

  const absolutePath = path.resolve(filePath);
  let text = "";
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read env file ${absolutePath}: ${error.message}`);
  }

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, "");
  }
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entryUrl) {
  runReport().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

#!/usr/bin/env -S node --import tsx

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readCorpus } from "./corpus.js";
import { compareReplayResult, parseAllowlistEntries } from "./equivalence.js";
import { MUTATING_METHODS, MutationBlockedError, replayEntry } from "./replay.js";
import { buildReport, writeReport, type ReplayEvaluation, type ReplayReport } from "./report.js";

/** Default overall replay timeout: 5 minutes. */
const DEFAULT_REPLAY_TIMEOUT_MS = 5 * 60 * 1_000;
/** Default per-request replay timeout: 30 seconds. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

interface CliOptions {
  corpusUri: string;
  target: string;
  reportPath: string;
  allowMutations: boolean;
  requestTimeoutMs: number;
  replayTimeoutMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  let corpusUri = "";
  let target = "";
  let reportPath = "";
  let allowMutations = false;
  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  let replayTimeoutMs = DEFAULT_REPLAY_TIMEOUT_MS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      target = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--report") {
      reportPath = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--allow-mutations") {
      allowMutations = true;
      continue;
    }
    if (arg === "--request-timeout-ms") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--request-timeout-ms must be a positive integer");
      }
      requestTimeoutMs = value;
      index += 1;
      continue;
    }
    if (arg === "--replay-timeout-ms") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--replay-timeout-ms must be a positive integer");
      }
      replayTimeoutMs = value;
      index += 1;
      continue;
    }
    if (!corpusUri) {
      corpusUri = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!corpusUri || !target || !reportPath) {
    throw new Error("Usage: replay <corpus-uri> --target <url> --report <path>");
  }

  return { corpusUri, target, reportPath, allowMutations, requestTimeoutMs, replayTimeoutMs };
}

async function loadAllowlist() {
  const allowlistPath = new URL("../equivalence.json", import.meta.url);
  const fileContent = await fs.readFile(allowlistPath, "utf8");
  return parseAllowlistEntries(JSON.parse(fileContent) as unknown);
}

export interface RunReplayHarnessOptions {
  allowMutations?: boolean;
  requestTimeoutMs?: number;
  replayTimeoutMs?: number;
}

export async function runReplayHarness(
  corpusUri: string,
  target: string,
  options: RunReplayHarnessOptions = {},
): Promise<ReplayEvaluation[]> {
  const replayTimeoutMs = options.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
  const deadline = Date.now() + replayTimeoutMs;
  const configuredRequestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const corpus = await readCorpus(corpusUri);
  const allowlist = await loadAllowlist();
  const evaluations: ReplayEvaluation[] = [];

  for (const entry of corpus) {
    const remainingReplayMs = deadline - Date.now();
    if (remainingReplayMs <= 0) {
      throw new Error(
        `Overall replay timeout of ${replayTimeoutMs} ms exceeded after ${evaluations.length} requests.`,
      );
    }

    if (MUTATING_METHODS.has(entry.method) && !options.allowMutations) {
      // Skip mutating entries in safe mode — log and continue rather than abort.
      console.warn(
        `[replay] Skipping mutating request ${entry.method} ${entry.path} (pass --allow-mutations to include)`,
      );
      continue;
    }

    try {
      const replayed = await replayEntry(entry, target, {
        allowMutations: options.allowMutations,
        requestTimeoutMs: Math.min(configuredRequestTimeoutMs, remainingReplayMs),
      });
      const result = compareReplayResult(entry, replayed, allowlist);
      evaluations.push({
        requestId: entry.request_id,
        method: entry.method,
        path: entry.path,
        targetUrl: replayed.url,
        result,
      });
    } catch (error) {
      if (error instanceof MutationBlockedError) {
        // Should not reach here because we pre-filter above, but guard anyway.
        console.warn(`[replay] ${error.message}`);
        continue;
      }
      throw error;
    }
  }

  return evaluations;
}

export async function runCli(argv: string[]): Promise<ReplayReport> {
  const options = parseArgs(argv);
  const evaluations = await runReplayHarness(options.corpusUri, options.target, {
    allowMutations: options.allowMutations,
    requestTimeoutMs: options.requestTimeoutMs,
    replayTimeoutMs: options.replayTimeoutMs,
  });
  const report = buildReport(options.corpusUri, options.target, evaluations);
  const resolvedReportPath = path.resolve(options.reportPath);
  await writeReport(resolvedReportPath, report);

  const summary = [
    `total=${report.totals.total}`,
    `identical=${report.totals.identical}`,
    `allowlisted=${report.totals.allowlisted}`,
    `divergent=${report.totals.divergent}`,
  ].join(" ");
  console.log(summary);
  process.exitCode = report.totals.divergent > 0 ? 1 : 0;
  return report;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export * from "./corpus.js";
export * from "./equivalence.js";
export * from "./replay.js";
export * from "./report.js";

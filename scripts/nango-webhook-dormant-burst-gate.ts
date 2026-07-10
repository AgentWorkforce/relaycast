#!/usr/bin/env node
/**
 * Dormant Nango webhook burst gate.
 *
 * This script drives the direct WebhookWorker URL while WEBHOOK_ORIGIN remains
 * unset. It must not be pointed at the live router/cloud-web path unless an
 * operator explicitly passes --allow-non-worker-target.
 */

import { createHmac } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ScenarioName =
  | "nango-sync"
  | "nango-duplicate"
  | "gitlab-hookdeck"
  | "forged-signature"
  | "malformed-json"
  | "oversized";

type Verdict = "PASS" | "FAIL";

interface CliOptions {
  target: string;
  path: string;
  secret: string;
  scenarios: ScenarioName[];
  requests: number;
  concurrency: number;
  timeoutMs: number;
  reportPath: string;
  allowNonWorkerTarget: boolean;
  seed: string;
}

interface GateRequest {
  scenario: ScenarioName;
  sequence: number;
  url: string;
  body: string;
  headers: Record<string, string>;
  expectedStatuses: number[];
}

interface GateResult {
  scenario: ScenarioName;
  sequence: number;
  expectedStatuses: number[];
  status: number | null;
  durationMs: number;
  ok: boolean;
  error?: string;
}

interface GateReport {
  target: string;
  path: string;
  startedAt: string;
  finishedAt: string;
  totals: {
    total: number;
    passed: number;
    failed: number;
    fiveXx: number;
    maxDurationMs: number;
  };
  byScenario: Record<
    string,
    {
      total: number;
      passed: number;
      failed: number;
      statuses: Record<string, number>;
      maxDurationMs: number;
    }
  >;
  results: GateResult[];
}

const ALL_SCENARIOS: ScenarioName[] = [
  "nango-sync",
  "nango-duplicate",
  "gitlab-hookdeck",
  "forged-signature",
  "malformed-json",
  "oversized",
];

function parseStrictInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} expected a positive integer, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${flag} expected a positive safe integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parseScenarios(value: string): ScenarioName[] {
  if (value === "all") {
    return [...ALL_SCENARIOS];
  }

  const names = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new Error("--scenarios must include at least one scenario");
  }

  for (const name of names) {
    if (!ALL_SCENARIOS.includes(name as ScenarioName)) {
      throw new Error(
        `Unknown scenario ${JSON.stringify(name)}. Expected one of: ${ALL_SCENARIOS.join(", ")}, all`,
      );
    }
  }

  return names as ScenarioName[];
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let target = "";
  let path = "/api/v1/webhooks/nango";
  let secret = env.NANGO_WEBHOOK_SECRET ?? "";
  let scenarios: ScenarioName[] = ["nango-sync"];
  let requests = 100;
  let concurrency = 25;
  let timeoutMs = 10_000;
  let reportPath = "nango-webhook-dormant-burst-report.json";
  let allowNonWorkerTarget = false;
  let seed = new Date().toISOString();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value == null) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--target":
        target = next();
        break;
      case "--path":
        path = next();
        break;
      case "--secret":
        secret = next();
        break;
      case "--scenarios":
        scenarios = parseScenarios(next());
        break;
      case "--requests":
        requests = parseStrictInt(next(), "--requests");
        break;
      case "--concurrency":
        concurrency = parseStrictInt(next(), "--concurrency");
        break;
      case "--timeout-ms":
        timeoutMs = parseStrictInt(next(), "--timeout-ms");
        break;
      case "--report":
        reportPath = next();
        break;
      case "--seed":
        seed = next();
        break;
      case "--allow-non-worker-target":
        allowNonWorkerTarget = true;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!target) {
    throw new Error("--target is required");
  }
  if (!secret) {
    throw new Error("--secret or NANGO_WEBHOOK_SECRET is required");
  }
  if (!path.startsWith("/")) {
    throw new Error("--path must start with /");
  }
  if (concurrency > requests) {
    concurrency = requests;
  }

  return {
    target,
    path,
    secret,
    scenarios,
    requests,
    concurrency,
    timeoutMs,
    reportPath,
    allowNonWorkerTarget,
    seed,
  };
}

export function assertDormantTarget(target: string, allowNonWorkerTarget: boolean): void {
  if (allowNonWorkerTarget) {
    return;
  }

  const url = new URL(target);
  const hostname = url.hostname.toLowerCase();
  const isLocalhost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isWorkersDev = hostname.endsWith(".workers.dev");

  if (!isLocalhost && !isWorkersDev) {
    throw new Error(
      "Refusing to run against a non-Workers target. Use the direct WebhookWorker " +
        "workers.dev URL while WEBHOOK_ORIGIN is unset, or pass --allow-non-worker-target " +
        "for an intentional non-production test.",
    );
  }
}

function signNangoHmac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function buildUrl(target: string, path: string): string {
  const url = new URL(target);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function nangoSyncBody(sequence: number, seed: string, duplicate = false): string {
  const stable = duplicate ? "duplicate-window" : `${seed}-${sequence}`;
  return JSON.stringify({
    type: "sync",
    from: "confluence-relay",
    payload: {
      connectionId: "b6-canary-connection",
      providerConfigKey: "confluence-relay",
      syncName: "fetch-spaces",
      model: "ConfluenceSpace",
      queryTimeStamp: stable,
      cursor: stable,
    },
  });
}

function gitlabHookdeckBody(sequence: number): string {
  return JSON.stringify({
    object_kind: "push",
    project: { id: 12345 },
    ref: "refs/heads/main",
    checkout_sha: `b6-${sequence}`,
  });
}

export function buildGateRequest(
  scenario: ScenarioName,
  sequence: number,
  opts: Pick<CliOptions, "target" | "path" | "secret" | "seed">,
): GateRequest {
  const url = buildUrl(opts.target, opts.path);
  let body: string;
  let expectedStatuses: number[];
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "agentrelay-nango-b6-dormant-burst-gate/1.0",
    "x-agentrelay-b6-canary": "true",
    "x-agentrelay-b6-sequence": String(sequence),
  };

  switch (scenario) {
    case "nango-sync":
      body = nangoSyncBody(sequence, opts.seed);
      headers["x-nango-hmac-sha256"] = signNangoHmac(body, opts.secret);
      expectedStatuses = [202];
      break;
    case "nango-duplicate":
      body = nangoSyncBody(sequence, opts.seed, true);
      headers["x-nango-hmac-sha256"] = signNangoHmac(body, opts.secret);
      expectedStatuses = [202];
      break;
    case "gitlab-hookdeck":
      body = gitlabHookdeckBody(sequence);
      headers["x-nango-hmac-sha256"] = signNangoHmac(body, opts.secret);
      headers["x-gitlab-event"] = "Push Hook";
      headers["x-gitlab-event-uuid"] = `b6-gitlab-${sequence}`;
      headers["x-gitlab-token"] = "b6-token";
      headers["x-hookdeck-signature"] = "b6-hookdeck-signature";
      expectedStatuses = [202];
      break;
    case "forged-signature":
      body = nangoSyncBody(sequence, opts.seed);
      headers["x-nango-hmac-sha256"] = "00";
      expectedStatuses = [401];
      break;
    case "malformed-json":
      body = `{"type":"sync","from":"confluence-relay","sequence":${sequence}`;
      headers["x-nango-hmac-sha256"] = signNangoHmac(body, opts.secret);
      expectedStatuses = [202];
      break;
    case "oversized":
      body = JSON.stringify({
        type: "sync",
        from: "confluence-relay",
        payload: {
          connectionId: "b6-canary-connection",
          providerConfigKey: "confluence-relay",
          syncName: "fetch-spaces",
          model: "ConfluenceSpace",
          queryTimeStamp: `${opts.seed}-${sequence}`,
          data: "x".repeat(130 * 1024),
        },
      });
      headers["x-nango-hmac-sha256"] = signNangoHmac(body, opts.secret);
      expectedStatuses = [202];
      break;
  }

  return { scenario, sequence, url, body, headers, expectedStatuses };
}

async function sendGateRequest(
  request: GateRequest,
  timeoutMs: number,
): Promise<GateResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    await response.arrayBuffer().catch(() => undefined);
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      scenario: request.scenario,
      sequence: request.sequence,
      expectedStatuses: request.expectedStatuses,
      status: response.status,
      durationMs,
      ok: request.expectedStatuses.includes(response.status),
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    return {
      scenario: request.scenario,
      sequence: request.sequence,
      expectedStatuses: request.expectedStatuses,
      status: null,
      durationMs,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<GateResult>,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()),
  );
  return results;
}

export async function runGate(opts: CliOptions): Promise<GateReport> {
  assertDormantTarget(opts.target, opts.allowNonWorkerTarget);

  const startedAt = new Date().toISOString();
  const requests: GateRequest[] = [];
  for (let index = 0; index < opts.requests; index += 1) {
    const scenario = opts.scenarios[index % opts.scenarios.length];
    requests.push(buildGateRequest(scenario, index + 1, opts));
  }

  const results = await runPool(requests, opts.concurrency, (request) =>
    sendGateRequest(request, opts.timeoutMs),
  );
  const finishedAt = new Date().toISOString();
  const byScenario: GateReport["byScenario"] = {};

  for (const result of results) {
    const bucket =
      byScenario[result.scenario] ??
      {
        total: 0,
        passed: 0,
        failed: 0,
        statuses: {},
        maxDurationMs: 0,
      };
    bucket.total += 1;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, result.durationMs);
    if (result.ok) {
      bucket.passed += 1;
    } else {
      bucket.failed += 1;
    }
    const statusKey = result.status == null ? "error" : String(result.status);
    bucket.statuses[statusKey] = (bucket.statuses[statusKey] ?? 0) + 1;
    byScenario[result.scenario] = bucket;
  }

  const failed = results.filter((result) => !result.ok).length;
  const fiveXx = results.filter(
    (result) => result.status != null && result.status >= 500 && result.status <= 599,
  ).length;

  return {
    target: opts.target,
    path: opts.path,
    startedAt,
    finishedAt,
    totals: {
      total: results.length,
      passed: results.length - failed,
      failed,
      fiveXx,
      maxDurationMs: Math.max(0, ...results.map((result) => result.durationMs)),
    },
    byScenario,
    results,
  };
}

function writeStepSummary(report: GateReport, verdict: Verdict): void {
  const lines: string[] = [];
  lines.push("# Nango dormant webhook burst gate");
  lines.push("");
  lines.push(`- Target: \`${report.target}\``);
  lines.push(`- Path: \`${report.path}\``);
  lines.push(`- Total: ${report.totals.total}`);
  lines.push(`- Passed: ${report.totals.passed}`);
  lines.push(`- Failed: ${report.totals.failed}`);
  lines.push(`- 5xx: ${report.totals.fiveXx}`);
  lines.push(`- Max duration: ${report.totals.maxDurationMs}ms`);
  lines.push("");
  lines.push("| Scenario | Total | Passed | Failed | Statuses | Max duration |");
  lines.push("| :------- | ----: | -----: | -----: | :------- | -----------: |");
  for (const [scenario, bucket] of Object.entries(report.byScenario)) {
    const statuses = Object.entries(bucket.statuses)
      .map(([status, count]) => `${status}:${count}`)
      .join(", ");
    lines.push(
      `| ${scenario} | ${bucket.total} | ${bucket.passed} | ${bucket.failed} | ${statuses} | ${bucket.maxDurationMs}ms |`,
    );
  }
  lines.push("");
  lines.push(`## Verdict: ${verdict}`);

  const summary = `${lines.join("\n")}\n`;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, summary);
  } else {
    console.log(summary);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runGate(opts);
  writeFileSync(opts.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const verdict: Verdict =
    report.totals.failed === 0 && report.totals.fiveXx === 0 ? "PASS" : "FAIL";
  writeStepSummary(report, verdict);
  console.log(
    `[nango-b6-gate] ${verdict} total=${report.totals.total} ` +
      `failed=${report.totals.failed} fiveXx=${report.totals.fiveXx} ` +
      `report=${opts.reportPath}`,
  );

  if (verdict === "FAIL") {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}

export { type CliOptions, type GateReport, type GateRequest, type GateResult };

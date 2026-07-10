#!/usr/bin/env node
/**
 * Post-deploy invariants verifier.
 *
 * Reads `infra/post-deploy-invariants.yaml`, queries live AWS state via the
 * AWS CLI (already available on every GitHub Actions runner and on local dev
 * machines), and exits non-zero if any hard-fail invariant is violated.
 *
 * Background: PR cloud#616 set `args.reservedConcurrentExecutions = N` inside
 * SST `transform.server` blocks. SST's FunctionArgs exposes concurrency via
 * `concurrency: { reserved }`; the wrong key was a silent no-op. Deploy
 * succeeded, code review couldn't catch it. cloud#624 was the hotfix. This
 * script is the safety net that fires on every future deploy.
 *
 * Usage:
 *   npx tsx scripts/post-deploy-verify.ts \
 *     [--manifest infra/post-deploy-invariants.yaml] \
 *     [--region us-east-1]
 *
 * Env:
 *   AWS_REGION            Falls back to this if --region is not passed.
 *   POST_DEPLOY_VERIFY_REGION  Explicit override (highest precedence after CLI).
 *
 * Exit codes:
 *   0  All invariants pass.
 *   1  At least one invariant failed (mismatch, function not found, AWS
 *      error, manifest parse error).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type FindBy = {
  nameContains?: string;
};

type LambdaExpect = {
  reservedConcurrentExecutions?: number;
};

type AssertionSeverity = "fail" | "warn";

type LambdaSeverity = {
  reservedConcurrentExecutions?: AssertionSeverity;
};

type LambdaInvariant = {
  logicalName: string;
  findBy: FindBy;
  expect: LambdaExpect;
  severity?: LambdaSeverity;
};

type Manifest = {
  lambdas?: LambdaInvariant[];
};

type CheckResult = {
  logicalName: string;
  property: string;
  expected: unknown;
  actual: unknown;
  status: "PASS" | "FAIL" | "WARN";
  message?: string;
  resolvedName?: string;
};

function parseArgs(argv: string[]): { manifest: string; region: string } {
  let manifest = "infra/post-deploy-invariants.yaml";
  let region =
    process.env.POST_DEPLOY_VERIFY_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manifest") {
      manifest = argv[++i];
    } else if (a === "--region") {
      region = argv[++i];
    } else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        "Usage: post-deploy-verify [--manifest path] [--region us-east-1]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { manifest, region };
}

function awsJson(args: string[]): unknown {
  const proc = spawnSync("aws", args, { encoding: "utf8" });
  if (proc.error) {
    throw new Error(`Failed to spawn aws CLI: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    const stderr = (proc.stderr || "").trim();
    throw new Error(
      `aws ${args.join(" ")} exited ${proc.status}: ${stderr || "no stderr"}`
    );
  }
  const stdout = (proc.stdout || "").trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(
      `Failed to parse JSON from 'aws ${args.join(" ")}': ${(e as Error).message}`
    );
  }
}

async function listAllFunctionNames(region: string): Promise<string[]> {
  // The CLI paginates automatically when --no-cli-pager is set and no
  // --max-items is provided. To be safe with large accounts we loop on
  // NextMarker.
  const names: string[] = [];
  let marker: string | undefined;
  while (true) {
    const cmd = [
      "lambda",
      "list-functions",
      "--region",
      region,
      "--output",
      "json",
    ];
    if (marker) {
      cmd.push("--starting-token", marker);
    }
    const res = awsJson(cmd) as
      | { Functions?: Array<{ FunctionName?: string }>; NextMarker?: string | null }
      | null;
    if (!res) break;
    for (const fn of res.Functions || []) {
      if (fn.FunctionName) names.push(fn.FunctionName);
    }
    if (!res.NextMarker) break;
    marker = res.NextMarker;
  }
  return names;
}

function resolveLambdaName(
  inv: LambdaInvariant,
  candidates: string[]
): { ok: true; name: string } | { ok: false; reason: string } {
  const { nameContains } = inv.findBy || {};
  if (!nameContains) {
    return {
      ok: false,
      reason: `invariant '${inv.logicalName}' has no findBy.nameContains rule (only nameContains is supported today)`,
    };
  }
  const matches = candidates.filter((n) => n.includes(nameContains));
  if (matches.length === 0) {
    return {
      ok: false,
      reason: `no function name contains '${nameContains}'`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `findBy.nameContains '${nameContains}' matched ${matches.length} functions (${matches.join(", ")}); narrow the substring`,
    };
  }
  return { ok: true, name: matches[0] };
}

function getReservedConcurrency(
  fnName: string,
  region: string
): number | null {
  // `get-function-concurrency` returns an empty object when no reservation is
  // set, or {"ReservedConcurrentExecutions": N} when one is. We normalize
  // "unset" to null.
  const res = awsJson([
    "lambda",
    "get-function-concurrency",
    "--function-name",
    fnName,
    "--region",
    region,
    "--output",
    "json",
  ]) as { ReservedConcurrentExecutions?: number } | null;
  if (!res) return null;
  if (typeof res.ReservedConcurrentExecutions !== "number") return null;
  return res.ReservedConcurrentExecutions;
}

function getExpectationSeverity(
  inv: LambdaInvariant,
  property: keyof LambdaSeverity
): AssertionSeverity {
  return inv.severity?.[property] === "warn" ? "warn" : "fail";
}

function checkLambda(
  inv: LambdaInvariant,
  candidates: string[],
  region: string
): CheckResult[] {
  const resolved = resolveLambdaName(inv, candidates);
  if (resolved.ok === false) {
    return [
      {
        logicalName: inv.logicalName,
        property: "resolve",
        expected: inv.findBy,
        actual: null,
        status: "FAIL",
        message: resolved.reason,
      },
    ];
  }

  const fnName = resolved.name;
  const results: CheckResult[] = [];

  if (typeof inv.expect.reservedConcurrentExecutions === "number") {
    let actual: number | null = null;
    let errMessage: string | undefined;
    try {
      actual = getReservedConcurrency(fnName, region);
    } catch (e) {
      errMessage = (e as Error).message;
    }
    const expected = inv.expect.reservedConcurrentExecutions;
    const severity = getExpectationSeverity(
      inv,
      "reservedConcurrentExecutions"
    );
    const matched = errMessage == null && actual === expected;
    const status: CheckResult["status"] = matched
      ? "PASS"
      : errMessage == null && severity === "warn"
        ? "WARN"
        : "FAIL";
    results.push({
      logicalName: inv.logicalName,
      property: "reservedConcurrentExecutions",
      expected,
      actual: errMessage ? `<aws error: ${errMessage}>` : actual,
      status,
      resolvedName: fnName,
      message:
        status !== "PASS"
          ? errMessage
            ? `failed to read concurrency: ${errMessage}`
            : `expected ${expected}, got ${actual === null ? "unset (no reservation)" : actual}`
          : undefined,
    });
  }

  return results;
}

function loadManifest(manifestPath: string): Manifest {
  const abs = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(process.cwd(), manifestPath);
  const raw = readFileSync(abs, "utf8");
  const parsed = parseYaml(raw) as Manifest | null;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Manifest at ${abs} did not parse to an object`);
  }
  return parsed;
}

function printSummary(results: CheckResult[]): void {
  const pad = (s: string, n: number) => s.padEnd(n, " ");
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("Post-deploy invariants:");
  // eslint-disable-next-line no-console
  console.log("");
  for (const r of results) {
    const head = `[${r.status}] ${pad(r.logicalName, 30)} ${r.property}`;
    if (r.status === "PASS") {
      // eslint-disable-next-line no-console
      console.log(`${head}  expected=${r.expected}  actual=${r.actual}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `${head}  expected=${JSON.stringify(r.expected)}  actual=${JSON.stringify(r.actual)}`
      );
      if (r.message) {
        // eslint-disable-next-line no-console
        console.log(`         reason: ${r.message}`);
      }
      if (r.resolvedName) {
        // eslint-disable-next-line no-console
        console.log(`         function: ${r.resolvedName}`);
      }
    }
  }
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  const passed = results.length - failed - warned;
  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log(
    `Summary: ${passed} passed, ${warned} warned, ${failed} failed, ${results.length} total`
  );
}

async function main(): Promise<void> {
  const { manifest, region } = parseArgs(process.argv);
  // eslint-disable-next-line no-console
  console.log(`Reading manifest: ${manifest}`);
  // eslint-disable-next-line no-console
  console.log(`AWS region:       ${region}`);

  const parsed = loadManifest(manifest);
  const lambdas = parsed.lambdas || [];
  if (lambdas.length === 0) {
    // eslint-disable-next-line no-console
    console.log("Manifest has no lambda invariants; nothing to verify.");
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(
    `Listing Lambda functions in ${region} to resolve logical names…`
  );
  const allNames = await listAllFunctionNames(region);
  // eslint-disable-next-line no-console
  console.log(`Found ${allNames.length} functions.`);

  const results: CheckResult[] = [];
  for (const inv of lambdas) {
    results.push(...checkLambda(inv, allNames, region));
  }

  printSummary(results);

  const anyFailed = results.some((r) => r.status === "FAIL");
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(`post-deploy-verify: fatal: ${(e as Error).message}`);
  process.exit(1);
});

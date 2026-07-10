#!/usr/bin/env node
/**
 * Cutover replay-harness gate.
 *
 * Wraps `@cloud/replay-harness` with the bits the existing CLI doesn't ship:
 *
 *   1. Pulls a corpus from the `traffic-recorder` R2 bucket. The bucket layout
 *      is `corpus/YYYY/MM/DD/HH/<request-id>.ndjson` (one request per object,
 *      each object is a single NDJSON line). The harness CLI expects a single
 *      corpus URI containing many lines, so we list+sample+concat into a
 *      temporary file before invoking it.
 *   2. Bounded sampling — `--sample-size N` random objects, deterministic via
 *      `--seed` so reruns inspect the same corpus.
 *   3. Pass-rate threshold — `--min-pass-rate 0.99` exits non-zero if
 *      `(identical + allowlisted) / total < threshold`. The harness CLI only
 *      knows `divergent > 0 → fail`, which is too strict for a probabilistic
 *      cutover gate.
 *   4. GH Actions step summary — writes a Markdown summary (totals, pass
 *      rate, top failure reasons) to `$GITHUB_STEP_SUMMARY` when set.
 *
 * Usage:
 *   npx tsx scripts/cutover-replay-gate.ts \
 *     --target https://cloud-web-worker-production.<acct>.workers.dev \
 *     --bucket traffic-recorder \
 *     [--prefix corpus/]                # default corpus/
 *     [--sample-size 200]               # default 200
 *     [--min-pass-rate 0.99]            # default 0.99
 *     [--seed 1]                        # default Date.now()
 *     [--report cutover-replay-report.json]
 *     [--allow-mutations]               # default false (read-only)
 *
 * Env:
 *   AWS_REGION / R2_ENDPOINT / S3_ENDPOINT — passed through to the corpus
 *   reader (see packages/replay-harness/src/corpus.ts). For Cloudflare R2,
 *   set R2_ENDPOINT to the `https://<accountId>.r2.cloudflarestorage.com`
 *   URL and provide AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY scoped to the
 *   bucket via an R2 access token.
 *
 * Exit codes:
 *   0  Pass rate >= threshold.
 *   1  Pass rate < threshold, or any infra error (auth, missing corpus, etc).
 */

import { ListObjectsV2Command, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runReplayHarness } from "../packages/replay-harness/src/index.js";
import { buildReport, writeReport } from "../packages/replay-harness/src/report.js";

interface CliOptions {
  target: string;
  bucket: string;
  prefix: string;
  sampleSize: number;
  minPassRate: number;
  seed: number;
  reportPath: string;
  allowMutations: boolean;
}

// Strict integer parser. `Number.parseInt("200abc", 10)` returns 200, which
// silently swallows operator typos. We require the entire string to be a
// well-formed signed integer.
function parseStrictInt(value: string, flag: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flag} expected an integer, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${flag} expected a finite integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Strict float parser. `Number.parseFloat("1.9xyz")` returns 1.9; we reject
// trailing garbage to avoid misreading the threshold.
function parseStrictFloat(value: string, flag: string): number {
  if (!/^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
    throw new Error(`${flag} expected a number, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} expected a finite number, got ${JSON.stringify(value)}`);
  }
  return n;
}

function parseArgs(argv: string[]): CliOptions {
  let target = "";
  let bucket = "";
  let prefix = "corpus/";
  let sampleSize = 200;
  let minPassRate = 0.99;
  let seed = Date.now();
  let reportPath = "cutover-replay-report.json";
  let allowMutations = false;

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
      case "--bucket":
        bucket = next();
        break;
      case "--prefix":
        prefix = next();
        break;
      case "--sample-size":
        sampleSize = parseStrictInt(next(), "--sample-size");
        break;
      case "--min-pass-rate":
        minPassRate = parseStrictFloat(next(), "--min-pass-rate");
        break;
      case "--seed":
        seed = parseStrictInt(next(), "--seed");
        break;
      case "--report":
        reportPath = next();
        break;
      case "--allow-mutations":
        allowMutations = true;
        break;
      default:
        throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!target) throw new Error("--target is required");
  if (!bucket) throw new Error("--bucket is required");
  if (!Number.isFinite(sampleSize) || sampleSize <= 0) {
    throw new Error("--sample-size must be a positive integer");
  }
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    throw new Error("--min-pass-rate must be in [0, 1]");
  }

  return {
    target,
    bucket,
    prefix,
    sampleSize,
    minPassRate,
    seed,
    reportPath,
    allowMutations,
  };
}

function createR2Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "auto",
    endpoint:
      process.env.R2_ENDPOINT ??
      process.env.S3_ENDPOINT ??
      process.env.AWS_ENDPOINT_URL_S3,
    forcePathStyle: true,
  });
}

async function listCorpusKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of response.Contents ?? []) {
      if (obj.Key && obj.Key.endsWith(".ndjson")) {
        keys.push(obj.Key);
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

// xorshift32 deterministic RNG so reruns with the same --seed sample identical
// corpus subsets. We divide by 2^32 (0x1_0000_0000), not 0xffffffff, so the
// returned value is in `[0, 1)` rather than `[0, 1]`. Hitting exactly 1.0
// makes `Math.floor(rng() * (i + 1))` equal `i + 1`, which would index past
// the end of the array in `sample()` and inject `undefined` into the corpus.
function makeRng(seed: number): () => number {
  let state = seed === 0 ? 1 : seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function sample<T>(items: T[], n: number, rng: () => number): T[] {
  if (items.length <= n) return [...items];
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

async function fetchObjectText(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`Empty body for s3://${bucket}/${key}`);
  }
  return response.Body.transformToString();
}

interface DivergenceBucket {
  reason: string;
  count: number;
  examples: string[];
}

function summarizeDivergences(
  results: Array<{ method: string; path: string; result: { kind: string; reason?: string } }>,
): DivergenceBucket[] {
  const buckets = new Map<string, DivergenceBucket>();
  for (const entry of results) {
    if (entry.result.kind !== "divergent") continue;
    const reason = entry.result.reason ?? "unknown";
    const bucket =
      buckets.get(reason) ?? { reason, count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < 3) {
      bucket.examples.push(`${entry.method} ${entry.path}`);
    }
    buckets.set(reason, bucket);
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count);
}

// GitHub-flavored Markdown table cells break on `|` and newlines: a literal
// pipe ends the cell early and a newline ends the row. Replace both with
// HTML-entity / `<br>` equivalents so divergence reasons that contain those
// characters render correctly in the step summary.
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "&#124;").replace(/\r?\n/g, "<br>");
}

function writeStepSummary(
  summary: string,
): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) {
    console.log(summary);
    return;
  }
  appendFileSync(path, `${summary}\n`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `[cutover-gate] target=${opts.target} bucket=${opts.bucket} ` +
      `prefix=${opts.prefix} sample=${opts.sampleSize} ` +
      `threshold=${opts.minPassRate} seed=${opts.seed}`,
  );

  const client = createR2Client();
  const allKeys = await listCorpusKeys(client, opts.bucket, opts.prefix);
  if (allKeys.length === 0) {
    throw new Error(
      `No NDJSON objects under s3://${opts.bucket}/${opts.prefix}. Has the ` +
        `traffic recorder been enabled (ROUTER_CONFIG.recorder=on)?`,
    );
  }
  console.log(`[cutover-gate] discovered ${allKeys.length} corpus objects`);

  const rng = makeRng(opts.seed);
  const sampledKeys = sample(allKeys, opts.sampleSize, rng);
  console.log(`[cutover-gate] sampled ${sampledKeys.length} keys`);

  const corpusDir = mkdtempSync(path.join(tmpdir(), "cutover-corpus-"));
  const corpusPath = path.join(corpusDir, "corpus.ndjson");
  const lines: string[] = [];
  for (const key of sampledKeys) {
    const text = await fetchObjectText(client, opts.bucket, key);
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    }
  }
  writeFileSync(corpusPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`[cutover-gate] wrote ${lines.length} corpus entries → ${corpusPath}`);

  const evaluations = await runReplayHarness(corpusPath, opts.target, {
    allowMutations: opts.allowMutations,
  });
  const report = buildReport(corpusPath, opts.target, evaluations);
  await writeReport(path.resolve(opts.reportPath), report);

  const total = report.totals.total;
  const passing = report.totals.identical + report.totals.allowlisted;
  const passRate = total === 0 ? 0 : passing / total;
  const buckets = summarizeDivergences(report.results as never);

  const lines2: string[] = [];
  lines2.push(`# Cutover replay-harness gate`);
  lines2.push("");
  lines2.push(`- Target: \`${opts.target}\``);
  lines2.push(`- Corpus bucket: \`${opts.bucket}/${opts.prefix}\``);
  lines2.push(`- Sample size: ${opts.sampleSize} (seed ${opts.seed})`);
  lines2.push(`- Threshold: ${(opts.minPassRate * 100).toFixed(2)}%`);
  lines2.push("");
  lines2.push(`## Result`);
  lines2.push("");
  lines2.push(`- Total: ${total}`);
  lines2.push(`- Identical: ${report.totals.identical}`);
  lines2.push(`- Allowlisted: ${report.totals.allowlisted}`);
  lines2.push(`- Divergent: ${report.totals.divergent}`);
  lines2.push(`- **Pass rate: ${(passRate * 100).toFixed(2)}%**`);
  lines2.push("");
  if (buckets.length > 0) {
    lines2.push(`## Top failure reasons`);
    lines2.push("");
    lines2.push(`| Count | Reason | Examples |`);
    lines2.push(`| ----: | :----- | :------- |`);
    for (const bucket of buckets.slice(0, 10)) {
      const reason = escapeTableCell(bucket.reason);
      const examples = bucket.examples.map(escapeTableCell).join("<br>");
      lines2.push(`| ${bucket.count} | ${reason} | ${examples} |`);
    }
    lines2.push("");
  }
  const verdict =
    passRate >= opts.minPassRate
      ? `PASS — pass rate ${(passRate * 100).toFixed(2)}% >= threshold`
      : `FAIL — pass rate ${(passRate * 100).toFixed(2)}% < threshold ${(opts.minPassRate * 100).toFixed(2)}%`;
  lines2.push(`## Verdict: ${verdict}`);
  writeStepSummary(lines2.join("\n"));

  console.log(`[cutover-gate] verdict: ${verdict}`);
  if (passRate < opts.minPassRate) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

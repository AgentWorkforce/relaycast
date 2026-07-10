#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const nangoConfigPath = path.join(repoRoot, "nango-integrations/.nango/nango.json");

const args = parseArgs(process.argv.slice(2));
const allIntegrations = readAllIntegrations();
const allIntegrationSet = new Set(allIntegrations);

const manual = args.manual?.trim();
if (manual) {
  printIntegrations(resolveManualIntegrations(manual));
  process.exit(0);
}

if (args.event !== "push") {
  printIntegrations(allIntegrations);
  process.exit(0);
}

if (!args.before || isZeroSha(args.before) || !args.after) {
  printIntegrations(allIntegrations);
  process.exit(0);
}

let changedFiles;
try {
  changedFiles = gitDiffNames(args.before, args.after);
} catch (error) {
  process.stderr.write(
    `Unable to diff Nango integration changes; deploying all integrations instead.\n${formatError(error)}\n`,
  );
  printIntegrations(allIntegrations);
  process.exit(0);
}
const selected = new Set();
let deployAll = false;

for (const file of changedFiles) {
  const classification = classifyChangedFile(file);
  if (classification === "all") {
    deployAll = true;
    break;
  }
  if (classification && allIntegrationSet.has(classification)) {
    selected.add(classification);
  }
}

printIntegrations(deployAll ? allIntegrations : allIntegrations.filter((integration) => selected.has(integration)));

function parseArgs(input) {
  const parsed = {};
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = input[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      parsed[key] = value;
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function readAllIntegrations() {
  const config = JSON.parse(readFileSync(nangoConfigPath, "utf8"));
  if (!Array.isArray(config)) {
    throw new Error(".nango/nango.json must be an array.");
  }
  return config
    .map((entry) => entry?.providerConfigKey)
    .filter((value) => typeof value === "string" && value.length > 0);
}

function resolveManualIntegrations(value) {
  if (value.toLowerCase() === "all") {
    return allIntegrations;
  }

  const requested = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const resolved = requested.map(resolveManualIntegration);
  const unknown = resolved
    .filter((entry) => !entry.integration)
    .map((entry) => entry.requested);
  if (unknown.length > 0) {
    throw new Error(`Unknown Nango integration(s): ${unknown.join(", ")}`);
  }
  const resolvedSet = new Set(resolved.map((entry) => entry.integration));
  return allIntegrations.filter((integration) => resolvedSet.has(integration));
}

function resolveManualIntegration(requested) {
  const normalized = requested.toLowerCase();
  const candidates = [
    requested,
    normalized,
    `${normalized}-relay`,
    `${normalized}-composio-relay`,
  ];
  const integration = candidates.find((candidate) => allIntegrationSet.has(candidate));
  return { requested, integration };
}

function gitDiffNames(before, after) {
  return execFileSync("git", ["diff", "--name-only", before, after], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function classifyChangedFile(file) {
  if (
    file === "package.json" ||
    file === "package-lock.json" ||
    file === ".github/workflows/deploy-nango-integrations.yml" ||
    file === "scripts/assert-nango-webhook-subscriptions.mjs" ||
    file === "scripts/refresh-nango-webhook-syncs.mjs" ||
    file === "scripts/generate-nango-github-webhook-events.mjs" ||
    file === "scripts/select-nango-integrations-to-deploy.mjs"
  ) {
    return "all";
  }

  if (!file.startsWith("nango-integrations/")) {
    return null;
  }

  const relative = file.slice("nango-integrations/".length);
  if (
    relative === "package.json" ||
    relative === "package-lock.json" ||
    relative === "index.ts" ||
    relative === "global-config.ts" ||
    relative === "schema.ts" ||
    relative === "schema.zod.ts" ||
    relative === "models.ts" ||
    relative === "tsconfig.json" ||
    relative.startsWith(".nango/") ||
    relative.startsWith("shared/")
  ) {
    return "all";
  }

  const [integration, ...rest] = relative.split("/");
  if (!integration.endsWith("-relay") && !integration.includes("-composio-relay")) {
    return "all";
  }

  const integrationPath = rest.join("/");
  if (
    integrationPath.startsWith("tests/") ||
    integrationPath.endsWith(".test.ts") ||
    integrationPath.endsWith(".test.json")
  ) {
    return null;
  }

  return integration;
}

function isZeroSha(value) {
  return /^0+$/.test(value);
}

function formatError(error) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr?.toString().trim();
    if (stderr) {
      return stderr;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function printIntegrations(integrations) {
  process.stdout.write(`${integrations.join("\n")}${integrations.length > 0 ? "\n" : ""}`);
}

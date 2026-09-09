#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function requiredString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u0020]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty value without whitespace`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

export function parseNpmDistTagOutput(stdout) {
  const output = stdout.trim();
  if (output === "" || output === "null") return { kind: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { kind: "ambiguous" };
  }
  if (parsed === null || parsed === undefined) return { kind: "missing" };
  if (
    typeof parsed !== "string" ||
    parsed.length === 0 ||
    parsed.trim() !== parsed
  ) {
    return { kind: "ambiguous" };
  }
  return { kind: "value", value: parsed };
}

/** Read one exact npm dist-tag without treating malformed output as absence. */
export function readNpmDistTag(
  packageName,
  distTag,
  { npmCommand = "npm", cwd = process.cwd(), env = process.env } = {},
) {
  const result = spawnSync(
    npmCommand,
    ["view", packageName, `dist-tags.${distTag}`, "--json", "--prefer-online"],
    { cwd, env, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    return { kind: "unavailable", exitCode: result.status };
  }
  return parseNpmDistTagOutput(result.stdout);
}

/**
 * Observe the requested npm dist-tag until the registry reports the exact
 * version. `npm publish --tag` is the only mutation in the workflow: npm OIDC
 * trusted publishing does not authorize `npm dist-tag`, so a retry must verify
 * and fail closed rather than attempt an unauthenticated tag rewrite. Missing,
 * stale, and transiently unavailable reads get a bounded propagation window;
 * malformed or multi-valued responses fail immediately rather than being
 * mistaken for a successful match.
 */
export async function ensureNpmDistTag({
  packageName,
  version,
  distTag,
  attempts = 5,
  delayMs = 5_000,
  readTag = readNpmDistTag,
  sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  requiredString(packageName, "packageName");
  requiredString(version, "version");
  requiredString(distTag, "distTag");
  positiveInteger(attempts, "attempts");
  nonNegativeInteger(delayMs, "delayMs");

  let last = { kind: "missing" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const observation = readTag(packageName, distTag);
    last = observation;
    if (observation?.kind === "value" && observation.value === version) {
      return { packageName, version, distTag, attempts: attempt };
    }
    if (
      !observation ||
      !["missing", "unavailable", "value"].includes(observation.kind)
    ) {
      throw new Error(
        `npm returned an ambiguous ${packageName} dist-tag ${distTag} response`,
      );
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  if (last.kind === "value") {
    throw new Error(
      `${packageName} dist-tag ${distTag} points to ${last.value}, expected ${version}`,
    );
  }
  if (last.kind === "unavailable") {
    throw new Error(
      `npm could not verify ${packageName} dist-tag ${distTag} after ${attempts} attempts`,
    );
  }
  throw new Error(
    `${packageName} dist-tag ${distTag} is absent after ${attempts} attempts`,
  );
}

function argument(name, { optional = false, fallback } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    if (optional) return fallback;
    throw new Error(`${name} is required`);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const command = process.argv[2];
  if (command !== "verify") {
    throw new Error("command must be verify");
  }
  const result = await ensureNpmDistTag({
    packageName: argument("--package"),
    version: argument("--version"),
    distTag: argument("--tag"),
    attempts: positiveInteger(
      argument("--attempts", { optional: true, fallback: "5" }),
      "--attempts",
    ),
    delayMs: nonNegativeInteger(
      argument("--delay-ms", { optional: true, fallback: "5000" }),
      "--delay-ms",
    ),
  });
  process.stdout.write(
    `${result.packageName} dist-tag ${result.distTag} verified at ${result.version}\n`,
  );
}

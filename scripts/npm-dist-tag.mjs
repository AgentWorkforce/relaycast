#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm may take a few minutes to expose a newly published package and its
// dist-tag through every registry read path. Keep retries bounded while
// allowing that documented propagation window to elapse.
export const DEFAULT_ATTEMPTS = 30;
export const DEFAULT_DELAY_MS = 10_000;

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

export function parseNpmDistTagsOutput(stdout, distTag) {
  const output = stdout.trim();
  if (output === "" || output === "null") return { kind: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { kind: "ambiguous" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "ambiguous" };
  }
  if (!Object.hasOwn(parsed, distTag)) return { kind: "missing" };
  const value = parsed[distTag];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    return { kind: "ambiguous" };
  }
  return { kind: "value", value };
}

/** Read one exact npm dist-tag without treating malformed output as absence. */
export function readNpmDistTag(
  packageName,
  distTag,
  {
    npmCommand = "npm",
    cwd = process.cwd(),
    env = process.env,
    spawn = spawnSync,
  } = {},
) {
  const result = spawn(
    npmCommand,
    ["view", packageName, "dist-tags", "--json", "--prefer-online"],
    { cwd, env, encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    return { kind: "unavailable", exitCode: result.status };
  }
  return parseNpmDistTagsOutput(result.stdout, distTag);
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
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  readTag = readNpmDistTag,
  sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  const result = await ensureNpmDistTags({
    packageNames: [packageName],
    version,
    distTag,
    attempts,
    delayMs,
    readTag,
    sleep,
  });
  return { packageName, version, distTag, attempts: result.attempts };
}

/**
 * Verify several dist-tags in rounds under one shared bounded window. A slow
 * package therefore cannot consume a separate retry budget before the other
 * packages are checked. This is read-only: stale tags fail closed and are
 * never rewritten or used as a reason to republish a package.
 */
export async function ensureNpmDistTags({
  packageNames,
  version,
  distTag,
  attempts = DEFAULT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  readTag = readNpmDistTag,
  sleep = (milliseconds) =>
    new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  if (!Array.isArray(packageNames) || packageNames.length === 0) {
    throw new Error("packageNames must contain at least one package");
  }
  const names = packageNames.map((packageName) =>
    requiredString(packageName, "packageName"),
  );
  if (new Set(names).size !== names.length) {
    throw new Error("packageNames must not contain duplicates");
  }
  requiredString(version, "version");
  requiredString(distTag, "distTag");
  positiveInteger(attempts, "attempts");
  nonNegativeInteger(delayMs, "delayMs");

  const last = new Map();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let pending = false;
    for (const packageName of names) {
      const observation = readTag(packageName, distTag);
      last.set(packageName, observation);
      if (observation?.kind === "value" && observation.value === version) {
        continue;
      }
      if (
        !observation ||
        !["missing", "unavailable", "value"].includes(observation.kind)
      ) {
        throw new Error(
          `npm returned an ambiguous ${packageName} dist-tag ${distTag} response`,
        );
      }
      pending = true;
    }
    if (!pending) {
      return { packageNames: names, version, distTag, attempts: attempt };
    }
    if (attempt < attempts) await sleep(delayMs);
  }

  const failures = names.flatMap((packageName) => {
    const observation = last.get(packageName);
    if (observation?.kind === "value") {
      return observation.value === version
        ? []
        : [`${packageName} dist-tag ${distTag} points to ${observation.value}, expected ${version}`];
    }
    if (observation?.kind === "unavailable") {
      return [`npm could not verify ${packageName} dist-tag ${distTag} after ${attempts} attempts`];
    }
    return [`${packageName} dist-tag ${distTag} is absent after ${attempts} attempts`];
  });
  if (failures.length === 1) throw new Error(failures[0]);
  throw new Error(
    `npm dist-tag ${distTag} reconciliation failed:\n${failures.join("\n")}`,
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

function argumentsFor(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    values.push(value);
  }
  return values;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const command = process.argv[2];
  if (command !== "verify" && command !== "verify-many") {
    throw new Error("command must be verify or verify-many");
  }
  const packageNames =
    command === "verify-many" ? argumentsFor("--package") : [argument("--package")];
  const result = await ensureNpmDistTags({
    packageNames,
    version: argument("--version"),
    distTag: argument("--tag"),
    attempts: positiveInteger(
      argument("--attempts", {
        optional: true,
        fallback: String(DEFAULT_ATTEMPTS),
      }),
      "--attempts",
    ),
    delayMs: nonNegativeInteger(
      argument("--delay-ms", {
        optional: true,
        fallback: String(DEFAULT_DELAY_MS),
      }),
      "--delay-ms",
    ),
  });
  process.stdout.write(
    command === "verify"
      ? `${packageNames[0]} dist-tag ${result.distTag} verified at ${result.version}\n`
      : `${packageNames.length} dist-tags ${result.distTag} verified at ${result.version}\n`,
  );
}

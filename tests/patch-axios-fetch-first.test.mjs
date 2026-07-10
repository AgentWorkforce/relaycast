import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceScript = join(repoRoot, "scripts/patch-axios-fetch-first.mjs");

const axiosFiles = [
  "lib/defaults/index.js",
  "dist/node/axios.cjs",
  "dist/esm/axios.js",
  "dist/axios.js",
  "dist/browser/axios.cjs",
];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "axios-fetch-first-"));
  const scriptPath = join(root, "scripts/patch-axios-fetch-first.mjs");
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(sourceScript, scriptPath);
  return { root, scriptPath };
}

function writeAxiosPackage(root, packagePath) {
  const packageRoot = join(root, packagePath);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "axios", version: "1.16.1" }),
    "utf8",
  );

  for (const relativeFile of axiosFiles) {
    const file = join(packageRoot, relativeFile);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        "const defaults = {",
        "  transitional: transitionalDefaults,",
        "  adapter: ['xhr', 'http', 'fetch'],",
        "};",
      ].join("\n"),
      "utf8",
    );
  }
}

function writeUnrecognizedAxiosPackage(root) {
  const packageRoot = join(root, "node_modules/unrecognized/node_modules/axios");
  mkdirSync(join(packageRoot, "lib/defaults"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/unrecognized/package.json"),
    JSON.stringify({ name: "unrecognized", version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "axios", version: "0.0.0-fixture" }),
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "lib/defaults/index.js"),
    "const defaults = { adapter: ['custom'] };\n",
    "utf8",
  );
}

function writeInternalAxiosFixture(root) {
  const fixtureRoot = join(root, "node_modules/not-axios/fixtures/axios");
  mkdirSync(join(fixtureRoot, "lib/defaults"), { recursive: true });
  writeFileSync(
    join(root, "node_modules/not-axios/package.json"),
    JSON.stringify({ name: "not-axios", version: "1.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "axios", version: "fixture" }),
    "utf8",
  );
  writeFileSync(
    join(fixtureRoot, "lib/defaults/index.js"),
    "const defaults = { adapter: ['custom'] };\n",
    "utf8",
  );
}

function runPatch(scriptPath, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

test("patch-axios-fetch-first rewrites every installed axios package and supports check mode", () => {
  const { root, scriptPath } = createFixture();
  writeAxiosPackage(root, "node_modules/axios");
  writeAxiosPackage(root, "node_modules/@daytonaio/sdk/node_modules/axios");
  writeUnrecognizedAxiosPackage(root);
  writeInternalAxiosFixture(root);

  const staleCheck = runPatch(scriptPath, ["--check"]);
  assert.notEqual(staleCheck.status, 0);
  assert.match(staleCheck.stderr, /axios adapter defaults are not fetch-first/);
  assert.match(staleCheck.stderr, /node_modules\/axios\/lib\/defaults\/index\.js/);
  assert.match(
    staleCheck.stderr,
    /node_modules\/@daytonaio\/sdk\/node_modules\/axios\/dist\/node\/axios\.cjs/,
  );

  const patch = runPatch(scriptPath);
  assert.equal(patch.status, 0, patch.stderr);
  assert.match(patch.stdout, /patched axios adapter defaults/);
  assert.match(patch.stderr, /package layout may have changed, skipping/);

  for (const packagePath of [
    "node_modules/axios",
    "node_modules/@daytonaio/sdk/node_modules/axios",
  ]) {
    for (const relativeFile of axiosFiles) {
      const patched = readFileSync(join(root, packagePath, relativeFile), "utf8");
      assert.match(patched, /adapter: \['fetch', 'xhr', 'http'\]/);
      assert.doesNotMatch(
        patched,
        /adapter:\s*\[\s*['"]xhr['"]\s*,\s*['"]http['"]\s*,\s*['"]fetch['"]\s*\]/,
      );
    }
  }

  const cleanCheck = runPatch(scriptPath, ["--check"]);
  assert.equal(cleanCheck.status, 0, cleanCheck.stderr);
  assert.match(cleanCheck.stderr, /package layout may have changed, skipping/);

  const idempotent = runPatch(scriptPath);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.match(idempotent.stdout, /already fetch-first/);

  const unrecognized = readFileSync(
    join(root, "node_modules/unrecognized/node_modules/axios/lib/defaults/index.js"),
    "utf8",
  );
  assert.match(unrecognized, /adapter: \['custom'\]/);

  const untouchedFixture = readFileSync(
    join(root, "node_modules/not-axios/fixtures/axios/lib/defaults/index.js"),
    "utf8",
  );
  assert.match(untouchedFixture, /adapter: \['custom'\]/);
});

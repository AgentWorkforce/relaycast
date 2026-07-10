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
const sourceScript = join(
  repoRoot,
  "scripts/patch-smithy-ini-file-loader.mjs",
);

// The exact unsafe content as it appears in the real dist files
const CJS_READ_FILE_CONTENT = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readFile = exports.fileIntercept = exports.filePromises = void 0;
const promises_1 = require("node:fs/promises");
exports.filePromises = {};
exports.fileIntercept = {};
const readFile = (path, options) => {
    if (exports.fileIntercept[path] !== undefined) {
        return exports.fileIntercept[path];
    }
    if (!exports.filePromises[path] || options?.ignoreCache) {
        exports.filePromises[path] = (0, promises_1.readFile)(path, "utf8");
    }
    return exports.filePromises[path];
};
exports.readFile = readFile;`;

const ES_READ_FILE_CONTENT = `import { readFile as fsReadFile } from "node:fs/promises";
export const filePromises = {};
export const fileIntercept = {};
export const readFile = (path, options) => {
    if (fileIntercept[path] !== undefined) {
        return fileIntercept[path];
    }
    if (!filePromises[path] || options?.ignoreCache) {
        filePromises[path] = fsReadFile(path, "utf8");
    }
    return filePromises[path];
};`;

const CJS_GET_SSO_TOKEN_CONTENT = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSSOTokenFromFile = exports.tokenIntercept = void 0;
const promises_1 = require("fs/promises");
const getSSOTokenFilepath_1 = require("./getSSOTokenFilepath");
exports.tokenIntercept = {};
const getSSOTokenFromFile = async (id) => {
    if (exports.tokenIntercept[id]) {
        return exports.tokenIntercept[id];
    }
    const ssoTokenFilepath = (0, getSSOTokenFilepath_1.getSSOTokenFilepath)(id);
    const ssoTokenText = await (0, promises_1.readFile)(ssoTokenFilepath, "utf8");
    return JSON.parse(ssoTokenText);
};
exports.getSSOTokenFromFile = getSSOTokenFromFile;`;

const ES_GET_SSO_TOKEN_CONTENT = `import { readFile } from "fs/promises";
import { getSSOTokenFilepath } from "./getSSOTokenFilepath";
export const tokenIntercept = {};
export const getSSOTokenFromFile = async (id) => {
    if (tokenIntercept[id]) {
        return tokenIntercept[id];
    }
    const ssoTokenFilepath = getSSOTokenFilepath(id);
    const ssoTokenText = await readFile(ssoTokenFilepath, "utf8");
    return JSON.parse(ssoTokenText);
};`;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "smithy-ini-fix-"));
  const scriptPath = join(root, "scripts/patch-smithy-ini-file-loader.mjs");
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(sourceScript, scriptPath);
  return { root, scriptPath };
}

function writeSmithyPackage(root, packagePath) {
  const packageRoot = join(root, packagePath);
  mkdirSync(join(packageRoot, "dist-cjs"), { recursive: true });
  mkdirSync(join(packageRoot, "dist-es"), { recursive: true });

  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@smithy/shared-ini-file-loader",
      version: "4.0.0",
    }),
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "dist-cjs/readFile.js"),
    CJS_READ_FILE_CONTENT,
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "dist-es/readFile.js"),
    ES_READ_FILE_CONTENT,
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "dist-cjs/getSSOTokenFromFile.js"),
    CJS_GET_SSO_TOKEN_CONTENT,
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "dist-es/getSSOTokenFromFile.js"),
    ES_GET_SSO_TOKEN_CONTENT,
    "utf8",
  );
}

function runPatch(scriptPath, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

test("patch-smithy-ini-file-loader patches readFile and getSSOTokenFromFile in all dist formats", () => {
  const { root, scriptPath } = createFixture();
  writeSmithyPackage(root, "node_modules/@smithy/shared-ini-file-loader");
  writeSmithyPackage(
    root,
    "node_modules/@aws-sdk/client-s3/node_modules/@smithy/shared-ini-file-loader",
  );

  // --check should fail before patching
  const staleCheck = runPatch(scriptPath, ["--check"]);
  assert.notEqual(staleCheck.status, 0);
  assert.match(staleCheck.stderr, /unsafe fs\.readFile calls remain/);
  assert.match(
    staleCheck.stderr,
    /node_modules\/@smithy\/shared-ini-file-loader\/dist-cjs\/readFile\.js/,
  );

  // Apply the patch
  const patch = runPatch(scriptPath);
  assert.equal(patch.status, 0, patch.stderr);
  assert.match(
    patch.stdout,
    /patched @smithy\/shared-ini-file-loader fs\.readFile calls/,
  );

  // Verify patches in both package locations
  for (const packagePath of [
    "node_modules/@smithy/shared-ini-file-loader",
    "node_modules/@aws-sdk/client-s3/node_modules/@smithy/shared-ini-file-loader",
  ]) {
    // CJS readFile: unsafe call replaced with Promise.resolve("")
    const cjsReadFile = readFileSync(
      join(root, packagePath, "dist-cjs/readFile.js"),
      "utf8",
    );
    assert.match(cjsReadFile, /Promise\.resolve\(""\)/);
    assert.doesNotMatch(
      cjsReadFile,
      /\(0, promises_1\.readFile\)\(path, "utf8"\)/,
    );
    // Function export signature preserved
    assert.match(cjsReadFile, /exports\.readFile = readFile/);

    // ES readFile: unsafe call replaced with Promise.resolve("")
    const esReadFile = readFileSync(
      join(root, packagePath, "dist-es/readFile.js"),
      "utf8",
    );
    assert.match(esReadFile, /Promise\.resolve\(""\)/);
    assert.doesNotMatch(esReadFile, /fsReadFile\(path, "utf8"\)/);
    // Function export signature preserved
    assert.match(esReadFile, /export const readFile/);

    // CJS getSSOTokenFromFile: throws instead of reading file
    const cjsSSO = readFileSync(
      join(root, packagePath, "dist-cjs/getSSOTokenFromFile.js"),
      "utf8",
    );
    assert.match(
      cjsSSO,
      /getSSOTokenFromFile: file system not available in CF worker/,
    );
    assert.doesNotMatch(
      cjsSSO,
      /\(0, promises_1\.readFile\)\(ssoTokenFilepath, "utf8"\)/,
    );

    // ES getSSOTokenFromFile: throws instead of reading file
    const esSSO = readFileSync(
      join(root, packagePath, "dist-es/getSSOTokenFromFile.js"),
      "utf8",
    );
    assert.match(
      esSSO,
      /getSSOTokenFromFile: file system not available in CF worker/,
    );
    assert.doesNotMatch(esSSO, /await readFile\(ssoTokenFilepath, "utf8"\)/);
  }

  // --check should pass after patching
  const cleanCheck = runPatch(scriptPath, ["--check"]);
  assert.equal(cleanCheck.status, 0, cleanCheck.stderr);
  assert.match(cleanCheck.stdout, /already patched/);

  // Idempotent: second patch run should report already patched
  const idempotent = runPatch(scriptPath);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.match(idempotent.stdout, /already patched/);
});

test("patch-smithy-ini-file-loader is a no-op when no smithy packages found", () => {
  const { root, scriptPath } = createFixture();
  // Create an empty node_modules with an unrelated package
  const unrelatedRoot = join(root, "node_modules/unrelated");
  mkdirSync(unrelatedRoot, { recursive: true });
  writeFileSync(
    join(unrelatedRoot, "package.json"),
    JSON.stringify({ name: "unrelated", version: "1.0.0" }),
    "utf8",
  );

  const result = runPatch(scriptPath);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no installed @smithy\/shared-ini-file-loader/);
});

test("patch-smithy-ini-file-loader does not patch unrelated packages", () => {
  const { root, scriptPath } = createFixture();
  // Write a real smithy package and a lookalike with smithy in the path
  writeSmithyPackage(root, "node_modules/@smithy/shared-ini-file-loader");

  const decoyRoot = join(
    root,
    "node_modules/@smithy/shared-ini-file-loader/fixtures/fake-copy",
  );
  mkdirSync(join(decoyRoot, "dist-cjs"), { recursive: true });
  writeFileSync(
    join(decoyRoot, "package.json"),
    JSON.stringify({ name: "fake-copy", version: "0.0.0" }),
    "utf8",
  );
  writeFileSync(
    join(decoyRoot, "dist-cjs/readFile.js"),
    CJS_READ_FILE_CONTENT,
    "utf8",
  );

  runPatch(scriptPath);

  // Decoy must be untouched
  const decoyContent = readFileSync(
    join(decoyRoot, "dist-cjs/readFile.js"),
    "utf8",
  );
  assert.match(decoyContent, /\(0, promises_1\.readFile\)\(path, "utf8"\)/);
});

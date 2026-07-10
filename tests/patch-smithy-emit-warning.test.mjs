import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceScript = join(repoRoot, "scripts/patch-smithy-emit-warning.mjs");

// dist-cjs codegen as shipped by @aws-sdk/client-s3@3.1041.0: the version
// check is a namespace-member call. The crash is `smithy_client_1` (the
// captured `@smithy/smithy-client` namespace) missing the member in a bundled
// worker isolate.
const CJS_RUNTIME_CONFIG = [
  'const smithy_client_1 = require("@smithy/smithy-client");',
  'const client_1 = require("@aws-sdk/core/client");',
  "const getRuntimeConfig = (config) => {",
  "    (0, smithy_client_1.emitWarningIfUnsupportedVersion)(process.version);",
  "    const defaultsMode = (0, smithy_client_1.loadConfigsForDefaultMode)(config);",
  "    (0, client_1.emitWarningIfUnsupportedVersion)(process.version);",
  "    return {};",
  "};",
  "exports.getRuntimeConfig = getRuntimeConfig;",
].join("\n");

// dist-es codegen for a newer client: bare destructured call plus the
// `@aws-sdk/core/client` alias `awsCheckVersion`.
const ES_RUNTIME_CONFIG = [
  'import { emitWarningIfUnsupportedVersion, loadConfigsForDefaultMode } from "@smithy/core/client";',
  'import { emitWarningIfUnsupportedVersion as awsCheckVersion } from "@aws-sdk/core/client";',
  "export const getRuntimeConfig = (config) => {",
  "    emitWarningIfUnsupportedVersion(process.version);",
  "    awsCheckVersion(process.version);",
  "    return {};",
  "};",
].join("\n");

// dist-cjs BUNDLED submodule index.js as shipped by newer
// @aws-sdk/nested-clients (vendored under @aws-sdk/credential-provider-*):
// the call is NOT in a runtimeConfig.js, and esbuild renamed the duplicate
// import to `emitWarningIfUnsupportedVersion$1`. cloud#2513 missed both.
const BUNDLED_NESTED_INDEX = [
  'const { emitWarningIfUnsupportedVersion: emitWarningIfUnsupportedVersion$1, createDefaultUserAgentProvider } = require("@aws-sdk/core/client");',
  'const { normalizeProvider, emitWarningIfUnsupportedVersion, loadConfigsForDefaultMode } = require("@smithy/core/client");',
  "const getRuntimeConfig = (config) => {",
  "    emitWarningIfUnsupportedVersion(process.version);",
  "    const defaultsMode = loadConfigsForDefaultMode(config);",
  "    emitWarningIfUnsupportedVersion$1(process.version);",
  "    return {};",
  "};",
  "exports.getRuntimeConfig = getRuntimeConfig;",
].join("\n");

function writeBundledNestedClient(root) {
  // Vendored copy nested under a credential-provider package, bundled index.js.
  const packageRoot = join(
    root,
    "node_modules/@aws-sdk/credential-provider-ini/node_modules/@aws-sdk/nested-clients",
  );
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@aws-sdk/nested-clients", version: "3.997.23" }),
    "utf8",
  );
  const file = join(packageRoot, "dist-cjs/submodules/sts/index.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, BUNDLED_NESTED_INDEX, "utf8");
  return "node_modules/@aws-sdk/credential-provider-ini/node_modules/@aws-sdk/nested-clients/dist-cjs/submodules/sts/index.js";
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "smithy-emit-warning-"));
  const scriptPath = join(root, "scripts/patch-smithy-emit-warning.mjs");
  mkdirSync(dirname(scriptPath), { recursive: true });
  copyFileSync(sourceScript, scriptPath);
  return { root, scriptPath };
}

function writeAwsSdkClient(root, packagePath, packageName) {
  const packageRoot = join(root, packagePath);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: packageName, version: "3.1041.0" }),
    "utf8",
  );
  const cjsFile = join(packageRoot, "dist-cjs/runtimeConfig.js");
  mkdirSync(dirname(cjsFile), { recursive: true });
  writeFileSync(cjsFile, CJS_RUNTIME_CONFIG, "utf8");

  const esFile = join(packageRoot, "dist-es/runtimeConfig.js");
  mkdirSync(dirname(esFile), { recursive: true });
  writeFileSync(esFile, ES_RUNTIME_CONFIG, "utf8");
}

function writeNestedClientSubmodule(root) {
  // @aws-sdk/nested-clients keeps a runtimeConfig.js per submodule.
  const packageRoot = join(root, "node_modules/@aws-sdk/nested-clients");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@aws-sdk/nested-clients", version: "3.1041.0" }),
    "utf8",
  );
  const file = join(packageRoot, "dist-cjs/submodules/sts/runtimeConfig.js");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, CJS_RUNTIME_CONFIG, "utf8");
}

function writeNonAwsPackage(root) {
  // A non-@aws-sdk package that happens to contain the same identifier must
  // not be touched (we only walk @aws-sdk/* runtimeConfig.js files).
  const packageRoot = join(root, "node_modules/@smithy/smithy-client");
  mkdirSync(join(packageRoot, "dist-cjs"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@smithy/smithy-client", version: "4.12.13" }),
    "utf8",
  );
  // The export definition — must remain unchanged (no `(process.version)` call).
  writeFileSync(
    join(packageRoot, "dist-cjs/index.js"),
    "exports.emitWarningIfUnsupportedVersion = (version) => {};\n",
    "utf8",
  );
}

function runPatch(scriptPath, args = []) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

test("patch-smithy-emit-warning typeof-guards every aws-sdk runtimeConfig call and supports check mode", (t) => {
  const { root, scriptPath } = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeAwsSdkClient(root, "node_modules/@aws-sdk/client-s3", "@aws-sdk/client-s3");
  writeAwsSdkClient(
    root,
    "node_modules/@daytonaio/sdk/node_modules/@aws-sdk/client-sts",
    "@aws-sdk/client-sts",
  );
  writeNestedClientSubmodule(root);
  writeNonAwsPackage(root);

  // check mode reports stale before patching.
  const staleCheck = runPatch(scriptPath, ["--check"]);
  assert.notEqual(staleCheck.status, 0);
  assert.match(staleCheck.stderr, /unguarded emitWarningIfUnsupportedVersion/);
  assert.match(staleCheck.stderr, /@aws-sdk\/client-s3\/dist-cjs\/runtimeConfig\.js/);
  assert.match(
    staleCheck.stderr,
    /@aws-sdk\/nested-clients\/dist-cjs\/submodules\/sts\/runtimeConfig\.js/,
  );

  const patch = runPatch(scriptPath);
  assert.equal(patch.status, 0, patch.stderr);
  assert.match(patch.stdout, /typeof-guarded emitWarningIfUnsupportedVersion/);

  for (const rel of [
    "node_modules/@aws-sdk/client-s3/dist-cjs/runtimeConfig.js",
    "node_modules/@daytonaio/sdk/node_modules/@aws-sdk/client-sts/dist-cjs/runtimeConfig.js",
    "node_modules/@aws-sdk/nested-clients/dist-cjs/submodules/sts/runtimeConfig.js",
  ]) {
    const patched = readFileSync(join(root, rel), "utf8");
    // namespace member calls are now typeof-guarded (handles non-null non-callable bindings)
    assert.match(
      patched,
      /typeof\(smithy_client_1\.emitWarningIfUnsupportedVersion\)==='function'&&\(0, smithy_client_1\.emitWarningIfUnsupportedVersion\)\(process\.version\)/,
    );
    assert.match(
      patched,
      /typeof\(client_1\.emitWarningIfUnsupportedVersion\)==='function'&&\(0, client_1\.emitWarningIfUnsupportedVersion\)\(process\.version\)/,
    );
    // no unguarded namespace call remains (line-start form of the original)
    assert.doesNotMatch(
      patched,
      /^\s+\(0, \w+\.emitWarningIfUnsupportedVersion\)\(process\.version\)/m,
    );
    // unrelated member call must be preserved verbatim
    assert.match(
      patched,
      /\(0, smithy_client_1\.loadConfigsForDefaultMode\)\(config\)/,
    );
  }

  // dist-es bare + alias forms are typeof-guarded too
  const esPatched = readFileSync(
    join(root, "node_modules/@aws-sdk/client-s3/dist-es/runtimeConfig.js"),
    "utf8",
  );
  assert.match(
    esPatched,
    /typeof\(emitWarningIfUnsupportedVersion\)==='function'&&emitWarningIfUnsupportedVersion\(process\.version\)/,
  );
  assert.match(
    esPatched,
    /typeof\(awsCheckVersion\)==='function'&&awsCheckVersion\(process\.version\)/,
  );
  // no unguarded bare call remains (not preceded by &&)
  assert.doesNotMatch(esPatched, /(?<![&])emitWarningIfUnsupportedVersion\(process\.version\)/);
  assert.doesNotMatch(esPatched, /(?<![&])awsCheckVersion\(process\.version\)/);

  // check mode now passes.
  const cleanCheck = runPatch(scriptPath, ["--check"]);
  assert.equal(cleanCheck.status, 0, cleanCheck.stderr);

  // idempotent re-run.
  const idempotent = runPatch(scriptPath);
  assert.equal(idempotent.status, 0, idempotent.stderr);
  assert.match(idempotent.stdout, /already typeof-guarded/);

  // the @smithy export definition is untouched.
  const smithyDef = readFileSync(
    join(root, "node_modules/@smithy/smithy-client/dist-cjs/index.js"),
    "utf8",
  );
  assert.equal(
    smithyDef,
    "exports.emitWarningIfUnsupportedVersion = (version) => {};\n",
  );
});

test("patch-smithy-emit-warning typeof-guards bundled nested-clients index.js incl. esbuild-renamed $1 binding (cloud#2515)", (t) => {
  const { root, scriptPath } = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The credential-provider package itself must be a real @aws-sdk pkg so the
  // traversal descends into its nested node_modules.
  const cpRoot = join(root, "node_modules/@aws-sdk/credential-provider-ini");
  mkdirSync(join(cpRoot, "dist-cjs"), { recursive: true });
  writeFileSync(
    join(cpRoot, "package.json"),
    JSON.stringify({ name: "@aws-sdk/credential-provider-ini", version: "3.972.39" }),
    "utf8",
  );
  const rel = writeBundledNestedClient(root);

  // check mode flags the bundled index.js as stale.
  const staleCheck = runPatch(scriptPath, ["--check"]);
  assert.notEqual(staleCheck.status, 0);
  assert.match(
    staleCheck.stderr,
    /credential-provider-ini\/node_modules\/@aws-sdk\/nested-clients\/dist-cjs\/submodules\/sts\/index\.js/,
  );

  const patch = runPatch(scriptPath);
  assert.equal(patch.status, 0, patch.stderr);

  const patched = readFileSync(join(root, rel), "utf8");
  // both the bare and the renamed ($1) binding calls are typeof-guarded
  assert.match(
    patched,
    /typeof\(emitWarningIfUnsupportedVersion\)==='function'&&emitWarningIfUnsupportedVersion\(process\.version\)/,
  );
  assert.match(
    patched,
    /typeof\(emitWarningIfUnsupportedVersion\$1\)==='function'&&emitWarningIfUnsupportedVersion\$1\(process\.version\)/,
  );
  // no unguarded call of either form remains (not preceded by &&)
  assert.doesNotMatch(
    patched,
    /(?<![&])(?:emitWarningIfUnsupportedVersion|awsCheckVersion)(?:\$\d+)?\(process\.version\)/,
  );
  // the import destructure (defines the names) is preserved verbatim
  assert.match(patched, /emitWarningIfUnsupportedVersion: emitWarningIfUnsupportedVersion\$1/);
  // unrelated call preserved
  assert.match(patched, /(^|\s)loadConfigsForDefaultMode\(config\)/m);

  // idempotent + check passes.
  assert.equal(runPatch(scriptPath, ["--check"]).status, 0);
  assert.match(runPatch(scriptPath).stdout, /already typeof-guarded/);
});

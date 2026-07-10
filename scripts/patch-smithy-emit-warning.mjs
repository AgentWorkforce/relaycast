#!/usr/bin/env node
/**
 * Patches installed @aws-sdk/* client packages so the cosmetic
 * `emitWarningIfUnsupportedVersion(process.version)` version-check call is
 * typeof-guarded in every dist file that contains it.
 *
 * WHY: AWS SDK v3 client constructors run `getRuntimeConfig()`, whose first
 * statement is e.g.
 *
 *   (0, smithy_client_1.emitWarningIfUnsupportedVersion)(process.version);
 *
 * where `smithy_client_1 = require("@smithy/smithy-client")` (newer clients
 * use `@smithy/core/client`). In the OpenNext-bundled Cloudflare Worker the
 * captured namespace object / destructured binding can be a non-null,
 * non-callable value (e.g. `{}` from stale circular-init exports): esbuild's
 * CJS wrappers + a circular-init order let a module capture a stale/partial
 * exports object before `@smithy/smithy-client` (or `@smithy/core/client`)
 * finished (re)assigning `module.exports`. The member is then a non-function
 * for the life of that isolate.
 *
 * Previous patches used optional-chaining `?.()`, which only guards
 * null/undefined. A non-null non-callable value (e.g. `{}`) STILL throws
 * `emitWarningIfUnsupportedVersion is not a function` — the 49-char error
 * that proves the binding is non-null. This patch uses a typeof guard instead:
 *   typeof(fn)==='function'&&fn(process.version)
 * which is safe for any binding state. The warning only checks the Node
 * version, which is meaningless in workerd, so skipping it is safe.
 *
 * COVERAGE (cloud#2515): the call site is NOT only in `runtimeConfig.js`.
 *  - Older clients put it in `<pkg>/dist-{cjs,es}/runtimeConfig.js`.
 *  - Newer `@aws-sdk/nested-clients` (vendored under every
 *    `@aws-sdk/credential-provider-*` / `token-providers` package, which
 *    `@aws-sdk/client-s3` drags in transitively) ships a BUNDLED
 *    `dist-cjs/submodules/<svc>/index.js` where the call is
 *      emitWarningIfUnsupportedVersion(process.version)        // @smithy/core/client
 *      emitWarningIfUnsupportedVersion$1(process.version)      // @aws-sdk/core/client (renamed)
 *    esbuild renames the duplicate import to `…$1`, so the regex must allow a
 *    trailing `$<n>` suffix. cloud#2513's runtimeConfig-only walk + suffix-less
 *    regex missed both, which is why the codemod ran clean yet the served
 *    worker still crashed. So we scan EVERY `.js` file under dist-cjs/dist-es
 *    and null-safe every bare/namespace/renamed form.
 *
 * The same package can be vendored/hoisted by multiple deps, so this scans
 * every installed @aws-sdk/* package (dist-cjs, dist-es, and nested
 * submodules/*), and every nested copy under other packages' node_modules.
 *
 * Mirrors scripts/patch-axios-fetch-first.mjs (same traversal + --check mode).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const nodeModulesRoot = resolve(repoRoot, "node_modules");
const checkMode = process.argv.includes("--check");
const LOG = "[patch-smithy-emit-warning]";

// The AWS SDK codegen shapes for the version-check call:
//   1. namespace member:  (0, ns.emitWarningIfUnsupportedVersion)(process.version)
//   2. bare/destructured: emitWarningIfUnsupportedVersion(process.version)
//      (and its `@aws-sdk/core/client` alias `awsCheckVersion(process.version)`)
//   3. esbuild-renamed bare binding: emitWarningIfUnsupportedVersion$1(process.version)
//      (when a bundled module destructures the same name from two modules,
//       esbuild appends `$<n>` to dedupe — seen in the vendored bundled
//       @aws-sdk/nested-clients submodule index.js, cloud#2515).
// Both patterns allow an optional `$<digits>` suffix on the identifier.
// They are anchored on `(process.version)` so they only touch the
// version-check call site, never the export definition.
//
// IDEMPOTENCY: the patched BARE form ends with `&&fn(process.version)`.
// `(?<!&&)` after group-1 prevents re-matching when the preceding char is `&`
// (i.e. the `&&` we already inserted). The patched NAMESPACE form starts with
// `&&(0,ns.fn)` — `(?<!&&)` before `\(0,` blocks re-matching that occurrence.
const NAMESPACE_CALL =
  /(?<!&&)(\(0,\s*(\w+)\.((?:emitWarningIfUnsupportedVersion|awsCheckVersion)(?:\$\d+)?))\)\(process\.version\)/g;
const BARE_CALL =
  /(^|[^.\w$])(?<!&&)((?:emitWarningIfUnsupportedVersion|awsCheckVersion)(?:\$\d+)?)\(process\.version\)/g;

function patchSource(src) {
  return src
    .replace(NAMESPACE_CALL, "typeof($2.$3)==='function'&&$1)(process.version)")
    .replace(BARE_CALL, "$1typeof($2)==='function'&&$2(process.version)");
}

function hasUnsafeCall(src) {
  NAMESPACE_CALL.lastIndex = 0;
  BARE_CALL.lastIndex = 0;
  return NAMESPACE_CALL.test(src) || BARE_CALL.test(src);
}

if (!existsSync(nodeModulesRoot)) {
  console.log(`${LOG} node_modules not found, skipping.`);
  process.exit(0);
}

const awsSdkPackages = findAwsSdkPackages(nodeModulesRoot);
if (awsSdkPackages.length === 0) {
  console.log(`${LOG} no installed @aws-sdk/* packages found, skipping.`);
  process.exit(0);
}

const changed = [];
const stale = [];

for (const packageRoot of awsSdkPackages) {
  for (const file of findDistJsFiles(packageRoot)) {
    const src = readFileSync(file, "utf8");
    if (!hasUnsafeCall(src)) continue;

    const patched = patchSource(src);
    if (patched === src) continue;

    const displayPath = display(file);
    if (checkMode) {
      stale.push(displayPath);
    } else {
      writeFileSync(file, patched, "utf8");
      changed.push(displayPath);
    }
  }
}

if (checkMode && stale.length > 0) {
  console.error(
    `${LOG} unguarded emitWarningIfUnsupportedVersion(process.version) calls remain in:\n` +
      stale.map((file) => `  - ${file}`).join("\n") +
      `\nRun \`node scripts/patch-smithy-emit-warning.mjs\` or \`npm install\` to fix.`,
  );
  process.exit(1);
}

if (changed.length > 0) {
  console.log(
    `${LOG} typeof-guarded emitWarningIfUnsupportedVersion calls in:\n` +
      changed.map((file) => `  - ${file}`).join("\n"),
  );
} else {
  console.log(
    `${LOG} emitWarningIfUnsupportedVersion calls already typeof-guarded.`,
  );
}

function findAwsSdkPackages(root) {
  const found = [];
  const seenDirectories = new Set();

  visitNodeModules(root);
  return found;

  function visitNodeModules(directory) {
    let realDirectory;
    try {
      realDirectory = realpathSync(directory);
    } catch {
      return;
    }
    if (seenDirectories.has(realDirectory)) return;
    seenDirectories.add(realDirectory);

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name === ".bin") continue;

      const child = join(directory, entry.name);
      if (entry.name === "@aws-sdk") {
        visitAwsSdkScope(child);
      } else if (entry.name.startsWith("@")) {
        visitScope(child);
      } else {
        visitPackage(child);
      }
    }
  }

  function visitAwsSdkScope(scopeDirectory) {
    let entries;
    try {
      entries = readdirSync(scopeDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      registerPackage(join(scopeDirectory, entry.name));
    }
  }

  function visitScope(scopeDirectory) {
    let entries;
    try {
      entries = readdirSync(scopeDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      visitPackage(join(scopeDirectory, entry.name));
    }
  }

  function visitPackage(packageDirectory) {
    registerPackage(packageDirectory);
  }

  function registerPackage(packageDirectory) {
    let realDirectory;
    try {
      realDirectory = realpathSync(packageDirectory);
    } catch {
      return;
    }
    if (seenDirectories.has(realDirectory)) return;
    seenDirectories.add(realDirectory);

    if (isAwsSdkPackage(join(realDirectory, "package.json"))) {
      found.push(realDirectory);
    }

    const nestedNodeModules = join(realDirectory, "node_modules");
    if (existsSync(nestedNodeModules)) {
      visitNodeModules(nestedNodeModules);
    }
  }
}

function isAwsSdkPackage(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed?.name === "string" && parsed.name.startsWith("@aws-sdk/");
  } catch {
    return false;
  }
}

function findDistJsFiles(packageRoot) {
  // Scan EVERY .js file under dist-cjs/dist-es, not just runtimeConfig.js: the
  // version-check call also lives in bundled `submodules/<svc>/index.js` files
  // (vendored @aws-sdk/nested-clients). hasUnsafeCall() then filters to the
  // files that actually contain the call, so the broad walk stays cheap.
  const files = [];
  for (const distDir of ["dist-cjs", "dist-es"]) {
    walk(join(packageRoot, distDir));
  }
  return files;

  function walk(directory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Skip a nested node_modules; those packages are visited on their own.
        if (entry.name === "node_modules") continue;
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(child);
      }
    }
  }
}

function display(file) {
  return file.startsWith(`${repoRoot}/`) ? file.slice(repoRoot.length + 1) : file;
}

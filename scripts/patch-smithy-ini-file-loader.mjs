#!/usr/bin/env node
/**
 * Patches installed @smithy/shared-ini-file-loader packages so that
 * file-system reads are no-ops in Cloudflare Workers.
 *
 * WHY: @smithy/shared-ini-file-loader's readFile.js calls
 * node:fs/promises.readFile during lazy AWS SDK config resolution (retryMode,
 * useDualstackEndpoint, etc.) — even when explicit credentials and
 * defaultsMode: "standard" are set. In a CF worker, unenv stubs fs.readFile
 * as not-implemented and throws:
 *   [unenv] fs.readFile is not implemented yet!
 *
 * The fix makes readFile return Promise.resolve("") (empty INI config) and
 * getSSOTokenFromFile throw a clear error (SSO credentials are never available
 * in CF workers anyway). No ~/.aws/config or SSO token files exist in workerd.
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
const LOG = "[patch-smithy-ini-file-loader]";

// Patterns to find and their replacements
const patches = [
  {
    file: "dist-cjs/readFile.js",
    // Matches: (0, promises_1.readFile)(path, "utf8")
    pattern: /\(0, promises_1\.readFile\)\(path, "utf8"\)/g,
    patched: 'Promise.resolve("")',
    alreadyPatched: /Promise\.resolve\(""\)/,
    description: "CJS readFile: node:fs/promises.readFile call",
  },
  {
    file: "dist-es/readFile.js",
    // Matches: fsReadFile(path, "utf8")
    pattern: /fsReadFile\(path, "utf8"\)/g,
    patched: 'Promise.resolve("")',
    alreadyPatched: /Promise\.resolve\(""\)/,
    description: "ES readFile: fsReadFile call",
  },
  {
    file: "dist-cjs/getSSOTokenFromFile.js",
    // Matches: await (0, promises_1.readFile)(ssoTokenFilepath, "utf8")
    pattern: /await \(0, promises_1\.readFile\)\(ssoTokenFilepath, "utf8"\)/g,
    patched:
      'await Promise.reject(new Error("getSSOTokenFromFile: file system not available in CF worker"))',
    alreadyPatched: /getSSOTokenFromFile: file system not available in CF worker/,
    description: "CJS getSSOTokenFromFile: fs readFile call",
  },
  {
    file: "dist-es/getSSOTokenFromFile.js",
    // Matches: await readFile(ssoTokenFilepath, "utf8")
    pattern: /await readFile\(ssoTokenFilepath, "utf8"\)/g,
    patched:
      'await Promise.reject(new Error("getSSOTokenFromFile: file system not available in CF worker"))',
    alreadyPatched: /getSSOTokenFromFile: file system not available in CF worker/,
    description: "ES getSSOTokenFromFile: readFile call",
  },
];

if (!existsSync(nodeModulesRoot)) {
  console.log(`${LOG} node_modules not found, skipping.`);
  process.exit(0);
}

const smithyPackages = findSmithyIniFileLoaderPackages(nodeModulesRoot);
if (smithyPackages.length === 0) {
  console.log(
    `${LOG} no installed @smithy/shared-ini-file-loader packages found, skipping.`,
  );
  process.exit(0);
}

const changed = [];
const stale = [];

for (const packageRoot of smithyPackages) {
  for (const patch of patches) {
    const file = join(packageRoot, patch.file);
    if (!existsSync(file)) continue;

    const src = readFileSync(file, "utf8");

    // Already patched — skip
    if (patch.alreadyPatched.test(src)) {
      continue;
    }

    if (!patch.pattern.test(src)) {
      console.warn(
        `${LOG} expected pattern not found in ${display(file)} (${patch.description}); ` +
          "the package layout may have changed, skipping.",
      );
      // Reset lastIndex after test()
      patch.pattern.lastIndex = 0;
      continue;
    }
    // Reset lastIndex after test()
    patch.pattern.lastIndex = 0;

    const displayPath = display(file);
    if (checkMode) {
      stale.push(displayPath);
    } else {
      const patched = src.replace(patch.pattern, patch.patched);
      writeFileSync(file, patched, "utf8");
      changed.push(displayPath);
    }
  }
}

if (checkMode && stale.length > 0) {
  console.error(
    `${LOG} unsafe fs.readFile calls remain in:\n` +
      stale.map((file) => `  - ${file}`).join("\n") +
      `\nRun \`node scripts/patch-smithy-ini-file-loader.mjs\` or \`npm install\` to fix.`,
  );
  process.exit(1);
}

if (changed.length > 0) {
  console.log(
    `${LOG} patched @smithy/shared-ini-file-loader fs.readFile calls in:\n` +
      changed.map((file) => `  - ${file}`).join("\n"),
  );
} else if (checkMode) {
  console.log(`${LOG} @smithy/shared-ini-file-loader already patched.`);
} else {
  console.log(`${LOG} @smithy/shared-ini-file-loader already patched.`);
}

function findSmithyIniFileLoaderPackages(root) {
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
      if (entry.name.startsWith("@")) {
        visitScope(child);
      } else {
        visitPackage(child);
      }
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
    let realDirectory;
    try {
      realDirectory = realpathSync(packageDirectory);
    } catch {
      return;
    }
    if (seenDirectories.has(realDirectory)) return;
    seenDirectories.add(realDirectory);

    const packageJson = join(realDirectory, "package.json");
    if (existsSync(packageJson) && isSmithyIniFileLoaderPackage(packageJson)) {
      found.push(realDirectory);
    }

    const nestedNodeModules = join(realDirectory, "node_modules");
    if (existsSync(nestedNodeModules)) {
      visitNodeModules(nestedNodeModules);
    }
  }
}

function isSmithyIniFileLoaderPackage(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return parsed?.name === "@smithy/shared-ini-file-loader";
  } catch {
    return false;
  }
}

function display(file) {
  return file.startsWith(`${repoRoot}/`) ? file.slice(repoRoot.length + 1) : file;
}

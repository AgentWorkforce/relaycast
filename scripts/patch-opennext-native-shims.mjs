#!/usr/bin/env node
/**
 * Patches @opennextjs/cloudflare's bundle-server.js for this repo's Worker
 * bundle constraints:
 *
 * 1. Alias cpu-features and ssh2 to empty stubs in the esbuild Worker bundle.
 * 2. Remove duplicate entity keys from @nodable/entities 2.1.0, which are
 *    otherwise emitted into OpenNext/Wrangler bundles and rejected by esbuild.
 * 3. Keep `sst` external in OpenNext's server bundle so Wrangler resolves a
 *    single `sst` module instance for both the deploy wrapper and app code.
 * 4. Stub Daytona's node-only ObjectStorage lazy loader in the generated
 *    OpenNext server handler before Wrangler rebundles it.
 *
 * WHY: @agent-relay/sdk transitively depends on @agent-relay/cloud → ssh2 →
 * cpu-features.  cpu-features ships a native .node binary that esbuild cannot
 * bundle for a Cloudflare Worker.  The Worker never calls any SSH code paths;
 * the dep is purely transitive.  Aliasing both packages to OpenNext's
 * cloudflare-templates/shims/empty.js produces Worker-safe empty modules and
 * lets the build complete.
 *
 * This script is idempotent: it checks for marker comments before patching.
 * Run it via the postinstall hook so it survives `npm install`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const targetFile = resolve(
  repoRoot,
  "node_modules/@opennextjs/cloudflare/dist/cli/build/bundle-server.js"
);
const nodableEntitiesFile = resolve(
  repoRoot,
  "node_modules/@nodable/entities/src/entities.js"
);
const generatedWorkerBundle = resolve(
  repoRoot,
  "packages/web/.open-next-cf/sst-bundle/worker.js"
);
const generatedServerHandler = resolve(
  repoRoot,
  "packages/web/.open-next-cf/server-functions/default/packages/web/handler.mjs"
);

patchNodableEntities();
patchDaytonaObjectStorageLoader();
patchGeneratedOpenNextOutput(generatedServerHandler, "OpenNext server handler");
patchGeneratedOpenNextOutput(generatedWorkerBundle, "CloudWebWorker bundle");

const NATIVE_SHIMS_MARKER = "// [cloud-patch] ssh2/cpu-features → empty shim";
const SST_EXTERNAL_MARKER = "// [cloud-patch] keep sst external for wrangler singleton";

if (!existsSync(targetFile)) {
  console.log(
    "[patch-opennext-native-shims] @opennextjs/cloudflare not found, skipping."
  );
  process.exit(0);
}

const src = readFileSync(targetFile, "utf8");
let patched = src;
let changed = false;

if (src.includes(NATIVE_SHIMS_MARKER) && src.includes(SST_EXTERNAL_MARKER)) {
  console.log(
    "[patch-opennext-native-shims] already applied, skipping."
  );
  process.exit(0);
}

// The patch adds ssh2 and cpu-features to the esbuild alias map right after
// the @next/env entry which is the last entry before the closing brace.
const NATIVE_SHIMS_ANCHOR = `"@next/env": path.join(buildOpts.outputDir, "cloudflare-templates/shims/env.js"),`;

if (!src.includes(NATIVE_SHIMS_MARKER)) {
  if (!patched.includes(NATIVE_SHIMS_ANCHOR)) {
    console.error(
      "[patch-opennext-native-shims] native shim anchor not found in bundle-server.js - " +
        "the patch may be incompatible with this version of @opennextjs/cloudflare. " +
        "Skipping that patch (build may fail)."
    );
  } else {
    const nativeShimsPatch = `            ${NATIVE_SHIMS_MARKER}
            // ssh2 and cpu-features are transitive deps of @agent-relay/cloud
            // via @agent-relay/sdk. The Worker never invokes SSH code paths;
            // aliasing them to the empty shim prevents esbuild from failing on
            // cpu-features' native .node binary.
            "ssh2": path.join(buildOpts.outputDir, "cloudflare-templates/shims/empty.js"),
            "cpu-features": path.join(buildOpts.outputDir, "cloudflare-templates/shims/empty.js"),`;

    patched = patched.replace(
      NATIVE_SHIMS_ANCHOR,
      `${NATIVE_SHIMS_ANCHOR}\n${nativeShimsPatch}`,
    );
    changed = true;
  }
}

if (!src.includes(SST_EXTERNAL_MARKER)) {
  const SST_EXTERNAL_ANCHOR = `        external: ["./middleware/handler.mjs"],`;
  if (!patched.includes(SST_EXTERNAL_ANCHOR)) {
    console.error(
      "[patch-opennext-native-shims] sst external anchor not found in bundle-server.js - " +
        "the patch may be incompatible with this version of @opennextjs/cloudflare. " +
        "Skipping that patch (SST Resource may resolve from duplicated bundles)."
    );
  } else {
    patched = patched.replace(
      SST_EXTERNAL_ANCHOR,
      `        ${SST_EXTERNAL_MARKER}
        // OpenNext's server esbuild otherwise inlines \`sst\` into route chunks.
        // The deploy wrapper also imports \`sst\`; keeping this first pass
        // external lets Wrangler's final bundle produce one shared instance.
        external: ["./middleware/handler.mjs", "sst"],`,
    );
    changed = true;
  }
}

if (!changed) {
  console.error(
    "[patch-opennext-native-shims] no compatible patch anchors found, skipping."
  );
  process.exit(0);
}

writeFileSync(targetFile, patched, "utf8");

console.log(
  "[patch-opennext-native-shims] patched bundle-server.js successfully."
);

function patchNodableEntities() {
  if (!existsSync(nodableEntitiesFile)) {
    return;
  }

  const src = readFileSync(nodableEntitiesFile, "utf8");
  const { patched, patchedKeys } = removeDuplicateEntityKeys(src);
  if (patched === src) {
    return;
  }

  writeFileSync(nodableEntitiesFile, patched, "utf8");
  console.log(
    `[patch-opennext-native-shims] patched @nodable/entities duplicate ${patchedKeys.join("/")} key(s).`
  );
}

function patchGeneratedOpenNextOutput(file, label) {
  if (!existsSync(file)) {
    return;
  }

  const src = readFileSync(file, "utf8");
  const { patched, patchedKeys } = removeDuplicateEntityKeys(src);
  if (patched === src) {
    return;
  }

  writeFileSync(file, patched, "utf8");
  console.log(
    `[patch-opennext-native-shims] patched generated ${label} duplicate ${patchedKeys.join("/")} key(s).`
  );
}

function removeDuplicateEntityKeys(src) {
  const replacements = [
    {
      key: "euro",
      pattern:
        /(euro\s*:\s*(["'])(?:\\u20AC|€)\2\s*,\s*dollar\s*:\s*(["'])\$\3\s*,\s*)euro\s*:\s*(["'])(?:\\u20AC|€)\4\s*,/g,
    },
    {
      key: "Vdash",
      pattern:
        /(Vdash\s*:\s*(["'])(?:\\u22A9|⊩)\2\s*,\s*dashv\s*:\s*(["'])(?:\\u22A3|⊣)\3\s*,\s*vDash\s*:\s*(["'])(?:\\u22A8|⊨)\4\s*,\s*)Vdash\s*:\s*(["'])(?:\\u22A9|⊩)\5\s*,/g,
    },
  ];

  let patched = src;
  const patchedKeys = [];
  for (const { key, pattern } of replacements) {
    const before = patched;
    patched = patched.replace(pattern, "$1");
    if (patched !== before) {
      patchedKeys.push(key);
    }
  }

  return { patched, patchedKeys };
}

function patchDaytonaObjectStorageLoader() {
  if (!existsSync(generatedServerHandler)) {
    return;
  }

  const src = readFileSync(generatedServerHandler, "utf8");
  const daytonaObjectStorageImport =
    /(?<key>["']?ObjectStorage["']?\s*:\s*)\(\s*\)\s*=>\s*import\s*\(\s*(?:\/\*[^*]*\*\/\s*)?["']\.\.\/ObjectStorage\.js["']\s*\)/g;
  const unpatchedDaytonaObjectStorageImport =
    /["']?ObjectStorage["']?\s*:\s*[^,;}]{0,160}\.\.\/ObjectStorage\.js/;
  const unavailableLoader =
    '$<key>()=>Promise.reject(new Error("Daytona ObjectStorage is unavailable in the Cloudflare Worker bundle"))';

  const patched = src.replace(daytonaObjectStorageImport, unavailableLoader);
  if (unpatchedDaytonaObjectStorageImport.test(patched)) {
    console.error(
      "[patch-opennext-native-shims] unpatched Daytona ObjectStorage loader remains in generated OpenNext server handler. " +
        "The loader shape likely changed; update this patch before running Wrangler."
    );
    process.exit(1);
  }

  if (patched === src) {
    return;
  }

  writeFileSync(generatedServerHandler, patched, "utf8");
  console.log(
    "[patch-opennext-native-shims] patched Daytona ObjectStorage loader in generated OpenNext server handler."
  );
}

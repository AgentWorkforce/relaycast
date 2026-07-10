#!/bin/bash
# Build the orchestrator lib tarball.
# Runtime deps are installed inside the sandbox via the launcher. Local
# @cloud/* workspace deps used by the compiled core output are bundled here
# because they are not published under those package names.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIST_DIR="$REPO_ROOT/packages/core/dist"
OUT="$REPO_ROOT/packages/web/public/orchestrator-lib.tar.gz"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

copy_package_dist_from() {
  local package_dir="$1"
  local dist_dir="$2"
  local target_dir="$3"

  mkdir -p "$target_dir"
  cp "$package_dir/package.json" "$target_dir/package.json"
  cp -a "$dist_dir" "$target_dir/dist"
}

copy_dist_package() {
  copy_package_dist_from "$1" "$1/dist" "$2"
}

# Always rebuild packages so TypeScript changes are reflected in the tarball.
echo "[prebuild] Building @cloud/daytona-runner..."
DAYTONA_DIST_DIR="$TMP_DIR/build/daytona-runner/dist"
npx tsc -p "$REPO_ROOT/packages/daytona-runner/tsconfig.json" --outDir "$DAYTONA_DIST_DIR"
find "$DAYTONA_DIST_DIR" -name '*.test.*' -delete

echo "[prebuild] Building @cloud/platform..."
npm run -w @cloud/platform build

echo "[prebuild] Building @cloud/core..."
npm run -w @cloud/core build

# Package compiled core as lib/.
mkdir -p "$TMP_DIR/node_modules/@cloud"
cp -a "$DIST_DIR" "$TMP_DIR/lib"
echo '{"type":"module"}' > "$TMP_DIR/lib/package.json"

# Package local workspace dependencies required by core/dist bare imports.
copy_dist_package \
  "$REPO_ROOT/packages/core" \
  "$TMP_DIR/node_modules/@cloud/core"
copy_package_dist_from \
  "$REPO_ROOT/packages/daytona-runner" \
  "$DAYTONA_DIST_DIR" \
  "$TMP_DIR/node_modules/@cloud/daytona-runner"
copy_dist_package \
  "$REPO_ROOT/packages/platform" \
  "$TMP_DIR/node_modules/@cloud/platform"

# @cloud/sts-broker does not currently emit dist/ and its package exports point
# at TypeScript sources. Compile the small HMAC surface that core imports and
# expose those JS files for plain Node in the Daytona sandbox.
mkdir -p "$TMP_DIR/node_modules/@cloud/sts-broker/dist"
npx esbuild \
  "$REPO_ROOT/packages/sts-broker/src/hmac.ts" \
  "$REPO_ROOT/packages/sts-broker/src/hmac-node.ts" \
  --format=esm \
  --platform=node \
  --target=node20 \
  --outbase="$REPO_ROOT/packages/sts-broker/src" \
  --outdir="$TMP_DIR/node_modules/@cloud/sts-broker/dist" \
  --log-level=warning
cat > "$TMP_DIR/node_modules/@cloud/sts-broker/package.json" <<'JSON'
{
  "name": "@cloud/sts-broker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./hmac.js": "./dist/hmac.js",
    "./hmac-node.js": "./dist/hmac-node.js"
  }
}
JSON

tar czf "$OUT" -C "$TMP_DIR" lib node_modules

# Smoke-test the package from an extracted tree, matching the Daytona layout.
SMOKE_DIR="$(mktemp -d)"
tar xzf "$OUT" -C "$SMOKE_DIR"
CLOUD_PACKAGES_FILE="$SMOKE_DIR/cloud-packages.txt"
grep -rhoE '@cloud/[a-z-]+' "$SMOKE_DIR/lib" "$SMOKE_DIR/node_modules/@cloud" 2>/dev/null \
  | sort -u > "$CLOUD_PACKAGES_FILE"
while IFS= read -r specifier; do
  [ -n "$specifier" ] || continue
  package_name="${specifier#@cloud/}"
  if [ ! -f "$SMOKE_DIR/node_modules/@cloud/$package_name/package.json" ]; then
    echo "[prebuild] Missing bundled package for $specifier" >&2
    exit 1
  fi
done < "$CLOUD_PACKAGES_FILE"

# Link public npm deps that are installed by the sandbox launcher. This keeps
# the smoke test focused on the extracted orchestrator-lib package while still
# using Node's normal package resolver from inside the extracted tree.
for dep in \
  @aws-sdk/client-s3 \
  @aws-sdk/client-sts \
  @agent-relay/sdk \
  @agent-relay/config \
  @agent-relay/credential-proxy \
  @relayflows/core \
  tar \
  ignore \
  @daytonaio/sdk \
  drizzle-orm \
  pg \
  postgres
do
  if [ -e "$REPO_ROOT/node_modules/$dep" ] && [ ! -e "$SMOKE_DIR/node_modules/$dep" ]; then
    mkdir -p "$(dirname "$SMOKE_DIR/node_modules/$dep")"
    ln -s "$REPO_ROOT/node_modules/$dep" "$SMOKE_DIR/node_modules/$dep"
  fi
done

cat > "$SMOKE_DIR/smoke.mjs" <<'NODE'
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const { BOOTSTRAP_STATIC_LIB_IMPORTS } = await import(`${root}/lib/bootstrap/script-generator.js`);
if (!Array.isArray(BOOTSTRAP_STATIC_LIB_IMPORTS) || BOOTSTRAP_STATIC_LIB_IMPORTS.length === 0) {
  throw new Error('BOOTSTRAP_STATIC_LIB_IMPORTS was not exported from script-generator.js');
}
for (const entry of BOOTSTRAP_STATIC_LIB_IMPORTS) {
  if (!entry || typeof entry.module !== 'string' || !entry.module.startsWith('./lib/')) {
    throw new Error(`Invalid bootstrap import entry: ${JSON.stringify(entry)}`);
  }
  const absoluteModule = `${root}/${entry.module.slice('./'.length)}`;
  await import(absoluteModule);
}
await import('@cloud/core/observability/error-cause.js');
NODE
node "$SMOKE_DIR/smoke.mjs"
rm -rf "$SMOKE_DIR"

echo "[prebuild] orchestrator-lib.tar.gz ready ($(du -h "$OUT" | cut -f1))"

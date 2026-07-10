import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const REPO_ROOT = new URL("..", import.meta.url);
const PACKAGES_ROOT = new URL("packages/", REPO_ROOT);

test("Daytona snapshot build pins daytona login shell to bash", async () => {
  const source = await readFile(new URL("scripts/create-snapshot.ts", REPO_ROOT), "utf8");

  assert.match(source, /usermod --shell \/bin\/bash daytona/);
  assert.match(source, /getent passwd daytona/);
  assert.match(source, /cut -d: -f7/);
});

test("Daytona snapshot build symlinks /usr/bin/zsh to bash", async () => {
  // Daytona's daemon fork/execs /usr/bin/zsh independently of /etc/passwd
  // (see #890 thread). The base image does not install zsh, so the
  // snapshot must provide the path. Symlink to /bin/bash keeps it light
  // and makes the actual interpreter consistent with what cloud commands
  // target.
  const source = await readFile(new URL("scripts/create-snapshot.ts", REPO_ROOT), "utf8");

  assert.match(source, /ln -sf \/bin\/bash \/usr\/bin\/zsh/);
  assert.match(source, /test -L \/usr\/bin\/zsh/);
});

test("Daytona snapshot build excludes private workspace dependencies", async () => {
  const source = await readFile(new URL("scripts/create-snapshot.ts", REPO_ROOT), "utf8");
  const corePkg = JSON.parse(
    await readFile(new URL("packages/core/package.json", REPO_ROOT), "utf8"),
  ) as { dependencies?: Record<string, string> };

  const workspacePackageNames = new Set<string>();
  for (const entry of await readdir(PACKAGES_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageJsonUrl = new URL(`${entry.name}/package.json`, PACKAGES_ROOT);
    try {
      const pkg = JSON.parse(await readFile(packageJsonUrl, "utf8")) as {
        name?: string;
        private?: boolean;
      };
      if (pkg.private && pkg.name) {
        workspacePackageNames.add(pkg.name);
      }
    } catch {
      // Not every directory under packages/ is required to be an npm package.
    }
  }

  for (const name of Object.keys(corePkg.dependencies ?? {})) {
    if (!workspacePackageNames.has(name)) continue;
    assert.match(
      source,
      new RegExp(`['"]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`),
      `${name} is private and must be excluded from the snapshot npm install list`,
    );
  }
});

test("Daytona snapshot build does not pin credential-proxy to the SDK version", async () => {
  const source = await readFile(new URL("scripts/create-snapshot.ts", REPO_ROOT), "utf8");
  const corePkg = JSON.parse(
    await readFile(new URL("packages/core/package.json", REPO_ROOT), "utf8"),
  ) as { dependencies?: Record<string, string> };

  assert.equal(
    corePkg.dependencies?.["@agent-relay/credential-proxy"],
    "7.1.1",
    "credential-proxy must be an exact independent snapshot dependency",
  );
  assert.match(source, /\$\{name\}@\$\{range\}/);
  assert.match(source, /npm install --legacy-peer-deps \$\{DEPS\}/);

  const sdkLineSetMatch = source.match(
    /const AGENT_RELAY_SDK_LINE_PINNED = new Set<string>\(\[([\s\S]*?)\]\);/,
  );
  assert.ok(sdkLineSetMatch, "SDK-line pinned package set not found");
  assert.doesNotMatch(
    sdkLineSetMatch[1] ?? "",
    /@agent-relay\/credential-proxy/,
    "credential-proxy is independently versioned and must not inherit SDK_VERSION",
  );
});

test("Daytona snapshot build bakes the proactive runtime into the workspace", async () => {
  const source = await readFile(new URL("scripts/create-snapshot.ts", REPO_ROOT), "utf8");

  assert.match(source, /WORKFORCE_RUNTIME_AWS_SMITHY_SPECS/);
  assert.match(source, /\.\.\.WORKFORCE_RUNTIME_AWS_SMITHY_SPECS/);
  assert.match(source, /corePin\(name\) !== spec/);
  assert.match(source, /\/home\/daytona\/workforce-runtime/);
  assert.match(source, /npm install --omit=dev --no-audit --no-fund \$\{PROACTIVE_RUNTIME_DEP_LIST\}/);
});

test("Daytona snapshot smoke checks AWS SDK and Smithy import consistency", async () => {
  const source = await readFile(new URL("scripts/smoke-sandbox-image.mjs", REPO_ROOT), "utf8");

  assert.match(source, /buildAwsSdkSmithyConsistencyCommand/);
  assert.match(source, /emitWarningIfUnsupportedVersion/);
  assert.match(source, /require\('@aws-sdk\/client-s3'\)/);
  assert.match(source, /require\('@aws-sdk\/lib-storage'\)/);
  assert.match(source, /AWS SDK\/Smithy runtime import consistency/);
});

test("Daytona snapshot Codex config disables interactive approvals", async () => {
  const source = await readFile(new URL("scripts/create-snapshot.ts", REPO_ROOT), "utf8");

  assert.match(source, /approval_policy = \\"never\\"/);
});

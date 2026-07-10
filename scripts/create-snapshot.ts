/**
 * scripts/create-snapshot.ts
 *
 * Creates a Daytona snapshot with all orchestrator dependencies pre-installed,
 * including the relayfile-mount binary cross-compiled from Go source.
 *
 * Usage:
 *   npx tsx scripts/create-snapshot.ts
 *   npx tsx scripts/create-snapshot.ts --name relay-orchestrator-v2
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  WORKFORCE_RUNTIME_AWS_SMITHY_SPECS,
  WORKFORCE_RUNTIME_SPEC,
  WORKFORCE_RUNTIME_VERSION,
  parseWorkforceRuntimePackageSpec,
} from '../packages/core/src/proactive-runtime/runtime-package.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAYFILE_ROOT = path.resolve(__dirname, '..', '..', 'relayfile');
const CORE_PACKAGE_JSON = path.resolve(__dirname, '..', 'packages/core/package.json');
const SANDBOX_ENTRYPOINT = path.resolve(__dirname, '..', 'deploy/daytona/relay-sandbox-entrypoint.sh');
const FULL_SNAPSHOT_BASE_IMAGE = 'daytonaio/sandbox:0.6.0';
const LITE_SNAPSHOT_BASE_IMAGE = 'node:22-bookworm-slim';
const SNAPSHOT_VARIANT = process.argv.includes('--variant')
  ? process.argv[process.argv.indexOf('--variant') + 1]!
  : process.env.SNAPSHOT_VARIANT?.trim() || 'full';
if (SNAPSHOT_VARIANT !== 'full' && SNAPSHOT_VARIANT !== 'lite') {
  throw new Error(`Unsupported snapshot variant "${SNAPSHOT_VARIANT}". Expected "full" or "lite".`);
}
const SNAPSHOT_BASE_IMAGE = SNAPSHOT_VARIANT === 'lite'
  ? LITE_SNAPSHOT_BASE_IMAGE
  : FULL_SNAPSHOT_BASE_IMAGE;

const SNAPSHOT_NAME = process.argv.includes('--name')
  ? process.argv[process.argv.indexOf('--name') + 1]!
  : 'relay-orchestrator-v2';
const SDK_VERSION = process.env.SDK_VERSION?.trim() || 'latest';
const PROACTIVE_RUNTIME_DIR = '/home/daytona/workforce-runtime';

// Resolve an exact dependency spec from packages/core/package.json so the
// snapshot stays the single source of truth and these pins cannot drift from
// what the orchestrator/web actually build against (the snapshot-impact CI
// check already treats packages/core/package.json as snapshot-affecting).
function corePin(name: string): string {
  const corePkg = JSON.parse(readFileSync(CORE_PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const range = corePkg.dependencies?.[name];
  if (!range) {
    throw new Error(`${name} is missing from packages/core/package.json`);
  }
  return `${name}@${range}`;
}

// @agentworkforce/runtime's aws-sdk dependency floats (caret), so a bare bake
// resolves @smithy/smithy-client to a build (>=4.14) that dropped the
// `emitWarningIfUnsupportedVersion` export the aws-sdk client still imports,
// crashing EVERY proactive fire on the box's Node v25 with
// "emitWarningIfUnsupportedVersion is not a function". The orchestrator loads
// aws-sdk from THIS runtime dir's node_modules, so pin the same coherent
// versions packages/core uses (#2505) directly into the runtime bake. Sourced
// from core (not hardcoded) so the two can't drift; core pins them EXACT.
const PROACTIVE_RUNTIME_DEPS = [
  WORKFORCE_RUNTIME_SPEC,
  ...WORKFORCE_RUNTIME_AWS_SMITHY_SPECS,
];

for (const spec of WORKFORCE_RUNTIME_AWS_SMITHY_SPECS) {
  const { name } = parseWorkforceRuntimePackageSpec(spec);
  if (corePin(name) !== spec) {
    throw new Error(`${spec} must match packages/core/package.json`);
  }
}

if (process.argv.includes('--print-base-image')) {
  console.log(SNAPSHOT_BASE_IMAGE);
  process.exit(0);
}

// Snapshot dep list is sourced from packages/core/package.json so the
// orchestrator can never import a package that isn't installed in the
// snapshot. Excludes are limited to deps that only the web/Lambda runtime
// uses (never imported from sandbox-side code) — adding to the include
// side is the safe default; trim only if a dep is provably web-only.
const SNAPSHOT_DEP_EXCLUDES = new Set<string>([
  '@cloud/platform',     // workspace package, not on the npm registry
  '@cloud/sts-broker',   // workspace package, not on the npm registry
  '@cloud/daytona-runner', // workspace package, not on the npm registry
  '@aws-sdk/client-sqs', // job queue, web Lambda only
  '@aws-sdk/client-ssm', // parameter store, web Lambda only
  '@nangohq/node',       // OAuth provider, web only
  'pg',                  // Postgres client, web only
  'agent-relay',         // CLI binary installed globally below; not used as a programmatic dep at runtime
]);

// SDK-line @agent-relay/* packages are pinned to SDK_VERSION so a given
// snapshot is locked to one SDK release (driven by
// .github/workflows/rebuild-snapshot.yml). Packages outside this line use the
// exact dependency declared by packages/core/package.json.
const AGENT_RELAY_SDK_LINE_PINNED = new Set<string>([
  '@agent-relay/sdk',
  '@agent-relay/config',
]);

function buildDepList(): string {
  const corePkg = JSON.parse(readFileSync(CORE_PACKAGE_JSON, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const coreDeps = corePkg.dependencies ?? {};

  const specs: string[] = [];
  for (const [name, range] of Object.entries(coreDeps)) {
    if (SNAPSHOT_DEP_EXCLUDES.has(name)) continue;
    if (AGENT_RELAY_SDK_LINE_PINNED.has(name)) {
      specs.push(`${name}@${SDK_VERSION}`);
    } else {
      specs.push(`${name}@${range}`);
    }
  }

  // tsx isn't a core dep but the bootstrap shells out to `npx tsx` to run
  // user TS workflow files. Daytona's base image ships ts-node + bun, not tsx.
  specs.push('tsx');

  return specs.join(' ');
}

const DEPS = buildDepList();
const PROACTIVE_RUNTIME_DEP_LIST = PROACTIVE_RUNTIME_DEPS.join(' ');

async function main() {
  const { Daytona, Image } = await import('@daytonaio/sdk');

  console.log(`[create-snapshot] Pinning @agent-relay/sdk and @agent-relay/config to ${SDK_VERSION}`);
  console.log(`[create-snapshot] Baking proactive runtime ${WORKFORCE_RUNTIME_VERSION} into ${PROACTIVE_RUNTIME_DIR}`);
  console.log(`[create-snapshot] Building ${SNAPSHOT_VARIANT} sandbox snapshot`);
  console.log(`[create-snapshot] Using sandbox image base ${SNAPSHOT_BASE_IMAGE}`);
  if (SDK_VERSION === 'latest') {
    console.warn('[create-snapshot] WARNING: SDK_VERSION not set — using "latest". This is not reproducible. Set SDK_VERSION env var to pin.');
  }

  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error('DAYTONA_API_KEY env var required');
  }

  // 1. Get relayfile-mount binary for linux/amd64.
  //    Prefer a pre-built binary at RELAYFILE_ROOT/bin/relayfile-mount (e.g. from
  //    a GitHub Release download in CI). Fall back to cross-compiling from Go source.
  // Check both the sibling relayfile repo (local dev) and the repo-relative
  // path (CI downloads to relayfile/bin/ inside the checkout).
  const prebuiltPath = path.join(RELAYFILE_ROOT, 'bin', 'relayfile-mount');
  const ciPrebuiltPath = path.resolve(__dirname, '..', 'relayfile', 'bin', 'relayfile-mount');
  let buildDir: string | null = null;
  let binaryPath: string;

  const { existsSync } = await import('node:fs');
  if (existsSync(prebuiltPath)) {
    console.log('Using pre-built relayfile-mount binary from', prebuiltPath);
    binaryPath = prebuiltPath;
  } else if (existsSync(ciPrebuiltPath)) {
    console.log('Using pre-built relayfile-mount binary from', ciPrebuiltPath);
    binaryPath = ciPrebuiltPath;
  } else {
    console.log('Building relayfile-mount for linux/amd64...');
    buildDir = mkdtempSync(path.join(tmpdir(), 'relayfile-mount-'));
    binaryPath = path.join(buildDir, 'relayfile-mount');
    try {
      execFileSync('go', ['build', '-o', binaryPath, './cmd/relayfile-mount'], {
        cwd: RELAYFILE_ROOT,
        env: {
          ...process.env,
          CGO_ENABLED: '0',
          GOOS: 'linux',
          GOARCH: 'amd64',
        },
        stdio: 'pipe',
      });
    } catch (error) {
      rmSync(buildDir, { recursive: true, force: true });
      const message = typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr)
        : error instanceof Error ? error.message : String(error);
      throw new Error(`relayfile-mount build failed: ${message}`);
    }
    console.log('relayfile-mount built successfully');
  }

  // 2. Build the Image using the SDK's fluent API.
  //
  const baseSetupCommands = SNAPSHOT_VARIANT === 'lite'
    ? [
      'USER root',
      'RUN apt-get update && apt-get install -y --no-install-recommends ' +
        'ca-certificates curl git jq bash sudo && ' +
        'apt-get clean && rm -rf /var/lib/apt/lists/*',
      'RUN groupadd --system daytona && ' +
        'useradd --system --gid daytona --create-home --home-dir /home/daytona --shell /bin/bash daytona && ' +
        'printf "daytona ALL=(ALL) NOPASSWD:ALL\\n" > /etc/sudoers.d/daytona && ' +
        'chmod 0440 /etc/sudoers.d/daytona && ' +
        'ln -sf /bin/bash /usr/bin/zsh && ' +
        'test "$(getent passwd daytona | cut -d: -f7)" = "/bin/bash" && ' +
        'test -L /usr/bin/zsh && ' +
        'chmod +x /usr/local/bin/relayfile-mount /usr/local/bin/relay-sandbox-entrypoint && ' +
        'mkdir -p /project /workspace && chown -R daytona:daytona /home/daytona /project /workspace',
      'USER daytona',
    ]
    : [
      // Switch to root for system-level setup (chmod, mkdir in /project)
      'USER root',
      // Daytona's daemon (the in-sandbox Toolbox API that handles
      // executeCommand RPCs) fork/execs /usr/bin/zsh to wrap commands —
      // independent of /etc/passwd. The official daytonaio/sandbox base
      // image does NOT install zsh (only `touch ~/.zshrc` to suppress
      // prompts), so every executeCommand 502s with
      // `fork/exec /usr/bin/zsh: no such file or directory` (see #890).
      //
      // Symlink /usr/bin/zsh -> /bin/bash so the daemon's exec succeeds
      // and the actual interpreter is bash (which all our commands target
      // anyway). #892's `usermod --shell /bin/bash daytona` is kept since
      // it's load-bearing for any future code path that reads the passwd
      // shell, but it is not what unblocked this path.
      'RUN ln -sf /bin/bash /usr/bin/zsh && ' +
        'usermod --shell /bin/bash daytona && ' +
        'test "$(getent passwd daytona | cut -d: -f7)" = "/bin/bash" && ' +
        'test -L /usr/bin/zsh && ' +
        'chmod +x /usr/local/bin/relayfile-mount /usr/local/bin/relay-sandbox-entrypoint && ' +
        'mkdir -p /project && chown daytona:daytona /project',
      // Switch back to daytona user for application setup
      'USER daytona',
    ];

  const harnessCliCommands = SNAPSHOT_VARIANT === 'lite'
    ? []
    : [
      // Codex CLI: not included in daytonaio/sandbox:0.6.0, install globally.
      // agent-relay CLI: required so workflows can spawn nested
      // `agent-relay local run workflows/.../sub.ts` sub-workflows (master/sub
      // orchestration pattern; 8.x moved `run` under the `local` namespace).
      // Pinned to the same SDK_VERSION so the
      // image's CLI tracks the SDK pin driven by rebuild-snapshot.yml.
      'USER root',
      `RUN npm install -g @openai/codex agent-relay@${SDK_VERSION}`,
      // Grok Build CLI (xAI): not in daytonaio/sandbox:0.6.0; required by
      // personas with `harness: 'grok'` (workforce >= 4.0.1). The Dockerfile
      // (deploy/daytona/Dockerfile) installs this too, but that image is only
      // used by local Docker/smoke tooling — this script is what builds the
      // live snapshot, so the install must be mirrored here or `spawn('grok')`
      // ENOENTs at runtime. No login baked in: the launcher mounts
      // ~/.grok/auth.json from the connected xai credential at run time
      // (XAI_API_KEY env is honored as a manual fallback).
      //
      // The x.ai installer drops the real (standalone, ~120MB) binary under
      // $HOME/.grok/downloads and only symlinks it onto PATH. Run as root that
      // home is /root, which the runtime `daytona` user can't traverse — a
      // symlink (even one pointed at /usr/local/bin) would dangle for daytona.
      // So resolve the symlink and `install` the real binary onto a
      // world-readable PATH dir, then drop root's ~/.grok.
      //
      // Copy grok *by name only*. The installer also links a sibling `agent`
      // alias next to it (-> the same grok binary), but cloud maps the `agent`
      // CLI name to Cursor (CLI_TO_PROVIDER.agent='cursor') and probes
      // `command -v agent` before `cursor-agent`, so a grok-backed `agent` on
      // PATH would route Cursor personas to the wrong CLI. Dropping the whole
      // install home keeps `agent` off PATH; the final guard fails the build if
      // an `agent` ever resolves to a grok binary (future installer change) or
      // if grok isn't a real executable (the dangling-symlink regression).
      'RUN curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install.sh && ' +
        'bash /tmp/grok-install.sh && ' +
        'install -m 0755 "$(readlink -f /root/.grok/bin/grok)" /usr/local/bin/grok && ' +
        'rm -rf /tmp/grok-install.sh /root/.grok && ' +
        'test -x /usr/local/bin/grok && ! test -L /usr/local/bin/grok && ' +
        '! { command -v agent >/dev/null 2>&1 && readlink -f "$(command -v agent)" | grep -qi grok; }',
      'USER daytona',
    ];

  // Base: Daytona's pinned base image for full snapshots, or node:22 slim for
  // ctx.llm-only lite snapshots. The AgentWorkforce relay-sandbox Docker image
  // is used by local Docker/smoke tooling, but snapshot creation cannot depend
  // on a per-commit GHCR tag that may not have been pushed yet.
  const image = Image.base(SNAPSHOT_BASE_IMAGE)
    .addLocalFile(binaryPath, '/usr/local/bin/relayfile-mount')
    .addLocalFile(SANDBOX_ENTRYPOINT, '/usr/local/bin/relay-sandbox-entrypoint')
    .dockerfileCommands(baseSetupCommands)
    .workdir('/home/daytona')
    .dockerfileCommands([
      // Install the cloud-specific runtime deps on top of what the base
      // already ships. tsx is added here because Daytona ships ts-node +
      // bun but not tsx, and our bootstrap (script-generator.ts) spawns
      // `npx tsx` to run TS workflow files.
      `RUN npm init -y && npm install --legacy-peer-deps ${DEPS}`,
      // Proactive cron ticks execute runner.mjs from the runtime dir and
      // intentionally skip per-tick npm install when this runtime closure
      // exists. Install the exact shared runtime version here so snapshot
      // bakes and fallback installs cannot drift.
      `RUN mkdir -p ${PROACTIVE_RUNTIME_DIR} && ` +
        `cd ${PROACTIVE_RUNTIME_DIR} && ` +
        `npm init -y && npm install --omit=dev --no-audit --no-fund ${PROACTIVE_RUNTIME_DEP_LIST}`,
      ...harnessCliCommands,
      // Codex: trust project directories and disable interactive approvals.
      'RUN mkdir -p /home/daytona/.codex && ' +
        "printf 'approval_policy = \"never\"\\n\\n[projects]\\n\"/home/daytona\" = { trust_level = \"trusted\" }\\n\"/project\" = { trust_level = \"trusted\" }\\n' > /home/daytona/.codex/config.toml",
      // Claude: auto-approve tools, skip onboarding, pre-accept folder trust for
      // /project so interactive PTY spawns in a fresh sandbox don't hit the
      // "Do you trust the files in this folder?" dialog (which claude renders
      // on first filesystem tool use even when --dangerously-skip-permissions
      // is set, blocking silently in a broker-wrapped PTY).
      'RUN mkdir -p /home/daytona/.claude && ' +
        `echo '{"permissions":{"allow":["Read","Edit","Write","Bash","Glob","Grep","Task","WebFetch","WebSearch","NotebookEdit","TodoWrite","mcp__relaycast__*"],"deny":[]},"autoApproveApiRequest":true}' > /home/daytona/.claude/settings.json && ` +
        `echo '{"hasCompletedOnboarding":true,"bypassPermissionsModeAccepted":true,"firstStartTime":"${new Date().toISOString()}","projects":{"/project":{"hasTrustDialogAccepted":true,"hasClaudeMdExternalIncludesApproved":true}}}' > /home/daytona/.claude.json`,
      // Git config
      'RUN git config --global user.email "agent@agent-relay.com" && git config --global user.name "Agent Relay"',
      'ENTRYPOINT ["/usr/local/bin/relay-sandbox-entrypoint"]',
      'CMD ["sleep", "infinity"]',
    ]);

  // 3. Create the snapshot via the SDK
  const daytona = new Daytona({ apiKey });

  console.log(`Creating snapshot "${SNAPSHOT_NAME}"...`);
  let snapshot: Awaited<ReturnType<typeof daytona.snapshot.create>>;
  try {
    snapshot = await daytona.snapshot.create(
      {
        name: SNAPSHOT_NAME,
        image,
        resources: { cpu: 2, memory: 2, disk: 5 },
      },
      {
        onLogs: (chunk) => process.stdout.write(chunk),
        timeout: 600,
      },
    );
  } catch (err: unknown) {
    // A prior run may have created the snapshot before timing out. Treat
    // Conflict (409) as a soft success so subsequent verify/pin steps run.
    if (err && typeof err === 'object' && 'errorCode' in err && (err as { errorCode: string }).errorCode === 'Conflict') {
      console.log(`Snapshot "${SNAPSHOT_NAME}" already exists — skipping creation, proceeding to verify.`);
      if (buildDir) rmSync(buildDir, { recursive: true, force: true });
      return;
    }
    throw err;
  }

  // Clean up build artifacts (only if we built from source)
  if (buildDir) {
    rmSync(buildDir, { recursive: true, force: true });
  }

  console.log(`\nSnapshot "${SNAPSHOT_NAME}" created successfully (state: ${snapshot.state})`);
  console.log(`Use in launcher with: daytona.create({ snapshot: '${SNAPSHOT_NAME}' })`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Snapshot creation failed:', err);
    process.exit(1);
  });
}

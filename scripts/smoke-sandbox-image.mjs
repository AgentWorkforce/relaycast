#!/usr/bin/env node

export function readArg(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] ?? null;
}

export function relayfileVersionFromSnapshot(snapshot) {
  const match = snapshot.match(/-relayfile-(v?[A-Za-z0-9._-]+)-runtime-/);
  if (!match) {
    throw new Error(`Could not parse relayfile version from snapshot name: ${snapshot}`);
  }
  return match[1];
}

// Snapshot names are `relay-orchestrator-sdk-<sdk>-relayfile-<rf>-runtime-<rt>`.
// The SDK-line packages (@agent-relay/sdk, @agent-relay/config, agent-relay CLI)
// are pinned to this version inside the snapshot, so it is the expected-version
// source of truth for the in-sandbox content assertions.
export function sdkVersionFromSnapshot(snapshot) {
  const match = snapshot.match(/-sdk-([A-Za-z0-9._-]+?)-relayfile-/);
  if (!match) {
    throw new Error(`Could not parse sdk version from snapshot name: ${snapshot}`);
  }
  return match[1];
}

function isTransientDaytonaError(error) {
  const message = String(error?.message ?? error ?? "");
  return (
    message.includes("No available runners") ||
    error?.statusCode === 429 ||
    error?.statusCode === 503
  );
}

// Daytona occasionally has no free runner the instant we ask, which surfaces as
// `DaytonaValidationError: No available runners` (HTTP 400). That is transient
// capacity, not a snapshot defect, so retry with backoff rather than failing the
// whole rebuild/promotion gate on a capacity blip.
async function createSandboxWithRetry(daytona, options, createOpts, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await daytona.create(options, createOpts);
    } catch (error) {
      lastError = error;
      if (!isTransientDaytonaError(error) || attempt === attempts) {
        throw error;
      }
      const delayMs = Math.min(30000, 3000 * 2 ** (attempt - 1));
      console.warn(
        `[smoke] daytona.create transient failure (attempt ${attempt}/${attempts}): ${
          error?.message ?? error
        }; retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function buildRelayfileHelpProbeCommand() {
  return [
    "out=$(relayfile-mount --help 2>&1)",
    "rc=$?",
    "printf '%s\\n' \"$out\" | head -5",
    "case \"$rc\" in",
    "  0|1|2) ;;",
    "  *) printf '[smoke] relayfile-mount unexpected exit code %s\\n' \"$rc\" >&2; exit \"$rc\";;",
    "esac",
  ].join("\n");
}

export function buildRuntimeClosureCommand() {
  return [
    "set -e",
    "cd /home/daytona",
    "test -f package.json",
    "node - <<'NODE'",
    "const fs = require('fs');",
    "const path = require('path');",
    "const requiredModules = [",
    "  '@agent-relay/sdk',",
    "  '@agent-relay/config',",
    "  '@agent-relay/credential-proxy',",
    "  '@relayflows/core',",
    "];",
    "for (const mod of requiredModules) {",
    "  console.log(`${mod} -> ${require.resolve(mod)}`);",
    "}",
    // SDK 8.x removed the `@agent-relay/sdk/package.json` + broker-path subpath
    // exports, so resolve the main export and walk up to the package root's
    // `bin/` (same resolver as the executor/entrypoint) rather than assuming a
    // fixed `../bin` depth.
    "let dir = path.dirname(require.resolve('@agent-relay/sdk'));",
    "const brokerName = `agent-relay-broker-${process.platform}-${process.arch}`;",
    "let broker = '';",
    "for (let i = 0; i < 10 && !broker; i++) {",
    "  const candidate = path.join(dir, 'bin', brokerName);",
    "  if (fs.existsSync(candidate)) broker = candidate;",
    "  const up = path.dirname(dir);",
    "  if (up === dir) break;",
    "  dir = up;",
    "}",
    "if (!broker) {",
    "  throw new Error('missing @agent-relay/sdk broker binary (walk-up found none)');",
    "}",
    "fs.accessSync(broker, fs.constants.X_OK);",
    "console.log(`@agent-relay/sdk broker -> ${broker}`);",
    "NODE",
    "test -x node_modules/.bin/tsx",
    "npx --no-install tsx --version",
  ].join("\n");
}

export function buildProactiveRuntimeCommand() {
  return [
    "set -e",
    "cd /home/daytona/workforce-runtime",
    "test -f package.json",
    "node - <<'NODE'",
    "const resolved = require.resolve('@agentworkforce/runtime');",
    "console.log(`@agentworkforce/runtime -> ${resolved}`);",
    "NODE",
  ].join("\n");
}

export function buildAwsSdkSmithyConsistencyCommand() {
  return [
    "set -e",
    "cd /home/daytona",
    "node - <<'NODE'",
    "const smithy = require('@smithy/smithy-client');",
    "if (typeof smithy.emitWarningIfUnsupportedVersion !== 'function') {",
    "  throw new Error(`@smithy/smithy-client resolved without emitWarningIfUnsupportedVersion: ${require.resolve('@smithy/smithy-client')}`);",
    "}",
    "require('@aws-sdk/client-s3');",
    "require('@aws-sdk/client-sts');",
    "require('@aws-sdk/lib-storage');",
    "console.log(`AWS SDK/Smithy OK: smithy=${require.resolve('@smithy/smithy-client')} client-s3=${require.resolve('@aws-sdk/client-s3')} lib-storage=${require.resolve('@aws-sdk/lib-storage')}`);",
    "NODE",
  ].join("\n");
}

// Assert the snapshot's installed package versions match the #1932 multi-line
// map: SDK line (@agent-relay/sdk + @agent-relay/config) pinned to the snapshot
// SDK version; protocol line (@agent-relay/credential-proxy + any agent/events)
// must stay on 7.x (no 8.x); @relayflows/core present (replaces the removed
// @agent-relay/sdk/workflows). Uses `npm ls --json` because SDK 8.x blocks
// `require('@agent-relay/sdk/package.json')` via the exports field.
// Relaycast is intentionally NOT asserted here: it is not a packages/core dep,
// so it is not in the snapshot closure (it is covered by the entrypoint/Dockerfile
// smoke instead).
export function buildSnapshotVersionAssertionsCommand(expectedSdkVersion, expectedRelayflowsVersion = "") {
  return [
    "set -e",
    "cd /home/daytona",
    `node - ${JSON.stringify(expectedSdkVersion)} ${JSON.stringify(expectedRelayflowsVersion)} <<'NODE'`,
    "const { execFileSync } = require('child_process');",
    "const expectedSdk = process.argv[2];",
    "const expectedRelayflowsRaw = process.argv[3] || '';",
    "const expectedRelayflows = expectedRelayflowsRaw.replace(/^[^0-9]*/, '');", // tolerate ^/~ ranges

    "let raw = '';",
    "try {",
    "  raw = execFileSync('npm', ['ls', '@agent-relay/sdk', '@agent-relay/config', '@agent-relay/credential-proxy', '@agent-relay/agent', '@agent-relay/events', '@relayflows/core', '--json', '--depth=0'], { cwd: '/home/daytona', encoding: 'utf8' });",
    "} catch (e) {",
    "  raw = e.stdout ? String(e.stdout) : '';", // npm ls exits non-zero on extraneous/missing; JSON still on stdout
    "}",
    "const deps = (raw && JSON.parse(raw).dependencies) || {};",
    "function ver(name, required) {",
    "  const d = deps[name];",
    "  if (!d || !d.version) { if (required) throw new Error(`${name} not installed in snapshot`); return null; }",
    "  return d.version;",
    "}",
    "const sdk = ver('@agent-relay/sdk', true);",
    "const config = ver('@agent-relay/config', true);",
    "const cp = ver('@agent-relay/credential-proxy', true);",
    "const agent = ver('@agent-relay/agent', false);",
    "const events = ver('@agent-relay/events', false);",
    "const relayflows = ver('@relayflows/core', true);",
    "if (sdk !== expectedSdk) throw new Error(`@agent-relay/sdk ${sdk} != expected ${expectedSdk}`);",
    "if (config !== expectedSdk) throw new Error(`@agent-relay/config ${config} != expected ${expectedSdk}`);",
    "for (const [n, v] of [['@agent-relay/credential-proxy', cp], ['@agent-relay/agent', agent], ['@agent-relay/events', events]]) {",
    "  if (v && !v.startsWith('7.')) throw new Error(`${n} ${v} must stay on the 7.x protocol line (no 8.x skew)`);",
    "}",
    "if (expectedRelayflows && relayflows !== expectedRelayflows) throw new Error(`@relayflows/core ${relayflows} != expected ${expectedRelayflows}`);",
    "console.log(`snapshot versions OK: sdk=${sdk} config=${config} credential-proxy=${cp} agent=${agent ?? 'absent'} events=${events ?? 'absent'} @relayflows/core=${relayflows}${expectedRelayflows ? ' (exact-matched)' : ''}`);",
    "NODE",
  ].join("\n");
}

// Resolve the broker (8.x-safe walk-up) and assert its CLI surface still exposes
// `--register` — the contract the Cloud executor relies on for MCP registration.
export function buildSnapshotBrokerRegisterCommand() {
  return [
    "set -e",
    "cd /home/daytona",
    "BROKER=\"$(node - <<'NODE'",
    "const fs = require('fs'); const path = require('path');",
    "let dir = path.dirname(require.resolve('@agent-relay/sdk'));",
    "const n = `agent-relay-broker-${process.platform}-${process.arch}`;",
    "let p = '';",
    "for (let i = 0; i < 10 && !p; i++) { const c = path.join(dir, 'bin', n); if (fs.existsSync(c)) p = c; const u = path.dirname(dir); if (u === dir) break; dir = u; }",
    "if (!p) process.exit(1);",
    "process.stdout.write(p);",
    "NODE",
    ")\"",
    "test -x \"$BROKER\"",
    "AGENT_RELAY_TELEMETRY_DISABLED=1 \"$BROKER\" mcp-args --help > /tmp/snapshot-broker-help.txt 2>&1",
    "grep -q -- '--register' /tmp/snapshot-broker-help.txt",
    "echo 'snapshot broker mcp-args --register OK'",
  ].join("\n");
}

// Prove the global `agent-relay` CLI is the expected SDK-line version and that
// `local run` actually executes a workflow inside the snapshot (8.x moved `run`
// under `local`). Uses the same deterministic-marker YAML shape as the managed
// cloud-run E2E fixture, which `agent-relay local run` delegates to relayflows.
export function buildSnapshotLocalRunCommand(expectedSdkVersion) {
  return [
    "set -e",
    `EXPECTED_SDK=${JSON.stringify(expectedSdkVersion)}`,
    "CLI_VER=\"$(agent-relay --version 2>&1 | tr -d '\\r' | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+([-+][0-9A-Za-z.-]+)?' | head -1)\"",
    "echo \"agent-relay --version -> ${CLI_VER}\"",
    "if [ \"${CLI_VER}\" != \"${EXPECTED_SDK}\" ]; then echo \"global agent-relay CLI ${CLI_VER} != expected ${EXPECTED_SDK}\" >&2; exit 1; fi",
    "rm -rf /tmp/snapshot-localrun && mkdir -p /tmp/snapshot-localrun && cd /tmp/snapshot-localrun",
    "cat > snapshot-localrun.yaml <<'YAML'",
    "name: snapshot-localrun",
    "version: \"1.0\"",
    "description: In-snapshot local-run smoke for Agent Relay 8.x verification",
    "swarm:",
    "  pattern: pipeline",
    "  maxConcurrency: 1",
    "  timeoutMs: 60000",
    "agents: []",
    "workflows:",
    "  - name: snapshot-localrun-flow",
    "    steps:",
    "      - name: marker",
    "        type: deterministic",
    "        command: |",
    "          echo AR_SNAPSHOT_LOCALRUN_MARKER_OK",
    "        captureOutput: true",
    "errorHandling:",
    "  strategy: fail-fast",
    "YAML",
    "agent-relay local run --json snapshot-localrun.yaml > /tmp/snapshot-localrun/run.json 2> /tmp/snapshot-localrun/run.err || { echo 'agent-relay local run failed:'; cat /tmp/snapshot-localrun/run.json /tmp/snapshot-localrun/run.err; exit 1; }",
    "RUN_ID=\"$(node -e \"const fs = require('fs'); const run = JSON.parse(fs.readFileSync('/tmp/snapshot-localrun/run.json', 'utf8')); if (!run.runId) process.exit(1); process.stdout.write(run.runId);\")\" || { echo 'local run id missing:'; cat /tmp/snapshot-localrun/run.json; exit 1; }",
    "agent-relay local logs \"$RUN_ID\" --follow --poll-interval 1 > /tmp/snapshot-localrun.out 2>&1 || { echo 'agent-relay local logs failed:'; cat /tmp/snapshot-localrun.out; exit 1; }",
    "grep -q 'AR_SNAPSHOT_LOCALRUN_MARKER_OK' /tmp/snapshot-localrun.out || { echo 'local run marker missing:'; cat /tmp/snapshot-localrun.out; exit 1; }",
    "echo 'snapshot agent-relay local run OK'",
  ].join("\n");
}

async function execChecked(sandbox, command, timeoutSeconds, env = undefined) {
  const result = await sandbox.process.executeCommand(command, undefined, env, timeoutSeconds);
  const output = String(result.result ?? result.artifacts?.stdout ?? "");
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${result.exitCode}): ${command}\n${output}`);
  }
  return output;
}

async function execSmokeCheck(sandbox, label, command, timeoutSeconds, env = undefined) {
  console.log(`[smoke] ${label}`);
  const output = await execChecked(sandbox, command, timeoutSeconds, env);
  if (output.trim()) {
    console.log(output.trim());
  }
  return output;
}

async function main() {
  const snapshotName = readArg(process.argv, "--snapshot");
  const lite = process.argv.includes("--lite");
  const requireMountProbe = process.argv.includes("--require-mount-probe");
  // Exact @relayflows/core version to assert in the snapshot, derived by the
  // caller from packages/core/package.json (it is an independent dep, not encoded
  // in the snapshot name). Empty = presence-only fallback.
  const expectedRelayflowsVersion = readArg(process.argv, "--relayflows-version") ?? "";

  if (!snapshotName) {
    console.error("Usage: node scripts/smoke-sandbox-image.mjs --snapshot <snapshot-name> [--lite] [--require-mount-probe]");
    process.exit(2);
  }

  if (!process.env.DAYTONA_API_KEY) {
    console.error("DAYTONA_API_KEY env var required");
    process.exit(2);
  }

  const expectedRelayfileVersion = relayfileVersionFromSnapshot(snapshotName);
  const expectedSdkVersion = sdkVersionFromSnapshot(snapshotName);
  const { Daytona } = await import("@daytonaio/sdk");
  const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  let sandbox = null;

  try {
    sandbox = await createSandboxWithRetry(
      daytona,
      {
        snapshot: snapshotName,
        name: `snapshot-smoke-${Date.now()}`,
        autoStopInterval: 10,
        autoDeleteInterval: 60,
      },
      { timeout: 120 },
    );

    await execSmokeCheck(
      sandbox,
      "Daytona Toolbox command shell",
      [
        "set -e",
        "test -x /usr/bin/zsh",
        "/usr/bin/zsh -lc 'printf sandbox-shell-ok'",
      ].join("\n"),
      15,
    );

    // `relayfile-mount` requires a token even to print --help and does not
    // expose its compiled-in version in flag output, so a string-match
    // assertion against the binary's stdout has nothing reliable to anchor
    // on. The snapshot name itself is the version source of truth
    // (`relayfileVersionFromSnapshot` extracted `${expectedRelayfileVersion}`
    // from the pin); the smoke step verifies the binary is present and runs
    // by checking `command -v` plus a non-empty default invocation. The
    // mount-probe block below exercises the actual binary end-to-end when
    // RELAYFILE_SMOKE_* env is configured.
    //
    // TODO(relayfile-mount): once the binary exposes `--version` (without
    // requiring `--token`), re-add a hard equality assertion here against
    // `${expectedRelayfileVersion}`.
    const binaryPath = await execSmokeCheck(
      sandbox,
      "relayfile-mount binary",
      "command -v relayfile-mount",
      15,
    );
    console.log(`relayfile-mount: ${binaryPath.trim()} (expected version per snapshot pin: ${expectedRelayfileVersion})`);
    // Probe the binary's invocation surface explicitly capturing its exit
    // code BEFORE piping to head, so 126 (not executable) / 127 (not found
    // — shouldn't happen since `command -v` already passed, but defensive)
    // / SIGSEGV-style codes propagate as failures. The Go binary exits
    // non-zero on missing `--token`, so 1 or 2 are EXPECTED here. Anything
    // else is a real load failure.
    const helpProbe = await execSmokeCheck(
      sandbox,
      "relayfile-mount invocation surface",
      buildRelayfileHelpProbeCommand(),
      15,
    );
    if (!helpProbe.trim()) {
      throw new Error(
        `relayfile-mount produced no help output on snapshot ${snapshotName}; binary may be broken or stripped.`,
      );
    }

    if (!lite) {
      const cliOutput = await execSmokeCheck(
        sandbox,
        "sandbox CLIs on PATH",
        [
          "set -e",
          "for cli in claude codex opencode agent-relay; do",
          "  printf '%s -> ' \"$cli\"",
          "  command -v \"$cli\"",
          "done",
        ].join("\n"),
        30,
      );
      if (!cliOutput.trim()) {
        throw new Error(`No sandbox CLI paths printed for snapshot ${snapshotName}`);
      }
    } else {
      await execSmokeCheck(
        sandbox,
        "lite snapshot omits harness CLIs",
        [
          "set -e",
          "for cli in claude codex opencode grok; do",
          "  if command -v \"$cli\" >/dev/null 2>&1; then",
          "    echo \"lite snapshot unexpectedly contains $cli\" >&2",
          "    exit 1",
          "  fi",
          "done",
          "echo 'lite harness CLI omission OK'",
        ].join("\n"),
        30,
      );
    }

    const runtimeOutput = await execSmokeCheck(
      sandbox,
      "pre-baked /home/daytona Node runtime closure",
      buildRuntimeClosureCommand(),
      60,
    );
    if (!runtimeOutput.trim()) {
      throw new Error(`Runtime dependency check produced no output for snapshot ${snapshotName}`);
    }

    await execSmokeCheck(
      sandbox,
      "pre-baked proactive runtime package",
      buildProactiveRuntimeCommand(),
      30,
    );

    await execSmokeCheck(
      sandbox,
      "AWS SDK/Smithy runtime import consistency",
      buildAwsSdkSmithyConsistencyCommand(),
      30,
    );

    // #1932 in-snapshot content gate: assert the installed Agent Relay versions
    // match the multi-line map, the broker still exposes --register, and the
    // global CLI runs a workflow via `local run`. This runs before the SSM
    // promotion step in rebuild-snapshot.yml, so a regressed snapshot fails
    // before it is promoted.
    await execSmokeCheck(
      sandbox,
      `snapshot Agent Relay version assertions (expected SDK ${expectedSdkVersion}${expectedRelayflowsVersion ? `, @relayflows/core ${expectedRelayflowsVersion}` : ""})`,
      buildSnapshotVersionAssertionsCommand(expectedSdkVersion, expectedRelayflowsVersion),
      60,
    );

    await execSmokeCheck(
      sandbox,
      "snapshot broker mcp-args --register contract",
      buildSnapshotBrokerRegisterCommand(),
      30,
    );

    if (!lite) {
      await execSmokeCheck(
        sandbox,
        "snapshot agent-relay local run",
        buildSnapshotLocalRunCommand(expectedSdkVersion),
        120,
      );
    }

    const relayfileEnv = {
      RELAYFILE_URL: process.env.RELAYFILE_SMOKE_BASE_URL ?? "",
      RELAYFILE_WORKSPACE_ID: process.env.RELAYFILE_SMOKE_WORKSPACE_ID ?? "",
      RELAYFILE_TOKEN: process.env.RELAYFILE_SMOKE_TOKEN ?? "",
      RELAYFILE_REMOTE_PATH: process.env.RELAYFILE_SMOKE_REMOTE_PATH ?? "",
    };
    const hasMountProbeConfig = Object.values(relayfileEnv).every(Boolean);
    if (!hasMountProbeConfig) {
      const message = "Skipping relayfile mount convergence probe; RELAYFILE_SMOKE_* env is incomplete.";
      if (requireMountProbe) throw new Error(message);
      console.warn(message);
    } else {
      const mountOutput = await execChecked(
        sandbox,
        [
          "set -euo pipefail",
          "rm -rf /tmp/relayfile-smoke && mkdir -p /tmp/relayfile-smoke",
          "timeout 90s relayfile-mount --once --base-url \"$RELAYFILE_URL\" --workspace \"$RELAYFILE_WORKSPACE_ID\" --token \"$RELAYFILE_TOKEN\" --local-dir /tmp/relayfile-smoke --remote-path \"$RELAYFILE_REMOTE_PATH\"",
          "find /tmp/relayfile-smoke -maxdepth 4 -type f | head -20",
        ].join("\n"),
        120,
        relayfileEnv,
      );
      console.log(mountOutput);
    }
  } finally {
    if (sandbox) {
      await sandbox.delete(60).catch((error) => {
        console.warn(`Failed to delete smoke sandbox ${sandbox?.id ?? ""}: ${error?.message ?? error}`);
      });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

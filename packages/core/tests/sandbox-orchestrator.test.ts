import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SandboxOrchestrator, buildRelayfileMountLifecycleShell } from "../src/executor/sandbox-orchestrator.js";

test("SandboxOrchestrator.runScript preserves merged output ordering in chunks", async () => {
  const orchestrator = new SandboxOrchestrator<string>({
    runScript: async () => ({
      output: "a\nb\nc\n",
      exitCode: 0,
    }),
  });

  const result = await orchestrator.runScript("sandbox-1", {
    command: "echo a; echo b >&2; echo c",
  });

  assert.equal(result.output, "a\nb\nc\n");
  assert.deepEqual(result.chunks, [{ stream: "combined", text: "a\nb\nc\n" }]);
  assert.equal(result.exitCode, 0);
});

test("SandboxOrchestrator.runScript rejects split-only adapter output", async () => {
  const orchestrator = new SandboxOrchestrator<string>({
    runScript: async () => ({
      stdout: "a\nc\n",
      stderr: "b\n",
      exitCode: 0,
    } as never),
  });

  await assert.rejects(
    () => orchestrator.runScript("sandbox-1", {
      command: "echo a; echo b >&2; echo c",
    }),
    /must return merged output/,
  );
});

// Initial sync runs detached in the sandbox; the orchestrator polls a status
// probe until the exit sentinel appears. This runtime mock answers the probe
// from a scripted sequence (last entry repeats).
function createStartMountRuntime(behavior: {
  statusOutputs?: string[];
  statusExitCode?: number;
  logTail?: string;
} = {}): {
  calls: Array<{ command: string; timeoutMs?: number }>;
  runtime: {
    runScript: (
      handle: string,
      options: { command: string; timeoutMs?: number },
    ) => Promise<{ output: string; exitCode: number }>;
  };
} {
  const calls: Array<{ command: string; timeoutMs?: number }> = [];
  let statusIndex = 0;
  return {
    calls,
    runtime: {
      runScript: async (_handle, options) => {
        calls.push({ command: options.command, timeoutMs: options.timeoutMs });
        if (options.command.includes("relayfile-initial-sync-exit:")) {
          const outputs = behavior.statusOutputs ?? ["relayfile-initial-sync-exit:0"];
          const output = outputs[Math.min(statusIndex, outputs.length - 1)];
          statusIndex += 1;
          return { output, exitCode: behavior.statusExitCode ?? 0 };
        }
        if (options.command.startsWith("tail -n ")) {
          return { output: behavior.logTail ?? "", exitCode: 0 };
        }
        return {
          output: options.command.includes("nohup relayfile-mount") ? "12345\n" : "",
          exitCode: 0,
        };
      },
    },
  };
}

test("SandboxOrchestrator.startMount starts daemon and polls the detached initial sync", async () => {
  const { calls, runtime } = createStartMountRuntime();
  const orchestrator = new SandboxOrchestrator<string>(runtime);

  const mount = await orchestrator.startMount(
    "sandbox-1",
    {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/home/daytona/workspace",
      token: "relay_pa_token",
      paths: ["/github/**"],
    },
    { initialSyncIdleTimeoutMs: 20_000, initialSyncPollIntervalMs: 0 },
  );

  assert.deepEqual(mount, { pid: "12345" });
  assert.match(calls[0].command, /^mkdir -p '/);
  assert.match(calls[1].command, /export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=20s/);
  assert.match(calls[1].command, /nohup relayfile-mount /);
  assert.match(calls[1].command, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.doesNotMatch(calls[1].command, /--paths\b/);
  assert.match(calls[1].command, /--remote-path '\/github'/);
  // The sync launches detached (heredoc script + nohup) instead of blocking a
  // single exec, preserving the in-sandbox idle watchdog.
  assert.match(calls[2].command, /export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=20s/);
  assert.match(calls[2].command, /relayfile-mount --once /);
  assert.match(calls[2].command, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.match(calls[2].command, /relayfile initial sync made no progress for 20s; canceling/);
  assert.match(calls[2].command, /RELAYFILE_INITIAL_SYNC_EOF/);
  assert.match(calls[2].command, /nohup sh -c /);
  assert.match(calls[2].command, /relayfile-initial-sync\.exit\.\d+-[a-z0-9]+/);
  assert.match(calls[2].command, /relayfile-initial-sync\.pid\.\d+-[a-z0-9]+/);
  assert.equal(calls[2].timeoutMs, undefined);
  assert.match(calls[3].command, /relayfile-initial-sync-exit:/);
  assert.match(calls[3].command, /relayfile-initial-sync\.exit\.\d+-[a-z0-9]+/);
  assert.match(calls[3].command, /relayfile-initial-sync\.pid\.\d+-[a-z0-9]+/);
});

test("SandboxOrchestrator.startMount preserves disabled initial sync idle timeout", async () => {
  const { calls, runtime } = createStartMountRuntime();
  const orchestrator = new SandboxOrchestrator<string>(runtime);

  await orchestrator.startMount(
    "sandbox-1",
    {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/home/daytona/workspace",
      token: "relay_pa_token",
      paths: ["/github/**"],
    },
    { initialSyncIdleTimeoutMs: 0, initialSyncPollIntervalMs: 0 },
  );

  assert.doesNotMatch(calls[1].command, /RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT/);
  assert.doesNotMatch(calls[2].command, /RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT/);
  assert.doesNotMatch(calls[2].command, /relayfile initial sync made no progress/);
  assert.match(calls[2].command, /relayfile-mount --once /);
});

test("SandboxOrchestrator.startMount surfaces a failed initial sync with its log tail", async () => {
  const { calls, runtime } = createStartMountRuntime({
    statusOutputs: ["relayfile-initial-sync-running", "relayfile-initial-sync-exit:124"],
    logTail: "relayfile initial sync made no progress for 20s; canceling",
  });
  const orchestrator = new SandboxOrchestrator<string>(runtime);

  await assert.rejects(
    orchestrator.startMount(
      "sandbox-1",
      {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        localDir: "/home/daytona/workspace",
        token: "relay_pa_token",
        paths: ["/github/**"],
      },
      { initialSyncIdleTimeoutMs: 20_000, initialSyncPollIntervalMs: 0 },
    ),
    /Failed initial relayfile sync: exit 124: relayfile initial sync made no progress/,
  );

  assert.match(calls.at(-1)?.command ?? "", /relayfile-initial-sync\.log\.\d+-[a-z0-9]+/);
});

test("SandboxOrchestrator.startMount fails immediately when initial sync status probe fails", async () => {
  const { runtime } = createStartMountRuntime({
    statusOutputs: ["status probe failed"],
    statusExitCode: 2,
  });
  const orchestrator = new SandboxOrchestrator<string>(runtime);

  await assert.rejects(
    orchestrator.startMount(
      "sandbox-1",
      {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        localDir: "/home/daytona/workspace",
        token: "relay_pa_token",
        paths: ["/github/**"],
      },
      { initialSyncIdleTimeoutMs: 20_000, initialSyncPollIntervalMs: 0 },
    ),
    /Failed to check relayfile initial sync status: status probe failed/,
  );
});

test("SandboxOrchestrator.startMount fails fast on unrecognized status probe output", async () => {
  // The probe prints exactly one of two markers; anything else means the
  // exec channel never reached the probe (broken runtime adapter, proxy
  // body). Without the fail-fast this polled until the deadline — in test
  // suites with catch-all command mocks that compounded into multi-hour
  // hangs.
  const { calls, runtime } = createStartMountRuntime({
    statusOutputs: ["ok"],
  });
  const orchestrator = new SandboxOrchestrator<string>(runtime);

  await assert.rejects(
    orchestrator.startMount(
      "sandbox-1",
      {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        localDir: "/home/daytona/workspace",
        token: "relay_pa_token",
        paths: ["/github/**"],
      },
      { initialSyncIdleTimeoutMs: 20_000, initialSyncPollIntervalMs: 0 },
    ),
    /Relayfile initial sync status probe returned unrecognized output: ok/,
  );

  const probeCalls = calls.filter((call) => call.command.includes("relayfile-initial-sync-exit:"));
  assert.equal(probeCalls.length, 3);
});

test("SandboxOrchestrator.startMount enforces the overall initial sync deadline", async () => {
  const { calls, runtime } = createStartMountRuntime({
    statusOutputs: ["relayfile-initial-sync-running"],
  });
  const orchestrator = new SandboxOrchestrator<string>(runtime);

  await assert.rejects(
    orchestrator.startMount(
      "sandbox-1",
      {
        baseUrl: "https://relayfile.example",
        workspaceId: "rw_abc12345",
        localDir: "/home/daytona/workspace",
        token: "relay_pa_token",
        paths: ["/github/**"],
      },
      {
        initialSyncIdleTimeoutMs: 20_000,
        initialSyncDeadlineMs: 0,
        initialSyncPollIntervalMs: 0,
      },
    ),
    /Relayfile initial sync did not finish within 0s/,
  );

  const killCall = calls.find((call) => call.command.includes("kill \"$relayfile_initial_sync_pid\""));
  assert.ok(killCall);
  assert.match(killCall.command, /relayfile-initial-sync\.pid\.\d+-[a-z0-9]+/);
  assert.doesNotMatch(killCall.command, /pkill/);
});

test("SandboxOrchestrator.flushMount defaults to a bounded timeout", async () => {
  const calls: Array<{ command: string; timeoutMs?: number }> = [];
  const orchestrator = new SandboxOrchestrator<string>({
    runScript: async (_handle, options) => {
      calls.push({ command: options.command, timeoutMs: options.timeoutMs });
      return { output: "", exitCode: 0 };
    },
  });

  await orchestrator.flushMount("sandbox-1", {
    baseUrl: "https://relayfile.example",
    workspaceId: "rw_abc12345",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_token",
  });

  assert.match(calls[0].command, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once /);
  assert.match(calls[0].command, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.equal(calls[0].timeoutMs, 120_000);
});

test("buildRelayfileMountLifecycleShell emits bounded cleanup and scoped path filter args", () => {
  const shell = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/ignored",
      token: "relay_pa_token",
      paths: ["/github/**"],
      websocket: false,
      interval: "3s",
    },
    localDir: "/home/daytona/workspace",
    initialSyncPaths: ["/github/repos/acme/cloud/issues/1"],
    flushTimeoutSeconds: 20,
    initialSyncIdleTimeoutSeconds: 90,
  });

  assert.match(shell, /RELAYFILE_MOUNT_PID=\$\(env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped nohup relayfile-mount /);
  // cloud#2029 #6c: cleanup flush runs the probed mode var (--flush-outbox-once
  // on v0.8.20+), not a hardcoded --once.
  assert.match(shell, /timeout 20s env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount "\$relayfile_mount_flush_mode" /);
  assert.match(shell, /relayfile_mount_flush_mode=--once/);
  assert.match(shell, /grep -q -- 'flush-outbox-once'; then relayfile_mount_flush_mode=--flush-outbox-once/);
  assert.match(shell, /: "\$\{relayfile_mount_flush_mode:=--once\}"/);
  assert.match(shell, /relayfile initial sync made no progress for 90s; canceling/);
  // cloud #1516: the daemon's internal bootstrap idle watchdog is raised to
  // MATCH the outer wrapper (matched pair) via an exported Go-duration string.
  assert.match(shell, /export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=90s/);
  assert.match(shell, /--websocket=false/);
  assert.match(shell, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.match(shell, /--interval '3s'/);
  assert.match(shell, /--remote-path '\/github'/);
  assert.match(shell, /--remote-path '\/github\/repos\/acme\/cloud\/issues\/1'/);
  assert.doesNotMatch(shell, /--paths\b/);
});

test("buildRelayfileMountLifecycleShell default cleanup timeout exceeds outbox flush deadline", () => {
  const shell = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/ignored",
      token: "relay_pa_token",
      paths: ["/slack/channels/C123/messages/**"],
      websocket: false,
    },
    localDir: "/home/daytona/workspace",
  });

  assert.match(shell, /timeout 75s env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount "\$relayfile_mount_flush_mode" /);
});

test("buildRelayfileMountLifecycleShell normalizes exported bootstrap idle timeout", () => {
  const shell = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/ignored",
      token: "relay_pa_token",
    },
    localDir: "/home/daytona/workspace",
    initialSyncPaths: ["/github/repos/acme/cloud/issues/1"],
    initialSyncIdleTimeoutSeconds: 90.2,
  });

  assert.match(shell, /export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=91s/);
  assert.match(shell, /relayfile initial sync made no progress for 91s; canceling/);
});

test("buildRelayfileMountLifecycleShell preserves disabled initial sync idle timeout", () => {
  const shell = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      localDir: "/ignored",
      token: "relay_pa_token",
    },
    localDir: "/home/daytona/workspace",
    initialSyncPaths: ["/github/repos/acme/cloud/issues/1"],
    initialSyncIdleTimeoutSeconds: 0,
  });

  assert.doesNotMatch(shell, /RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT/);
  assert.doesNotMatch(shell, /relayfile initial sync made no progress/);
  assert.match(shell, /relayfile-mount --once /);
});

// cloud#2029 #6c — BEHAVIORAL both-ways proof of the flush-mode probe.
//
// The string-match tests above prove the probe LINE is emitted; this proves
// the probe actually RESOLVES the mode correctly against a real
// `relayfile-mount --help` and that the flush is invoked with the resolved
// mode. The probe is the load-bearing cure on v0.8.20+ (it picks the
// O(outbox) `--flush-outbox-once` path that ends the flush-124 choke), so its
// runtime behavior — not just its source text — is what must be verified.
//
// Runs the lifecycle segment from the support probe through the cleanup
// function against a stubbed `relayfile-mount` (whose `--help` either lists or
// omits `flush-outbox-once`) and a `timeout` stub that execs its wrapped
// command, then reads back the mode the flush was actually invoked with.
function runFlushModeProbeHarness(options: {
  helpAdvertisesFlushOutboxOnce: boolean;
  helpAdvertisesPushLocalOnce?: boolean;
  pendingLocalWrite?: boolean;
}): { flushMode: string; status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "relayfile-flushmode-"));
  const workspace = join(root, "workspace");
  const binDir = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const helpFile = join(root, "help.txt");
  let help = "Usage: relayfile-mount [flags]\n  --once                 one-shot full-tree reconcile\n";
  if (options.helpAdvertisesFlushOutboxOnce) {
    help += "  --flush-outbox-once    flush the durable outbox without a full-tree reconcile\n";
  }
  if (options.helpAdvertisesPushLocalOnce) {
    help += "  --push-local-once      ingest pending local drafts then flush the outbox\n";
  }
  writeFileSync(helpFile, help);

  // Simulate a draft written after the daemon's last cycle: a workspace file
  // newer than the flush marker, so the cleanup's `find -newer` flags pending
  // local writes (which upgrades the mode to --push-local-once when supported).
  let flushMarker = "";
  if (options.pendingLocalWrite) {
    flushMarker = join(root, "flush-marker");
    writeFileSync(flushMarker, "");
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(flushMarker, past, past);
    writeFileSync(join(workspace, "draft.json"), '{"text":"hi"}');
  }

  const modeMarker = join(root, "flush-mode");

  // Stub `relayfile-mount`: serve `--help` from the fixture (so the probe's
  // `grep -q -- 'flush-outbox-once'` decides the mode), and on the real flush
  // invocation record its first arg — the resolved `$relayfile_mount_flush_mode`.
  const mountStub = join(binDir, "relayfile-mount");
  writeFileSync(
    mountStub,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then',
      `  cat ${JSON.stringify(helpFile)}`,
      "  exit 0",
      "fi",
      `printf '%s' "$1" > ${JSON.stringify(modeMarker)}`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(mountStub, 0o755);

  // Stub `timeout`: drop the duration arg and exec the wrapped command, so the
  // flush actually runs the relayfile-mount stub (an `exit 0` stub would skip
  // it and never record the mode).
  const timeoutStub = join(binDir, "timeout");
  writeFileSync(timeoutStub, '#!/bin/sh\nshift\nexec "$@"\n');
  chmodSync(timeoutStub, 0o755);

  const lifecycle = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      token: "relay_pa_daemon_token",
    },
    localDir: workspace,
    flushTimeoutSeconds: 5,
  });
  // Slice from the support probe (`relayfile_mount_flush_mode=--once`, the
  // first occurrence — the in-function default uses `:=` so it does not match)
  // through to (not including) the EXIT trap. That captures the real
  // `relayfile-mount --help` probe plus the cleanup function; the daemon-start
  // block above the probe is intentionally excluded so no daemon launches. The
  // function is then invoked directly.
  const probeIdx = lifecycle.indexOf("relayfile_mount_flush_mode=--once");
  const trapIdx = lifecycle.indexOf("trap relayfile_mount_cleanup EXIT");
  assert.ok(probeIdx >= 0 && trapIdx > probeIdx, "probe + trap markers present");
  const segment = lifecycle.slice(probeIdx, trapIdx);

  const result = spawnSync(
    "sh",
    [
      "-c",
      [
        `PATH=${JSON.stringify(binDir)}:$PATH`,
        "RELAYFILE_MOUNT_PID=",
        flushMarker ? `RELAYFILE_MOUNT_FLUSH_MARKER=${JSON.stringify(flushMarker)}` : "",
        segment,
        "relayfile_mount_cleanup",
        "exit $?",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  let flushMode = "";
  try {
    flushMode = readFileSync(modeMarker, "utf8").trim();
  } catch {
    flushMode = "";
  }
  return { flushMode, status: result.status, stderr: result.stderr };
}

test("buildRelayfileMountLifecycleShell: flush resolves to --flush-outbox-once when the binary advertises it", () => {
  const { flushMode, status } = runFlushModeProbeHarness({
    helpAdvertisesFlushOutboxOnce: true,
  });
  assert.equal(flushMode, "--flush-outbox-once");
  assert.equal(status, 0);
});

test("buildRelayfileMountLifecycleShell: flush falls back to --once when the binary lacks flush-outbox-once", () => {
  const { flushMode, status } = runFlushModeProbeHarness({
    helpAdvertisesFlushOutboxOnce: false,
  });
  assert.equal(flushMode, "--once");
  assert.equal(status, 0);
});

test("buildRelayfileMountLifecycleShell: upgrades to --push-local-once when pending local writes exist and the binary advertises it", () => {
  const { flushMode, status } = runFlushModeProbeHarness({
    helpAdvertisesFlushOutboxOnce: true,
    helpAdvertisesPushLocalOnce: true,
    pendingLocalWrite: true,
  });
  assert.equal(flushMode, "--push-local-once");
  assert.equal(status, 0);
});

test("buildRelayfileMountLifecycleShell: keeps --flush-outbox-once (no scan) when no pending local writes, even if push-local-once is advertised", () => {
  const { flushMode, status } = runFlushModeProbeHarness({
    helpAdvertisesFlushOutboxOnce: true,
    helpAdvertisesPushLocalOnce: true,
    pendingLocalWrite: false,
  });
  assert.equal(flushMode, "--flush-outbox-once");
  assert.equal(status, 0);
});

test("buildRelayfileMountLifecycleShell: pending local writes but no push-local-once support stays on --flush-outbox-once", () => {
  const { flushMode, status } = runFlushModeProbeHarness({
    helpAdvertisesFlushOutboxOnce: true,
    helpAdvertisesPushLocalOnce: false,
    pendingLocalWrite: true,
  });
  assert.equal(flushMode, "--flush-outbox-once");
  assert.equal(status, 0);
});

// cloud#2029 #1b — REAL-SHELL behavioral harness for the positive
// adapter-dispatch-receipt signal `commandDraftsUndeliverable`. It runs the
// actual cleanup function (including the embedded node classifier) against an
// on-disk fixture of this-run command drafts + durable-outbox records, then
// parses the emitted `relayfile.mount.cleanup` JSON. `node` is the real test
// runtime; `relayfile-mount`/`timeout` are stubbed so the flush is a no-op.
type ReceiptDraftState =
  | "delivered"
  | "running"
  | "pending"
  | "queued"
  | "needsAttention"
  | "noOpId"
  | "noRecord"
  // v0.8.20-pre-PR2 shape: an UPLOAD-ack record with NO opId/dispatchStatus.
  | "uploadAck";

function runReceiptGateHarness(options: {
  drafts: Array<{ rel: string; state: ReceiptDraftState }>;
  /** Simulate node failing (exit 1) → signal must degrade to null, never crash. */
  nodeStub?: "error";
  /** Put the command root OUTSIDE localDir → unscoped-localDir precondition violated → null. */
  commandRootOutsideLocalDir?: boolean;
  /** v0.8.19: do not create `.relay/outbox` at all → no capability marker → null. */
  noOutboxDir?: boolean;
  /** v0.8.20 (current fleet): outbox dirs exist but NO capabilities.json marker → null. */
  noCapabilityMarker?: boolean;
  /** Write this raw string as capabilities.json instead of the valid marker (malformed / old-schema cases). */
  markerOverride?: string;
}): {
  undeliverable: number | null;
  commandDraftWritten: boolean | null;
  status: number | null;
  stderr: string;
} {
  const root = mkdtempSync(join(tmpdir(), "relayfile-receipt-"));
  const workspace = join(root, "workspace");
  const binDir = join(root, "bin");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const cmdRoot = options.commandRootOutsideLocalDir
    ? join(root, "outside", "slack", "channels", "C", "messages")
    : join(workspace, "slack", "channels", "C", "messages");
  mkdirSync(cmdRoot, { recursive: true });

  const outbox = join(workspace, ".relay", "outbox");
  if (!options.noOutboxDir) {
    mkdirSync(join(outbox, "acked"), { recursive: true });
    mkdirSync(join(outbox, "pending"), { recursive: true });
    if (!options.noCapabilityMarker) {
      // v0.8.21 capability marker (relayfile #266 contract) — gates the positive
      // receipt classifier; absent on v0.8.19 (no outbox) + v0.8.20 (no marker).
      writeFileSync(
        join(outbox, "capabilities.json"),
        options.markerOverride ?? JSON.stringify({ schemaVersion: 2, dispatchReceipts: true }),
      );
    }
  }

  // Flush no-op stubs. node stays the real runtime unless we deliberately break it.
  writeFileSync(join(binDir, "relayfile-mount"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(binDir, "relayfile-mount"), 0o755);
  writeFileSync(join(binDir, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n');
  chmodSync(join(binDir, "timeout"), 0o755);
  if (options.nodeStub === "error") {
    writeFileSync(join(binDir, "node"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(binDir, "node"), 0o755);
  }

  const marker = join(root, "flush-marker");
  writeFileSync(marker, "");
  const future = new Date(Date.now() + 10_000);

  let idx = 0;
  for (const draft of options.drafts) {
    const localPath = join(cmdRoot, draft.rel);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, "{}");
    utimesSync(localPath, future, future); // newer than the flush marker = this-run
    const remotePath = `/${localPath.slice(workspace.length).replace(/^[/\\]+/u, "").replace(/\\/gu, "/")}`;
    const id = `c${idx++}`;
    const write = (dir: string, rec: Record<string, unknown>) =>
      writeFileSync(join(outbox, dir, `${id}.json`), JSON.stringify(rec));
    switch (draft.state) {
      case "delivered":
        write("acked", { remotePath, opId: `op-${id}`, dispatchStatus: "succeeded" });
        break;
      case "running":
        write("pending", { remotePath, opId: `op-${id}`, dispatchStatus: "running" });
        break;
      case "pending":
        write("pending", { remotePath, opId: `op-${id}`, dispatchStatus: "pending" });
        break;
      case "queued":
        write("pending", { remotePath, opId: `op-${id}`, dispatchStatus: "queued" });
        break;
      case "needsAttention":
        write("pending", {
          remotePath,
          opId: `op-${id}`,
          dispatchStatus: "failed",
          needsAttention: true,
        });
        break;
      case "noOpId":
        write("pending", { remotePath, opId: "", dispatchStatus: "pending" });
        break;
      case "uploadAck":
        // v0.8.20-pre-PR2: an UPLOAD-ack in acked/ with NO opId/dispatchStatus.
        write("acked", { remotePath, ackedAt: "t", revision: "r1", status: "acked" });
        break;
      case "noRecord":
        break; // intentionally no outbox record
    }
  }

  const lifecycle = buildRelayfileMountLifecycleShell({
    mount: {
      baseUrl: "https://relayfile.example",
      workspaceId: "rw_abc12345",
      token: "relay_pa_daemon_token",
    },
    localDir: workspace,
    flushTimeoutSeconds: 5,
    cleanupStatusMessage: "relayfile.mount.cleanup",
    commandRootLocalDirs: [cmdRoot],
  });
  const probeIdx = lifecycle.indexOf("relayfile_mount_flush_mode=--once");
  const trapIdx = lifecycle.indexOf("trap relayfile_mount_cleanup EXIT");
  assert.ok(probeIdx >= 0 && trapIdx > probeIdx, "probe + trap markers present");
  const segment = lifecycle.slice(probeIdx, trapIdx);

  const result = spawnSync(
    "sh",
    [
      "-c",
      [
        `PATH=${JSON.stringify(binDir)}:$PATH`,
        "RELAYFILE_MOUNT_PID=",
        `RELAYFILE_MOUNT_FLUSH_MARKER=${JSON.stringify(marker)}`,
        segment,
        "relayfile_mount_cleanup",
        "exit $?",
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  const line = result.stderr
    .split(/\r?\n/u)
    .find((entry) => entry.includes("relayfile.mount.cleanup"));
  let undeliverable: number | null = null;
  let commandDraftWritten: boolean | null = null;
  if (line) {
    const parsed = JSON.parse(line) as {
      commandDraftsUndeliverable?: number | null;
      commandDraftWrittenThisRun?: boolean | null;
    };
    undeliverable = parsed.commandDraftsUndeliverable ?? null;
    commandDraftWritten = parsed.commandDraftWrittenThisRun ?? null;
  }
  return { undeliverable, commandDraftWritten, status: result.status, stderr: result.stderr };
}

test("receipt gate: delivered draft (acked + opId + succeeded) does not count", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    drafts: [{ rel: "draft-a.json", state: "delivered" }],
  });
  assert.equal(undeliverable, 0);
  assert.equal(status, 0);
});

test("receipt gate: benign in-flight (opId + running/pending/queued) does not count", () => {
  const { undeliverable } = runReceiptGateHarness({
    drafts: [
      { rel: "draft-r.json", state: "running" },
      { rel: "123/replies/draft-p.json", state: "pending" },
      { rel: "draft-q.json", state: "queued" },
    ],
  });
  assert.equal(undeliverable, 0);
});

test("receipt gate: needsAttention (failed/dead-lettered) counts as undeliverable", () => {
  const { undeliverable } = runReceiptGateHarness({
    drafts: [{ rel: "draft-failed.json", state: "needsAttention" }],
  });
  assert.equal(undeliverable, 1);
});

test("receipt gate: missing/empty opId (never uploaded) counts as undeliverable", () => {
  const { undeliverable } = runReceiptGateHarness({
    drafts: [{ rel: "draft-noop.json", state: "noOpId" }],
  });
  assert.equal(undeliverable, 1);
});

test("receipt gate: no outbox record at all (never enqueued) counts as undeliverable", () => {
  const { undeliverable } = runReceiptGateHarness({
    drafts: [{ rel: "123/replies/draft-orphan.json", state: "noRecord" }],
  });
  assert.equal(undeliverable, 1);
});

test("receipt gate: mixed states count only the undeliverable ones (nested replies included)", () => {
  const { undeliverable, commandDraftWritten } = runReceiptGateHarness({
    drafts: [
      { rel: "draft-delivered.json", state: "delivered" },
      { rel: "123/replies/draft-running.json", state: "running" },
      { rel: "draft-failed.json", state: "needsAttention" },
      { rel: "456/replies/draft-noop.json", state: "noOpId" },
      { rel: "draft-orphan.json", state: "noRecord" },
    ],
  });
  // needsAttention + noOpId + noRecord = 3; delivered + running excluded.
  assert.equal(undeliverable, 3);
  assert.equal(commandDraftWritten, true);
});

test("receipt gate: node failure degrades to null (feature-detect fallback, no crash)", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    drafts: [{ rel: "draft-failed.json", state: "needsAttention" }],
    nodeStub: "error",
  });
  assert.equal(undeliverable, null);
  // The signal degrading must never perturb the teardown exit code.
  assert.equal(status, 0);
});

test("receipt gate: command root outside localDir (scoping precondition violated) degrades to null", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    drafts: [{ rel: "draft-failed.json", state: "needsAttention" }],
    commandRootOutsideLocalDir: true,
  });
  assert.equal(undeliverable, null);
  assert.equal(status, 0);
});

// Capability feature-detect (relayfile #266 marker). The gate must be INERT on
// every pre-v0.8.21 mount — else it false-fires on DELIVERED writebacks
// fleet-wide on deploy (a delivered draft persists on disk; the mirror doesn't
// auto-delete). CASE-1b is the current-fleet biter.
test("receipt gate CASE-1: v0.8.19 (no .relay/outbox at all) → null, inert", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    drafts: [{ rel: "draft-x.json", state: "noRecord" }],
    noOutboxDir: true,
  });
  assert.equal(undeliverable, null);
  assert.equal(status, 0);
});

test("receipt gate CASE-1b: v0.8.20 fleet (outbox dirs + upload-ack record, NO capabilities marker) → null, NOT a false-fire", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    // A delivered draft on disk with a v0.8.20 upload-ack record (no opId).
    // Without the marker gate this counted as undeliverable → fleet false-fire.
    drafts: [{ rel: "draft-delivered.json", state: "uploadAck" }],
    noCapabilityMarker: true,
  });
  assert.equal(undeliverable, null);
  assert.equal(status, 0);
});

test("receipt gate: malformed capabilities.json → treated as absent → null (no crash)", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    drafts: [{ rel: "draft-failed.json", state: "needsAttention" }],
    markerOverride: "{ not valid json",
  });
  assert.equal(undeliverable, null);
  assert.equal(status, 0);
});

test("receipt gate: old-schema marker (schemaVersion 1) → null (forward-safe version guard)", () => {
  const { undeliverable, status } = runReceiptGateHarness({
    drafts: [{ rel: "draft-failed.json", state: "needsAttention" }],
    markerOverride: JSON.stringify({ schemaVersion: 1, dispatchReceipts: true }),
  });
  assert.equal(undeliverable, null);
  assert.equal(status, 0);
});

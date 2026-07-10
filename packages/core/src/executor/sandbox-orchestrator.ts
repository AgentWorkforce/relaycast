import {
  buildRelayfileMountCleanupFlushShell,
  buildRelayfileMountFlushShell,
  buildRelayfileMountInitialSyncBackgroundShell,
  buildRelayfileMountInitialSyncKillShell,
  buildRelayfileMountInitialSyncLogTailShell,
  buildRelayfileMountInitialSyncShell,
  buildRelayfileMountInitialSyncStatusShell,
  buildRelayfileMountStartShell,
  parseRelayfileMountInitialSyncStatus,
  type RelayfileMountDaemonOptions,
  type RelayfileMountShellOptions,
} from "../relayfile/mount-script.js";

function sleepMs(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

function relayfileInitialSyncRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2) || "0"}`;
}

export type SandboxCommandResult = {
  output: string;
  exitCode: number | null;
  cmdId?: string;
};

export type SandboxOutputChunk = {
  stream: "combined";
  text: string;
};

export type SandboxCapturedOutput = {
  output: string;
  chunks: SandboxOutputChunk[];
  exitCode: number | null;
  cmdId?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

export type SandboxRunScriptOptions = {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  sessionId?: string;
};

export type SandboxProvisionOptions = {
  label?: string;
  name?: string;
  workdir?: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  createTimeoutSeconds?: number;
};

export type SandboxBundleFile = {
  source: string | Buffer;
  destination: string;
};

export type SandboxOrchestratorRuntime<Handle> = {
  provision?: (options?: SandboxProvisionOptions) => Promise<Handle>;
  uploadBundle?: (handle: Handle, files: readonly SandboxBundleFile[]) => Promise<void>;
  runScript: (handle: Handle, options: SandboxRunScriptOptions) => Promise<SandboxCommandResult>;
  teardown?: (handle: Handle) => Promise<void>;
};

export type RelayfileMountHandle = {
  pid?: string;
};

export type StartMountOptions = {
  cwd?: string;
  /** @deprecated Use initialSyncIdleTimeoutMs; kept for existing call sites. */
  initialSyncTimeoutMs?: number;
  initialSyncIdleTimeoutMs?: number;
  /** @deprecated No longer used: the initial sync is polled, not one exec. */
  timeoutMs?: number;
  /**
   * Overall wall-clock budget for the polled initial sync. Unlike the idle
   * timeout (which cancels a *stalled* sync in-sandbox), this bounds a sync
   * that keeps progressing — pick it to fit the caller's step/lease budget.
   */
  initialSyncDeadlineMs?: number;
  /** Cadence of the short status-probe execs. */
  initialSyncPollIntervalMs?: number;
  killExisting?: boolean;
};

export type FlushMountOptions = {
  cwd?: string;
  timeoutMs?: number;
};

export type StopMountOptions = FlushMountOptions;

export class SandboxOrchestrator<Handle> {
  constructor(private readonly runtime: SandboxOrchestratorRuntime<Handle>) {}

  async provision(options?: SandboxProvisionOptions): Promise<Handle> {
    if (!this.runtime.provision) {
      throw new Error("SandboxOrchestrator runtime does not support provision");
    }
    return this.runtime.provision(options);
  }

  async uploadBundle(handle: Handle, files: readonly SandboxBundleFile[]): Promise<void> {
    if (!this.runtime.uploadBundle) {
      throw new Error("SandboxOrchestrator runtime does not support uploadBundle");
    }
    await this.runtime.uploadBundle(handle, files);
  }

  async runScript(handle: Handle, options: SandboxRunScriptOptions): Promise<SandboxCapturedOutput> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const result = await this.runtime.runScript(handle, options);
    return this.captureOutput(result, startedAt, started);
  }

  captureOutput(
    result: SandboxCommandResult,
    startedAt = new Date().toISOString(),
    started = Date.parse(startedAt),
  ): SandboxCapturedOutput {
    const ended = Date.now();
    if (typeof result.output !== "string") {
      throw new Error(
        "SandboxOrchestrator runtime adapter must return merged output; split stdout/stderr results are not accepted",
      );
    }
    const output = result.output;
    return {
      output,
      chunks: output ? [{ stream: "combined", text: output }] : [],
      exitCode: result.exitCode,
      ...(result.cmdId !== undefined ? { cmdId: result.cmdId } : {}),
      startedAt,
      endedAt: new Date(ended).toISOString(),
      durationMs: Number.isFinite(started) ? Math.max(0, ended - started) : 0,
    };
  }

  async startMount(
    handle: Handle,
    config: RelayfileMountDaemonOptions,
    options: StartMountOptions = {},
  ): Promise<RelayfileMountHandle> {
    const cwd = options.cwd;
    const mkdir = await this.runtime.runScript(handle, {
      command: `mkdir -p ${shellQuote(config.localDir)}`,
      cwd,
    });
    if (mkdir.exitCode !== 0) {
      throw new Error(`Failed to create relayfile mount path: ${mkdir.output}`);
    }

    if (options.killExisting) {
      await this.runtime.runScript(handle, {
        command: "pkill -f '(^|/)relayfile-mount( |$)' 2>/dev/null || true",
        cwd,
      });
    }

    const idleTimeoutMs =
      options.initialSyncIdleTimeoutMs ?? options.initialSyncTimeoutMs ?? 60_000;
    const initialSyncIdleTimeoutSeconds = relayfileBootstrapIdleTimeoutSeconds(
      idleTimeoutMs / 1000,
    );
    const start = await this.runtime.runScript(handle, {
      command: withRelayfileBootstrapIdleTimeout(
        buildRelayfileMountStartShell(config),
        initialSyncIdleTimeoutSeconds,
      ),
      cwd,
    });
    if (start.exitCode !== 0) {
      throw new Error(`Failed to start relayfile mount: ${start.output}`);
    }

    // The initial sync can outlive any single exec (Daytona's proxy read
    // timeout is ~120s and callers wrap execs in client-side fail-fasts), so
    // it runs detached in the sandbox — keeping the in-sandbox idle watchdog
    // — while we poll its exit sentinel with short, idempotent execs.
    const initialSyncRun = { runId: relayfileInitialSyncRunId() };
    const launch = await this.runtime.runScript(handle, {
      command: withRelayfileBootstrapIdleTimeout(
        buildRelayfileMountInitialSyncBackgroundShell(
          {
            ...config,
            idleTimeoutSeconds: initialSyncIdleTimeoutSeconds,
          },
          initialSyncRun,
        ),
        initialSyncIdleTimeoutSeconds,
      ),
      cwd,
    });
    if (launch.exitCode !== 0) {
      throw new Error(`Failed to launch relayfile initial sync: ${launch.output}`);
    }

    const deadlineMs = options.initialSyncDeadlineMs ?? 240_000;
    const pollIntervalMs = options.initialSyncPollIntervalMs ?? 2_000;
    const deadline = Date.now() + deadlineMs;
    // The probe prints exactly one of two markers. Output with neither means
    // the exec channel is not actually reaching our probe (a broken runtime
    // adapter, a proxy interposing its own body) — fail fast after a couple
    // of confirmations instead of polling garbage until the deadline.
    let unknownStatusCount = 0;
    for (;;) {
      const status = await this.runtime.runScript(handle, {
        command: buildRelayfileMountInitialSyncStatusShell(initialSyncRun),
        cwd,
      });
      if (status.exitCode !== 0) {
        throw new Error(`Failed to check relayfile initial sync status: ${status.output}`);
      }
      const parsed = parseRelayfileMountInitialSyncStatus(status.output);
      if (parsed.state === "unknown") {
        unknownStatusCount += 1;
        if (unknownStatusCount >= 3) {
          throw new Error(
            `Relayfile initial sync status probe returned unrecognized output: ${status.output.trim().slice(0, 200)}`,
          );
        }
        await sleepMs(pollIntervalMs);
        continue;
      }
      unknownStatusCount = 0;
      if (parsed.state === "exited") {
        if (parsed.exitCode === 0) break;
        const logTail = await this.runtime
          .runScript(handle, {
            command: buildRelayfileMountInitialSyncLogTailShell(40, initialSyncRun),
            cwd,
          })
          .catch(() => null);
        const detail = logTail?.output?.trim();
        throw new Error(
          `Failed initial relayfile sync: exit ${parsed.exitCode}${detail ? `: ${detail}` : ""}`,
        );
      }
      if (Date.now() >= deadline) {
        await this.runtime
          .runScript(handle, {
            command: buildRelayfileMountInitialSyncKillShell(initialSyncRun),
            cwd,
          })
          .catch(() => undefined);
        throw new Error(
          `Relayfile initial sync did not finish within ${Math.ceil(deadlineMs / 1000)}s`,
        );
      }
      await sleepMs(pollIntervalMs);
    }

    const pid = start.output.trim().split(/\s+/).at(-1);
    return pid ? { pid } : {};
  }

  async flushMount(
    handle: Handle,
    config: RelayfileMountShellOptions,
    options: FlushMountOptions = {},
  ): Promise<void> {
    const result = await this.runtime.runScript(handle, {
      command: buildRelayfileMountFlushShell(config),
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to flush relayfile mount: ${result.output}`);
    }
  }

  async stopMount(
    handle: Handle,
    mount: RelayfileMountHandle,
    config: RelayfileMountShellOptions,
    options: StopMountOptions = {},
  ): Promise<void> {
    try {
      await this.flushMount(handle, config, options);
    } finally {
      if (mount.pid) {
        await this.runtime.runScript(handle, {
          command: `kill ${shellQuote(mount.pid)} 2>/dev/null || true`,
          cwd: options.cwd,
        });
      }
    }
  }

  async teardown(handle: Handle): Promise<void> {
    if (!this.runtime.teardown) {
      throw new Error("SandboxOrchestrator runtime does not support teardown");
    }
    await this.runtime.teardown(handle);
  }
}

export type RelayfileMountLifecycleShellOptions = {
  mount: (Omit<RelayfileMountShellOptions, "localDir"> & { interval?: string; logPath?: string }) | null;
  localDir: string;
  initialSyncPaths?: readonly string[];
  flushTimeoutSeconds?: number;
  initialSyncIdleTimeoutSeconds?: number;
  continueOnInitialSyncFailure?: boolean;
  cleanupStatusMessage?: string;
  /**
   * Local mount directories that hold writeback command drafts (e.g. the Slack
   * `.../messages` + `.../threads/<id>/replies` roots). The cleanup probes
   * these for files written during THIS run so a dropped writeback can be
   * surfaced as a loud, command-specific failure rather than a swallowed
   * teardown warning (cloud#2029). Empty/omitted → no command-draft probe.
   */
  commandRootLocalDirs?: readonly string[];
  mountLogTail?: {
    startMarker: string;
    endMarker: string;
    bytes: number;
    lines: number;
  };
};

export function buildRelayfileMountLifecycleShell(
  options: RelayfileMountLifecycleShellOptions,
): string {
  const mount = options.mount;
  if (!mount) return "";

  const config = { ...mount, localDir: options.localDir };
  const start = buildRelayfileMountStartShell(config);
  // cloud#2029 #6c: the post-handler cleanup flush uses `--flush-outbox-once`
  // (O(outbox), no full-tree reconcile — the permanent flush-124 cure) when the
  // mount binary supports it, falling back to `--once` otherwise. The outer
  // teardown timeout must exceed relayfile-mount's outbox flush deadline
  // (RELAYFILE_OUTBOX_TIMEOUT, default 60s) or cleanup can SIGKILL a slow but
  // healthy writeback before the independent outbox drain finishes.
  const sync = buildRelayfileMountCleanupFlushShell(config);
  const flushTimeoutSeconds = options.flushTimeoutSeconds ?? 75;
  const initialSyncIdleTimeoutSeconds = relayfileBootstrapIdleTimeoutSeconds(
    options.initialSyncIdleTimeoutSeconds ?? 90,
  );
  const initialSync = (options.initialSyncPaths?.length ?? 0) > 0
    ? buildRelayfileMountInitialSyncShell({
        ...config,
        paths: options.initialSyncPaths,
        idleTimeoutSeconds: initialSyncIdleTimeoutSeconds,
      })
    : "";

  return [
    // Raise the relayfile-mount daemon's INTERNAL bootstrap no-progress
    // watchdog (v0.8.5 `RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT`, syncer.go:957 ->
    // resolveDurationEnv -> time.ParseDuration, default 90s) to MATCH the outer
    // `buildIdleWatchedCommand` wrapper's idle timeout. They are a matched pair:
    // the daemon's atomic full export does not report progress until the body
    // fully returns, so on a slow-but-progressing export whichever watchdog is
    // lower cancels the bootstrap mid-flight -> "non-empty without completed
    // bootstrap -> force full reconcile" sticky loop (cloud #1516 interim; the
    // durable fix is the daemon's export-to-resumable-tree fall-through). Value is
    // a Go duration string ("<n>s"); RELAYFILE_BOOTSTRAP_TIMEOUT is left UNSET
    // (0 = unbounded while making progress, v0.8.5 main.go:78) - a hard total
    // cap could kill a legitimately long resumable pull. The `$(${start})`
    // subshell and the initial-sync block below both inherit this export.
    ...relayfileBootstrapIdleTimeoutEnvShell(initialSyncIdleTimeoutSeconds),
    `if ! RELAYFILE_MOUNT_PID=$(${start}); then`,
    "  echo '[relayfile-mount] failed to start daemon' >&2",
    "  exit 1",
    "fi",
    // cloud#2029 #6c: probe ONCE for `--flush-outbox-once` support. The cleanup
    // flush then runs `relayfile-mount "$relayfile_mount_flush_mode" ...` —
    // O(outbox) on v0.8.20+ (the flush-124 cure), `--once` on older binaries
    // (inert / no regression). Probed here (not in the trap) so it runs once.
    "relayfile_mount_flush_mode=--once",
    "if relayfile-mount --help 2>&1 | grep -q -- 'flush-outbox-once'; then relayfile_mount_flush_mode=--flush-outbox-once; fi",
    // relayfile#304: probe ONCE for `--push-local-once` — the teardown drain that
    // ingests local drafts the running daemon never picked up (one pushLocal pass,
    // no pullRemote/digest). Used below ONLY when pending local writes are detected;
    // the outbox-only `--flush-outbox-once` stays the no-pending-writes fast path.
    "relayfile_mount_push_local_supported=false",
    "if relayfile-mount --help 2>&1 | grep -q -- 'push-local-once'; then relayfile_mount_push_local_supported=true; fi",
    "relayfile_mount_cleanup() {",
    "  relayfile_mount_status=$?",
    // Harness/backward safety: default the mode if the probe did not run in this
    // shell context.
    '  : "${relayfile_mount_flush_mode:=--once}"',
    "  relayfile_mount_has_pending_writes=false",
    "  relayfile_mount_kill_attempted=false",
    "  relayfile_mount_kill_status=0",
    "  relayfile_mount_pending_writeback=0",
    "  relayfile_mount_has_pending_writeback=false",
    "  relayfile_mount_outbox_needs_attention=false",
    "  relayfile_mount_command_draft=false",
    // cloud#2029 #1b: empty = null = "not computed" (pre-receipt mount, node
    // absent, or precondition violated) → the TS gate feature-detects this and
    // falls back to the outbox-pending signals above. A number is the positive
    // adapter-dispatch-receipt count.
    "  relayfile_mount_command_drafts_undeliverable=",
    `  if [ -n "\${RELAYFILE_MOUNT_FLUSH_MARKER:-}" ] && [ -d ${shellQuote(options.localDir)} ]; then`,
    `    relayfile_mount_pending_path=$(find ${shellQuote(options.localDir)} \\( -name '.git' -o -name 'node_modules' -o -name '.agent-relay' \\) -prune -o \\( -type f -o -type d \\) -newer "$RELAYFILE_MOUNT_FLUSH_MARKER" ! -name '.relayfile-mount-state.json' ! -name '..relayfile-mount-state.json.tmp-*' -print -quit 2>/dev/null || true)`,
    '    if [ -n "$relayfile_mount_pending_path" ]; then',
    "      relayfile_mount_has_pending_writes=true",
    // A draft written after the daemon's last sync cycle (e.g. a final
    // fire-and-forget reply right before teardown) is on disk but not yet in the
    // outbox, so the outbox-only flush would drop it. When such pending writes
    // exist and the binary supports it, upgrade the cleanup to push-local-once so
    // the on-disk mirror is scanned and the draft is ingested before the flush.
    '      if [ "$relayfile_mount_push_local_supported" = true ]; then',
    "        relayfile_mount_flush_mode=--push-local-once",
    "      fi",
    "    fi",
    "  fi",
    "  if command -v timeout >/dev/null 2>&1; then",
    `    timeout ${Math.ceil(flushTimeoutSeconds)}s ${sync} >> /tmp/relayfile-mount.log 2>&1 || relayfile_mount_status=$?`,
    "  else",
    `    ${sync} >> /tmp/relayfile-mount.log 2>&1 || relayfile_mount_status=$?`,
    "  fi",
    '  if [ "$relayfile_mount_status" -eq 124 ] && [ "$relayfile_mount_has_pending_writes" = false ]; then',
    "    echo '[relayfile-mount] cleanup sync timed out with no pending local writes; treating as clean' >&2",
    "    relayfile_mount_status=0",
    "  fi",
    '  if [ -n "${RELAYFILE_MOUNT_PID:-}" ]; then',
    "    relayfile_mount_kill_attempted=true",
    '    kill "$RELAYFILE_MOUNT_PID" 2>/dev/null || relayfile_mount_kill_status=$?',
    "  fi",
    writebackUndeliveredSignalShell(options),
    cleanupStatusShell(options.cleanupStatusMessage),
    mountLogTailShell(options.mountLogTail),
    '  if [ -n "${RELAYFILE_MOUNT_FLUSH_MARKER:-}" ]; then',
    '    rm -f "$RELAYFILE_MOUNT_FLUSH_MARKER"',
    "  fi",
    '  return "$relayfile_mount_status"',
    "}",
    "trap relayfile_mount_cleanup EXIT",
    "trap 'relayfile_mount_cleanup; exit $?' INT TERM",
    initialSync
      ? buildInitialSyncBlock(initialSync, options.continueOnInitialSyncFailure ?? true)
      : "",
    "RELAYFILE_MOUNT_FLUSH_MARKER=$(mktemp /tmp/relayfile-mount-flush-baseline.XXXXXX) || RELAYFILE_MOUNT_FLUSH_MARKER=",
    'if [ -n "$RELAYFILE_MOUNT_FLUSH_MARKER" ]; then',
    '  touch "$RELAYFILE_MOUNT_FLUSH_MARKER"',
    "fi",
  ].join("\n");
}

function relayfileBootstrapIdleTimeoutSeconds(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const seconds = Math.ceil(value);
  return seconds > 0 ? seconds : undefined;
}

function relayfileBootstrapIdleTimeoutEnvShell(idleTimeoutSeconds: number | undefined): string[] {
  return idleTimeoutSeconds === undefined
    ? []
    : [`export RELAYFILE_BOOTSTRAP_IDLE_TIMEOUT=${idleTimeoutSeconds}s`];
}

function withRelayfileBootstrapIdleTimeout(
  command: string,
  idleTimeoutSeconds: number | undefined,
): string {
  return [
    ...relayfileBootstrapIdleTimeoutEnvShell(idleTimeoutSeconds),
    command,
  ].join("\n");
}

function cleanupStatusShell(message: string | undefined): string {
  if (!message) return "";
  return `  printf '{"message":"${message}","flushExitCode":%s,"killAttempted":%s,"killExitCode":%s,"pendingWriteback":%s,"hasPendingWriteback":%s,"outboxNeedsAttention":%s,"commandDraftWrittenThisRun":%s,"commandDraftsUndeliverable":%s}\\n' "$relayfile_mount_status" "$relayfile_mount_kill_attempted" "$relayfile_mount_kill_status" "$relayfile_mount_pending_writeback" "$relayfile_mount_has_pending_writeback" "$relayfile_mount_outbox_needs_attention" "$relayfile_mount_command_draft" "\${relayfile_mount_command_drafts_undeliverable:-null}" >&2`;
}

/**
 * cloud#2029 #1b — the positive adapter-dispatch-receipt classifier, run in the
 * sandbox at teardown via `node` (NOT sed/grep: it needs same-record
 * multi-field correlation — remotePath ∧ dispatchStatus ∧ opId ∧
 * needsAttention from ONE durable-outbox record — which cross-record grep
 * cannot do safely). Reads ONLY `<localDir>/.relay/outbox/{acked,pending}`
 * (O(outbox), no mirror walk) + the command roots, so it stays off the
 * flush-124 path. Prints a single integer (undeliverable count) to stdout on
 * success; prints NOTHING and exits non-zero on ANY error / precondition
 * violation, so the caller leaves the signal empty → the TS gate reads it as
 * null and falls back to the outbox-pending signals (feature-detect; can never
 * false-fire from this path).
 *
 * Undeliverable = a THIS-run command draft (newer than the flush marker) whose
 * derived remotePath has NO acked-succeeded receipt AND is either (a) in
 * `pending/` with `needsAttention:true` (failed/dead-lettered), (b) in
 * `pending/` with an empty/missing `opId` (never uploaded — sandbox-local
 * risk), or (c) has NO outbox record at all (never enqueued: --flush-outbox-once
 * does not scan command roots, so a just-written draft can race ahead of
 * enqueue). A draft with `opId` + `dispatchStatus` pending/running/queued is
 * BENIGN in-flight — once an opId is committed, the server owns delivery and
 * sandbox teardown cannot orphan it (relayfile-expert), so it does NOT count.
 *
 * remotePath derivation assumes the cloud invariant: `--local-dir` is the
 * UNSCOPED workspace root, so a draft sits at its full provider-rooted path
 * under localDir and `remotePath == "/" + rel(localDir, draftPath)` (the bare
 * strip equals relayfile's `normalizeRemotePath(remoteRoot + "/" + rel(...))`
 * because remoteRoot is "/" relative to the unscoped root). If a draft is NOT
 * under localDir (someone scoped the mount later), the invariant is broken and
 * the program bails to null rather than emit wrong paths that would false-fire.
 */
const WRITEBACK_RECEIPT_SCAN_PROGRAM = `"use strict";
const fs = require("fs");
const path = require("path");
function normalizeRemotePath(p) {
  let s = String(p).replace(/\\/+/g, "/");
  if (s.charAt(0) !== "/") s = "/" + s;
  if (s.length > 1) s = s.replace(/\\/+$/g, "");
  return s;
}
function statMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch (e) { return null; }
}
function walkFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, out);
    else if (ent.isFile()) out.push(full);
  }
}
function isDraftFile(name) {
  return /^draft.*\\.json$/.test(name) || name === "create.json";
}
function readRecords(dir) {
  const out = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    if (n.slice(-5) !== ".json") continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (rec && typeof rec === "object") out.push(rec);
    } catch (e) { /* skip malformed */ }
  }
  return out;
}
try {
  const argv = process.argv.slice(2);
  const localDir = (argv[0] || "").replace(/\\/+$/g, "");
  const marker = argv[1] || "";
  const roots = argv.slice(2);
  if (!localDir || !marker || roots.length === 0) process.exit(1);
  const markerMtime = statMtime(marker);
  if (markerMtime === null) process.exit(1);
  const drafts = [];
  for (const root of roots) {
    const files = [];
    walkFiles(root, files);
    for (const f of files) {
      if (!isDraftFile(path.basename(f))) continue;
      const m = statMtime(f);
      if (m === null || m <= markerMtime) continue;
      drafts.push(f);
    }
  }
  const prefix = localDir + "/";
  const draftRemotePaths = [];
  for (const f of drafts) {
    if (f.indexOf(prefix) !== 0) process.exit(1);
    draftRemotePaths.push(normalizeRemotePath(f.slice(localDir.length)));
  }
  const outbox = path.join(localDir, ".relay", "outbox");
  // PR2-RECEIPT CAPABILITY DETECT (load-bearing — without it this gate
  // false-fires fleet-wide). The positive gate is valid ONLY on a mount whose
  // outbox emits adapter-dispatch receipts. v0.8.21+ (#266) outbox-setup writes
  // a capability marker — .relay/outbox/capabilities.json {"dispatchReceipts":
  // true} — on EVERY run (even with an empty pending set); v0.8.19 (no outbox)
  // and the CURRENT v0.8.20 fleet (#264 durable outbox, pre-receipts) do NOT
  // write it. So classify ONLY when the marker confirms receipts are active;
  // else bail → empty stdout → the TS gate reads null and falls back to the
  // pending gate (truly inert on v0.8.19 AND v0.8.20). Marker (vs opId-record
  // presence) closes the empty-outbox blind spot: a v0.8.21 run whose only draft
  // never enqueued still carries the marker → classified correctly.
  // Contract (relayfile-expert #266 pin): .relay/outbox/capabilities.json =
  // {"schemaVersion":2,"dispatchReceipts":true}, written by v0.8.21's
  // ensureOutboxDirs (which --flush-outbox-once calls even with empty pending).
  // Require BOTH dispatchReceipts===true AND schemaVersion>=2 (the version guard
  // is forward-safe). Absent / parse-fail / not-enabled → treated as absent.
  let dispatchReceiptsActive = false;
  try {
    const cap = JSON.parse(fs.readFileSync(path.join(outbox, "capabilities.json"), "utf8"));
    dispatchReceiptsActive = !!(
      cap &&
      cap.dispatchReceipts === true &&
      typeof cap.schemaVersion === "number" &&
      cap.schemaVersion >= 2
    );
  } catch (e) {
    dispatchReceiptsActive = false;
  }
  if (!dispatchReceiptsActive) process.exit(1);
  const acked = readRecords(path.join(outbox, "acked"));
  const pending = readRecords(path.join(outbox, "pending"));
  const ackedByRemote = new Map();
  for (const r of acked) {
    if (!r || !r.remotePath) continue;
    const opId = typeof r.opId === "string" ? r.opId.trim() : "";
    if (opId && r.dispatchStatus === "succeeded") ackedByRemote.set(normalizeRemotePath(r.remotePath), true);
  }
  const pendingByRemote = new Map();
  for (const r of pending) {
    if (!r || !r.remotePath) continue;
    const key = normalizeRemotePath(r.remotePath);
    if (!pendingByRemote.has(key)) pendingByRemote.set(key, r);
  }
  let undeliverable = 0;
  for (const rp of draftRemotePaths) {
    if (ackedByRemote.get(rp) === true) continue;
    const rec = pendingByRemote.get(rp);
    if (!rec) { undeliverable += 1; continue; }
    const opId = typeof rec.opId === "string" ? rec.opId.trim() : "";
    if (rec.needsAttention === true) { undeliverable += 1; continue; }
    if (!opId) { undeliverable += 1; continue; }
  }
  process.stdout.write(String(undeliverable));
} catch (e) {
  process.exit(1);
}
`;

/**
 * Compute the two cloud#2029 writeback-delivery signals into shell vars the
 * cleanup-status printf emits:
 *
 *  - `relayfile_mount_pending_writeback`: the canonical undelivered count from
 *    `<localDir>/.relay/state.json` (the mount/outbox public status file — the
 *    public state lives under localDir, NOT `--state-dir`). Parsed with `sed`
 *    (no `jq` dependency); absent/unparsable → 0. A stamped `revision` is NOT
 *    read here — it is not proof of delivery.
 *  - `relayfile_mount_has_pending_writeback` / `relayfile_mount_outbox_needs_attention`:
 *    the unified pending + needs-attention flags from `states` in the same
 *    `.relay/state.json`. `states.hasPendingWriteback` is set by the daemon for
 *    LOCAL pending (v0.8.19+) AND, post-#264, for durable-outbox pending — so it
 *    subsumes the nested `outbox.pending` count without fragile nested parsing.
 *    `states.outboxNeedsAttention` is `omitempty` (absent → false on pre-#264
 *    mounts). Matched with `grep -Eq` (whitespace-tolerant); both keys live ONLY
 *    under top-level `states`, never per-file under `files`, so the context-blind
 *    grep can't false-positive. Backward-safe: absent → false. (cloud#2029 #1)
 *  - `relayfile_mount_command_draft`: whether THIS run wrote a writeback command
 *    FILE (`draft*.json` / `create.json`, the agent-authored convention) under a
 *    configured command root, newer than the run's flush marker. The glob is
 *    deliberately narrow: command roots are MIRROR dirs, so an INBOUND message
 *    mirrored down mid-run (timestamp-named `<ts>.json`) is also `-newer` — a
 *    broad `*.json` probe would flag a read-only run that merely RECEIVED a
 *    message and, with a backlog present, falsely fail it (the cloud#2013
 *    regression). Only agent-authored draft/create files count.
 *    The conjunction of these two is what makes the failure loud yet free of
 *    read-only false alarms.
 *
 * This is pure observability — it never changes `relayfile_mount_status`, so it
 * does not perturb the teardown exit code (cloud#2013 stays intact). The TS
 * layer folds these into run status.
 */
function writebackUndeliveredSignalShell(
  options: RelayfileMountLifecycleShellOptions,
): string {
  const stateJson = `${options.localDir.replace(/\/+$/u, "")}/.relay/state.json`;
  const lines: string[] = [
    `  if [ -f ${shellQuote(stateJson)} ]; then`,
    `    relayfile_mount_pending_writeback=$(sed -n 's/.*"pendingWriteback":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' ${shellQuote(stateJson)} 2>/dev/null | head -n 1)`,
    '    if [ -z "$relayfile_mount_pending_writeback" ]; then relayfile_mount_pending_writeback=0; fi',
    `    if grep -Eq '"hasPendingWriteback":[[:space:]]*true' ${shellQuote(stateJson)} 2>/dev/null; then relayfile_mount_has_pending_writeback=true; fi`,
    `    if grep -Eq '"outboxNeedsAttention":[[:space:]]*true' ${shellQuote(stateJson)} 2>/dev/null; then relayfile_mount_outbox_needs_attention=true; fi`,
    "  fi",
  ];
  const commandRoots = (options.commandRootLocalDirs ?? []).filter(
    (dir) => dir.trim().length > 0,
  );
  if (commandRoots.length > 0) {
    const quoted = commandRoots.map((dir) => shellQuote(dir)).join(" ");
    lines.push(
      '  if [ -n "${RELAYFILE_MOUNT_FLUSH_MARKER:-}" ]; then',
      `    for relayfile_mount_cmd_root in ${quoted}; do`,
      '      if [ -d "$relayfile_mount_cmd_root" ]; then',
      '        relayfile_mount_cmd_hit=$(find "$relayfile_mount_cmd_root" -type f -newer "$RELAYFILE_MOUNT_FLUSH_MARKER" \\( -name \'draft*.json\' -o -name \'create.json\' \\) -print -quit 2>/dev/null || true)',
      '        if [ -n "$relayfile_mount_cmd_hit" ]; then relayfile_mount_command_draft=true; break; fi',
      "      fi",
      "    done",
      "  fi",
    );
    // cloud#2029 #1b: positive adapter-dispatch-receipt count. Materialize the
    // classifier to a temp file (no extension → node runs it as CommonJS; the
    // program uses `require`) and run it over the durable outbox. Self-
    // protecting: node-absent / mktemp-fail / any program error → the var stays
    // empty → the TS gate reads null → falls back to the outbox-pending signals.
    // The `|| true` + 2>/dev/null guarantee it never perturbs the flush exit code.
    lines.push(
      '  if [ -n "${RELAYFILE_MOUNT_FLUSH_MARKER:-}" ] && command -v node >/dev/null 2>&1; then',
      "    relayfile_mount_receipt_scan=$(mktemp /tmp/relayfile-receipt-scan.XXXXXX 2>/dev/null || true)",
      '    if [ -n "$relayfile_mount_receipt_scan" ]; then',
      `      cat > "$relayfile_mount_receipt_scan" <<'RELAYFILE_RECEIPT_SCAN_EOF'`,
      WRITEBACK_RECEIPT_SCAN_PROGRAM,
      "RELAYFILE_RECEIPT_SCAN_EOF",
      `      relayfile_mount_command_drafts_undeliverable=$(node "$relayfile_mount_receipt_scan" ${shellQuote(options.localDir)} "$RELAYFILE_MOUNT_FLUSH_MARKER" ${quoted} 2>/dev/null || true)`,
      '      rm -f "$relayfile_mount_receipt_scan" 2>/dev/null || true',
      "    fi",
      "  fi",
    );
  }
  return lines.join("\n");
}

function mountLogTailShell(options: RelayfileMountLifecycleShellOptions["mountLogTail"]): string {
  if (!options) return "";
  return [
    "  if [ -f /tmp/relayfile-mount.log ]; then",
    `    echo '${options.startMarker}' >&2`,
    `    tail -c ${Math.max(0, Math.ceil(options.bytes))} /tmp/relayfile-mount.log 2>/dev/null | tail -n ${Math.max(0, Math.ceil(options.lines))} >&2 || true`,
    `    echo '${options.endMarker}' >&2`,
    "  fi",
  ].join("\n");
}

export function buildRelayfileMountCleanupInvocationShell(
  mount: unknown | null,
): string {
  if (!mount) return "";
  return [
    "trap - EXIT INT TERM",
    "MOUNT_EXIT=0",
    "relayfile_mount_cleanup || MOUNT_EXIT=$?",
  ].join("\n");
}

function buildInitialSyncBlock(initialSync: string, continueOnFailure: boolean): string {
  if (!continueOnFailure) {
    return initialSync;
  }
  return [
    `if ! ${initialSync} >> /tmp/relayfile-mount.log 2>&1; then`,
    "  echo '[relayfile-mount] scoped initial sync failed; continuing without preloaded reads' >&2",
    "fi",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

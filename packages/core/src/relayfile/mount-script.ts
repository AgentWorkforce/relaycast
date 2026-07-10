/**
 * Shell snippets for running the `relayfile-mount` daemon inside a Daytona
 * sandbox.
 *
 * Three call sites independently constructed near-identical bash to start /
 * stop / flush the mount:
 *   - `packages/core/src/executor/executor.ts` (workflow executor, runs each
 *     command via `executeRuntimeCommand`)
 *   - `packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts`
 *     (proactive runtime, runs a single multi-line script via
 *     `DaytonaRuntime.runScript`)
 *   - `packages/core/src/bootstrap/script-generator.ts` (emits sandbox-side
 *     JS that wraps the bash in `execSync`)
 *
 * This file is the canonical builder for the executor + proactive-runtime
 * paths, and also owns the command templates that `script-generator.ts`
 * emits into sandbox-resident bootstrap JS.
 *
 * The contract: helpers take primitives, do their own shell quoting, and
 * return ready-to-run bash. Callers must not re-quote.
 */

export type RelayfileMountShellOptions = {
  /** Relayfile base URL, e.g. `https://api.relayfile.dev`. */
  baseUrl: string;
  /** Workspace id the path-scoped token is bound to. */
  workspaceId: string;
  /** Local mirror root inside the sandbox, e.g. `/home/daytona/workspace`. */
  localDir: string;
  /**
   * Private relayfile-mount state directory. Defaults outside the mounted
   * workspace so sync metadata never appears in the Relayfile tree.
   */
  stateDir?: string;
  /** Path-scoped relayfile token (`relay_pa_*`). */
  token: string;
  /**
   * Optional logical path scopes. The daemon accepts repeated
   * `--remote-path` args; callers pass persona/event scopes here so the
   * continuous sync never pulls a full workspace export.
   */
  paths?: readonly string[];
  /**
   * Whether relayfile-mount should use the WebSocket event stream. Omit to use
   * the CLI default. Cloud sandboxes set this false so they use bounded
   * /fs/events polling instead of a long-lived Worker WebSocket request.
   */
  websocket?: boolean;
  /**
   * Lazily materialize GitHub repo subtrees on first access instead of eagerly
   * hydrating every repo file during bootstrap.
   */
  lazyRepos?: boolean;
  /**
   * Path to a JSON creds file (`{"token": "relay_pa_…", "mintedAt"?, "expiresAt"?}`)
   * the daemon re-reads on 401 so a refreshed token heals the mount without a
   * restart. Passed as the RELAYFILE_MOUNT_CREDS_FILE env var rather than a
   * `--creds-file` flag for the same version-skew reason as
   * RELAYFILE_MOUNT_LOCAL_LAYOUT above: pre-creds binaries reject an unknown
   * flag but ignore the env var, so one spelling works across every binary a
   * snapshot may carry. `--token` stays as the launch credential either way.
   */
  credsFilePath?: string;
};

export const DEFAULT_RELAYFILE_MOUNT_STATE_DIR = "/home/daytona/.relayfile-mount-state";

/**
 * Pin the daemon's local layout to `scoped` (remote path appended under
 * --local-dir) on every invocation.
 *
 * relayfile v0.8.11 (AgentWorkforce/relayfile#243) made the layout explicit:
 * the binary now defaults to `exact` (--local-dir IS the mirror root) and
 * hard-errors on multiple --remote-path values unless
 * `--local-layout=scoped`. All builders in this module pre-compute an
 * UNSCOPED local dir (see `unscopedLocalDir`) and rely on the daemon
 * appending the remote path — the implicit behavior of pre-v0.8.11 binaries
 * (relayfile#206). Without this pin, a v0.8.11 sandbox binary breaks two
 * ways: multi-path mounts fail at startup, and single-path mounts silently
 * mirror at the wrong depth.
 *
 * Pinned via env var rather than the `--local-layout` flag on purpose:
 * pre-v0.8.11 binaries reject the unknown flag but ignore the env var, and
 * v0.8.11+ reads RELAYFILE_MOUNT_LOCAL_LAYOUT as the flag default — so this
 * one spelling yields an identical on-disk layout across every binary
 * version a sandbox snapshot may carry (v0.8.9 pin today, v0.8.11 after the
 * next rebake). The pathless case is safe: scoped layout with remote path
 * "/" is a no-op join (normalizeMountRemotePath("/") → localDir).
 *
 * Spelled `env VAR=… relayfile-mount` (not the bare `VAR=… relayfile-mount`
 * shell form) because initial-sync commands get wrapped by coreutils
 * `timeout`, which execs its argument instead of shell-parsing it — a bare
 * assignment prefix would make `timeout '20s' VAR=… relayfile-mount` fail
 * with "failed to run command". `env` is a real executable, so the same
 * prefix composes under `timeout`, `nohup`, and direct execution alike.
 */
const SCOPED_LOCAL_LAYOUT_ENV = "env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped ";

/**
 * `env`-prefix for every relayfile-mount invocation: always pins the scoped
 * local layout, and when the caller provides a creds file, also points the
 * daemon at it via RELAYFILE_MOUNT_CREDS_FILE (see `credsFilePath` docs for
 * the version-skew rationale).
 */
function mountEnvPrefix(opts: Pick<RelayfileMountShellOptions, "credsFilePath">): string {
  if (!opts.credsFilePath) {
    return SCOPED_LOCAL_LAYOUT_ENV;
  }
  return `env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped RELAYFILE_MOUNT_CREDS_FILE=${shellQuote(opts.credsFilePath)} `;
}

export type RelayfileMountInitialSyncOptions = RelayfileMountShellOptions & {
  /**
   * Optional timeout for a pre-handler sync. When set, the command uses
   * coreutils `timeout`; if it is unavailable, the sync fails so callers can
   * gracefully continue without risking an unbounded pre-handler sync.
   */
  timeoutSeconds?: number;
  /**
   * Optional idle timeout for pre-handler sync. Unlike timeoutSeconds, this
   * cancels only when mount state stops progressing for N seconds.
   */
  idleTimeoutSeconds?: number;
};

export type RelayfileMountDaemonOptions = RelayfileMountShellOptions & {
  /** Daemon sync interval. Defaults to `1s` for near-real-time writeback. */
  interval?: string;
  /** Path the daemon redirects stdout/stderr to. Defaults to `/tmp/relayfile-mount.log`. */
  logPath?: string;
};

export type RelayfileMountShellTemplate = {
  startShellTemplate: string;
  flushShellTemplate: string;
  pathArgsPlaceholderArg: string;
  pathArgTemplate: string;
  placeholders: {
    baseUrl: string;
    workspaceId: string;
    localDir: string;
    token: string;
    pathArgs: string;
    path: string;
  };
};

const DEFAULT_TEMPLATE_PLACEHOLDERS: RelayfileMountShellTemplate["placeholders"] = {
  baseUrl: "__relayfile_base_url__",
  workspaceId: "__relayfile_workspace_id__",
  localDir: "__relayfile_local_dir__",
  token: "__relayfile_token__",
  pathArgs: "__relayfile_path_args__",
  path: "__relayfile_path__",
};

/**
 * Bash command that starts a `relayfile-mount` daemon in the background and
 * echoes the daemon PID on stdout (so callers can capture it and kill the
 * process later). The daemon redirects all output to `logPath` so it does
 * not pollute the caller's stdout/stderr.
 *
 * Mirrors the inline command originally in
 * `executor.ts:startRelayfileMount` (#???) — see the file-level comment for
 * the migration story.
 */
export function buildRelayfileMountStartShell(opts: RelayfileMountDaemonOptions): string {
  const scopedRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const localDir = unscopedLocalDir(opts.localDir, scopedRoots);
  const args = buildMountArgs({ ...opts, localDir, paths: scopedRoots });
  const interval = opts.interval ?? "1s";
  const logPath = opts.logPath ?? "/tmp/relayfile-mount.log";
  const startShell = [
    `${mountEnvPrefix(opts)}nohup relayfile-mount`,
    ...args,
    `--interval ${shellQuote(interval)}`,
    `> ${shellQuote(logPath)} 2>&1 & echo $!`,
  ].join(" ");
  if (scopedRoots.length <= 1) {
    return startShell;
  }
  // `paths-file` is the new-daemon sentinel: relayfile #206 ships it together
  // with repeated `--remote-path` support. The Go flag package prints
  // `-paths-file` in help while the command accepts `--paths-file`, so probe
  // for the flag name without assuming dash style.
  return [
    "if relayfile-mount --help 2>&1 | grep -q -- 'paths-file'; then",
    `${startShell};`,
    "else",
    "echo 'relayfile-mount multi-path filters unsupported; starting one daemon per remote path' >&2;",
    `${buildRelayfileMountFallbackStartShell({ ...opts, paths: scopedRoots })};`,
    "fi",
  ].join(" ");
}

/**
 * Bash command that runs a one-time relayfile-mount sync (`--once`). Pushes
 * any pending local writes upstream and exits. Use this:
 *   - As an explicit pre-handler sync so the mount mirror is populated
 *     before the handler reads from it (executor's initial-sync pattern).
 *   - As a post-handler flush before sandbox teardown so writeback drafts
 *     the handler created (e.g. `ctx.github.comment` files) reach
 *     relayfile cloud before the sandbox stops.
 */
export function buildRelayfileMountFlushShell(opts: RelayfileMountShellOptions): string {
  const scopedRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const localDir = unscopedLocalDir(opts.localDir, scopedRoots);
  const args = buildMountArgs({ ...opts, localDir, paths: scopedRoots });
  return [`${mountEnvPrefix(opts)}relayfile-mount --once`, ...args].join(" ");
}

/**
 * Post-handler CLEANUP flush command (cloud#2029 #6c — the permanent flush-124
 * cure). Identical to {@link buildRelayfileMountFlushShell} EXCEPT the mode flag
 * is the shell variable `$relayfile_mount_flush_mode`, which the lifecycle shell
 * probes once into `--flush-outbox-once` (O(durable outbox); flushes only
 * `.relay/outbox/pending` and exits WITHOUT a full-tree reconcile —
 * scanLocalFiles/pushLocal/pullRemote — so a large mirror can't blow the cleanup
 * `timeout`) on a relayfile-mount that supports it (v0.8.20+), else `--once`
 * (today's v0.8.19 fleet — unchanged behavior). Emitted as a SINGLE command (the
 * flag is one expanded token) so it stays valid inside the cleanup's
 * `timeout Ns ...` wrapper — an inline `if/fi` would break `timeout`. The flag
 * choice does not change the exit-code/`.relay/state.json` contract the
 * #2036/#2037 cleanup gate reads: a real outbox-flush failure still exits
 * nonzero + leaves pending, so the loud-fold stays load-bearing.
 */
export function buildRelayfileMountCleanupFlushShell(
  opts: RelayfileMountShellOptions,
): string {
  const scopedRoots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const localDir = unscopedLocalDir(opts.localDir, scopedRoots);
  const args = buildMountArgs({ ...opts, localDir, paths: scopedRoots });
  return [
    `${mountEnvPrefix(opts)}relayfile-mount "$relayfile_mount_flush_mode"`,
    ...args,
  ].join(" ");
}

export function buildRelayfileMountInitialSyncShell(
  opts: RelayfileMountInitialSyncOptions,
): string {
  const commands = buildInitialSyncCommands(opts);
  const command = commands.join(" && ");
  if (opts.idleTimeoutSeconds && opts.idleTimeoutSeconds > 0) {
    return buildIdleWatchedCommand(
      command,
      initialSyncProgressFiles(opts),
      opts.idleTimeoutSeconds,
    );
  }
  if (!opts.timeoutSeconds || opts.timeoutSeconds <= 0) {
    return command;
  }
  const timeout = `${Math.ceil(opts.timeoutSeconds)}s`;
  const timedCommand = commands
    .map((entry) => `timeout ${shellQuote(timeout)} ${entry}`)
    .join(" && ");
  return [
    "{",
    "if command -v timeout >/dev/null 2>&1; then",
    `${timedCommand};`,
    "else",
    "echo 'timeout command unavailable for relayfile initial sync' >&2;",
    "false;",
    "fi;",
    "}",
  ].join(" ");
}

export const RELAYFILE_INITIAL_SYNC_SCRIPT_PATH = "/tmp/relayfile-initial-sync.sh";
export const RELAYFILE_INITIAL_SYNC_EXIT_PATH = "/tmp/relayfile-initial-sync.exit";
export const RELAYFILE_INITIAL_SYNC_LOG_PATH = "/tmp/relayfile-initial-sync.log";
export const RELAYFILE_INITIAL_SYNC_PID_PATH = "/tmp/relayfile-initial-sync.pid";

export type RelayfileMountInitialSyncRunOptions = {
  runId?: string;
};

function relayfileInitialSyncPath(path: string, runId: string | undefined): string {
  if (!runId) {
    return path;
  }
  const safeRunId = runId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${path}.${safeRunId}`;
}

/**
 * Bash that launches the (idle-watched) initial sync in the background and
 * returns immediately, echoing the launcher PID. Daytona's exec path cannot
 * host a single long-running command: the proxy read-times-out around 120s
 * (Cloudflare 524) and callers add their own client-side fail-fast, so a
 * first materialization with real data (a populated /github tree, a cold
 * workspace export) gets killed mid-sync. Instead the sync runs detached in
 * the sandbox — preserving the in-sandbox idle watchdog — and callers poll
 * `buildRelayfileMountInitialSyncStatusShell` with short execs until the
 * exit sentinel appears.
 */
export function buildRelayfileMountInitialSyncBackgroundShell(
  opts: RelayfileMountInitialSyncOptions,
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const scriptPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_SCRIPT_PATH,
    runOptions.runId,
  );
  const exitPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_EXIT_PATH,
    runOptions.runId,
  );
  const logPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_LOG_PATH,
    runOptions.runId,
  );
  const pidPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_PID_PATH,
    runOptions.runId,
  );
  const syncShell = buildRelayfileMountInitialSyncShell(opts);
  const runner = [
    "if command -v setsid >/dev/null 2>&1; then",
    `  setsid sh ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1 &`,
    "else",
    `  sh ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1 &`,
    "fi;",
    "relayfile_initial_sync_pid=$!;",
    `echo "$relayfile_initial_sync_pid" > ${shellQuote(pidPath)};`,
    'wait "$relayfile_initial_sync_pid";',
    `echo $? > ${shellQuote(exitPath)}`,
  ].join(" ");
  return [
    "set -e",
    `rm -f ${shellQuote(scriptPath)} ${shellQuote(exitPath)} ${shellQuote(logPath)} ${shellQuote(pidPath)} &&`,
    // Quoted heredoc delimiter: the sync shell lands in the script file
    // verbatim, with no re-quoting hazards from nesting it in `sh -c`.
    `cat > ${shellQuote(scriptPath)} <<'RELAYFILE_INITIAL_SYNC_EOF'
${syncShell}
RELAYFILE_INITIAL_SYNC_EOF
`,
    `nohup sh -c ${shellQuote(runner)} >/dev/null 2>&1 & echo $!`,
  ].join("\n");
}

const RELAYFILE_INITIAL_SYNC_EXIT_MARKER = "relayfile-initial-sync-exit:";
const RELAYFILE_INITIAL_SYNC_RUNNING_MARKER = "relayfile-initial-sync-running";

/** Short, idempotent status probe for the backgrounded initial sync. */
export function buildRelayfileMountInitialSyncStatusShell(
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const exitPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_EXIT_PATH,
    runOptions.runId,
  );
  const pidPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_PID_PATH,
    runOptions.runId,
  );
  return [
    `if [ -f ${shellQuote(exitPath)} ]; then`,
    `echo "${RELAYFILE_INITIAL_SYNC_EXIT_MARKER}$(cat ${shellQuote(exitPath)})";`,
    `elif [ -f ${shellQuote(pidPath)} ]; then`,
    `relayfile_initial_sync_pid=$(cat ${shellQuote(pidPath)} 2>/dev/null || true);`,
    'case "$relayfile_initial_sync_pid" in',
    `  ''|*[!0-9]*) echo ${RELAYFILE_INITIAL_SYNC_RUNNING_MARKER} ;;`,
    '  *)',
    '    if kill -0 "$relayfile_initial_sync_pid" 2>/dev/null; then',
    `      echo ${RELAYFILE_INITIAL_SYNC_RUNNING_MARKER};`,
    "    else",
    `      echo "${RELAYFILE_INITIAL_SYNC_EXIT_MARKER}127";`,
    "    fi",
    "    ;;",
    "esac",
    "else",
    `echo ${RELAYFILE_INITIAL_SYNC_RUNNING_MARKER};`,
    "fi",
  ].join(" ");
}

export function buildRelayfileMountInitialSyncKillShell(
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const pidPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_PID_PATH,
    runOptions.runId,
  );
  return [
    `if [ -f ${shellQuote(pidPath)} ]; then`,
    `relayfile_initial_sync_pid=$(cat ${shellQuote(pidPath)} 2>/dev/null || true);`,
    'case "$relayfile_initial_sync_pid" in',
    "  ''|*[!0-9]*) ;;",
    '  *)',
    '    kill -TERM -- "-$relayfile_initial_sync_pid" 2>/dev/null || true;',
    '    kill "$relayfile_initial_sync_pid" 2>/dev/null || true',
    "    ;;",
    "esac",
    "fi",
  ].join(" ");
}

export function buildRelayfileMountInitialSyncLogTailShell(
  lines = 40,
  runOptions: RelayfileMountInitialSyncRunOptions = {},
): string {
  const logPath = relayfileInitialSyncPath(
    RELAYFILE_INITIAL_SYNC_LOG_PATH,
    runOptions.runId,
  );
  return `tail -n ${Math.max(1, Math.floor(lines))} ${shellQuote(logPath)} 2>/dev/null || true`;
}

export type RelayfileMountInitialSyncStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number }
  // The probe's output is a closed set (exit marker or running marker), so
  // anything else means the exec channel itself is broken — callers fail
  // fast instead of polling garbage until their deadline.
  | { state: "unknown" };

export function parseRelayfileMountInitialSyncStatus(
  output: string,
): RelayfileMountInitialSyncStatus {
  const match = output.match(
    new RegExp(`${RELAYFILE_INITIAL_SYNC_EXIT_MARKER}(-?\\d+)`),
  );
  if (match) {
    return { state: "exited", exitCode: Number.parseInt(match[1], 10) };
  }
  if (output.includes(RELAYFILE_INITIAL_SYNC_RUNNING_MARKER)) {
    return { state: "running" };
  }
  return { state: "unknown" };
}

export function buildRelayfileMountPathArgsShell(paths: readonly string[]): string {
  return scopedRemoteRoots(paths, { allowProviderRoot: true })
    .map(buildMountPathArg)
    .join("");
}

export function buildRelayfileMountShellTemplate(
  placeholders: Partial<RelayfileMountShellTemplate["placeholders"]> = {},
  options: Pick<RelayfileMountDaemonOptions, "interval" | "websocket" | "stateDir"> = {},
): RelayfileMountShellTemplate {
  const resolved = { ...DEFAULT_TEMPLATE_PLACEHOLDERS, ...placeholders };
  const baseOpts = {
    baseUrl: resolved.baseUrl,
    workspaceId: resolved.workspaceId,
    localDir: resolved.localDir,
    stateDir: options.stateDir,
    token: resolved.token,
    ...options,
  };
  const pathArgsPlaceholderArg = buildMountPathArg(resolved.pathArgs);
  const pathArgTemplate = buildMountPathArg(resolved.path);
  const startShellWithoutPaths = buildRelayfileMountStartShell(baseOpts);
  const flushShellWithoutPaths = buildRelayfileMountFlushShell(baseOpts);
  return {
    startShellTemplate: insertStartTemplatePathArgs(
      startShellWithoutPaths,
      pathArgsPlaceholderArg,
    ),
    flushShellTemplate: `${flushShellWithoutPaths}${pathArgsPlaceholderArg}`,
    pathArgsPlaceholderArg,
    pathArgTemplate,
    placeholders: resolved,
  };
}

function buildMountArgs(opts: RelayfileMountShellOptions): string[] {
  return [
    `--base-url ${shellQuote(opts.baseUrl)}`,
    `--workspace ${shellQuote(opts.workspaceId)}`,
    `--local-dir ${shellQuote(opts.localDir)}`,
    `--state-dir ${shellQuote(opts.stateDir ?? DEFAULT_RELAYFILE_MOUNT_STATE_DIR)}`,
    `--token ${shellQuote(opts.token)}`,
    ...(opts.websocket === false ? ["--websocket=false"] : []),
    ...(opts.lazyRepos ? ["--lazy-repos"] : []),
    ...scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true })
      .map((path) => `--remote-path ${shellQuote(path)}`),
  ];
}

function buildInitialSyncCommands(opts: RelayfileMountInitialSyncOptions): string[] {
  const roots = scopedRemoteRoots(opts.paths ?? []);
  if (roots.length === 0) {
    return [buildRelayfileMountFlushShell(opts)];
  }
  const localDir = unscopedLocalDir(opts.localDir, roots);
  return roots
    .map((remoteRoot, index) => {
      const args = [
        ...buildMountArgs({ ...opts, localDir, paths: [] }),
        `--remote-path ${shellQuote(remoteRoot)}`,
        `--state-file ${shellQuote(`/tmp/relayfile-mount-initial-sync-${index}.json`)}`,
      ];
      return [`${mountEnvPrefix(opts)}relayfile-mount --once`, ...args].join(" ");
    });
}

function initialSyncProgressFiles(opts: RelayfileMountInitialSyncOptions): string[] {
  const roots = scopedRemoteRoots(opts.paths ?? []);
  if (roots.length === 0) {
    const stateDir = opts.stateDir ?? DEFAULT_RELAYFILE_MOUNT_STATE_DIR;
    return [
      `${stateDir.replace(/\/+$/u, "")}/.relayfile-mount-state.json`,
    ];
  }
  return roots.map((_remoteRoot, index) =>
    `/tmp/relayfile-mount-initial-sync-${index}.json`
  );
}

function buildIdleWatchedCommand(
  command: string,
  progressFiles: readonly string[],
  idleTimeoutSeconds: number,
): string {
  const idle = Math.max(1, Math.ceil(idleTimeoutSeconds));
  const poll = Math.max(1, Math.min(5, Math.floor(idle / 3) || 1));
  const progressArgs = progressFiles.map(shellQuote).join(" ");
  return [
    "(",
    `set -- ${progressArgs};`,
    "relayfile_mount_marker=$(mktemp /tmp/relayfile-mount-progress.XXXXXX) || exit 1;",
    'touch "$relayfile_mount_marker";',
    `(${command}) &`,
    "relayfile_mount_sync_pid=$!;",
    "relayfile_mount_status=0;",
    'while kill -0 "$relayfile_mount_sync_pid" 2>/dev/null; do',
    '  for relayfile_mount_progress_file in "$@"; do',
    '    if [ -f "$relayfile_mount_progress_file" ] && [ "$relayfile_mount_progress_file" -nt "$relayfile_mount_marker" ]; then',
    '      touch "$relayfile_mount_marker";',
    "    fi;",
    "  done;",
    "  relayfile_mount_now=$(date +%s);",
    '  relayfile_mount_marker_mtime=$(date -r "$relayfile_mount_marker" +%s 2>/dev/null || stat -c %Y "$relayfile_mount_marker" 2>/dev/null || echo "$relayfile_mount_now");',
    `  if [ $((relayfile_mount_now - relayfile_mount_marker_mtime)) -ge ${idle} ]; then`,
    `    echo 'relayfile initial sync made no progress for ${idle}s; canceling' >&2;`,
    '    kill "$relayfile_mount_sync_pid" 2>/dev/null || true;',
    '    wait "$relayfile_mount_sync_pid" 2>/dev/null || true;',
    '    rm -f "$relayfile_mount_marker";',
    "    exit 124;",
    "  fi;",
    `  sleep ${poll};`,
    "done;",
    'wait "$relayfile_mount_sync_pid" || relayfile_mount_status=$?;',
    'rm -f "$relayfile_mount_marker";',
    'exit "$relayfile_mount_status";',
    ")",
  ].join(" ");
}

function scopedRemoteRoots(
  paths: readonly string[],
  options: { allowProviderRoot?: boolean } = {},
): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = scopedRemoteRoot(path, options);
    if (root) {
      roots.add(root);
    }
  }
  return [...roots].sort();
}

function scopedRemoteRoot(
  path: string,
  options: { allowProviderRoot?: boolean } = {},
): string | null {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const withoutGlob = trimmed.endsWith("/**") ? trimmed.slice(0, -3) : trimmed;
  const normalized = withoutGlob.replace(/\/{2,}/g, "/").replace(/\/$/u, "");
  if (!normalized || normalized === "/" || normalized.includes("*")) {
    return null;
  }
  if (!options.allowProviderRoot && normalized.slice(1).split("/").length < 2) {
    return null;
  }
  return normalized;
}

function unscopedLocalDir(localRoot: string, remoteRoots: readonly string[]): string {
  let normalizedRoot = localRoot.replace(/\/+$/u, "");
  const suffixes = remoteRoots
    .map((remoteRoot) => remoteRoot.replace(/^\/+/u, "").replace(/\/+$/u, ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const suffix of suffixes) {
    if (!suffix) {
      continue;
    }
    if (normalizedRoot === suffix) {
      normalizedRoot = "";
      continue;
    }
    if (normalizedRoot.endsWith(`/${suffix}`)) {
      normalizedRoot = normalizedRoot.slice(0, -suffix.length).replace(/\/+$/u, "");
      continue;
    }
    const nestedSuffix = `/${suffix}/`;
    const nestedIndex = normalizedRoot.indexOf(nestedSuffix);
    if (nestedIndex !== -1) {
      normalizedRoot = normalizedRoot.slice(0, nestedIndex).replace(/\/+$/u, "");
    }
  }
  return normalizedRoot || "/";
}

function buildMountPathArg(path: string): string {
  return ` --remote-path ${shellQuote(path)}`;
}

function insertStartTemplatePathArgs(shell: string, pathArgsPlaceholderArg: string): string {
  return shell.replace(" --interval ", `${pathArgsPlaceholderArg} --interval `);
}

function buildRelayfileMountFallbackStartShell(opts: RelayfileMountDaemonOptions): string {
  const roots = scopedRemoteRoots(opts.paths ?? [], { allowProviderRoot: true });
  const localDir = unscopedLocalDir(opts.localDir, roots);
  const interval = opts.interval ?? "1s";
  const logPath = opts.logPath ?? "/tmp/relayfile-mount.log";
  const starts = roots.map((root) => [
    `${mountEnvPrefix(opts)}relayfile-mount`,
    ...buildMountArgs({ ...opts, localDir, paths: [root] }),
    `--interval ${shellQuote(interval)}`,
    `>> ${shellQuote(logPath)} 2>&1 &`,
    "relayfile_mount_pids=\"$relayfile_mount_pids $!\";",
  ].join(" "));
  return [
    "(",
    "relayfile_mount_pids='';",
    ...starts,
    "trap 'kill $relayfile_mount_pids 2>/dev/null || true; wait' INT TERM EXIT;",
    "wait",
    ") >/dev/null 2>&1 & echo $!",
  ].join(" ");
}

/**
 * POSIX-safe single-quote escape. `foo` → `'foo'`, `foo's` → `'foo'\''s'`.
 * Conservative — quotes every value, even ones that don't strictly need it,
 * so callers never have to think about characters that would otherwise be
 * shell-interpreted (spaces, `$`, etc.).
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

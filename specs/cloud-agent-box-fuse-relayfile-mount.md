# Cloud-agent box: FUSE relayfile-mount inside the Daytona sandbox

## Goal

The agent process running inside a **cloud-agent box** sandbox should see the
workspace's relayfile contents as a real local filesystem (e.g. `cat
/workspace/foo.txt` works with plain shell tools) instead of only via HTTP API
calls authenticated with `RELAYFILE_TOKEN`. Two-way sync: local edits from the
user's Pear-side mount surface in the sandbox; sandbox edits surface back.

## Non-goals

- Pear-side mount changes. Pear already mounts at `project.rootPath` via
  `RelayfileSetup.mountWorkspace` (`pear:src/main/cloud-agent.ts` —
  `cloudAgentManager.attachInternal` → `startMount`). Leave that alone; this
  spec is about adding the **sandbox-side** half so the FUSE round-trip is
  symmetric.
- Proactive-runtime sandboxes. A parallel PR on branch
  `fix/proactive-relayfile-mount-daemon` adds FUSE for the
  `provisionOnDemandSandbox` path in
  `cloud:packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts`.
  This spec mirrors that work for the cloud-agent box path
  (`cloud:packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager.ts`).
  Both paths should converge on a shared helper (see §3).

## Background — the two code paths

```
[User's Mac]                     [Relayfile service]                    [Daytona sandbox]
project.rootPath  ⇄  FUSE   ⇄        workspace          ⇄  (this spec)    /workspace
   (Pear-side                                                              (sandbox-side
    RelayfileSetup.                                                          relayfile-mount
    mountWorkspace,                                                          daemon)
    already wired)
```

Today the sandbox side does **not** have the daemon. The agent reads/writes
through relayfile's HTTP API using `RELAYFILE_TOKEN`. After this change, the
daemon presents `/workspace` as a filesystem and the same relayfile workspace
is the source of truth on both ends.

## 1. Pattern to reuse

**`cloud:packages/core/src/executor/executor.ts`** lines 553–642 already
implements daemon-start + flush + stop for relayfile-mount inside a Daytona
sandbox, used by the workflow executor. Mirror this pattern verbatim — do not
reinvent.

The three operations:

| Method | Behaviour |
|---|---|
| `startRelayfileMount(handle, sandboxHome, relayfileToken)` (lines 553–604) | `mkdir -p` the mount point, start daemon with `nohup relayfile-mount --base-url … --workspace … --local-dir … --token … --interval 1s … & echo $!`, capture the daemon PID, then run `--once` synchronously so the initial pull blocks until complete. Returns `{ pid }`. |
| `flushRelayfileMount(handle, sandboxHome, relayfileToken)` (lines 623–642) | One-time `relayfile-mount --once …` to push any local writes to relayfile before the sandbox is torn down. |
| `stopRelayfileMount(handle, sandboxHome, mount, relayfileToken)` (lines 606–621) | `flushRelayfileMount` first (try-finally so flush errors don't skip the kill), then `kill $PID`. |

The shell-quoting helpers live at
**`cloud:packages/core/src/relayfile/mount-script.ts`**:

- `buildRelayfileMountStartShell(opts: RelayfileMountDaemonOptions): string`
  (lines 58–68). Inputs `{ baseUrl, workspaceId, localDir, token, interval?,
  logPath? }`. Returns ready-to-run bash:
  ```bash
  nohup relayfile-mount --base-url '…' --workspace '…' --local-dir '…' \
    --token '…' --interval 1s > /tmp/relayfile-mount.log 2>&1 & echo $!
  ```
- `buildRelayfileMountFlushShell(opts: RelayfileMountShellOptions): string`
  (lines 79–82). Same inputs minus `interval`/`logPath`, returns
  `relayfile-mount --once --base-url '…' --workspace '…' --local-dir '…'
  --token '…'`.

**Daemon binary**: `relayfile-mount` is already preinstalled in the cloud
Daytona snapshot (the snapshot used by `getSnapshotName` from
`@cloud/core/config/snapshot.js`). No `npm install` or binary download step
needed; just invoke directly.

## 2. Insertion point in box-manager.ts

**File**: `cloud:packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager.ts`
**Function**: `prepareSandbox` (around lines 760–798)
**Insertion**: between `mountCliCredentials` (line 777) and `writeBoxEnvFile`
(line 784).

```ts
776  if (credential.authType !== "byo_api_key" && credentialSecret) {
777    await deps.mountCliCredentials(…)
778  }
                                                ← insert mount daemon start here
779  await writeBoxEnvFile(sandbox, home, envVars);
780  const apiKey = deps.deriveBrokerApiKey(…)
781  await ensureBrokerReady(sandbox, home, envVars, apiKey);
```

Ordering rationale:

- **After `mountCliCredentials`**: CLI creds must land before anything else
  invokes the CLI surface; the mount is orthogonal to those creds.
- **Either side of `writeBoxEnvFile` is acceptable** — the daemon doesn't read
  the env file. Placing the start before the env file write keeps the
  conceptual grouping ("set up the box filesystem") together.
- **Before `ensureBrokerReady`**: the broker doesn't depend on the mount, but
  the agent process that the broker spawns does. The daemon's initial `--once`
  sync blocks until the workspace files are pulled — this is the desired
  ordering for the agent's first read against `/workspace`.

## 3. Shared helper — bridging the two runtime shapes

The proactive-runtime PR runs inside a `DaytonaRuntime` abstraction
(`runtime.runScript`, multi-line embedded shell). The cloud-agent box runs
against the raw `DaytonaSandbox` shape (`sandbox.process.executeCommand`).
The mount daemon's actual shell commands are identical; only the executor
differs.

**Recommendation**: extract a shared helper module at
**`cloud:packages/core/src/relayfile/mount-daemon.ts`** (or extend
`mount-script.ts`) exposing an executor-agnostic interface:

```ts
export interface MountDaemonExecutor {
  exec(command: string, opts?: { timeoutSeconds?: number }): Promise<{
    exitCode: number;
    stdout: string;
  }>;
}

export async function startMountDaemon(
  executor: MountDaemonExecutor,
  sandboxHome: string,
  config: RelayfileMountDaemonOptions,
): Promise<{ pid: string | undefined }> { … }

export async function flushMountDaemon(
  executor: MountDaemonExecutor,
  sandboxHome: string,
  config: RelayfileMountShellOptions,
): Promise<void> { … }

export async function stopMountDaemon(
  executor: MountDaemonExecutor,
  sandboxHome: string,
  pid: string,
  config: RelayfileMountShellOptions,
): Promise<void> { … }
```

Both `DaytonaSandbox.process.executeCommand` and
`DaytonaRuntime.runScript`/`exec` adapt to `MountDaemonExecutor` via a thin
wrapper. Land this in the cloud-agent box PR if the proactive-runtime PR
hasn't already extracted it; otherwise consume what they extracted.

## 4. Flush-on-exit hook

The cloud-agent box can be torn down via `stopCloudAgentBox`
(box-manager.ts:992–1031, behind the DELETE route handler). Pending writes
must flush before the sandbox is destroyed, otherwise user-side edits queued
during the last 1s polling window are lost.

Insert the flush **before** `daytona.stop()` / `sandbox.stop?.()` in
`stopCloudAgentBox`:

```ts
const sandbox = await daytona.get(existing.id);

if (deps.flushRelayfileMountOnStop && existing.relayfileToken) {
  try {
    const sandboxHome = (await sandbox.getUserHomeDir?.()) ?? "/home/daytona";
    await deps.flushRelayfileMountOnStop({
      sandbox,
      sandboxHome,
      relayfileToken: existing.relayfileToken,
      mountPaths: existing.mountPaths,
    });
  } catch (err) {
    logger.warn("Failed to flush relayfile mount on stop", { … });
    // do not throw — proceed with sandbox stop
  }
}

if (daytona.stop) { await daytona.stop(sandbox); }
else { await sandbox.stop?.(); }
```

### DB schema decision (choose one)

The flush needs the original mount config to address the right
paths/workspace. Two options:

- **(A) Persist mount context on the `sandboxes` row** — add
  `relayfile_token TEXT NULL` and `relayfile_mount_paths JSONB NOT NULL
  DEFAULT '[]'::jsonb` columns. Populate in `prepareSandbox` →
  `insertSandbox` (around line 899). Cleanest semantics, but requires a
  migration.
- **(B) Re-mint a fresh token on stop** — call `mintRelayfileToken` (the
  helper already in box-manager.ts) right before flush, using the agent's
  current `mountPaths` from the sticky-sandbox row's existing fields. No
  schema change; the trade-off is one extra token mint per stop.

Prefer (B) for the first iteration — smaller blast radius, no migration
coordination. (A) becomes attractive only if we end up needing the original
exact paths for audit reasons.

## 5. Env vars for the daemon

`buildRuntimeEnv` (box-manager.ts:719–758) already sets these into the
sandbox env file; the daemon reads them at startup:

| Var | Source | Used by |
|---|---|---|
| `RELAYFILE_TOKEN` | path-scoped `relay_pa_*` token minted via `mintRelayfileToken` | daemon `--token` |
| `RELAYFILE_MOUNT_PATHS` | JSON array, from `normalizeMountPaths(input.mountPaths)` | daemon `--paths` (or parsed by helper into scoped reads) |
| `RELAYFILE_URL` | `resolveRelayAuthConfig().relayfileUrl` | daemon `--base-url` |
| `RELAYFILE_WORKSPACE` / `RELAYFILE_WORKSPACE_ID` | `input.auth.workspaceId` | daemon `--workspace` |

`--local-dir` is hardcoded `/workspace` for now (matches the convention the
proactive PR uses). Make it overridable via a `DEFAULT_MOUNT_LOCAL_DIR`
constant so future callers can pin a different path without forking the
helper.

## 6. Error surface — graceful degrade vs hard fail

**Recommendation: graceful degrade.** If the mount daemon fails to start, log
a WARN and continue the warm. The broker and agent still work without the
mount because `RELAYFILE_TOKEN` is in the env and the agent SDK falls back to
HTTP-API calls.

```ts
let relayfileMountPid: string | undefined;
try {
  const { pid } = await deps.startRelayfileMount({
    sandbox,
    sandboxHome: home,
    config: {
      baseUrl: relayfile.relayfileUrl,
      workspaceId: input.auth.workspaceId,
      localDir: DEFAULT_MOUNT_LOCAL_DIR,
      token: envVars.RELAYFILE_TOKEN,
      paths: JSON.parse(envVars.RELAYFILE_MOUNT_PATHS ?? "[]"),
    },
  });
  relayfileMountPid = pid;
} catch (err) {
  logger.warn("[cloud-agent-box] relayfile mount startup failed; continuing without FUSE", {
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
    sandboxId: sandbox.id,
    error: err instanceof Error ? err.message : String(err),
  });
}
```

Rationale:

1. Mount is a UX upgrade (filesystem access) on top of a working functional
   layer (HTTP API). Losing FUSE is degradation, not breakage.
2. Mount failures are typically transient (permission/disk/daemon issues).
   Blocking warm on it makes the user retry the whole flow.
3. Broker startup is already a hard-fail; layering another hard-fail on top
   shrinks the operational success rate without proportional benefit.

The contrasting choice (hard-fail) would be appropriate **only** if the box
is later discovered to be unusable without FUSE for some reason we don't yet
have evidence for. Revisit if that emerges.

## 7. Test plan

File: `cloud:packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager.test.ts`

### Updates to existing tests

- **`"warms a box using auth.workspaceId..."`** (line 144) — extend the
  harness mocks: `deps.startRelayfileMount = vi.fn(async () => ({ pid:
  "12345" }))`. Assert it was called with the right config (baseUrl,
  workspaceId, token, localDir, paths).
- **`"PATCH re-scopes mount paths..."`** — assert flush + restart sequence:
  flush is called with the **old** token, then start is called with the new
  token.
- **`"DELETE marks the box stopping..."`** — assert flush is called before
  `daytona.stop()`.

### New test cases

1. **`"gracefully continues if relayfile mount startup fails"`** — make
   `startRelayfileMount` throw, assert: warm returns successfully, WARN is
   logged with the expected shape, broker still starts.
2. **`"flushes relayfile mount before stopping the sandbox"`** — assert
   ordering: `flushRelayfileMount` resolves before `daytona.stop` is called.
3. **`"gracefully continues if relayfile mount flush fails on stop"`** —
   `flushRelayfileMount` throws → WARN logged → `daytona.stop` still called
   → response is `{ status: "stopping" }`.
4. **`"respects interval and logPath overrides in the mount shell"`** —
   unit-level test of the shell builder, asserting the produced string
   includes the expected `--interval` / log-redirect.

### Integration test (separate file or suite)

- Real Daytona sandbox + mocked relayfile API.
- Verify daemon starts, initial sync completes, files appear in
  `/workspace`.
- Edit `/workspace/foo.txt` from sandbox → relayfile sees the write.
- Mock-edit relayfile remotely → daemon syncs it into `/workspace/foo.txt`
  on next interval.
- Flush before stop captures any in-flight writes.

## Critical notes for the implementer

1. **Binary availability** — `relayfile-mount` is in the Daytona snapshot.
   No download/install step needed in box-manager. (Confirmed by the
   proactive-runtime author.)
2. **Token freshness** — path-scoped tokens have ~1h TTL. The flush-on-stop
   path may be hit after the original token is expired. Use the "re-mint on
   stop" approach (§4 option B) so the flush always has a fresh token.
3. **POSIX shell quoting** — never inline values into shell. Use the
   `shellQuote` helper from `mount-script.ts` (or the helpers it exports).
   Tested under POSIX sh, not bash-specific.
4. **Initial sync blocking** — the `--once` sync after daemon start must
   complete before `prepareSandbox` returns. The agent inside the sandbox
   expects `/workspace` populated.
5. **No stdout pollution** — daemon output goes to `/tmp/relayfile-mount.log`
   (or an equivalent path). The `echo $!` after the backgrounded `nohup`
   reliably captures the PID without polluting the parent shell.
6. **Watch the wall budget** — Cloudflare Workers have a hard CPU/wall-time
   limit per request. Adding the mount-start step (which includes a
   blocking `--once` initial sync) lengthens the warm. If the warm starts
   bumping against the limit, this is another reason to move toward the
   async-warm-with-poll architecture (see the parallel discussion on the
   Daytona 524 timeout fix).

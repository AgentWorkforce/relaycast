# Proactive runtime vs workflow executor parity

## Goal

The proactive runtime and the workflow executor both provision a Daytona
sandbox, mount relayfile, run user code, capture output, flush writes, and tear
down the sandbox. They must share primitives wherever possible, and any
intentional sequencing difference must be documented here.

This checklist exists because the two flows drifted across several relayfile and
sandbox behaviors during the #944 -> #1002 recovery chain. Future PRs that
touch one flow without touching the other should get a CI or review nag asking
whether this parity checklist needs an update.

## Code paths

| Flow | Primary owner file | Current shared surface |
|---|---|---|
| Workflow executor | `packages/core/src/executor/executor.ts` | `packages/core/src/relayfile/mount-script.ts`, `LogStreamer`, `WorkflowRuntime` |
| Proactive runtime | `packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts` (`deliverEnvelopeToSandbox`) | `packages/core/src/relayfile/mount-script.ts`, Daytona `runScript` response capture |
| Cloud-agent box sandbox delivery | `packages/web/app/api/v1/workspaces/[workspaceId]/cloud-agents/[cloudAgentId]/box/box-manager.ts` | `packages/core/src/relayfile/mount-script.ts`, Daytona `executeCommand` response capture |

## Required parity touch-points

### Mount daemon launch

- Both flows must call the shared relayfile mount shell builders instead of
  embedding separate `relayfile-mount` invocations.
- The launch command must come from
  `buildRelayfileMountStartShell(...)`.
- The local mount directory must be created before launch.
- Existing stale `relayfile-mount` daemons may be killed before a warm restart,
  but that behavior must be explicit and covered by tests where the flow
  supports warm reuse.
- The initial pull must block before user code reads from the mounted workspace.

### Mount cleanup and flush bounds

- Both flows must flush with `buildRelayfileMountFlushShell(...)`.
- Flushes must be bounded in both flows. If a current call site lacks a timeout,
  the `SandboxOrchestrator` extraction should remove that drift instead of
  copying it.
- If this checklist finds an unbounded flush in either flow, treat it as drift
  to remove during the `SandboxOrchestrator` extraction.
- Cleanup must attempt flush before sandbox stop or teardown.
- Flush failure must not skip teardown. The caller may log and continue when the
  sandbox is already being destroyed.
- Daemon stop must not depend on a successful flush.

### Output capture

- Workflow output must continue flowing through `runtime.exec(...).output` and
  `LogStreamer` for persisted workflow logs.
- Proactive output must come from the Daytona `runScript` or command response,
  not from appending to bundle-uploaded files in the sandbox.
- No flow should redirect handler output to a file that was uploaded as part of
  the code bundle; bundle permissions previously caused `EACCES` failures.
- If a flow adds a new output sink, it must record stdout, stderr, exit code,
  and wall-clock timing with the same semantics as the other flow or document
  why the sink is flow-specific.
- Captured output must preserve stdout/stderr interleave order end-to-end. The
  default orchestrator response path must not expose only a `{ stdout, stderr }`
  split-string shape that loses ordering on reassembly. If a caller needs split
  streams, that must be an explicit opt-in primitive, not the default capture
  result.

### Mount argument shape

- The daemon command must not emit `--paths`, `--remote-path`, or other path
  filter flags unless the installed `relayfile-mount` binary supports them.
- Path restrictions belong in path-scoped relayfile tokens and initial-sync
  helper behavior, not unsupported daemon CLI flags.
- Tests around `buildRelayfileMountPathArgsShell(...)` should remain the shared
  guardrail for this rule.

### Token shape and auth parsing

- Both flows must mint path-scoped `relay_pa_*` relayfile tokens for
  mounted-sandbox auth. Any alternative token shape requires explicit
  justification in this file.
- Cloud-side relayfile auth must parse the same token prefix used by both
  flows.
- Token scope derivation must stay close to the event or agent mount-path
  derivation. Do not create a second ad hoc token format for proactive fires.

### Dependency installation

- Neither flow should run `npm install` on every fire or step just to obtain
  runtime support dependencies that are already present in the Daytona snapshot
  or uploaded bundle.
- If a dependency install remains necessary for a specific CLI or compatibility
  path, gate it behind an explicit preflight and document why cached
  `node_modules` or snapshot contents are insufficient.
- Changes to the snapshot dependency list must be evaluated for both workflow
  steps and proactive fires.

### Bundle upload and writable files

- Uploaded bundle files should be treated as immutable inputs unless a flow has
  verified the target path is writable.
- Runtime-generated logs, mount state, and temporary files belong under `/tmp`,
  the sandbox home, or another known writable path.
- Bundle upload exclusions such as `.git`, `node_modules`, mount state files,
  and large artifacts should stay aligned unless a flow documents a different
  artifact contract.

### Sandbox lifecycle sequencing

- Provision, bundle upload, mount start, user script execution, output capture,
  mount flush, and teardown should be represented as shared primitives.
- The workflow executor and proactive runtime may order those primitives
  differently only when the flow contract requires it.
- Any sequence-specific difference must be documented in this file and covered
  by a focused test or reviewer checklist item.

## Proposed shared primitive

Proposal 1 from #1003 should extract a `SandboxOrchestrator` abstraction with a
small interface around these primitives:

- `provision`
- `uploadBundle`
- `startMount`
- `runScript`
- `captureOutput`
- `flushMount`
- `teardown`

The long-term shape should put implementation details such as Daytona command
execution, shell builders, stdout/stderr normalization, timeout conversion, and
mount cleanup behind the orchestrator. The workflow executor and proactive
runtime should compose the same primitive methods in their required sequence
instead of carrying duplicate helper implementations.

The interface should expose independently callable primitives on a state-holding
orchestrator instance, not only a single full-sequence `run()` method. Callers
must be able to use `startMount` and `flushMount` without opting into
`provision -> uploadBundle -> runScript -> teardown`.

`box-manager.ts` is a recognized third sandbox-delivery surface that uses the
same mount primitives (`startRelayfileMount`, `flushRelayfileMount`, and Daytona
command execution). Adopting it into the first `SandboxOrchestrator` extraction
is deferred per khaliq's scope decision on #1003 (the first extraction stays
2-flow); its follow-up adoption is tracked in cloud#1006. The orchestrator
interface should still be designed so this third caller can adopt `startMount`
and `flushMount` later without taking on the workflow or proactive lifecycle
sequence.

## Cross-flow contract tests

Proposal 2 from #1003 is intentionally blocked until cloud#989 and cloud#990
land. Once unblocked, add contract tests that run a representative workflow step
and a representative proactive fire against the same Daytona snapshot or a fake
runtime with the same command surface. The tests should assert:

- both flows start relayfile mount with the same supported flag set;
- both flows perform a bounded pre-handler sync and bounded flush;
- both flows capture stdout, stderr, exit code, and mount log tail without
  relying on writable bundle files;
- both flows preserve path-scoped token semantics;
- neither flow performs unnecessary per-fire or per-step dependency installs.

## PR checklist

Use this checklist on any PR touching the workflow executor, the proactive
runtime, cloud-agent box sandbox delivery, relayfile mount shell generation, or
Daytona runtime command execution.

- Does the PR touch only one flow? If yes, add a CI/review nag asking whether
  the other flow needs the same change.
- Does the PR change any relayfile mount command? If yes, update or add shared
  tests for `packages/core/src/relayfile/mount-script.ts`.
- Does the PR change timeout handling? If yes, verify both initial sync and
  flush remain bounded in both flows.
- Does the PR change output capture? If yes, verify stdout, stderr, exit code,
  and log persistence semantics are still aligned.
- Does the PR change token minting or parsing? If yes, verify both flows still
  accept path-scoped `relay_pa_*` tokens.
- Does the PR add an install step? If yes, explain why snapshot or cached
  dependencies cannot cover both flows.
- Does the PR modify bundle upload or runtime-generated files? If yes, verify
  logs and mount state write only to known writable paths.
- Does the PR intentionally diverge from this checklist? If yes, document the
  flow-specific reason in this file.

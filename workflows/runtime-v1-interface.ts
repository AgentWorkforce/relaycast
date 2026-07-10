/**
 * runtime-v1-interface.ts
 *
 * Phase 1 of the workflow runtime adapter refactor.
 *
 * Extracts a `WorkflowRuntime` interface so Daytona becomes one of many
 * possible sandbox backends (e2b, freestyle, openclaw, local, EC2, own
 * sandbox, BYO infra). This workflow does NOT add a new backend — it only
 * introduces the abstraction seam and wraps the existing Daytona path
 * behind it. Zero behavior change for production.
 *
 * Files created:
 *   packages/core/src/runtime/types.ts    — WorkflowRuntime interface + types
 *   packages/core/src/runtime/daytona.ts  — DaytonaRuntime adapter
 *   packages/core/src/runtime/index.ts    — public exports
 *
 * Files modified:
 *   packages/core/src/executor/executor.ts           — DaytonaStepExecutor → SandboxedStepExecutor
 *   packages/core/src/bootstrap/script-generator.ts  — construct DaytonaRuntime
 *
 * This workflow MUST run before any other runtime-v{N}-*.ts workflow.
 *
 * Run: agent-relay run workflows/runtime-v1-interface.ts
 */

import { CodexModels, workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('runtime-v1-interface')
    .description('Extract WorkflowRuntime interface; wrap Daytona as first adapter')
    .pattern('dag')
    .channel('wf-runtime-v1')
    .maxConcurrency(4)
    .timeout(2_700_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Architect — designs the WorkflowRuntime interface and reviews shape',
      // Non-interactive headless Codex avoids PTY idle-kill during long
      // plan/reflect prompts while keeping the analyst-style read-only flow.
      preset: 'analyst',
      interactive: false,
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: {
          read: ['packages/core/src/**', 'package.json', 'tsconfig*.json'],
          write: [],
          deny: [],
        },
        exec: [],
      },
    })

    .agent('impl', {
      cli: 'codex',
      role: 'Implementer — writes interface, Daytona adapter, refactors executor',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/core/**', 'package.json', 'tsconfig*.json'],
          write: [
            'packages/core/src/runtime/**',
            'packages/core/src/executor/executor.ts',
            'packages/core/src/bootstrap/script-generator.ts',
          ],
          deny: [
            'packages/core/src/bootstrap/launcher.ts',
            'tests/**',
            '**/*.test.ts',
            '.env*',
            'infra/**',
          ],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'codex',
      role: 'Peer reviewer — independent review of the adapter shape and refactor',
      preset: 'reviewer',
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/core/**'], write: [], deny: [] },
        exec: [],
      },
    })

    // ─── Phase 1: Read context ─────────────────────────────────────────

    .step('read-executor', {
      type: 'deterministic',
      command: 'cat packages/core/src/executor/executor.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-script-generator-slice', {
      type: 'deterministic',
      command: 'sed -n "520,640p" packages/core/src/bootstrap/script-generator.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-sandbox-like', {
      type: 'deterministic',
      command: [
        'echo "=== SandboxLike type ==="',
        'cat packages/core/src/code-sync/types.ts 2>/dev/null || echo "(none)"',
        'echo',
        'echo "=== asSandboxLike adapter ==="',
        'cat packages/core/src/code-sync/sandbox.ts',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-step-executor-iface', {
      type: 'deterministic',
      command:
        'grep -n "StepExecutor\\|executeAgentStep\\|executeDeterministicStep\\|executeIntegrationStep" node_modules/@agent-relay/sdk/dist/workflows/types.d.ts | head -40',
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 2: Plan ─────────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: [
        'read-executor',
        'read-script-generator-slice',
        'read-sandbox-like',
        'read-step-executor-iface',
      ],
      task: `Design the WorkflowRuntime interface for the cloud repo.

Current DaytonaStepExecutor:
{{steps.read-executor.output}}

Current bootstrap wiring around DaytonaStepExecutor:
{{steps.read-script-generator-slice.output}}

Existing SandboxLike (already a partial abstraction):
{{steps.read-sandbox-like.output}}

SDK StepExecutor interface:
{{steps.read-step-executor-iface.output}}

Produce a detailed plan that specifies:

1. **File: packages/core/src/runtime/types.ts** — define and export:

   export type IsolationLevel = 'strong' | 'process' | 'none';

   export interface RuntimeCapabilities {
     pty: boolean;
     snapshots: boolean;
     isolation: IsolationLevel;
     persistentHandle: boolean;
     streamingLogs: boolean;
   }

   export interface LaunchOptions {
     image?: string;
     snapshot?: string;
     language?: 'typescript' | 'python' | 'go' | 'rust' | 'node';
     workdir?: string;
     env?: Record<string, string>;
     label?: string;
   }

   export interface RuntimeHandle {
     id: string;
     homeDir: string;
     metadata?: Record<string, unknown>;
   }

   export interface ExecOptions {
     cwd?: string;
     env?: Record<string, string>;
     timeoutMs?: number;
   }

   export interface ExecResult {
     output: string;
     exitCode: number;
   }

   export interface WorkflowRuntime {
     readonly id: string;
     readonly capabilities: RuntimeCapabilities;
     launch(options: LaunchOptions): Promise<RuntimeHandle>;
     exec(handle: RuntimeHandle, command: string, options?: ExecOptions): Promise<ExecResult>;
     uploadFile(handle: RuntimeHandle, contents: Buffer | string, remotePath: string): Promise<void>;
     downloadFile(handle: RuntimeHandle, remotePath: string): Promise<Buffer>;
     getHomeDir(handle: RuntimeHandle): Promise<string>;
     destroy(handle: RuntimeHandle): Promise<void>;
     // Optional — only implemented if capabilities.pty === true
     openPty?(handle: RuntimeHandle, command: string, options?: ExecOptions): AsyncIterable<Uint8Array>;
   }

2. **File: packages/core/src/runtime/daytona.ts**
   export class DaytonaRuntime implements WorkflowRuntime
   - id: 'daytona'
   - capabilities: { pty: true, snapshots: true, isolation: 'strong', persistentHandle: true, streamingLogs: true }
   - constructor({ daytona: Daytona, snapshot?: string, defaultHomeDir?: string })
   - launch(): Mirrors the current snapshot-first-then-fresh-fallback logic from DaytonaStepExecutor and launcher.ts. Tracks the underlying Sandbox in a WeakMap keyed by RuntimeHandle id so exec/upload/destroy can look it up.
   - exec(): wraps sandbox.process.executeCommand(cmd, cwd, env, timeoutSec). Convert timeoutMs → seconds. Return { output: result, exitCode }.
   - uploadFile/downloadFile: wraps sandbox.fs.uploadFile/downloadFile.
   - getHomeDir(): wraps sandbox.getUserHomeDir() with '/home/daytona' fallback.
   - destroy(): await this.daytona.delete(sandbox) with catch-and-swallow (log only).

3. **File: packages/core/src/runtime/index.ts**
   export * from './types.js';
   export { DaytonaRuntime } from './daytona.js';

4. **Modify: packages/core/src/executor/executor.ts**
   - Rename class DaytonaStepExecutor → SandboxedStepExecutor
   - Replace constructor field daytona: Daytona with runtime: WorkflowRuntime
   - Drop the @daytonaio/sdk import (only runtime.ts needs it)
   - Replace every sandbox.process.executeCommand(...) call with runtime.exec(handle, cmd, { cwd, env, timeoutMs })
   - Replace sandbox.fs.uploadFile(...) with runtime.uploadFile(handle, buf, path)
   - Replace createSandbox() method with a call to runtime.launch({ snapshot: this.snapshot, label: step.name })
   - Replace disposeSandbox() with runtime.destroy(handle)
   - Replace getSandboxHome() with runtime.getHomeDir(handle) — but prefer using handle.homeDir returned from launch
   - Gate the codex --dangerously-bypass workaround on runtime.capabilities.isolation === 'strong'
   - Add at the bottom, for one-release back-compat:
       export { SandboxedStepExecutor as DaytonaStepExecutor };
     and keep the DaytonaStepExecutorOptions type exported. Add an overloaded constructor or options adapter that accepts either { runtime } (new) or { daytona, snapshot } (legacy — internally constructs a DaytonaRuntime). Mark the legacy form @deprecated.

5. **Modify: packages/core/src/bootstrap/script-generator.ts**
   - Where DaytonaStepExecutor is instantiated (search for 'new DaytonaStepExecutor'), add an import for DaytonaRuntime from '../runtime/index.js', construct a DaytonaRuntime({ daytona, snapshot }) first, then pass { runtime, credentials, s3, relayfileUrl, relayfileToken, relayfileWorkspaceId, envSecrets } to SandboxedStepExecutor (use the new class name).
   - Do not alter any other logic in script-generator.ts.

6. **Do NOT touch packages/core/src/bootstrap/launcher.ts.** The bootstrap
   sandbox that the launcher creates stays on the raw Daytona SDK for now.
   Only the per-step sandbox creation path (inside the executor) is being
   abstracted. The launcher-level refactor is a later phase.

End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Phase 3: Self-reflection ──────────────────────────────────────

    .step('reflect', {
      agent: 'lead',
      dependsOn: ['plan'],
      task: `Self-reflect on the plan you just produced.

Your plan:
{{steps.plan.output}}

Challenge yourself honestly on each of these:

1. **exec() signature completeness**: DaytonaStepExecutor today passes env, cwd, and a timeout-in-seconds to sandbox.process.executeCommand. Does the ExecOptions shape in the plan capture everything the existing code path needs? Read the executor output from {{steps.read-executor.output}} again if unsure.

2. **Handle identity**: RuntimeHandle carries { id, homeDir }. Is that enough to re-find the underlying Daytona Sandbox object on later calls? If you use a WeakMap<RuntimeHandle, Sandbox> internal to DaytonaRuntime, does that work across async boundaries?

3. **PTY deferral**: openPty? is optional in the v1 interface and DaytonaRuntime won't implement it in v1. Is that OK given the existing interactive path goes through WorkflowRunner, not the executor? Confirm the interactive path is untouched by this refactor.

4. **Error handling parity**: When runtime.launch() fails, the current code throws. When runtime.destroy() fails, the current code swallows. Does the plan preserve this exactly? Call it out if not.

5. **Back-compat export**: does "export { SandboxedStepExecutor as DaytonaStepExecutor }" actually cover every import site? Consider: is DaytonaStepExecutor imported from outside packages/core/? (If so, the plan needs to cover a re-export from packages/core/src/index.ts.)

6. **Relayfile coupling**: every RELAYFILE_* env var and the relayfile-mount start/stop/flush commands stay in executor.ts. Is that still the right layer, or should they move into runtime? Your answer: STAYS in executor — relayfile is a cross-cutting concern that sits above the runtime abstraction. Confirm this and record the reasoning.

7. **Codex isolation gate**: codex --dangerously-bypass-approvals-and-sandbox is currently unconditional. The plan gates it on capabilities.isolation === 'strong'. For DaytonaRuntime (strong), behavior is unchanged. Is this the right default for future runtimes? Note: yes — weak/none runtimes must NOT pass the bypass flag because codex needs its own sandbox when the outer environment offers no isolation.

8. **Circular import risk**: runtime/daytona.ts → @daytonaio/sdk. executor.ts → runtime/index.ts → runtime/daytona.ts. Is there any cycle? Should runtime/index.ts avoid importing DaytonaRuntime eagerly to keep the core import graph clean? Decide and state.

9. **What wasn't in the plan that should be**: is there any piece of today's DaytonaStepExecutor that the plan forgot? Specifically audit: logStreamer wiring, the exit-code error message, the auth-error detection, the step metadata writing. All of these should be runtime-agnostic and stay in the executor. Confirm.

If the plan needs changes, produce a REVISED plan section with edits called out.
If the plan is sound, say so explicitly and re-confirm each of the 9 points above with a one-line note.

End with REFLECTION_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
    })

    // ─── Phase 4: Implement ────────────────────────────────────────────

    .step('implement', {
      agent: 'impl',
      dependsOn: ['reflect'],
      task: `Implement the runtime adapter refactor.

Plan:
{{steps.plan.output}}

Reflection (follow any revisions here verbatim — they override the plan):
{{steps.reflect.output}}

Create these files (write to disk, full path from project root):
- packages/core/src/runtime/types.ts
- packages/core/src/runtime/daytona.ts
- packages/core/src/runtime/index.ts

Modify these files (apply minimal diffs — do not rewrite unchanged code):
- packages/core/src/executor/executor.ts
- packages/core/src/bootstrap/script-generator.ts

Do NOT touch:
- packages/core/src/bootstrap/launcher.ts
- any test file or __tests__ directory
- any package.json
- any .env file
- infra/**

Hard rules:
1. Every file you create or modify is written to disk. Do not print file contents to stdout.
2. Preserve the existing relayfile-mount daemon logic verbatim (runtime-agnostic; just call runtime.exec instead of sandbox.process.executeCommand).
3. Preserve the codex --dangerously-bypass-approvals-and-sandbox workaround but gate it on runtime.capabilities.isolation === 'strong'.
4. Preserve snapshot-first-fallback-to-fresh behavior — move it inside DaytonaRuntime.launch().
5. Export both class names from executor.ts:
      export class SandboxedStepExecutor implements StepExecutor { ... }
      export { SandboxedStepExecutor as DaytonaStepExecutor };
6. DaytonaStepExecutorOptions stays exported under its original name. The internal shape takes { runtime: WorkflowRuntime, ... } but the constructor accepts either the new or legacy shape (legacy: { daytona, snapshot }) and normalizes internally. Mark the legacy form @deprecated.
7. If packages/core/src/index.ts currently re-exports DaytonaStepExecutor, keep that export working (it will pick up the back-compat alias automatically).

Do not run any build or type-check commands — a deterministic step handles that.`,
      verification: { type: 'file_exists', value: 'packages/core/src/runtime/types.ts' },
    })

    // ─── Phase 5: Self-review ──────────────────────────────────────────

    .step('self-review', {
      agent: 'impl',
      dependsOn: ['implement'],
      task: `Self-review the code you just wrote.

Re-read every file you created or modified:
- packages/core/src/runtime/types.ts
- packages/core/src/runtime/daytona.ts
- packages/core/src/runtime/index.ts
- packages/core/src/executor/executor.ts (only the parts you changed)
- packages/core/src/bootstrap/script-generator.ts (only the parts you changed)

Checklist:
1. Every method declared on WorkflowRuntime has a matching implementation in DaytonaRuntime.
2. SandboxedStepExecutor no longer imports from '@daytonaio/sdk' anywhere in the file.
3. Every sandbox.process.executeCommand / sandbox.fs.uploadFile call in executor.ts is gone — replaced by runtime.exec / runtime.uploadFile.
4. The back-compat export "export { SandboxedStepExecutor as DaytonaStepExecutor }" is present at the bottom of executor.ts.
5. script-generator.ts constructs a DaytonaRuntime and passes it to the executor.
6. No stray TODO or half-finished function. No placeholder strings like "...".
7. TypeScript imports are complete and correct. All imports use .js extensions per the repo convention.
8. The codex isolation gate reads runtime.capabilities.isolation === 'strong' (not a hardcoded true).
9. LogStreamer wiring, auth-error detection, metadata writing are preserved verbatim.

If you find ANY issue, FIX IT NOW by editing the file. Do not just list issues.

End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    // ─── Phase 6: Deterministic build verification ─────────────────────

    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: [
        'echo "=== tsc --noEmit on packages/core ==="',
        'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tee /tmp/runtime-v1-tsc.log | head -300',
        'echo',
        'echo "=== error count ==="',
        'grep -c "error TS" /tmp/runtime-v1-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-build', {
      agent: 'impl',
      dependsOn: ['verify-build'],
      task: `Below is the output of "tsc --noEmit" on packages/core after your implementation:

{{steps.verify-build.output}}

If there are TypeScript errors, FIX THEM now by editing the affected files on disk. Focus on:
- Missing type imports
- Incorrect method signatures between WorkflowRuntime and DaytonaRuntime
- Type mismatches at call sites in executor.ts

Only edit files inside your write allowlist (packages/core/src/runtime/**, packages/core/src/executor/executor.ts, packages/core/src/bootstrap/script-generator.ts).

If there are no errors (no line contains "error TS"), output NO_FIX_NEEDED and stop.

Do not run tsc yourself — the next deterministic step re-runs it.`,
      verification: { type: 'exit_code' },
    })

    .step('re-verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: 'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-no-daytona-leak', {
      type: 'deterministic',
      dependsOn: ['re-verify-build'],
      command: [
        'echo "=== @daytonaio/sdk imports outside runtime/ and bootstrap/ ==="',
        'grep -rn "from .@daytonaio/sdk." packages/core/src | grep -v "runtime/daytona.ts" | grep -v "bootstrap/launcher.ts" | grep -v "bootstrap/script-generator.ts" || echo "CLEAN"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 7: Peer review ──────────────────────────────────────────

    .step('peer-review', {
      agent: 'reviewer',
      dependsOn: ['re-verify-build', 'verify-no-daytona-leak'],
      task: `Peer-review the runtime adapter refactor.

Build check output (must be clean):
{{steps.re-verify-build.output}}

Daytona SDK leak check:
{{steps.verify-no-daytona-leak.output}}

Read these files end-to-end:
- packages/core/src/runtime/types.ts
- packages/core/src/runtime/daytona.ts
- packages/core/src/runtime/index.ts
- packages/core/src/executor/executor.ts
- packages/core/src/bootstrap/script-generator.ts

Verify:
1. The WorkflowRuntime interface is coherent and minimal — no method is speculative.
2. DaytonaRuntime is a thin adapter — no business logic beyond mapping SDK shapes.
3. SandboxedStepExecutor is runtime-agnostic — the only runtime-specific branch is the capabilities.isolation === 'strong' gate.
4. Back-compat export is present and functional.
5. Relayfile logic is preserved (spot-check startRelayfileMount, stopRelayfileMount, flushRelayfileMount).
6. No behavior changed for production — running with DaytonaRuntime must be observationally identical to the old DaytonaStepExecutor.
7. The import graph is clean (runtime/ does not import from executor/, executor/ imports from runtime/).

Produce a verdict: APPROVED or CHANGES_REQUESTED with a bulleted list of required changes.

End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);

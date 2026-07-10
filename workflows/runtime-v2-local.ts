/**
 * runtime-v2-local.ts
 *
 * Phase 2 of the workflow runtime adapter refactor.
 *
 * Adds a LocalRuntime adapter that executes agent steps directly on the
 * host machine using child_process.spawn and Node's fs module. No isolation.
 * Intended for:
 *   - Local development loop (no Daytona round-trip)
 *   - CI tests of workflows themselves
 *   - Stress-testing the WorkflowRuntime interface against a minimal backend
 *
 * Security: LocalRuntime sets capabilities.isolation === 'none'. This MUST
 * propagate to the codex bypass gate in SandboxedStepExecutor — when running
 * locally, codex should use its OWN internal sandbox because the host offers
 * no outer isolation.
 *
 * Files created:
 *   packages/core/src/runtime/local.ts
 *
 * Files modified:
 *   packages/core/src/runtime/index.ts  (add LocalRuntime export)
 *
 * Prerequisite: runtime-v1-interface.ts must have been merged.
 *
 * Run: agent-relay run workflows/runtime-v2-local.ts
 */

import { CodexModels, workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('runtime-v2-local')
    .description('Add LocalRuntime adapter (child_process-based, no isolation)')
    .pattern('dag')
    .channel('wf-runtime-v2')
    .maxConcurrency(4)
    .timeout(1_800_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Architect — plans the LocalRuntime adapter shape',
      // Non-interactive headless Codex avoids PTY idle-kill during long
      // plan/reflect prompts while keeping the analyst-style read-only flow.
      preset: 'analyst',
      interactive: false,
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/core/src/runtime/**', 'packages/core/src/executor/**'], write: [], deny: [] },
        exec: [],
      },
    })

    .agent('impl', {
      cli: 'codex',
      role: 'Implementer — writes LocalRuntime',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/core/**', 'package.json', 'tsconfig*.json'],
          write: ['packages/core/src/runtime/local.ts', 'packages/core/src/runtime/index.ts'],
          deny: ['packages/core/src/runtime/types.ts', 'packages/core/src/runtime/daytona.ts', 'tests/**', '.env*'],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'codex',
      role: 'Peer reviewer — checks adapter shape + security implications',
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

    .step('read-runtime-types', {
      type: 'deterministic',
      command: 'cat packages/core/src/runtime/types.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-daytona-runtime', {
      type: 'deterministic',
      command: 'cat packages/core/src/runtime/daytona.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-runtime-index', {
      type: 'deterministic',
      command: 'cat packages/core/src/runtime/index.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 2: Plan ─────────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-runtime-types', 'read-daytona-runtime', 'read-runtime-index'],
      task: `Design a LocalRuntime adapter that implements WorkflowRuntime.

Interface:
{{steps.read-runtime-types.output}}

Existing DaytonaRuntime (reference):
{{steps.read-daytona-runtime.output}}

Current runtime/index.ts:
{{steps.read-runtime-index.output}}

Specify:

1. **File: packages/core/src/runtime/local.ts**

   export class LocalRuntime implements WorkflowRuntime
   id: 'local'
   capabilities: {
     pty: true,
     snapshots: false,
     isolation: 'none',
     persistentHandle: true,
     streamingLogs: true,
   }

   Constructor options:
     { rootDir?: string }   // default: os.tmpdir() + a unique subdir
     { inheritEnv?: boolean } // default: true
     { shell?: string }       // default: /bin/bash on *nix, cmd on win

   launch(opts):
     - Create a unique working directory under rootDir (e.g. rootDir/local-{random})
     - If opts.workdir is passed, mkdir -p it inside the sandbox dir
     - Return RuntimeHandle { id: the dir, homeDir: the dir }
     - Snapshot is ignored (log a warn if opts.snapshot is set)
     - Language is ignored (local host has whatever it has)

   exec(handle, command, { cwd, env, timeoutMs }):
     - Use child_process.spawn with shell: true
     - cwd defaults to handle.homeDir
     - env merges process.env (if inheritEnv) + options.env
     - Capture stdout + stderr into a single 'output' string (preserve ordering)
     - timeoutMs implemented via AbortController + setTimeout
     - Return { output, exitCode }. If the process was killed by timeout, exitCode = 124 and append '\\n[timeout after Nms]' to output.

   uploadFile(handle, contents, remotePath):
     - Resolve remotePath against handle.homeDir if not absolute
     - fs/promises mkdir(dirname, recursive) + writeFile(contents)

   downloadFile(handle, remotePath):
     - Resolve against handle.homeDir if relative
     - fs/promises readFile → Buffer

   getHomeDir(handle): returns handle.homeDir

   destroy(handle):
     - fs/promises rm(handle.homeDir, { recursive: true, force: true })
     - Swallow errors (log only)

   openPty is OPTIONAL — for v2, do NOT implement it. LocalRuntime can
   add it later via node-pty; the optional method keeps capabilities.pty
   accurate without forcing a new dep. Either set pty: false in v2 or
   document that pty: true but openPty is not yet implemented so callers
   should fall back to exec(). PICK pty: false for v2 to keep the
   capability flag honest. Update the plan accordingly.

2. **Modify: packages/core/src/runtime/index.ts**
   Add: export { LocalRuntime } from './local.js';

3. **Dependencies**
   LocalRuntime uses only Node built-ins: node:child_process, node:fs/promises,
   node:path, node:os, node:crypto. No new package.json deps.

4. **Security notes to include as a header comment in local.ts**
   - "NO ISOLATION — do not run untrusted code"
   - "isolation: 'none' — SandboxedStepExecutor will NOT strip codex's internal sandbox gate"
   - "Intended for dev loop and CI tests only"

End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Phase 3: Self-reflection ──────────────────────────────────────

    .step('reflect', {
      agent: 'lead',
      dependsOn: ['plan'],
      task: `Self-reflect on the LocalRuntime plan.

Your plan:
{{steps.plan.output}}

Challenge yourself:

1. **Timeout correctness**: spawn + AbortController — does killing the spawned process also kill its children (e.g. a shell that forks another process)? On Linux you need { detached: true, ...process.kill(-pid) } or similar. Clarify the plan.

2. **stdout/stderr interleaving**: Merging both streams into a single 'output' can scramble order. Is the existing DaytonaStepExecutor contract "output is the terminal output" or "output is just stdout"? Check. For parity with Daytona (which bundles everything in 'result'), interleaving is correct but warn about order.

3. **Environment leakage**: inheritEnv: true means host env vars (including AWS creds, user tokens) leak into the step process. This matches Daytona-like behavior (explicit env wins, but inherited host env is the base) only if the executor already merges exhaustively. Confirm the executor passes a complete env dict every call — if it does, LocalRuntime should default inheritEnv: false to prevent accidental leakage.

4. **rootDir cleanup**: If the process crashes before destroy(), the local rootDir leaks. Should LocalRuntime register a process.on('exit') cleanup hook, or is that a footgun (can't await async cleanup in exit handlers)? Call it out; probably NO cleanup hook, just document the leak.

5. **Cross-platform**: Does the plan work on Windows? shell: true + forward-slash paths + /bin/bash defaults — Windows will break. For v2, document that LocalRuntime is POSIX-only (macOS + Linux) and throw with a clear message on win32 in the constructor.

6. **Codex isolation gate**: LocalRuntime reports isolation: 'none'. SandboxedStepExecutor (from v1) gates the --dangerously-bypass flag on isolation === 'strong'. When isolation is 'none', codex keeps its internal sandbox — which is exactly what we want. Confirm this flows through correctly by re-reading v1's gate in executor.ts.

7. **Home dir semantics**: RuntimeHandle.homeDir on Daytona is the user's home dir INSIDE the sandbox. On LocalRuntime, is the "home dir" the ephemeral rootDir (project-like sandbox) or os.homedir() (the real host home)? You want the ephemeral dir — because the executor writes CLI credential files there (~/.claude/credentials.json) and you DO NOT want those to land in the user's real home. Double-check this decision.

8. **inheritEnv default again**: given (7), the CLI credential mounting writes to handle.homeDir/.claude/credentials.json. If inheritEnv: true, the existing CLAUDE_CONFIG env var (pointing at real host ~/.claude) would fight with the sandbox-local credentials. Default inheritEnv: false and let the executor explicitly pass env vars it needs.

Produce revisions where needed. End with REFLECTION_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
    })

    // ─── Phase 4: Implement ────────────────────────────────────────────

    .step('implement', {
      agent: 'impl',
      dependsOn: ['reflect'],
      task: `Implement LocalRuntime.

Plan:
{{steps.plan.output}}

Reflection (overrides the plan where they conflict):
{{steps.reflect.output}}

Create:
- packages/core/src/runtime/local.ts

Modify:
- packages/core/src/runtime/index.ts  (add LocalRuntime export)

Hard rules:
1. Write the file to disk; do not print to stdout.
2. Use only Node built-ins — no new npm deps.
3. inheritEnv default: false. Document why in a comment near the constructor.
4. Windows: constructor throws on process.platform === 'win32' with a clear message.
5. Include a top-of-file header comment with the security notes from the plan.
6. Implement timeout via AbortController + detached spawn + process.kill(-pid, 'SIGKILL') on *nix.
7. capabilities.pty: false for v2. openPty is not implemented. Add a JSDoc comment explaining that node-pty can add this in a later version.
8. Do not edit packages/core/src/runtime/types.ts or daytona.ts — the interface is already frozen in v1.

Do not run build or test commands — a deterministic step handles verification.`,
      verification: { type: 'file_exists', value: 'packages/core/src/runtime/local.ts' },
    })

    // ─── Phase 5: Self-review ──────────────────────────────────────────

    .step('self-review', {
      agent: 'impl',
      dependsOn: ['implement'],
      task: `Self-review local.ts and the updated index.ts.

Checklist:
1. LocalRuntime implements every method on WorkflowRuntime — types.ts is the contract.
2. capabilities object matches the plan (pty: false, snapshots: false, isolation: 'none', persistentHandle: true, streamingLogs: true).
3. Windows guard in constructor is present.
4. Timeout uses detached spawn + process.kill(-pid) on *nix.
5. Security header comment is present at the top of local.ts.
6. inheritEnv defaults to false.
7. destroy() does NOT rm a dir that wasn't created by LocalRuntime (safety: reject if homeDir === os.homedir() or any path not under rootDir).
8. index.ts exports LocalRuntime.
9. No TODO, no placeholder strings, no "// ..." elisions.
10. All imports use .js extensions.

Fix any issue you find by editing the file. Do not just list issues.

End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    // ─── Phase 6: Deterministic build verification ─────────────────────

    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: [
        'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tee /tmp/runtime-v2-tsc.log | head -200',
        'echo',
        'grep -c "error TS" /tmp/runtime-v2-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-build', {
      agent: 'impl',
      dependsOn: ['verify-build'],
      task: `TypeScript check output:

{{steps.verify-build.output}}

If there are "error TS" lines, fix them by editing packages/core/src/runtime/local.ts or packages/core/src/runtime/index.ts on disk.

If no errors, output NO_FIX_NEEDED and stop.`,
      verification: { type: 'exit_code' },
    })

    .step('re-verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: 'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 7: Peer review ──────────────────────────────────────────

    .step('peer-review', {
      agent: 'reviewer',
      dependsOn: ['re-verify-build'],
      task: `Peer-review LocalRuntime.

Read:
- packages/core/src/runtime/local.ts
- packages/core/src/runtime/index.ts

Review for:
1. **Interface fidelity**: every method on WorkflowRuntime is implemented with correct signatures.
2. **Security**: isolation: 'none' is honest; no claims of pty/snapshots it can't back up. Windows is gated. destroy() has a safety check against nuking real home dir.
3. **Process lifecycle**: timeout kills process groups, not just the top-level process.
4. **Cleanup**: destroy() removes the sandbox dir completely; no partial state.
5. **Env handling**: inheritEnv: false by default is documented; comment explains the reasoning tied to CLI credential isolation.
6. **No silent failures**: exec errors are either thrown or returned in the exitCode, never swallowed.
7. **Build is clean** — confirm from the re-verify-build step upstream.

Output APPROVED or CHANGES_REQUESTED with a bulleted list.

End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);

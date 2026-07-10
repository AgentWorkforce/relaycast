/**
 * runtime-v3-e2b.ts
 *
 * Phase 3 of the workflow runtime adapter refactor.
 *
 * Adds an E2BRuntime adapter using e2b.dev — a serverless sandbox provider
 * with ~150ms cold starts, templates (analogous to Daytona snapshots), and
 * a JS SDK with commands.run / files.write / files.read / sandbox.kill.
 *
 * Why e2b: it's the closest match to Daytona's model, has the best cold-start
 * economics in its class, and proves the WorkflowRuntime interface survives
 * a real second provider.
 *
 * Key constraint: the relayfile-mount binary must be baked into the e2b
 * template, otherwise the executor's startRelayfileMount call will fail.
 * This workflow also creates a small e2b template spec file documenting
 * the image requirements — the actual template build is a separate ops task.
 *
 * Files created:
 *   packages/core/src/runtime/e2b.ts
 *   infra/e2b/template.json          — e2b template manifest (docs only for v3)
 *   infra/e2b/README.md               — how to build + publish the template
 *
 * Files modified:
 *   packages/core/src/runtime/index.ts   — add E2BRuntime export
 *   packages/core/package.json           — add e2b dep (by agent via file edit)
 *
 * Prerequisite: runtime-v1-interface.ts must have been merged.
 *
 * Run: agent-relay run workflows/runtime-v3-e2b.ts
 */

import { CodexModels, workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('runtime-v3-e2b')
    .description('Add E2BRuntime adapter using e2b.dev SDK')
    .pattern('dag')
    .channel('wf-runtime-v3')
    .maxConcurrency(4)
    .timeout(2_400_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Architect — maps e2b SDK onto WorkflowRuntime interface',
      // Non-interactive headless Codex avoids PTY idle-kill during long
      // plan/reflect prompts while keeping the analyst-style read-only flow.
      preset: 'analyst',
      interactive: false,
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: {
          read: ['packages/core/src/runtime/**', 'packages/core/src/executor/**', 'packages/core/package.json'],
          write: [],
          deny: [],
        },
        exec: [],
      },
    })

    .agent('impl', {
      cli: 'codex',
      role: 'Implementer — writes E2BRuntime and template manifest',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/core/**', 'package.json', 'tsconfig*.json'],
          write: [
            'packages/core/src/runtime/e2b.ts',
            'packages/core/src/runtime/index.ts',
            'packages/core/package.json',
            'infra/e2b/**',
          ],
          deny: [
            'packages/core/src/runtime/types.ts',
            'packages/core/src/runtime/daytona.ts',
            'packages/core/src/runtime/local.ts',
            'tests/**',
            '.env*',
          ],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'codex',
      role: 'Peer reviewer — checks SDK wiring and template manifest',
      preset: 'reviewer',
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/core/**', 'infra/**'], write: [], deny: [] },
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

    .step('read-package-json', {
      type: 'deterministic',
      command: 'cat packages/core/package.json',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-relayfile-mount-usage', {
      type: 'deterministic',
      command: 'grep -n "relayfile-mount" packages/core/src/executor/executor.ts',
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 2: Plan ─────────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-runtime-types', 'read-daytona-runtime', 'read-package-json', 'read-relayfile-mount-usage'],
      task: `Design an E2BRuntime adapter.

WorkflowRuntime interface:
{{steps.read-runtime-types.output}}

DaytonaRuntime reference:
{{steps.read-daytona-runtime.output}}

Current packages/core/package.json:
{{steps.read-package-json.output}}

relayfile-mount call sites in executor (these must work on e2b):
{{steps.read-relayfile-mount-usage.output}}

## e2b SDK summary

Package: 'e2b' (main SDK) — import { Sandbox } from 'e2b'

  Sandbox.create(template?: string, opts?: { apiKey?, timeoutMs?, envs?, metadata? }): Promise<Sandbox>
  sandbox.commands.run(cmd: string, opts?: { cwd?, envs?, timeoutMs?, user? }): Promise<CommandResult>
     → CommandResult { stdout, stderr, exitCode, error? }
  sandbox.files.write(path: string, data: string | Buffer | Uint8Array): Promise<EntryInfo>
  sandbox.files.read(path: string, opts?: { format: 'text' | 'bytes' | 'stream' }): Promise<string | Uint8Array>
  sandbox.kill(): Promise<boolean>
  sandbox.sandboxId: string
  Sandbox.connect(sandboxId: string, opts?): Promise<Sandbox>  // re-attach

Environment: E2B_API_KEY env var (or passed via opts.apiKey).

Templates: built via e2b CLI, referenced by template id or name. Default
template 'base' has Node + Python but NOT relayfile-mount. We need a
custom template 'relay-orchestrator-e2b-v1' that is a superset of
relayfile-mount + the orchestrator deps. For v3 we DOCUMENT the template
in infra/e2b/ but do not build it here (ops task).

## Plan

1. **File: packages/core/src/runtime/e2b.ts**

   export class E2BRuntime implements WorkflowRuntime
   id: 'e2b'
   capabilities: {
     pty: false,               // e2b has pty via commands.run stdin but v3 won't wire it
     snapshots: true,          // e2b templates
     isolation: 'strong',      // firecracker microVMs
     persistentHandle: true,
     streamingLogs: true,
   }

   Constructor options:
     {
       apiKey?: string;           // falls back to process.env.E2B_API_KEY
       template?: string;         // default: process.env.E2B_TEMPLATE || 'relay-orchestrator-e2b-v1'
       defaultTimeoutMs?: number; // default: 5 * 60 * 1000
     }

   Internal state: a Map<RuntimeHandle.id, Sandbox> — because e2b Sandbox
   instances are separate from RuntimeHandle records. Use sandbox.sandboxId
   as the RuntimeHandle.id for symmetry.

   launch(opts):
     - template = opts.snapshot || this.template
     - envs = opts.env
     - sandbox = await Sandbox.create(template, { apiKey: this.apiKey, envs, metadata: { label: opts.label } })
     - homeDir = await this.detectHomeDir(sandbox) → run "echo $HOME" via commands.run, default '/home/user' on failure
     - handle = { id: sandbox.sandboxId, homeDir, metadata: { template } }
     - Store sandbox in the map keyed by handle.id
     - Return handle

   exec(handle, cmd, { cwd, env, timeoutMs }):
     - sandbox = this.map.get(handle.id) || throw 'unknown handle'
     - result = await sandbox.commands.run(cmd, { cwd: cwd ?? handle.homeDir, envs: env, timeoutMs: timeoutMs ?? this.defaultTimeoutMs })
     - Return { output: (result.stdout || '') + (result.stderr ? '\\n' + result.stderr : ''), exitCode: result.exitCode ?? 0 }
     - Catch CommandExitError from e2b and return { output: err.stdout + err.stderr, exitCode: err.exitCode } — DaytonaStepExecutor expects non-zero exit to be a return value, not a throw.

   uploadFile(handle, contents, remotePath):
     - sandbox.files.write(remotePath, contents)
     - If remotePath is relative, prefix with handle.homeDir

   downloadFile(handle, remotePath):
     - const bytes = await sandbox.files.read(remotePath, { format: 'bytes' })
     - return Buffer.from(bytes)

   getHomeDir(handle): return handle.homeDir

   destroy(handle):
     - sandbox = this.map.get(handle.id)
     - if (sandbox) await sandbox.kill().catch(log)
     - this.map.delete(handle.id)

2. **File: infra/e2b/template.json**
   A minimal e2b template manifest (JSON). Document the required contents:
     - Base: ubuntu 22.04 or e2b 'base'
     - Pre-installed: node (>= 20), git, curl, python3, jq
     - Pre-installed: relayfile-mount binary at /usr/local/bin/relayfile-mount
     - Pre-installed: claude, codex, gemini, aider CLIs (same set as Daytona snapshot)
     - Working dir: /home/user

3. **File: infra/e2b/README.md**
   Step-by-step instructions:
     - Install e2b CLI (npm i -g @e2b/cli)
     - e2b auth login
     - cd infra/e2b
     - e2b template build --name relay-orchestrator-e2b-v1
     - Set E2B_TEMPLATE=relay-orchestrator-e2b-v1 and E2B_API_KEY in the environment for any process using E2BRuntime

4. **Modify: packages/core/src/runtime/index.ts**
   Add: export { E2BRuntime } from './e2b.js';

5. **Modify: packages/core/package.json**
   Add to "dependencies": "e2b": "^1.0.0"
   (Exact version: agent should read the e2b SDK latest from https://www.npmjs.com/package/e2b if accessible, otherwise default to "^1.0.0")

End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Phase 3: Self-reflection ──────────────────────────────────────

    .step('reflect', {
      agent: 'lead',
      dependsOn: ['plan'],
      task: `Self-reflect on the E2BRuntime plan.

Plan:
{{steps.plan.output}}

Challenges:

1. **Error semantics parity**: Daytona's sandbox.process.executeCommand returns { exitCode, result } whether exit is 0 or not — no throw. e2b's commands.run THROWS CommandExitError on non-zero. The plan catches that and normalizes to a return. Double-check that CommandExitError is the actual e2b class name; if not, use instanceof check + a fallback try/catch that looks for .exitCode on the error object.

2. **Relayfile-mount availability**: the executor calls 'nohup relayfile-mount ...' inside the sandbox. If the binary isn't in the e2b template, every step will fail. The plan documents this in infra/e2b/README but doesn't enforce it. Should E2BRuntime do a preflight check on launch — e.g. exec 'which relayfile-mount' — and throw a clear error if missing? YES. Add this to the plan: after launch, run 'command -v relayfile-mount' and throw "E2B template {name} is missing relayfile-mount binary — rebuild per infra/e2b/README.md" if exit != 0.

3. **PTY gap**: capabilities.pty: false means this runtime can't host interactive WorkflowRunner (Claude PTY mode). That's acceptable for v3 — non-interactive agents (codex exec, claude -p) work fine. Document in the class JSDoc that interactive Claude sessions must use DaytonaRuntime until E2BRuntime grows PTY support via commands.run with stdin/stdout streams.

4. **File path resolution**: DaytonaStepExecutor uploads files using absolute paths. e2b's files.write accepts absolute paths. Is there anywhere in the executor that passes a relative path? If yes, the plan's "prefix with handle.homeDir" handles it; if no, that branch is dead code — keep it anyway for safety.

5. **Template caching**: every launch creates a new Sandbox, even if the same template is used repeatedly. e2b's billing is per-second per-sandbox, so N steps = N sandboxes = N cold starts (~150ms each). Is there a way to reuse a single sandbox across steps in the same workflow? Yes — capabilities.persistentHandle: true signals this, but the executor today calls runtime.destroy at the end of each step. A later optimization can teach SandboxedStepExecutor to reuse handles when capabilities.persistentHandle is true AND the step allows it. Do NOT implement this in v3 — just note it in the JSDoc as a follow-up.

6. **Dependency version**: the plan says "^1.0.0". e2b is an active project; double-check this is reasonable. If the agent implementing can inspect node_modules or a recent package-lock, prefer the exact version already present in the monorepo. Otherwise, default to a recent major.

7. **Env var bleed**: the plan passes env via Sandbox.create opts.envs AND via commands.run opts.envs. e2b layers these. Is there a conflict? No — Sandbox.create envs are the sandbox baseline, commands.run envs override per-command. That's correct. Confirm.

End with REFLECTION_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
    })

    // ─── Phase 4: Implement ────────────────────────────────────────────

    .step('implement', {
      agent: 'impl',
      dependsOn: ['reflect'],
      task: `Implement E2BRuntime.

Plan:
{{steps.plan.output}}

Reflection (overrides where they conflict):
{{steps.reflect.output}}

Create these files (write to disk, full path):
- packages/core/src/runtime/e2b.ts
- infra/e2b/template.json
- infra/e2b/README.md

Modify:
- packages/core/src/runtime/index.ts  (add E2BRuntime export)
- packages/core/package.json            (add "e2b" dependency)

Hard rules:
1. The class implements WorkflowRuntime exactly — no extra public methods.
2. capabilities exactly as specified in the plan (pty: false, snapshots: true, isolation: 'strong', persistentHandle: true, streamingLogs: true).
3. Add a preflight check in launch() that runs "command -v relayfile-mount" and throws a clear error message if the binary is missing.
4. Wrap the commands.run call in try/catch and normalize CommandExitError (or any error with .exitCode) into a returned { output, exitCode } — never let a non-zero exit throw from E2BRuntime.exec().
5. JSDoc on the class: mention "No interactive PTY support in v3 — use DaytonaRuntime for interactive Claude sessions" and "Persistent handle optimization (reuse across steps) is a follow-up — SandboxedStepExecutor currently destroys after each step".
6. infra/e2b/template.json is a valid JSON manifest even if the exact schema isn't finalized — use reasonable keys (name, base, setup, env, entrypoint).
7. infra/e2b/README.md is markdown with clear numbered steps to build + publish the template.
8. Do not modify packages/core/src/runtime/types.ts, daytona.ts, or local.ts.

Do not run build or test commands.`,
      verification: { type: 'file_exists', value: 'packages/core/src/runtime/e2b.ts' },
    })

    // ─── Phase 5: Self-review ──────────────────────────────────────────

    .step('self-review', {
      agent: 'impl',
      dependsOn: ['implement'],
      task: `Self-review the E2B adapter.

Re-read:
- packages/core/src/runtime/e2b.ts
- packages/core/src/runtime/index.ts
- packages/core/package.json
- infra/e2b/template.json
- infra/e2b/README.md

Checklist:
1. Every WorkflowRuntime method is implemented with the right signature.
2. launch() does the relayfile-mount preflight check and throws a clear error.
3. exec() never throws on non-zero exit — it returns { output, exitCode }.
4. capabilities object matches the plan.
5. index.ts has the E2BRuntime export.
6. package.json has the e2b dep in "dependencies" (not "devDependencies").
7. infra/e2b/template.json is valid JSON (you can mentally parse it).
8. infra/e2b/README.md has at least: install CLI, auth, build template, env vars to set.
9. No stray imports, no TODO, no "// ..." elisions.

Fix anything broken by editing on disk. End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    // ─── Phase 6: Deterministic verification ───────────────────────────

    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: [
        'echo "=== tsc --noEmit ==="',
        'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tee /tmp/runtime-v3-tsc.log | head -200',
        'echo',
        'echo "=== tsc error count (e2b missing dep errors are expected until npm install) ==="',
        'grep -c "error TS" /tmp/runtime-v3-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('verify-template-json', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: 'node -e "JSON.parse(require(\'fs\').readFileSync(\'infra/e2b/template.json\',\'utf8\')); console.log(\'JSON_VALID\')"',
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-package-json', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: 'node -e "const p=require(\'./packages/core/package.json\'); if(!p.dependencies || !p.dependencies.e2b){ process.exit(1); } console.log(\'e2b dep:\', p.dependencies.e2b)"',
      captureOutput: true,
      failOnError: true,
    })

    .step('fix-build', {
      agent: 'impl',
      dependsOn: ['verify-build', 'verify-template-json', 'verify-package-json'],
      task: `TypeScript check output:

{{steps.verify-build.output}}

Template JSON check:
{{steps.verify-template-json.output}}

Package.json check:
{{steps.verify-package-json.output}}

Rules for fixing:
- Errors referencing "Cannot find module 'e2b'" or "Cannot find type definitions for 'e2b'" are EXPECTED (the dep is declared but not installed in this checkout). Do NOT try to fix these. Leave them.
- Errors in e2b.ts that are NOT about the missing 'e2b' module (e.g. interface mismatch with WorkflowRuntime, wrong return types, missing methods) — fix them.
- Errors in any other file — fix them.

If no non-dep errors exist, output NO_FIX_NEEDED.`,
      verification: { type: 'exit_code' },
    })

    // ─── Phase 7: Peer review ──────────────────────────────────────────

    .step('peer-review', {
      agent: 'reviewer',
      dependsOn: ['fix-build'],
      task: `Peer-review the E2BRuntime adapter.

Read:
- packages/core/src/runtime/e2b.ts
- infra/e2b/template.json
- infra/e2b/README.md
- packages/core/src/runtime/index.ts  (delta only)
- packages/core/package.json           (delta only — check e2b dep)

Review for:
1. **Interface fidelity**: all WorkflowRuntime methods present, correct signatures, correct return shapes.
2. **Error semantics parity with Daytona**: exec() returns non-zero exit, never throws on it.
3. **Preflight check**: relayfile-mount binary is verified on launch with a clear error message.
4. **Capabilities honesty**: the flags accurately describe what the adapter can do (no pty yet → pty: false).
5. **Template manifest**: the JSON has the right shape (reasonable keys even if e2b's schema is informal) and documents the required binaries (relayfile-mount, claude, codex, etc.).
6. **README**: a developer with access to an e2b account can follow it end-to-end to produce a working template.
7. **No coupling**: e2b.ts does not import from executor/ or bootstrap/ — the runtime layer is pure.

Verdict: APPROVED or CHANGES_REQUESTED with specific items.

End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);

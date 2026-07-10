/**
 * runtime-v5-registry.ts
 *
 * Phase 5 of the workflow runtime adapter refactor.
 *
 * Adds a RuntimeRegistry — the indirection that lets downstream callers
 * (workflow runner, CLI, per-tenant configs) select a runtime by id and
 * instantiate it from a config dict without importing the concrete class.
 *
 * This is the surface the future `agent-relay workflow runtimes --list`
 * CLI subcommand will consume. The CLI itself lives outside this repo, but
 * v5 ships a standalone developer script (scripts/list-runtimes.ts) that
 * prints every registered runtime + capabilities. That script is also a
 * reference implementation the agent-relay CLI can copy.
 *
 * Files created:
 *   packages/core/src/runtime/registry.ts          — RuntimeRegistry class + defaultRegistry
 *   packages/core/src/runtime/descriptor.ts        — RuntimeDescriptor + RuntimeFactory types
 *   scripts/list-runtimes.ts                        — CLI-style list tool
 *
 * Files modified:
 *   packages/core/src/runtime/index.ts             — export registry + descriptor
 *
 * Prerequisite: runtime-v1-interface.ts must have been merged.
 *               v2/v3/v4 are optional — the registry works with whatever
 *               runtimes exist; each of those workflows can register itself
 *               in a follow-up PR.
 *
 * Run: agent-relay run workflows/runtime-v5-registry.ts
 */

import { CodexModels, workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('runtime-v5-registry')
    .description('Add RuntimeRegistry + list-runtimes script (CLI surface)')
    .pattern('dag')
    .channel('wf-runtime-v5')
    .maxConcurrency(4)
    .timeout(1_800_000)

    .agent('lead', {
      cli: 'codex',
      role: 'Architect — designs registry shape and CLI surface',
      // Non-interactive headless Codex avoids PTY idle-kill during long
      // plan/reflect prompts while keeping the analyst-style read-only flow.
      preset: 'analyst',
      interactive: false,
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/core/src/runtime/**', 'scripts/**'], write: [], deny: [] },
        exec: [],
      },
    })

    .agent('impl', {
      cli: 'codex',
      role: 'Implementer — writes registry + descriptor + list script',
      preset: 'worker',
      retries: 2,
      constraints: { model: CodexModels.GPT_5_3_CODEX },
      permissions: {
        access: 'restricted',
        files: {
          read: ['packages/core/**', 'package.json', 'tsconfig*.json', 'scripts/**'],
          write: [
            'packages/core/src/runtime/registry.ts',
            'packages/core/src/runtime/descriptor.ts',
            'packages/core/src/runtime/index.ts',
            'scripts/list-runtimes.ts',
          ],
          deny: [
            'packages/core/src/runtime/types.ts',
            'packages/core/src/runtime/daytona.ts',
            'packages/core/src/runtime/local.ts',
            'packages/core/src/runtime/e2b.ts',
            'packages/core/src/runtime/openclaw.ts',
            'tests/**',
            '.env*',
          ],
        },
        exec: [],
      },
    })

    .agent('reviewer', {
      cli: 'codex',
      role: 'Peer reviewer — registry API ergonomics + CLI output shape',
      preset: 'reviewer',
      retries: 1,
      constraints: { model: CodexModels.GPT_5_4 },
      permissions: {
        access: 'readonly',
        files: { read: ['packages/core/**', 'scripts/**'], write: [], deny: [] },
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

    .step('read-runtime-index', {
      type: 'deterministic',
      command: 'cat packages/core/src/runtime/index.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('list-runtime-files', {
      type: 'deterministic',
      command: 'ls -la packages/core/src/runtime/',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-existing-workspace-registry', {
      type: 'deterministic',
      command: 'sed -n "1,80p" packages/core/src/workspace/registry.ts',
      captureOutput: true,
      failOnError: false,
    })

    // ─── Phase 2: Plan ─────────────────────────────────────────────────

    .step('plan', {
      agent: 'lead',
      dependsOn: ['read-runtime-types', 'read-runtime-index', 'list-runtime-files', 'read-existing-workspace-registry'],
      task: `Design a RuntimeRegistry.

Interface:
{{steps.read-runtime-types.output}}

Current runtime index:
{{steps.read-runtime-index.output}}

Runtime files present:
{{steps.list-runtime-files.output}}

Existing workspace registry for style reference:
{{steps.read-existing-workspace-registry.output}}

## Plan

1. **File: packages/core/src/runtime/descriptor.ts**

   export interface RuntimeDescriptor {
     id: string;                    // 'daytona' | 'local' | 'e2b' | 'openclaw' | 'freestyle' | 'ec2' | 'byoi' | ...
     displayName: string;           // 'Daytona', 'Local Host', 'e2b.dev'
     status: 'stable' | 'beta' | 'alpha' | 'experimental';
     capabilities: RuntimeCapabilities;
     description: string;           // one-liner for list output
     configSchema?: RuntimeConfigSchema;  // optional — shape of config users pass
     docsUrl?: string;              // pointer to docs/runtimes/<id>.md or external
   }

   export interface RuntimeConfigSchema {
     required: string[];            // e.g. ['apiKey', 'template']
     optional: string[];            // e.g. ['defaultTimeoutMs']
     envVars: string[];             // env vars the runtime reads, e.g. ['E2B_API_KEY', 'E2B_TEMPLATE']
   }

   export type RuntimeFactory = (config: unknown) => WorkflowRuntime | Promise<WorkflowRuntime>;

   export interface RuntimeRegistration {
     descriptor: RuntimeDescriptor;
     factory: RuntimeFactory;
   }

2. **File: packages/core/src/runtime/registry.ts**

   import { RuntimeRegistration, RuntimeDescriptor, RuntimeFactory } from './descriptor.js';
   import type { WorkflowRuntime } from './types.js';

   export class RuntimeRegistry {
     private entries = new Map<string, RuntimeRegistration>();

     register(registration: RuntimeRegistration): void {
       if (this.entries.has(registration.descriptor.id)) {
         throw new Error('runtime already registered: ' + registration.descriptor.id);
       }
       this.entries.set(registration.descriptor.id, registration);
     }

     unregister(id: string): boolean {
       return this.entries.delete(id);
     }

     has(id: string): boolean { return this.entries.has(id); }

     get(id: string): RuntimeRegistration | undefined { return this.entries.get(id); }

     list(): RuntimeDescriptor[] {
       return Array.from(this.entries.values()).map(e => e.descriptor);
     }

     async create(id: string, config: unknown): Promise<WorkflowRuntime> {
       const entry = this.entries.get(id);
       if (!entry) throw new Error('unknown runtime: ' + id + '. Available: ' + this.list().map(d => d.id).join(', '));
       return await entry.factory(config);
     }
   }

   // Module-level singleton that the application can pre-populate and share
   export const defaultRegistry = new RuntimeRegistry();

   IMPORTANT: the registry does NOT auto-register known runtimes. Each
   concrete runtime (DaytonaRuntime, LocalRuntime, etc.) gets a
   registration call in a follow-up PR (or lazily when the consumer imports
   it). This keeps the registry cycle-free and lets consumers opt into
   whichever runtimes they want.

   Exception: the Daytona runtime already exists and is the "default".
   Register it eagerly in registry.ts IF the import doesn't create a cycle.
   To check: does daytona.ts import from registry.ts? No. Does registry.ts
   importing from daytona.ts cause anything? Only if the caller of registry
   also imports from daytona — which is fine. DO the eager registration of
   DaytonaRuntime in registry.ts so the registry is non-empty out of the box.

3. **File: scripts/list-runtimes.ts**

   A standalone Node script that imports defaultRegistry and prints a table:

     npx tsx scripts/list-runtimes.ts
     npx tsx scripts/list-runtimes.ts --json     # machine-readable output

   Table columns: id, name, status, isolation, snapshots, pty, description

   Example output:

     ID         NAME           STATUS    ISOLATION  SNAPSHOTS  PTY    DESCRIPTION
     daytona    Daytona        stable    strong     yes        yes    Daytona cloud sandboxes (default)
     local      Local Host     beta      none       no         no     Run directly on the host
     e2b        e2b.dev        beta      strong     yes        no     e2b.dev microVM sandboxes
     openclaw   OpenClaw       alpha     process    no         no     macOS host via relaycast gateway

   Also include a footer: "Runtimes are registered via RuntimeRegistry.register(). See packages/core/src/runtime/registry.ts"

4. **Modify: packages/core/src/runtime/index.ts**
   Add exports: registry.ts (RuntimeRegistry, defaultRegistry) and descriptor.ts (RuntimeDescriptor, RuntimeFactory, RuntimeRegistration, RuntimeConfigSchema).

5. Do NOT touch types.ts or any concrete runtime file. Each concrete runtime
   (local, e2b, openclaw) will register itself in a follow-up PR by calling
   defaultRegistry.register() — for now, only Daytona is eagerly registered.

End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    })

    // ─── Phase 3: Self-reflection ──────────────────────────────────────

    .step('reflect', {
      agent: 'lead',
      dependsOn: ['plan'],
      task: `Self-reflect on the registry plan.

Plan:
{{steps.plan.output}}

Challenges:

1. **Config type safety**: factory takes "config: unknown". This loses type safety at call sites. Could we make RuntimeFactory generic over config type? Yes — RuntimeFactory<C = unknown> — but the registry must store them with their concrete types. The cost of generics here outweighs the benefit; the registry is a runtime-polymorphic store by design. Accept 'unknown' and have each factory validate at its boundary. Document this.

2. **Eager Daytona registration**: if registry.ts eagerly imports DaytonaRuntime, then any consumer that imports the registry pulls in the Daytona SDK as a transitive dep. That's already true today (every cloud entry point imports Daytona), so no regression. But if a future consumer wants a "headless" core without Daytona, they'd have to unregister. Alternative: move eager registration to a separate file 'register-defaults.ts' that consumers explicitly import when they want the defaults. Prefer this approach — it keeps registry.ts pure. REVISE the plan.

3. **Config schema vs JSON Schema**: the RuntimeConfigSchema is a hand-rolled {required, optional, envVars} triple. Would it be better to use JSON Schema? No — JSON Schema adds a dep and complexity for a v5 surface. The hand-rolled shape is enough for the list CLI to show users what to set.

4. **Async register**: should register() be async (to allow runtime-time lookups)? No — registration is pure metadata + factory reference. Factories are async; registration is not.

5. **Duplicate id handling**: the plan throws on duplicate register. Good for safety, bad for idempotency. A hot-reload dev loop would crash on the second import. Consider either (a) throw by default but accept { override: true } option, or (b) replace-on-duplicate with a warn log. Pick (a) — explicit is safer.

6. **List output ordering**: the plan prints runtimes in Map insertion order. Should it sort by status (stable first, then beta, alpha, experimental) with id as tiebreaker? That's more user-friendly for a CLI. Add this to the script.

7. **--json flag**: the plan mentions it but doesn't specify the shape. Decide: { runtimes: RuntimeDescriptor[] } — the list() output verbatim. Simple and scriptable.

8. **scripts/list-runtimes.ts and the future CLI**: the script is a reference for the agent-relay CLI (in a separate repo) to model its 'workflow runtimes --list' subcommand. Add a JSDoc header linking to the future CLI integration and explaining that the script reads defaultRegistry, so if new runtimes are registered elsewhere, they only show up if their registration module was imported first. This is a limitation but acceptable for v5.

Produce revisions. End with REFLECTION_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REFLECTION_COMPLETE' },
    })

    // ─── Phase 4: Implement ────────────────────────────────────────────

    .step('implement', {
      agent: 'impl',
      dependsOn: ['reflect'],
      task: `Implement the registry.

Plan:
{{steps.plan.output}}

Reflection (overrides plan conflicts):
{{steps.reflect.output}}

Create:
- packages/core/src/runtime/descriptor.ts
- packages/core/src/runtime/registry.ts
- packages/core/src/runtime/register-defaults.ts   (per reflection #2)
- scripts/list-runtimes.ts

Modify:
- packages/core/src/runtime/index.ts  (export registry + descriptor types; do NOT eagerly import register-defaults — consumers opt in)

Hard rules:
1. registry.ts is pure — no eager runtime registration. register-defaults.ts handles Daytona registration for consumers who want defaults.
2. register() throws on duplicate id unless { override: true } is passed.
3. list() returns sorted by status priority then id.
4. scripts/list-runtimes.ts imports defaultRegistry from '../packages/core/src/runtime/index.js' AND imports register-defaults.ts for its side effect. It supports --json and default-table output.
5. No JSON Schema dep. Config validation is left to each factory.
6. All imports use .js extensions.
7. Do not touch types.ts, daytona.ts, local.ts, e2b.ts, openclaw.ts.

Do not run build or test commands.`,
      verification: { type: 'file_exists', value: 'packages/core/src/runtime/registry.ts' },
    })

    // ─── Phase 5: Self-review ──────────────────────────────────────────

    .step('self-review', {
      agent: 'impl',
      dependsOn: ['implement'],
      task: `Self-review.

Re-read:
- packages/core/src/runtime/descriptor.ts
- packages/core/src/runtime/registry.ts
- packages/core/src/runtime/register-defaults.ts
- packages/core/src/runtime/index.ts
- scripts/list-runtimes.ts

Checklist:
1. RuntimeRegistry has: register, unregister, has, get, list, create.
2. register() accepts { override?: boolean } option.
3. list() sort order: stable < beta < alpha < experimental, then by id.
4. defaultRegistry is a module-level singleton.
5. register-defaults.ts imports DaytonaRuntime and calls defaultRegistry.register() with a DaytonaRuntime factory.
6. scripts/list-runtimes.ts handles --json and prints a table otherwise.
7. index.ts exports everything from registry.ts and descriptor.ts but does NOT eagerly import register-defaults.ts.
8. No TODO, no placeholder.

Fix any issue by editing on disk. End with SELF_REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'SELF_REVIEW_COMPLETE' },
    })

    // ─── Phase 6: Deterministic verification ───────────────────────────

    .step('verify-build', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: [
        'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1 | tee /tmp/runtime-v5-tsc.log | head -200',
        'echo',
        'grep -c "error TS" /tmp/runtime-v5-tsc.log || echo 0',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('verify-list-script-runs', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: 'npx tsx scripts/list-runtimes.ts 2>&1 | head -40 || echo "LIST_SCRIPT_FAILED"',
      captureOutput: true,
      failOnError: false,
    })

    .step('verify-list-script-json', {
      type: 'deterministic',
      dependsOn: ['self-review'],
      command: 'npx tsx scripts/list-runtimes.ts --json 2>&1 | node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>{try{const j=JSON.parse(d);if(!Array.isArray(j.runtimes))throw new Error(\'no runtimes array\');console.log(\'JSON_OK runtimes:\',j.runtimes.length);}catch(e){console.log(\'JSON_BAD\',e.message);process.exit(1);}})"',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-build', {
      agent: 'impl',
      dependsOn: ['verify-build', 'verify-list-script-runs', 'verify-list-script-json'],
      task: `TypeScript check:
{{steps.verify-build.output}}

list-runtimes script (table mode):
{{steps.verify-list-script-runs.output}}

list-runtimes script (--json mode):
{{steps.verify-list-script-json.output}}

If tsc errors exist, fix them by editing files on disk.
If the list script failed to run (output contains LIST_SCRIPT_FAILED or a stack trace), fix the script.
If --json output is invalid (JSON_BAD), fix the script to emit valid JSON to stdout and route logs to stderr.

If everything is clean, output NO_FIX_NEEDED.`,
      verification: { type: 'exit_code' },
    })

    .step('re-verify-build', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: 'cd packages/core && npx tsc --noEmit -p tsconfig.build.json 2>&1',
      captureOutput: true,
      failOnError: true,
    })

    .step('re-verify-list-script', {
      type: 'deterministic',
      dependsOn: ['fix-build'],
      command: 'npx tsx scripts/list-runtimes.ts --json',
      captureOutput: true,
      failOnError: true,
    })

    // ─── Phase 7: Peer review ──────────────────────────────────────────

    .step('peer-review', {
      agent: 'reviewer',
      dependsOn: ['re-verify-build', 're-verify-list-script'],
      task: `Peer-review the registry implementation.

Final list-runtimes output (should contain at least 'daytona'):
{{steps.re-verify-list-script.output}}

Read:
- packages/core/src/runtime/descriptor.ts
- packages/core/src/runtime/registry.ts
- packages/core/src/runtime/register-defaults.ts
- packages/core/src/runtime/index.ts
- scripts/list-runtimes.ts

Review for:
1. **API ergonomics**: register / get / create / list cover the full lifecycle; no awkward pairing.
2. **No cycles**: registry.ts does not import concrete runtimes; register-defaults.ts is the only coupling point.
3. **Override safety**: register() duplicate handling is explicit (throw unless override: true).
4. **Sort order**: list() returns stable-first, id-second.
5. **Script output**: table mode is human-readable; --json mode is valid JSON on stdout.
6. **CLI-ready shape**: a future 'agent-relay workflow runtimes --list' subcommand can shell out to this script or copy its logic trivially.
7. **No TODO / stub code**.

Verdict: APPROVED or CHANGES_REQUESTED.

End with REVIEW_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Result:', result.status);
}

main().catch(console.error);

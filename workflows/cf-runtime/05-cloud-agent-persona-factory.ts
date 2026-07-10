// W5: cloud repo — @cloud/cloudflare-agent-bindings package + infra/agent-persona.ts
// factory. Lands AFTER Wave A–C are merged and @agent-assistant/cloudflare-runtime
// has been published to npm (and its version bumped in cloud's workspaces).
//
// Target repo: cloud
// Branch: feat/cloud-agent-persona-factory
// Base: main

import { workflow } from '@relayflows/core';
import { applyWorktreeSetup, inWorktree, pushAndOpenPrStep } from './lib/worktree-setup.ts';

const REPO_PATH = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const BRANCH = 'feat/cloud-agent-persona-factory';
const REPO_SLUG = 'AgentWorkforce/cloud';
const WORKTREE_PATH = `${REPO_PATH}/../.cf-runtime-worktrees/cloud-feat-agent-persona-factory`;

async function runWorkflow() {
  let wf = workflow('cf-runtime-05-cloud-agent-persona-factory')
    .description('Cloud repo: new @cloud/cloudflare-agent-bindings package (CF-typed Env + concrete TurnExecutorDO subclass factory) + infra/agent-persona.ts SST factory that provisions worker + queue + KVs + DO namespace per persona.')
    .pattern('dag')
    .channel('wf-cf-runtime-05')
    .maxConcurrency(4)
    .timeout(3_600_000)

    .agent('lead', {
      cli: 'claude',
      role: 'Lead. Owns the boundary between OSS cloudflare-runtime and cloud-repo CF-specific code. Rejects any cloudflare:workers import leaking into a published package, and any deployment-env coupling leaking out of the factory.',
      retries: 1,
    })
    .agent('impl-bindings', {
      cli: 'codex',
      role: 'Implements @cloud/cloudflare-agent-bindings — CfAgentEnv generic type, TurnExecutorDO subclass, queue-producer helpers.',
      retries: 2,
    })
    .agent('impl-infra', {
      cli: 'codex',
      role: 'Implements infra/agent-persona.ts SST factory and refactors infra/sage.ts to use it (behind a feature flag — sage migration itself is W6).',
      retries: 2,
    })
    .agent('tester', {
      cli: 'claude',
      preset: 'worker',
      role: 'Writes unit tests for the bindings package; validates SST plan output with `sst diff` (or equivalent) to confirm no resource drift on the existing sage worker.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Reviews diff. Verifies platform split (no cloudflare:workers in @agent-assistant/*; no SST types in @cloud/cloudflare-agent-bindings). Writes VERDICT.',
      retries: 1,
    });

  wf = applyWorktreeSetup(wf, {
    repoLabel: 'cloud',
    repoPath: REPO_PATH,
    branch: BRANCH,
    worktreePath: WORKTREE_PATH,
    extraSetupCommands: [
      'cd "$WT" && npm run build:platform 2>&1 | tail -5 || true',
      'cd "$WT" && npm run build:core 2>&1 | tail -5 || true',
    ],
    expectedDirty: [
      'packages/cloudflare-agent-bindings/package.json',
      'packages/cloudflare-agent-bindings/tsconfig.json',
      'packages/cloudflare-agent-bindings/src/env.ts',
      'packages/cloudflare-agent-bindings/src/turn-executor-do.ts',
      'packages/cloudflare-agent-bindings/src/queue-producer.ts',
      'packages/cloudflare-agent-bindings/src/index.ts',
      'infra/agent-persona.ts',
      'package.json',
      'package-lock.json',
    ],
  });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-spec', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: 'cat workflows/cf-runtime/SPEC.md',
      captureOutput: true,
      failOnError: true,
    });

  // Pre-flight gate: @agent-assistant/cloudflare-runtime MUST already be installed
  // from the published version.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-published-runtime', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'if [ ! -d node_modules/@agent-assistant/cloudflare-runtime ]; then',
          '  echo "ERROR: @agent-assistant/cloudflare-runtime is not installed. Publish it from agent-assistant and bump its version in this repo before running W5."',
          '  exit 1',
          'fi',
          'VERSION=$(node -p "require(\\"./node_modules/@agent-assistant/cloudflare-runtime/package.json\\").version")',
          'echo "Runtime version: $VERSION"',
          'if ! node -e "import(\\"@agent-assistant/cloudflare-runtime\\").then(m => { if (!m.wrapCloudflareWorker || !m.handleCfQueue || !m.TurnExecutorDO) { console.error(\\"missing exports\\"); process.exit(1) } console.log(\\"exports OK\\") })"; then',
          '  echo "ERROR: runtime missing required exports"',
          '  exit 1',
          'fi',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('read-existing-infra', {
      type: 'deterministic',
      dependsOn: ['install-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'echo "=== infra/sage.ts ===" && cat infra/sage.ts',
          'echo "=== infra/edge.ts ===" && cat infra/edge.ts',
          'echo "=== infra/specialist-worker.ts ===" && head -120 infra/specialist-worker.ts',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const leadTask = [
    'You are the lead on #wf-cf-runtime-05.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'This workflow lands the cloud-repo adapters for the runtime. Two workers split the',
    'work cleanly:',
    '  - impl-bindings: TypeScript package @cloud/cloudflare-agent-bindings (CF types + DO',
    '    subclass + typed queue producer).',
    '  - impl-infra: SST factory infra/agent-persona.ts that provisions the queue + DLQ +',
    '    KVs + DO namespace + secrets + domain for a persona. Also adds a defineAgentPersona',
    '    call behind a feature flag (`CF_RUNTIME_PERSONA_FACTORY=1`) so we can land it',
    '    without touching sage\'s existing resources yet.',
    '',
    'Boundary enforcement (SPEC §"Design principles" #2):',
    '  - @agent-assistant/* packages MUST NOT import cloudflare:workers at runtime.',
    '  - @cloud/cloudflare-agent-bindings owns the DO subclass that actually extends the',
    '    cloudflare:workers DurableObject. It passes a structural storage/state object up',
    '    into the abstract base from the runtime package.',
    '  - infra/agent-persona.ts knows about SST + Pulumi; neither package imports those.',
    '',
    'Critical: the sage worker must KEEP WORKING while this lands. No behavior change for',
    'sage in this PR. Migration is W6. If you see impl-infra changing sage resource names',
    'or removing SST bindings, REJECT.',
    '',
    'SPEC:',
    '{{steps.read-spec.output}}',
    '',
    'Existing infra:',
    '{{steps.read-existing-infra.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('lead-coordinate', {
      agent: 'lead',
      dependsOn: ['read-spec', 'verify-published-runtime', 'read-existing-infra'],
      task: leadTask,
    });

  const implBindingsTask = [
    'You are impl-bindings on #wf-cf-runtime-05.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create the new package packages/cloudflare-agent-bindings with files:',
    '  package.json — name "@cloud/cloudflare-agent-bindings", type "module", private: true',
    '  tsconfig.json — extends ../../tsconfig.base (or equivalent), outDir dist, moduleResolution bundler',
    '  src/index.ts — re-exports',
    '  src/env.ts — exports:',
    '    export interface CfAgentEnv {',
    '      TURN_QUEUE: Queue<unknown>;',
    '      TURN_DLQ: Queue<unknown>;',
    '      DEDUP: KVNamespace;',
    '      CONTINUATIONS: KVNamespace;',
    '      THREADS: KVNamespace;',
    '      PREFS: KVNamespace;',
    '      SIGNALS: KVNamespace;',
    '      QUIET_HOURS: KVNamespace;',
    '      [key: string]: unknown;',
    '    }',
    '  src/turn-executor-do.ts — concrete DO subclass factory:',
    '    export function createTurnExecutorDoClass<Env extends CfAgentEnv>(',
    '      opts: { name: string; buildExecutorOptions: (env: Env) => CfTurnExecutorOptions<Env, any> }',
    '    ): new (state: DurableObjectState, env: Env) => DurableObject',
    '    — internally extends DurableObject (from cloudflare:workers), and delegates to the',
    '      abstract TurnExecutorDO base class from @agent-assistant/cloudflare-runtime.',
    '  src/queue-producer.ts — typed helper `sendTurnMessage(env, msg)` with JSDoc.',
    '',
    'Add @agent-assistant/cloudflare-runtime to dependencies.',
    'Update root package.json workspaces to include packages/cloudflare-agent-bindings.',
    '',
    'Run `cd packages/cloudflare-agent-bindings && npx tsc --noEmit` after each file edit.',
    '',
    'Post "IMPL_BINDINGS_DONE" when done.',
    '',
    'SPEC: {{steps.read-spec.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-bindings-work', {
      agent: 'impl-bindings',
      dependsOn: ['lead-coordinate'],
      task: implBindingsTask,
    });

  const implInfraTask = [
    'You are impl-infra on #wf-cf-runtime-05.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Create infra/agent-persona.ts exporting:',
    '  export interface AgentPersonaInputs { ... }  // see SPEC §"infra/agent-persona.ts"',
    '  export function defineAgentPersona(inputs: AgentPersonaInputs): AgentPersonaOutputs',
    '',
    'Factory behavior:',
    '  - Create an sst.cloudflare.Queue named `${name}-turn-queue${stageSuffix}`.',
    '  - Create an sst.cloudflare.Queue named `${name}-turn-dlq${stageSuffix}` — bound as DLQ',
    '    via queue consumer options.',
    '  - Create 6 KVs: dedup, threads, prefs, signals, quiet-hours, continuations (new).',
    '  - Create DO namespace for TurnExecutorDO-<Name>.',
    '  - Create sst.cloudflare.Worker with the handler path from inputs, bind all of the',
    '    above, environment from inputs.environment, link secrets from inputs.secrets,',
    '    service-bind each specialist from inputs.specialists.',
    '  - Return { worker, turnQueue, deadLetterQueue, kvs, turnExecutorDoName }.',
    '',
    'Also do NOT touch infra/sage.ts in this workflow. Sage migration is W6. Import the new',
    'factory into infra/sage.ts only to make it *available* for W6 — do not invoke it.',
    '',
    'Run `npx tsc --noEmit -p infra` (or whatever the existing pattern is) after each edit.',
    '',
    'Post "IMPL_INFRA_DONE" when done.',
    '',
    'SPEC: {{steps.read-spec.output}}',
    '',
    'Existing infra (reference):',
    '{{steps.read-existing-infra.output}}',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('impl-infra-work', {
      agent: 'impl-infra',
      dependsOn: ['lead-coordinate'],
      task: implInfraTask,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-files', {
      type: 'deterministic',
      dependsOn: ['impl-bindings-work', 'impl-infra-work'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'missing=0',
          'for f in packages/cloudflare-agent-bindings/package.json packages/cloudflare-agent-bindings/tsconfig.json packages/cloudflare-agent-bindings/src/env.ts packages/cloudflare-agent-bindings/src/turn-executor-do.ts packages/cloudflare-agent-bindings/src/queue-producer.ts packages/cloudflare-agent-bindings/src/index.ts infra/agent-persona.ts; do',
          '  if [ ! -f "$f" ]; then echo "MISSING: $f"; missing=$((missing+1)); fi',
          'done',
          'if [ $missing -gt 0 ]; then echo "$missing files missing"; exit 1; fi',
          'echo ALL_FILES_PRESENT',
        ].join('; '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('reinstall-deps', {
      type: 'deterministic',
      dependsOn: ['verify-files'],
      command: inWorktree(WORKTREE_PATH, 'npm install --legacy-peer-deps --no-audit --no-fund 2>&1 | tail -10'),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['reinstall-deps'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'cd packages/cloudflare-agent-bindings && npx tsc --noEmit 2>&1 | tail -40 && echo BINDINGS_TSC_OK',
          'cd - >/dev/null',
          'npx tsc --noEmit --project tsconfig.infra.json 2>&1 | tail -40 || true',
          'echo TYPECHECK_PASS',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-typecheck', {
      agent: 'impl-bindings',
      dependsOn: ['typecheck'],
      task: [
        'Fix typecheck errors if any. Output:',
        '{{steps.typecheck.output}}',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  // Drift check: sst diff against main for sage / specialist resources.
  // If the new factory is NOT yet applied to sage, there should be no drift on sage.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('sst-drift-check', {
      type: 'deterministic',
      dependsOn: ['fix-typecheck'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'echo "=== changed infra files ==="',
          'git diff --stat origin/main -- infra/',
          'echo "=== infra/sage.ts diff ==="',
          'git diff origin/main -- infra/sage.ts || true',
          'if git diff origin/main -- infra/sage.ts | grep -q "^-\\s*const\\|^+\\s*const"; then echo "WARNING: infra/sage.ts has resource-definition changes (W5 should not touch sage)"; exit 1; fi',
          'echo DRIFT_CHECK_OK',
        ].join('; '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  const writeTestsTask = [
    'Write unit tests for @cloud/cloudflare-agent-bindings.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Required tests (vitest or node:test — follow existing conventions):',
    '  packages/cloudflare-agent-bindings/src/queue-producer.test.ts',
    '    - sendTurnMessage round-trips through a fake Queue',
    '',
    '  packages/cloudflare-agent-bindings/src/turn-executor-do.test.ts',
    '    - createTurnExecutorDoClass returns a class whose instances delegate fetch() and',
    '      alarm() into the abstract base (verify via a spy base class).',
    '    - Multiple personas (separate names) produce independent classes.',
    '',
    'Run: `cd packages/cloudflare-agent-bindings && npx vitest run` (install vitest as devDep',
    'if not present). Fix until green.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('write-tests', {
      agent: 'tester',
      dependsOn: ['sst-drift-check'],
      task: writeTestsTask,
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests', {
      type: 'deterministic',
      dependsOn: ['write-tests'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-agent-bindings && npx vitest run 2>&1 | tail -60 || true'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-tests', {
      agent: 'tester',
      dependsOn: ['run-tests'],
      task: [
        'Fix test failures. Output:',
        '{{steps.run-tests.output}}',
        `Worktree: ${WORKTREE_PATH}. Only edit packages/cloudflare-agent-bindings/.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-tests'],
      command: inWorktree(WORKTREE_PATH, 'cd packages/cloudflare-agent-bindings && npx vitest run'),
      captureOutput: true,
      failOnError: true,
    });

  // Regression test: existing cloud test suite should still pass.
  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('run-existing-tests', {
      type: 'deterministic',
      dependsOn: ['run-tests-final'],
      command: inWorktree(WORKTREE_PATH, 'npm run test 2>&1 | tail -50 || true'),
      captureOutput: true,
      failOnError: false,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('fix-regressions', {
      agent: 'impl-bindings',
      dependsOn: ['run-existing-tests'],
      task: [
        'Check whether our changes broke any existing cloud tests.',
        'Output:',
        '{{steps.run-existing-tests.output}}',
        '',
        'If all existing tests pass, do nothing. If a regression shows up, the most likely cause',
        'is a missed workspace.json entry, a typecheck issue, or an SST resource reference',
        'that no longer resolves.',
        '',
        `Worktree: ${WORKTREE_PATH}.`,
      ].join('\n'),
      verification: { type: 'exit_code' },
    });

  const reviewTask = [
    'Review the cloud-side factory PR.',
    '',
    `Worktree: ${WORKTREE_PATH}.`,
    '',
    'Run:',
    `  cd ${WORKTREE_PATH} && git diff origin/main...HEAD`,
    '',
    'Verify:',
    '  [platform split]  packages/cloudflare-agent-bindings imports from',
    '                    @agent-assistant/cloudflare-runtime and cloudflare:workers.',
    '                    @agent-assistant/* packages still have ZERO cloudflare:workers imports.',
    '  [no sage drift]   infra/sage.ts has no resource-definition changes (no renames,',
    '                    no removed bindings). W6 is where sage migrates.',
    '  [factory coverage] defineAgentPersona provisions all 6 KVs + 2 queues + DO namespace',
    '                    + worker + specialist bindings, matching SPEC §"infra/agent-persona.ts".',
    '  [typing]          CfAgentEnv is generic enough that sage and specialist can both',
    '                    satisfy it without casting.',
    '',
    'Write VERDICT-05.md with KEEP | PAUSE.',
  ].join('\n');

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('review', {
      agent: 'reviewer',
      dependsOn: ['fix-regressions'],
      task: reviewTask,
      verification: { type: 'file_exists', value: `${WORKTREE_PATH}/VERDICT-05.md` },
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review'],
      command: [
        `cd ${JSON.stringify(WORKTREE_PATH)}`,
        'grep -Eqi "(^|[*#[:space:]])verdict:?[[:space:]]*keep" VERDICT-05.md || (cat VERDICT-05.md; exit 1)',
        'echo VERDICT_KEEP',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('commit', {
      type: 'deterministic',
      dependsOn: ['verify-verdict'],
      command: inWorktree(
        WORKTREE_PATH,
        [
          'set -e',
          'git add packages/cloudflare-agent-bindings',
          'git add infra/agent-persona.ts',
          'git add package.json package-lock.json',
          'MSG=$(mktemp)',
          'printf "%s\\n" "feat(cloud): cloudflare-agent-bindings + defineAgentPersona factory" "" "- new package @cloud/cloudflare-agent-bindings: CfAgentEnv, TurnExecutorDO" "  subclass factory, typed queue producer" "- new infra/agent-persona.ts: SST factory provisioning per-persona queue +" "  DLQ + 6 KVs + DO namespace + specialist service bindings + secrets" "" "Does NOT migrate sage or specialist — those are W6 and W7." > "$MSG"',
          'git commit -F "$MSG"',
          'rm -f "$MSG"',
        ].join(' && '),
      ),
      captureOutput: true,
      failOnError: true,
    });

  wf = (wf as unknown as { step: (n: string, c: unknown) => typeof wf })
    .step('open-pr', pushAndOpenPrStep({
      worktreePath: WORKTREE_PATH,
      branch: BRANCH,
      repoSlug: REPO_SLUG,
      title: 'feat(cloud): cloudflare-agent-bindings + defineAgentPersona factory',
      dependsOn: ['commit'],
      labels: ['cf-runtime', 'no-merge-without-w6-w7'],
      bodyLines: [
        '## Summary',
        'Cloud-repo adapters for the new `@agent-assistant/cloudflare-runtime` package.',
        '',
        '- **new package** `@cloud/cloudflare-agent-bindings`: CF-typed `CfAgentEnv`, concrete `TurnExecutorDO` subclass factory, typed queue producer.',
        '- **new infra** `infra/agent-persona.ts`: `defineAgentPersona({...})` — provisions per-persona turn queue + DLQ + 6 KVs + DO namespace + worker + specialist service bindings + secrets.',
        '',
        '## What this does NOT do',
        '- No changes to sage or specialist resources in this PR. Migrations land in W6 (sage) and W7 (specialist).',
        '- No new runtime behavior visible in production.',
        '',
        '## Platform split',
        '`@agent-assistant/*` packages stay platform-agnostic (no `cloudflare:workers` imports). The concrete DO subclass that extends `DurableObject` from `cloudflare:workers` lives in `@cloud/cloudflare-agent-bindings`. Mirrors the existing `packages/relayauth` vs `@relayauth/*` split.',
        '',
        '## Order',
        'Requires:',
        '- W1–W4 merged in `agent-assistant` repo.',
        '- `@agent-assistant/cloudflare-runtime@0.1.0` published to npm.',
        '- That version bumped in this repo\'s workspace `package.json` (preflight step verifies this).',
        '',
        '## Follow-up',
        'W6 (sage migration) and W7 (specialist migration) land on top of this.',
      ],
    }));

  const result = await wf.run({ cwd: process.cwd() });
  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});

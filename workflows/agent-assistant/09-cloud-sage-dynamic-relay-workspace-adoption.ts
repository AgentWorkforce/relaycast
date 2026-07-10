import { workflow } from '@relayflows/core';

async function runWorkflow() {
  const result = await workflow('cloud-sage-dynamic-relay-workspace-adoption')
    .description('Define and implement the bounded Cloud + Sage adoption slice for dynamic relay workspace / relaycast API key resolution, replacing the primary global RELAY_API_KEY assumption where the per-workspace path already exists.')
    .pattern('dag')
    .channel('wf-cloud-sage-dynamic-relay-workspace-adoption')
    .maxConcurrency(3)
    .timeout(3600000)

    .agent('lead', {
      cli: 'claude',
      role: 'Architecture lead. Choose the canonical workspace mapping rule, review implementation, reject shortcuts, and decide readiness.',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implementation engineer. Edit only the bounded Cloud/Sage seams required for the dynamic relay workspace adoption slice.',
      retries: 2,
    })
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Review diff for correctness, shortcut avoidance, and acceptance coverage.',
      retries: 1,
    })

    .step('read-current-seams', {
      type: 'deterministic',
      command: [
        'printf "=== workflow run route ===\\n"',
        'sed -n "1,260p" packages/web/app/api/v1/workflows/run/route.ts',
        'printf "\\n=== workspace registry ===\\n"',
        'sed -n "1,260p" packages/web/lib/workspace-registry.ts',
        'printf "\\n=== relay workspaces ===\\n"',
        'sed -n "1,260p" packages/web/lib/relay-workspaces.ts',
        'printf "\\n=== sage worker infra ===\\n"',
        'sed -n "1,240p" infra/sage.ts',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('choose-canonical-mapping', {
      agent: 'lead',
      dependsOn: ['read-current-seams'],
      task: `Read the current seams below and decide the single canonical mapping/resolution rule for app workspace -> relay workspace -> relaycast API key. Reject expedient shortcuts such as fabricating records with a copied global key.

Current seams:
{{steps.read-current-seams.output}}

Write your decision and bounded implementation plan to docs/agent-assistant/cloud-sage-dynamic-relay-workspace-implementation-plan.md.

Requirements:
- define the single canonical resolver owner
- identify which save/run/runtime paths that currently expect RELAY_API_KEY must be updated
- include Sage specialist/runtime expectations
- explicitly call out whether temporary global RELAY_API_KEY fallback remains, and if so, where and why
`,
      verification: { type: 'file_exists', value: 'docs/agent-assistant/cloud-sage-dynamic-relay-workspace-implementation-plan.md' },
    })

    .step('implement-slice', {
      agent: 'impl',
      dependsOn: ['choose-canonical-mapping'],
      task: `Implement the bounded slice described in docs/agent-assistant/cloud-sage-dynamic-relay-workspace-implementation-plan.md.

Rules:
- do not fabricate relay workspace records with a copied global env key
- do not spread mapping logic across multiple ad hoc call sites
- keep the diff focused on the canonical resolver and the runtime/save paths that require it
- update or add targeted tests where the new behavior can be proven locally
- if a temporary fallback to global RELAY_API_KEY remains, make it clearly fallback-only and document it honestly

When done, summarize changed files in docs/agent-assistant/cloud-sage-dynamic-relay-workspace-review-notes.md.
`,
      verification: { type: 'exit_code' },
    })

    .step('run-focused-validation', {
      type: 'deterministic',
      dependsOn: ['implement-slice'],
      command: 'npx vitest run tests/workflow-relay-api-key.test.ts tests/workflow-ref.test.ts tests/workflow-run-route.test.ts',
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-validation', {
      agent: 'impl',
      dependsOn: ['run-focused-validation'],
      task: `Read the focused validation output below.

{{steps.run-focused-validation.output}}

If tests failed because the command/targets are stale, adjust to the correct focused validation command for this repo and run it. If tests failed because implementation is wrong, fix and rerun until the focused validation is green. Update docs/agent-assistant/cloud-sage-dynamic-relay-workspace-review-notes.md with the final validation command and result.
`,
      verification: { type: 'exit_code' },
    })

    .step('review-slice', {
      agent: 'reviewer',
      dependsOn: ['fix-validation'],
      task: `Review the implemented slice.

Check:
- one canonical mapping/resolution seam exists
- workflow run/save/runtime path no longer relies primarily on global RELAY_API_KEY when per-workspace relaycast key resolution is available
- Sage specialist/runtime expectations are handled or honestly documented
- no fabricated record shortcut was introduced
- fallback behavior is explicit and honest

Write verdict to docs/agent-assistant/cloud-sage-dynamic-relay-workspace-review-verdict.md using KEEP or PAUSE with reasons.
`,
      verification: { type: 'file_exists', value: 'docs/agent-assistant/cloud-sage-dynamic-relay-workspace-review-verdict.md' },
    })

    .step('verify-verdict', {
      type: 'deterministic',
      dependsOn: ['review-slice'],
      command: 'grep -E "KEEP|PAUSE" docs/agent-assistant/cloud-sage-dynamic-relay-workspace-review-verdict.md',
      captureOutput: true,
      failOnError: true,
    })

    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Review and fix the TS config extraction in the bootstrap script.
 *
 * The current approach on branch fix/ts-workflow-cloud-executor uses
 * a subprocess to extract config from TS workflow files. This workflow
 * reviews the implementation, identifies issues, and fixes them.
 *
 * Run from cloud repo root:
 *   agent-relay run workflows/review-fix-ts-config-extraction.ts
 */

import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('review-fix-ts-config-extraction')
    .description('Review and harden TS config extraction in bootstrap')
    .pattern('dag')
    .channel('wf-review-ts-extract')
    .maxConcurrency(4)
    .timeout(1_200_000)

    .agent('reviewer', {
      cli: 'claude',
      role: 'Code reviewer analyzing the approach for correctness and robustness',
      preset: 'reviewer',
      retries: 1,
    })
    .agent('impl', {
      cli: 'codex',
      role: 'Implement fixes based on review findings',
      preset: 'worker',
      retries: 2,
    })

    // ── Phase 1: Read context ────────────────────────────────────────────

    .step('read-current-impl', {
      type: 'deterministic',
      command: [
        'echo "=== Current TS extraction implementation ==="',
        'cat packages/core/src/bootstrap/script-generator.ts',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-example-ts-workflow', {
      type: 'deterministic',
      command: [
        'echo "=== notion-cloud.ts (example TS workflow with exported config) ==="',
        'cat /Users/khaliqgant/Sites/nango-workflows/workflows/notion-cloud.ts',
      ].join(' && '),
      captureOutput: true,
    })

    .step('read-tests', {
      type: 'deterministic',
      command: 'cat tests/orchestrator/script-generator.test.ts',
      captureOutput: true,
    })

    // ── Phase 2: Review ──────────────────────────────────────────────────

    .step('review', {
      agent: 'reviewer',
      dependsOn: ['read-current-impl', 'read-example-ts-workflow'],
      task: `
Review the TypeScript workflow config extraction in the bootstrap script.

Current implementation:
{{steps.read-current-impl.output}}

Example TS workflow that needs to work:
{{steps.read-example-ts-workflow.output}}

## Context

When a TS workflow is submitted to cloud, the bootstrap needs to:
1. Extract the exported config from the TS file
2. Run it through WorkflowRunner + DaytonaStepExecutor (same as YAML)
3. Fall back to npx tsx if no config is exported

The bootstrap itself runs as a generated .mjs file inside a Daytona sandbox.
Node.js cannot natively import .ts files — tsx is needed.

## Review checklist

1. Does the extraction approach correctly handle .ts files? (Node can't import .ts natively)
2. Will the isMain guard in notion-cloud.ts prevent the runner from executing during extraction?
3. Is the config detection robust? (checks for version + swarm)
4. Are there edge cases that could cause silent failures?
5. Is the fallback to npx tsx reliable?
6. Could the extraction cause side effects (network calls, file writes)?
7. Is the approach debuggable when it fails?
8. Would a temp file approach be better than inline eval?
9. Are permissions correctly stripped?
10. Does the runner construction match the YAML path exactly?

Write a detailed review with APPROVED, CHANGES_REQUESTED, or specific fixes needed.
If changes are needed, be specific about what code to write.
      `.trim(),
    })

    // ── Phase 3: Implement fixes ─────────────────────────────────────────

    .step('fix', {
      agent: 'impl',
      dependsOn: ['review', 'read-current-impl', 'read-tests'],
      task: `
Based on the review findings, fix the TS config extraction in
packages/core/src/bootstrap/script-generator.ts.

Review findings:
{{steps.review.output}}

Current implementation:
{{steps.read-current-impl.output}}

Current tests:
{{steps.read-tests.output}}

Apply the fixes recommended by the reviewer. If the reviewer approved
with no changes, verify the implementation is correct and add any
missing test coverage.

Key requirements:
- The extraction MUST use tsx (not native Node import) for .ts files
- The isMain guard must prevent runner execution during extraction
- Config detection must check for version + swarm fields
- Permissions must be stripped
- Fallback to npx tsx must work for files without exported configs
- The approach must be debuggable (good error messages)

Update tests to match any changes made.

Rules:
- Only modify packages/core/src/bootstrap/script-generator.ts and tests/orchestrator/script-generator.test.ts
- Build to verify: npm run -w @cloud/core build
- Run tests: npx tsx --test tests/orchestrator/script-generator.test.ts
      `.trim(),
      verification: { type: 'exit_code' },
    })

    // ── Phase 4: Verify ──────────────────────────────────────────────────

    .step('build', {
      type: 'deterministic',
      dependsOn: ['fix'],
      command: 'npm run -w @cloud/core build 2>&1 | tail -5',
      failOnError: true,
    })

    .step('test', {
      type: 'deterministic',
      dependsOn: ['build'],
      command: 'npx tsx --test tests/orchestrator/script-generator.test.ts 2>&1 | tail -15',
      failOnError: true,
    })

    .step('final-review', {
      agent: 'reviewer',
      dependsOn: ['test'],
      task: `
Final review of the changes.

Test results: {{steps.test.output}}

Read packages/core/src/bootstrap/script-generator.ts and verify:
1. The TS extraction is robust and handles edge cases
2. Tests cover the key behaviors
3. Build and tests pass
4. No regressions to the YAML or Python paths

State APPROVED or CHANGES_REQUESTED. If changes needed, fix them.
      `.trim(),
    })

    .step('final-test', {
      type: 'deterministic',
      dependsOn: ['final-review'],
      command: 'npm run -w @cloud/core build && npx tsx --test tests/orchestrator/*.test.ts 2>&1 | tail -10',
      failOnError: true,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log(`Done: ${result.status} (${result.id})`);
}

main().catch(console.error);

/**
 * V5-03B: Isolated GitHub Clone Runner Validation
 *
 * Local repeatable validation for the V5 GitHub clone runner. This workflow
 * does not write implementation code and does not spawn agents. It rebuilds
 * the deterministic tarball fixture, runs the GitHub clone contract/unit
 * suites against in-process mock Nango and Relayfile servers, and captures
 * the test output for review.
 *
 * Run:
 *   agent-relay run workflows/v5-03b-cloud-github-validation.ts
 *
 * Direct equivalent:
 *   npm run github:validate
 */

import { workflow } from '@relayflows/core';

async function main() {
  const result = await workflow('cloud-v5-03b-github-validation')
    .description('Repeatable local validation for the GitHub clone runner using mock Nango and Relayfile servers')
    .pattern('pipeline')
    .channel('wf-cloud-v5-03b-github-validation')
    .maxConcurrency(1)
    .timeout(1_200_000) // 20 min - fixture rebuild plus contract/unit suites

    .step('preflight', {
      type: 'deterministic',
      command: [
        'test -f package.json',
        'test -f tests/fixtures/github/build-small-repo-fixture.ts',
        'test -f tests/github-tarball-walker.test.ts',
        'test -f tests/github-clone-writer.test.ts',
        'test -f tests/github-clone-audit.test.ts',
        'test -f tests/github-clone-runner.contract.test.ts',
        'node -e "const p=require(\'./package.json\'); if (!p.scripts || !p.scripts[\'github:validate\']) process.exit(1)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('run-github-validation', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'mkdir -p .logs',
        'bash -o pipefail -c "npm run github:validate 2>&1 | tee .logs/v5-03b-github-validation.log"',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('capture-summary', {
      type: 'deterministic',
      dependsOn: ['run-github-validation'],
      command: [
        'echo "=== github validation log ==="',
        'ls -la .logs/v5-03b-github-validation.log',
        'echo "=== tail ==="',
        'tail -80 .logs/v5-03b-github-validation.log',
        'echo GITHUB_VALIDATED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'GITHUB_VALIDATED' },
    })

    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

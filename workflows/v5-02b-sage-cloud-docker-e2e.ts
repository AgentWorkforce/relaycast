/**
 * V5-02B: Isolated Sage/Cloud/Slack Docker E2E Validation
 *
 * Repeatable local validation for the Docker E2E stack. This workflow does
 * not write implementation code and does not spawn agents. It runs the same
 * command a developer can run locally, captures the evidence file, and checks
 * that compose teardown left no containers or volumes behind.
 *
 * Run:
 *   agent-relay run workflows/v5-02b-sage-cloud-docker-e2e.ts
 *
 * Direct equivalent:
 *   npm run e2e:docker
 */

import { workflow } from '@relayflows/core';

const SUMMARIZE_EVIDENCE = `node -e "
const fs = require('fs');
const files = fs.readdirSync('.logs')
  .filter((name) => /^e2e-.*\\.json$/.test(name))
  .map((name) => '.logs/' + name)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!files.length) {
  console.error('NO_EVIDENCE');
  process.exit(1);
}
const evidencePath = files[0];
const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
console.log('evidence=' + evidencePath);
const assertions = evidence.goldenPath && evidence.goldenPath.assertions ? evidence.goldenPath.assertions : {};
for (const key of Object.keys(assertions)) {
  const assertion = assertions[key];
  console.log(key + ': ' + (assertion.pass ? 'PASS' : 'FAIL') + ' - ' + assertion.detail);
}
console.log('g_wrongBearer: ' + (evidence.controlWrongBearer && evidence.controlWrongBearer.pass ? 'PASS' : 'FAIL'));
console.log('h_okFalse: ' + (evidence.controlOkFalse && evidence.controlOkFalse.pass ? 'PASS' : 'FAIL'));
if (!evidence.summary || !evidence.summary.pass) {
  const failures = evidence.summary && evidence.summary.failures ? evidence.summary.failures : [];
  console.error('summary failures: ' + JSON.stringify(failures));
  process.exit(1);
}
console.log('DOCKER_E2E_EVIDENCE_OK');
"`;

async function main() {
  const result = await workflow('cloud-v5-02b-sage-cloud-docker-e2e')
    .description('Repeatable local Docker E2E validation for Sage to Cloud to Slack proxying')
    .pattern('pipeline')
    .channel('wf-cloud-v5-02b-docker-e2e')
    .maxConcurrency(1)
    .timeout(2_700_000) // 45 min - image rebuilds can be slow on cold Docker caches

    .step('preflight', {
      type: 'deterministic',
      command: [
        'test -f docker-compose.e2e.yml',
        'test -x scripts/e2e/up.sh',
        'test -x scripts/e2e/down.sh',
        'test -x scripts/e2e/seed.sh',
        'test -x scripts/e2e/run.sh',
        'test -f tests/e2e/drive-app-mention-fixture.ts',
        'test -f tests/e2e/fixtures/app-mention.json',
        'test -f ../sage/package.json',
        'node -e "const p=require(\'./package.json\'); if (!p.scripts || p.scripts[\'e2e:docker\'] !== \'bash scripts/e2e/run.sh\') process.exit(1)"',
        'docker info >/dev/null',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('run-docker-e2e', {
      type: 'deterministic',
      dependsOn: ['preflight'],
      command: [
        'mkdir -p .logs',
        'bash -o pipefail -c "npm run e2e:docker 2>&1 | tee .logs/v5-02b-sage-cloud-docker-e2e.log"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('capture-evidence', {
      type: 'deterministic',
      dependsOn: ['run-docker-e2e'],
      command: [
        'containers="$(docker ps -aq --filter label=com.docker.compose.project=cloud)"',
        'if [ -n "$containers" ]; then echo "Leaked compose containers: $containers"; exit 1; fi',
        'volumes="$(docker volume ls -q --filter label=com.docker.compose.project=cloud)"',
        'if [ -n "$volumes" ]; then echo "Leaked compose volumes: $volumes"; exit 1; fi',
        SUMMARIZE_EVIDENCE,
        'echo DOCKER_E2E_VALIDATED',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
      verification: { type: 'output_contains', value: 'DOCKER_E2E_VALIDATED' },
    })

    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

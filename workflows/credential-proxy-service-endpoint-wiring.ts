import { workflow } from '@relayflows/core';

const CLOUD = process.env.CLOUD_REPO ?? `${process.env.HOME}/Projects/AgentWorkforce/cloud`;

await workflow('credential-proxy-service-endpoint-wiring')
  .description('Wire Cloud to an explicit credential-proxy service endpoint and verify the end-to-end env/endpoint contract.')
  .pattern('dag')
  .channel('wf-credential-proxy-service-endpoint-wiring')
  .maxConcurrency(3)
  .timeout(60 * 60 * 1000)

  .agent('planner', { cli: 'claude', role: 'Service-endpoint architect', interactive: true, retries: 1 })
  .agent('implementer', { cli: 'codex', role: 'Cloud wiring implementer', interactive: true, retries: 1 })
  .agent('reviewer', { cli: 'claude', role: 'Final endpoint wiring reviewer', interactive: true, retries: 1 })

  .step('audit-endpoint-wiring', {
    type: 'deterministic',
    command: [
      `cd ${CLOUD}`,
      `rg -n "credentialProxyUrl|credentialProxyToken|RELAY_LLM_PROXY|CREDENTIAL_PROXY_TOKEN|RelayauthUrl|RelayfileUrl|service-config" infra packages --glob '!**/node_modules/**' --glob '!**/dist/**'`,
      `echo '--- service-config ---'`,
      `test -f infra/service-config.ts && sed -n '1,220p' infra/service-config.ts || true`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('design-endpoint-wiring', {
    agent: 'planner',
    dependsOn: ['audit-endpoint-wiring'],
    task: `Design the smallest correct set of changes to make the credential-proxy service endpoint explicit in Cloud and make final E2E verification meaningful.

Audit output:\n{{steps.audit-endpoint-wiring.output}}

Requirements:
- prefer the Cloud-hosted service-boundary architecture
- make endpoint configuration explicit and consistent with existing service-config patterns
- ensure sandboxs receive proxy URL/token through the intended path
- define what final verification should prove
- keep changes narrow

Write the plan to ${CLOUD}/workflows/PLAN-credential-proxy-service-endpoint-wiring.md and end with PLAN_COMPLETE.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-endpoint-wiring', {
    agent: 'implementer',
    dependsOn: ['design-endpoint-wiring'],
    task: `Read ${CLOUD}/workflows/PLAN-credential-proxy-service-endpoint-wiring.md and implement it exactly.

Rules:
- write changes to disk in ${CLOUD}
- keep edits narrow and endpoint-focused
- align with existing service-config / env wiring patterns
- add targeted verification where useful
`,
    verification: { type: 'exit_code' },
  })

  .step('verify-endpoint-wiring', {
    type: 'deterministic',
    dependsOn: ['implement-endpoint-wiring'],
    command: [
      `cd ${CLOUD}`,
      `rg -n "credentialProxyUrl|credentialProxyToken|RELAY_LLM_PROXY|CREDENTIAL_PROXY_TOKEN|CredentialProxy|proxy" infra packages/core packages/web --glob '!**/node_modules/**' --glob '!**/dist/**' | sed -n '1,260p'`,
      `echo ENDPOINT_WIRING_GREP_OK`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('run-final-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-endpoint-wiring'],
    command: [
      `cd ${CLOUD}`,
      `agent-relay run workflows/credential-proxy-e2e-verification.ts`,
    ].join(' && '),
    captureOutput: true,
    failOnError: true,
  })

  .step('review-endpoint-wiring', {
    agent: 'reviewer',
    dependsOn: ['run-final-e2e'],
    task: `Review the Cloud credential-proxy service endpoint wiring and final E2E verification.

Verification:\n{{steps.run-final-e2e.output}}

Check:
- endpoint path is explicit
- env contract reaches the sandbox
- final E2E proof is meaningful for the service-boundary architecture

End with REVIEW_COMPLETE if acceptable.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({ cwd: CLOUD });

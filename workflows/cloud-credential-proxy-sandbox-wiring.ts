import { workflow } from '@relayflows/core';
import { ClaudeModels } from '@agent-relay/sdk';

await workflow('cloud-credential-proxy-sandbox-wiring')
  .description('Wire Relay credential proxy into Cloud sandbox execution with end-to-end verification that sandboxes use proxy access rather than raw provider credentials.')
  .pattern('dag')
  .channel('wf-cloud-credential-proxy-sandbox-wiring')
  .maxConcurrency(4)
  .timeout(4_200_000)

  .agent('planner', {
    cli: 'claude',
    preset: 'lead',
    role: 'Trust-boundary planner and architecture researcher',
    model: ClaudeModels.SONNET,
    retries: 2,
  })
  .agent('impl-cloud', {
    cli: 'codex',
    preset: 'worker',
    role: 'Cloud sandbox/proxy integration implementer',
    retries: 2,
  })
  .agent('impl-qa', {
    cli: 'codex',
    preset: 'worker',
    role: 'End-to-end sandbox QA implementer',
    retries: 2,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Architecture and QA reviewer',
    model: ClaudeModels.SONNET,
    retries: 1,
  })

  .step('read-plan-doc', {
    type: 'deterministic',
    command: 'cat workflows/PLAN-cloud-credential-proxy-wiring.md',
    captureOutput: true,
    failOnError: true,
  })

  .step('capture-cloud-context', {
    type: 'deterministic',
    command: `
      set -e
      echo 'PWD='$PWD
      echo 'branch='$(git rev-parse --abbrev-ref HEAD)
      echo 'status:'
      git status --short || true
      echo 'cloud files:'
      find infra packages workflows -maxdepth 3 -type f | sort | sed -n '1,260p'
      echo 'matches:'
      rg -n "sandbox|credential proxy|credential-proxy|openrouter|proxy token|sandbox env|daytona|runner env|proxy url|budget|verification|traceback" infra packages workflows -g '!node_modules' || true
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('capture-relay-context', {
    type: 'deterministic',
    command: `
      set -e
      cd ~/Projects/AgentWorkforce/relay-credential-proxy
      echo 'relay branch='$(git rev-parse --abbrev-ref HEAD)
      echo 'relay status:'
      git status --short || true
      echo 'credential proxy files:'
      find packages/credential-proxy packages/sdk/src/workflows -maxdepth 4 -type f | sort | sed -n '1,260p'
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('plan', {
    agent: 'planner',
    dependsOn: ['read-plan-doc', 'capture-cloud-context', 'capture-relay-context'],
    task: `Create the implementation plan for wiring Relay credential proxy into Cloud sandboxes.

Plan doc:
{{steps.read-plan-doc.output}}

Cloud context:
{{steps.capture-cloud-context.output}}

Relay context:
{{steps.capture-relay-context.output}}

Return sections:
1. TRUST_BOUNDARY_MODEL
2. CLOUD_INTEGRATION_POINTS
3. SANDBOX_ENV_STRATEGY
4. E2E_TEST_STRATEGY
5. IMPLEMENTATION_PLAN
6. RISKS_AND_FOLLOWUPS

End with PLAN_COMPLETE.`,
    verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
    retries: 2,
  })

  .step('implement-cloud-wiring', {
    agent: 'impl-cloud',
    dependsOn: ['plan'],
    task: `Implement the Cloud-side wiring in the current checkout/worktree.

Plan:
{{steps.plan.output}}

Requirements:
- wire Cloud sandbox/runtime env to use Relay credential proxy access instead of raw upstream API credentials
- keep the design generic for API-based credentials, not OpenRouter-only
- add only the files/changes needed for Cloud-side integration
- write code to disk
- end by printing CHANGES_COMPLETE`,
    verification: { type: 'exit_code' },
    retries: 2,
  })

  .step('implement-e2e-qa', {
    agent: 'impl-qa',
    dependsOn: ['plan'],
    task: `Implement a deterministic end-to-end QA path in the current checkout/worktree.

Plan:
{{steps.plan.output}}

Requirements:
- create a realistic end-to-end test path for sandbox -> proxy -> provider adapter behavior
- use a fake sandbox or Docker container if that is the best practical path
- the QA path must prove that raw provider credentials are not directly present in the sandbox env while proxy-mediated calls still work
- write code/scripts/tests to disk
- end by printing CHANGES_COMPLETE`,
    verification: { type: 'exit_code' },
    retries: 2,
  })

  .step('verify-cloud-diff', {
    type: 'deterministic',
    dependsOn: ['implement-cloud-wiring', 'implement-e2e-qa'],
    // Use git status --porcelain (not git diff --quiet) so newly created
    // untracked files count as changes. Upstream agent steps are explicitly
    // told to write new files, and a bare git diff would miss them and
    // falsely fail the step.
    command: `
      set -e
      if [ -z "$(git status --porcelain)" ]; then
        echo NO_CHANGES_DETECTED
        exit 1
      fi
      git diff --stat
      echo 'Untracked files:'
      git ls-files --others --exclude-standard
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('run-e2e-qa', {
    type: 'deterministic',
    dependsOn: ['verify-cloud-diff'],
    command: `
      set -e
      npm run qa:credential-proxy
    `,
    captureOutput: true,
    failOnError: true,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['plan', 'verify-cloud-diff', 'run-e2e-qa'],
    task: `Review the Cloud credential-proxy sandbox wiring work.

Plan:
{{steps.plan.output}}

Diff summary:
{{steps.verify-cloud-diff.output}}

E2E QA output:
{{steps.run-e2e-qa.output}}

Return:
- PASS_FAIL
- what was implemented
- whether the trust boundary is actually enforced
- whether end-to-end proof is sufficient
- follow-up work still needed

End with REVIEW_COMPLETE.`,
    verification: { type: 'output_contains', value: 'REVIEW_COMPLETE' },
    retries: 1,
  })

  .run({ cwd: process.cwd() });

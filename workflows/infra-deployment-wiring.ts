/**
 * infra-deployment-wiring.ts
 *
 * Wire Cloudflare infrastructure into SST deployment so relayauth
 * and relayfile workers are actually deployable:
 *
 * 1. Wire infra/relayauth.ts and infra/relayfile.ts into sst.config.ts
 * 2. Model Cloudflare resources directly with SST components
 * 3. Set secrets and config (RelayJwtSecret plus relay service URLs)
 * 4. Add workspace cleanup cron job
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/infra-deployment-wiring.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
const result = await workflow('infra-deployment-wiring')
  .description('Wire Cloudflare workers into SST deployment, set secrets, and add cleanup')
  .pattern('dag')
  .channel('wf-infra-wiring')
  .maxConcurrency(3)
  .timeout(1_800_000)

  .agent('sst-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Wires relay service SST modules into sst.config.ts',
    cwd: CLOUD,
  })
  .agent('secrets-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Documents and scripts secret setup, adds health checks to launcher',
    cwd: CLOUD,
  })
  .agent('cleanup-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Adds workspace TTL cleanup cron job for stale relayfile workspaces',
    cwd: CLOUD,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-sst-config', {
    type: 'deterministic',
    command: `cat ${CLOUD}/sst.config.ts`,
    captureOutput: true,
  })

  .step('read-relay-service-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/relayauth.ts && echo "=== RELAYFILE ===" && cat ${CLOUD}/infra/relayfile.ts`,
    captureOutput: true,
  })

  .step('read-relayauth-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/relayauth.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/relayfile.ts`,
    captureOutput: true,
  })

  .step('read-secrets', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/secrets.ts`,
    captureOutput: true,
  })

  .step('read-launcher', {
    type: 'deterministic',
    command: `head -30 ${CLOUD}/packages/core/src/bootstrap/launcher.ts`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Three codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-sst-wiring', {
    agent: 'sst-worker',
    dependsOn: ['read-sst-config', 'read-relay-service-infra', 'read-relayauth-infra', 'read-relayfile-infra'],
    task: `Wire the relay services into the SST app using the same ownership model for every stage.

SST CONFIG:
{{steps.read-sst-config.output}}

RELAY SERVICE INFRA:
{{steps.read-relay-service-infra.output}}

RELAYAUTH SST MODULE:
{{steps.read-relayauth-infra.output}}

RELAYFILE SST MODULE:
{{steps.read-relayfile-infra.output}}

Use SST as the single deploy owner for relayauth and relayfile.

1. Import the root-level relay service modules in sst.config.ts and return their outputs.
2. Keep the Cloudflare resources and worker deploys owned by SST, not by per-package deploy config.
3. Keep production on the root relay domains and make every other stage use its own stage-prefixed hostname.
4. Keep the relay service resource definitions in the same root-level infra pattern as the rest of the app.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-secrets-and-health', {
    agent: 'secrets-worker',
    dependsOn: ['read-secrets', 'read-launcher'],
    task: `Document secret setup and add health checks to the launcher.

SECRETS:
{{steps.read-secrets.output}}

LAUNCHER:
{{steps.read-launcher.output}}

1. Create ${CLOUD}/scripts/setup-secrets.sh:
   Documents and scripts the secret setup process:

   #!/bin/bash
   # Required secrets for relay services
   echo "Setting up relay secrets..."

   # Shared JWT secret (used by both relayauth and relayfile)
   # Generate a strong random secret
   SECRET=$(openssl rand -base64 32)
   sst secret set RelayJwtSecret "$SECRET"

   echo "RelayJwtSecret configured."
   echo "Set RELAYFILE_URL and RELAYAUTH_URL in .env if you need non-default service endpoints."
   echo "Deploy with: sst deploy"

2. Edit ${CLOUD}/packages/core/src/bootstrap/launcher.ts:

   Add health check before sandbox creation:

   if (relayfileUrl) {
     const healthy = await fetch(relayfileUrl + '/health', { signal: AbortSignal.timeout(5000) })
       .then(r => r.ok)
       .catch(() => false);
     if (!healthy) {
       throw new Error('Relayfile service not healthy at ' + relayfileUrl);
     }
   }

3. Update ${CLOUD}/infra config:
   - Ensure RelayJwtSecret remains a secret
   - Move RelayauthUrl and RelayfileUrl to plain env-backed config with defaults
   - Document each config value's purpose with comments

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-workspace-cleanup', {
    agent: 'cleanup-worker',
    dependsOn: ['read-relayfile-infra'],
    task: `Add workspace TTL cleanup for stale relayfile workspaces.

RELAYFILE SST MODULE:
{{steps.read-relayfile-infra.output}}

Workspaces accumulate in relayfile D1/R2 and are never cleaned up.
Add a scheduled cleanup job.

1. Create ${CLOUD}/packages/relayfile/src/cleanup-cron.ts:

   Cloudflare Workers support scheduled triggers (cron):

   export default {
     async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
       // Find workspaces with no activity in the last 7 days
       // Delete their files from R2
       // Delete their metadata from D1
       // Log: "Cleaned up N stale workspaces"
     },
   };

   Query D1 for workspaces where last_activity < NOW() - 7 days.
   For each: DELETE files from R2, DELETE rows from D1.

2. Register the cleanup worker with an SST cron in ${CLOUD}/infra/relayfile.ts.

3. Add workspace_activity tracking:
   On every file read/write, update a last_activity timestamp
   in D1 for the workspace. This is a lightweight UPDATE on each request.

   If this is too expensive per-request, update every N minutes
   or on workspace creation only + first request per hour.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-sst-wiring', 'impl-secrets-and-health', 'impl-workspace-cleanup'],
    command: `echo "=== RELAY SERVICE INFRA ===" && test -f ${CLOUD}/infra/relayauth.ts && echo "relayauth EXISTS" || echo "MISSING" && test -f ${CLOUD}/infra/relayfile.ts && echo "relayfile EXISTS" || echo "MISSING" && echo "=== CLEANUP ===" && test -f ${CLOUD}/packages/relayfile/src/cleanup-cron.ts && echo "cleanup EXISTS" || echo "MISSING" && echo "=== HEALTH CHECK ===" && grep -c "healthy\\|health" ${CLOUD}/packages/core/src/bootstrap/launcher.ts && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'sst-worker',
    dependsOn: ['verify'],
    task: `Fix any build failures.

VERIFY:
{{steps.verify.output}}

Fix TypeScript errors. Then: cd ${CLOUD} && npx tsc --noEmit

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nInfra Deployment Wiring: ${result.status}`);
}

main().catch(console.error);

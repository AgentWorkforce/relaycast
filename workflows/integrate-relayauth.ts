/**
 * integrate-relayauth.ts
 *
 * Integrates relayauth into the cloud workflow system: mint relayauth
 * tokens for each workflow run, pass to sandbox bootstrap, use for
 * relaycast + relayfile access within the workflow.
 *
 * Depends on: @relayauth/sdk (RelayAuthClient)
 *
 * Changes:
 *   - Workflow run API: create relayauth identity + token for each run
 *   - Launcher: pass relayauth token to sandbox env
 *   - Bootstrap: use relayauth token for relaycast + relayfile access
 *   - Token scoping: workflow agents get only the scopes they need
 *   - Cleanup: revoke relayauth identity when workflow completes
 *
 * Run: agent-relay run workflows/integrate-relayauth.ts
 */

import { workflow } from '@relayflows/core';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('integrate-relayauth-cloud')
  .description('Mint relayauth tokens for workflow runs, scoped access across planes')
  .pattern('dag')
  .channel('wf-cloud-relayauth')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design the integration, review code, fix issues',
    cwd: CLOUD,
  })
  .agent('api-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Update workflow run API to create relayauth identities',
    cwd: CLOUD,
  })
  .agent('launcher-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Update launcher and bootstrap to use relayauth tokens',
    cwd: CLOUD,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write integration tests',
    cwd: CLOUD,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review for security, token lifecycle, cleanup on failure',
    cwd: CLOUD,
  })

  // ── Phase 1: Read existing code ────────────────────────────────────

  .step('read-run-route', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts`,
    captureOutput: true,
  })

  .step('read-launcher', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/launcher.ts`,
    captureOutput: true,
  })

  .step('read-bootstrap', {
    type: 'deterministic',
    command: `head -100 ${CLOUD}/packages/core/src/bootstrap/script-generator.ts`,
    captureOutput: true,
  })

  .step('read-callback', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/web/app/api/v1/workflows/callback/route.ts`,
    captureOutput: true,
  })

  .step('read-cancel-route', {
    type: 'deterministic',
    command: `cat '${CLOUD}/packages/web/app/api/v1/workflows/runs/[runId]/cancel/route.ts'`,
    captureOutput: true,
  })

  .step('read-relayauth-sdk', {
    type: 'deterministic',
    command: `cat ${RELAYAUTH}/packages/sdk/src/client.ts && echo "=== TYPES ===" && cat ${RELAYAUTH}/packages/types/src/token.ts && echo "=== IDENTITY ===" && cat ${RELAYAUTH}/packages/types/src/identity.ts`,
    captureOutput: true,
  })

  .step('read-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/web.ts | head -60`,
    captureOutput: true,
  })

  // ── Phase 2: Write tests + Implement ──────────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-run-route', 'read-relayauth-sdk'],
    task: `Write tests for cloud + relayauth integration.

Current run route:
{{steps.read-run-route.output}}

RelayAuth SDK:
{{steps.read-relayauth-sdk.output}}

Create ${CLOUD}/tests/orchestrator/relayauth-integration.test.ts:

Tests:
1. Workflow run creates a relayauth identity with:
   - name: "wf-{runId}"
   - sponsor: userId from the authenticated session
   - scopes: relaycast + relayfile + cloud scopes for the run
   - budget: { maxActionsPerHour: 1000 }
   - ttl: 1h
2. Relayauth token is passed to the sandbox via env vars
3. Token scopes include only the cross-plane actions the run needs:
   - relaycast:channel:read:wf-{runId}*
   - relaycast:message:write:wf-{runId}*
   - relaycast:dm:read:*
   - relaycast:dm:send:*
   - relayfile:fs:read:*
   - relayfile:fs:write:*
   - cloud:workflow:read:{runId}
4. On workflow completion: relayauth identity is revoked
5. On workflow failure: relayauth identity is revoked (cleanup)
6. Sub-agent tokens are scoped narrower than the run token
7. Without RELAYAUTH_URL configured: falls back to existing token system

Use node:test. Mock the RelayAuthClient.
Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('create-relayauth-client', {
    agent: 'api-dev',
    dependsOn: ['read-relayauth-sdk', 'read-infra'],
    task: `Create a relayauth client module for the cloud.

RelayAuth SDK:
{{steps.read-relayauth-sdk.output}}

Infra:
{{steps.read-infra.output}}

Create ${CLOUD}/packages/core/src/relayauth/client.ts:

1. Import { RelayAuthClient } from '@relayauth/sdk'
2. Add @relayauth/sdk as a dependency in packages/core/package.json

3. Export factory:
   export function createRelayAuthClient(): RelayAuthClient | null {
     const baseUrl = process.env.RELAYAUTH_URL;
     const apiKey = process.env.RELAYAUTH_API_KEY;
     if (!baseUrl || !apiKey) return null;
     return new RelayAuthClient({ baseUrl, apiKey });
   }

4. Export helper:
   export async function createWorkflowIdentity(
     client: RelayAuthClient,
     runId: string,
     userId: string,
     workspaceId: string,
   ): Promise<{ identityId: string; token: TokenPair }> {
     // Create identity for this workflow run
     const identity = await client.createIdentity({
       name: 'wf-' + runId.slice(0, 8),
       type: 'agent',
       sponsor: userId,
       scopes: [
         'relaycast:channel:read:wf-' + runId + '*',
         'relaycast:message:write:wf-' + runId + '*',
         'relaycast:dm:read:*',
         'relaycast:dm:send:*',
         'relayfile:fs:read:*',
         'relayfile:fs:write:*',
         'cloud:workflow:read:' + runId,
       ],
       budget: { maxActionsPerHour: 1000 },
       metadata: { runId, workspaceId },
       workspaceId,
     });
     const token = await client.issueToken(identity.id, { ttl: '1h' });
     return { identityId: identity.id, token };
   }

5. Export cleanup:
   export async function revokeWorkflowIdentity(
     client: RelayAuthClient,
     identityId: string,
   ): Promise<void> {
     await client.revokeIdentity(identityId).catch(() => {});
   }

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('update-run-route', {
    agent: 'api-dev',
    dependsOn: ['create-relayauth-client', 'read-run-route', 'write-tests'],
    task: `Update the workflow run API to create relayauth identities.

Current run route:
{{steps.read-run-route.output}}

Edit ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts:

1. Import { createRelayAuthClient, createWorkflowIdentity, revokeWorkflowIdentity }
2. After creating the token session (line ~128), add:
   const relayauthClient = createRelayAuthClient();
   let relayauthIdentityId: string | null = null;
   let relayauthToken: string | null = null;
   if (relayauthClient) {
     const ra = await createWorkflowIdentity(relayauthClient, runId, auth.userId, auth.workspaceId);
     relayauthIdentityId = ra.identityId;
     relayauthToken = ra.token.accessToken;
   }

3. Pass relayauthToken to the credential bundle or launch options

4. In the catch block (cleanup on failure), add:
   if (relayauthClient && relayauthIdentityId) {
     await revokeWorkflowIdentity(relayauthClient, relayauthIdentityId);
   }

Write changes to disk. Keep changes minimal — only add relayauth, don't refactor existing code.`,
    verification: { type: 'exit_code' },
  })

  .step('update-launcher', {
    agent: 'launcher-dev',
    dependsOn: ['read-launcher', 'read-bootstrap', 'update-run-route'],
    task: `Update launcher and bootstrap to pass relayauth token to sandboxes.

Current launcher:
{{steps.read-launcher.output}}

Current bootstrap (first 100 lines):
{{steps.read-bootstrap.output}}

Changes to launcher (${CLOUD}/packages/core/src/bootstrap/launcher.ts):
1. Add relayauthToken to LaunchOptions (optional)
2. If set, add RELAYAUTH_TOKEN to env vars passed to sandbox

Changes to script-generator (${CLOUD}/packages/core/src/bootstrap/script-generator.ts):
1. If env.RELAYAUTH_TOKEN is set:
   - Use it as the Bearer token for relaycast API calls (instead of RELAY_API_KEY)
   - Use it as the token for relayfile-mount daemon
   - Log: '[bootstrap] Using relayauth token for cross-plane auth'

Write changes to disk. Keep changes minimal.`,
    verification: { type: 'exit_code' },
  })

  .step('update-callback', {
    agent: 'api-dev',
    dependsOn: ['read-callback', 'read-cancel-route', 'create-relayauth-client'],
    task: `Update the callback route to revoke relayauth identity on completion.

Current callback:
{{steps.read-callback.output}}

Current cancel route:
{{steps.read-cancel-route.output}}

Edit ${CLOUD}/packages/web/app/api/v1/workflows/callback/route.ts and ${CLOUD}/packages/web/app/api/v1/workflows/runs/[runId]/cancel/route.ts:

When a workflow completes or fails (status === "completed" || "failed"):
1. Look up the relayauth identity ID from the run record (store it in the DB alongside the run)
2. If it exists, revoke it: await revokeWorkflowIdentity(client, identityId)

When a workflow is cancelled:
1. Revoke the relayauth identity in the cancel route too
2. Keep cancellation cleanup best-effort so the run can still be marked cancelled

This ensures relayauth tokens are cleaned up on success, failure, and cancellation.

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['update-run-route', 'update-launcher', 'update-callback'],
    command: `bash -lc 'cd ${CLOUD} && echo "=== New files ===" && ls packages/core/src/relayauth/ 2>&1 && echo "=== Typecheck ===" && set -o pipefail && npx tsc --noEmit 2>&1 | tail -10'`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Review + Fix ─────────────────────────────────────────

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['verify-files'],
    task: `Review the relayauth integration.

Build results:
{{steps.verify-files.output}}

Read changed files:
- cat ${CLOUD}/packages/core/src/relayauth/client.ts
- cat ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts
- cat ${CLOUD}/packages/web/app/api/v1/workflows/callback/route.ts
- cat '${CLOUD}/packages/web/app/api/v1/workflows/runs/[runId]/cancel/route.ts'

Verify:
1. Identity is created with correct sponsor (the human user, not the system)
2. Scopes are appropriately narrow (channel scoped to run, not all channels)
3. Cleanup happens on success, failure, and cancellation paths
4. Falls back gracefully when RELAYAUTH_URL not configured
5. Token TTL is set (no permanent tokens)
6. Budget is set on the workflow identity
7. No secrets logged or exposed`,
    verification: { type: 'exit_code' },
  })

  .step('fix', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix issues from review and typecheck.

Build: {{steps.verify-files.output}}
Review: {{steps.review.output}}

Fix all issues. Run typecheck again to verify clean.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nCloud + RelayAuth integration: ${result.status}`);
}

main().catch(console.error);

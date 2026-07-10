/**
 * integrate-relayfile-cloud.ts
 *
 * Wires relayfile into the cloud workflow system end-to-end:
 *   - Bake relayfile-mount into Daytona sandbox snapshot
 *   - Add RELAYFILE_URL to SST infra config
 *   - Update launcher + bootstrap to use relayfile for ALL workflows (not just concurrent)
 *   - Update POST /api/v1/workflows/run to create relayfile workspace + seed files
 *   - Migrate away from Daytona S3 volumes entirely
 *   - E2E test: submit a workflow via the API and verify it runs with relayfile
 *
 * Depends on: relayfile server deployed (deploy-relayfile.ts) or running locally
 * Run: agent-relay run workflows/integrate-relayfile-cloud.ts
 */

import { workflow } from '@relayflows/core';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('integrate-relayfile-cloud')
  .description('Wire relayfile into the cloud workflow system — replace Daytona volumes entirely')
  .pattern('dag')
  .channel('wf-relayfile-cloud')
  .maxConcurrency(3)
  .timeout(3_600_000)

  .agent('infra-lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'SST config, snapshot updates, infrastructure wiring',
    cwd: CLOUD,
  })
  .agent('launcher-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Update launcher, bootstrap, and executor to use relayfile',
    cwd: CLOUD,
  })
  .agent('api-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Update workflow run API to create relayfile workspaces',
    cwd: CLOUD,
  })
  .agent('snapshot-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Build relayfile-mount into the sandbox snapshot',
    cwd: CLOUD,
  })
  .agent('e2e-tester', {
    cli: 'claude',
    preset: 'lead',
    role: 'Write and run E2E integration test',
    cwd: CLOUD,
  })

  // ── Phase 1: Read current code ─────────────────────────────────────

  .step('read-launcher', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/launcher.ts`,
    captureOutput: true,
  })

  .step('read-bootstrap', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/script-generator.ts`,
    captureOutput: true,
  })

  .step('read-executor', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/executor/executor.ts`,
    captureOutput: true,
  })

  .step('read-run-route', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts`,
    captureOutput: true,
  })

  .step('read-snapshot-script', {
    type: 'deterministic',
    command: `cat ${CLOUD}/scripts/create-snapshot.ts`,
    captureOutput: true,
  })

  .step('read-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/web.ts && echo "=== SECRETS ===" && cat ${CLOUD}/infra/secrets.ts 2>/dev/null || echo "no secrets.ts"`,
    captureOutput: true,
  })

  .step('read-volume-manager', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/volumes/manager.ts`,
    captureOutput: true,
  })

  .step('read-code-transfer', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/storage/code-transfer.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-sdk', {
    type: 'deterministic',
    command: `cat ${RELAYFILE}/sdk/relayfile-sdk/src/client.ts | head -200`,
    captureOutput: true,
  })

  // ── Phase 2: Infrastructure setup ──────────────────────────────────

  .step('add-infra-config', {
    agent: 'infra-lead',
    dependsOn: ['read-infra'],
    task: `Add relayfile configuration to the SST infrastructure.

Current infra:
{{steps.read-infra.output}}

Changes needed:

1. Add RELAYFILE_URL to the SST secrets/config:
   - For local dev: http://localhost:9090 (Go server)
   - For production: https://relayfile-api.agentworkforce.workers.dev (CF Workers)
   - Add as an SST Secret or config binding, same pattern as DAYTONA_API_KEY

2. Add RELAYFILE_JWT_SECRET — shared secret for minting workspace tokens
   - Used by the cloud API to create per-workflow-run JWT tokens
   - Same secret configured in the relayfile server

3. Pass both to the web Lambda environment in infra/web.ts

4. Create ${CLOUD}/packages/core/src/relayfile/client.ts:
   - Thin wrapper that initializes the relayfile TS SDK client
   - Factory: createRelayfileClient(url, jwtSecret) that mints a JWT and returns a configured RelayFileClient
   - Token minting: sign { workspace_id, agent_name: "cloud-orchestrator", scopes: ["fs:read","fs:write","sync:read"], exp: now+3600, aud: "relayfile" }

Write all changes to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('bake-mount-into-snapshot', {
    agent: 'snapshot-dev',
    dependsOn: ['read-snapshot-script'],
    task: `Update the snapshot creation script to include relayfile-mount.

Current snapshot script:
{{steps.read-snapshot-script.output}}

The relayfile-mount binary is built from Go:
  cd ${RELAYFILE} && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o relayfile-mount ./cmd/relayfile-mount

Add to the snapshot creation process:
1. Cross-compile relayfile-mount for linux/amd64
2. Upload the binary to the snapshot sandbox at /usr/local/bin/relayfile-mount
3. chmod +x

This way every sandbox created from the snapshot has the mount daemon available.

Edit ${CLOUD}/scripts/create-snapshot.ts to include this step.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 3: Replace volumes with relayfile ────────────────────────

  .step('update-launcher', {
    agent: 'launcher-dev',
    dependsOn: ['add-infra-config', 'read-launcher', 'read-volume-manager'],
    task: `Update the launcher to use relayfile instead of Daytona volumes.

Current launcher:
{{steps.read-launcher.output}}

Current volume manager:
{{steps.read-volume-manager.output}}

Changes to ${CLOUD}/packages/core/src/bootstrap/launcher.ts:

1. Add relayfileUrl and relayfileJwtSecret to LaunchOptions

2. When relayfileUrl is set:
   - Skip volume creation entirely (no volumeManager.createCodeVolume)
   - Don't mount any volume on sandbox creation
   - Set RELAYFILE_URL and RELAYFILE_TOKEN in env vars for the bootstrap script
   - Generate a per-run JWT token for the workspace "wf-{runId}"

3. When relayfileUrl is NOT set:
   - Keep existing volume behavior as fallback
   - Log warning: "[launcher] No RELAYFILE_URL — using legacy Daytona volume"

4. Remove the auto-cleanup volume code (no longer needed when using relayfile)
   But keep it behind a flag in case volumes are still used.

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('update-bootstrap', {
    agent: 'launcher-dev',
    dependsOn: ['update-launcher', 'read-bootstrap', 'read-code-transfer'],
    task: `Update the bootstrap script to seed relayfile and start the mount daemon.

Current bootstrap:
{{steps.read-bootstrap.output}}

Current code transfer:
{{steps.read-code-transfer.output}}

Changes to ${CLOUD}/packages/core/src/bootstrap/script-generator.ts:

In initializeWorkflow(), when env.RELAYFILE_URL is set:

1. After code extraction (downloadAndExtractCode to local /project):
   - Seed relayfile workspace with all files from /project
   - Use the relayfile REST API directly (fetch):
     For each file in /project (use find to list):
       PUT /v1/workspaces/{workspaceId}/fs/file?path={relativePath}
       Body: { contentType: detectMimeType(path), content: fileContent }
   - Or if bulk API is available:
     POST /v1/workspaces/{workspaceId}/fs/bulk with all files in one request
   - Log: '[bootstrap] Seeded {N} files to relayfile workspace {workspaceId}'

2. Start relayfile-mount daemon in background:
   execSync('nohup relayfile-mount --base-url ' + env.RELAYFILE_URL + ' --workspace wf-' + runId + ' --local-dir ' + codeMountPath + ' --token ' + env.RELAYFILE_TOKEN + ' --interval 1s > /tmp/relayfile-mount.log 2>&1 &');
   Log: '[bootstrap] Started relayfile-mount daemon'

3. Skip the git baseline manifest (relayfile tracks revisions, not needed)
   Or keep it as a lightweight fallback for patch generation.

4. At workflow end (in the completion handler):
   - Kill the mount daemon
   - Final sync: run relayfile-mount --once to push any remaining changes
   - Export workspace as patch: GET /v1/workspaces/{workspaceId}/fs/export?format=patch
   - Upload patch to S3 (existing behavior)

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('update-run-route', {
    agent: 'api-dev',
    dependsOn: ['add-infra-config', 'read-run-route'],
    task: `Update the workflow run API to pass relayfile config to the launcher.

Current run route:
{{steps.read-run-route.output}}

Changes to ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts:

1. Import the relayfile URL from SST Resource or process.env:
   const relayfileUrl = optionalEnv("RELAYFILE_URL") ?? "";

2. Pass to launchOrchestratorSandbox:
   Add relayfileUrl to the launch options if it's set.

3. That's it — the launcher handles the rest.

Also create ${CLOUD}/packages/web/app/api/v1/workflows/runs/[runId]/export/route.ts:
   GET handler that proxies to relayfile's export endpoint:
   - Get the run's workspace ID (wf-{runId})
   - Fetch from relayfile: GET /v1/workspaces/wf-{runId}/fs/export?format={query.format}
   - Return the response
   - Auth: requireSessionAuth or requireAuthScope("workflow:runs:read")

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 4: E2E test ─────────────────────────────────────────────

  .step('verify-all', {
    type: 'deterministic',
    dependsOn: ['update-bootstrap', 'update-run-route', 'bake-mount-into-snapshot'],
    command: `cd ${CLOUD} && echo "=== Key files ===" && \
grep -l "RELAYFILE" packages/core/src/bootstrap/launcher.ts packages/core/src/bootstrap/script-generator.ts packages/web/app/api/v1/workflows/run/route.ts 2>/dev/null && \
echo "" && echo "=== New files ===" && \
ls packages/core/src/relayfile/ 2>/dev/null && \
echo "" && echo "=== Typecheck ===" && \
npx tsc --noEmit 2>&1 | tail -10; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('write-e2e-test', {
    agent: 'e2e-tester',
    dependsOn: ['verify-all'],
    task: `Write an E2E integration test that verifies the full relayfile cloud flow.

Typecheck results:
{{steps.verify-all.output}}

First fix any type errors if EXIT != 0.

Then create ${CLOUD}/tests/e2e-relayfile.ts:

1. Start relayfile server locally (go run ../relayfile/cmd/relayfile with RELAYFILE_BACKEND_PROFILE=memory)
2. Set RELAYFILE_URL=http://localhost:9090 in env
3. Use the existing workflow run infrastructure to launch a simple test workflow
4. Verify:
   - Sandbox was created WITHOUT a Daytona volume
   - relayfile workspace wf-{runId} was seeded with project files
   - relayfile-mount daemon started in the sandbox
   - Workflow completed successfully
   - Files are accessible via relayfile API
   - Patch was generated from relayfile export
5. Cleanup: stop relayfile server

This is the proof that the entire integration works end-to-end.
Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nCloud integration workflow: ${result.status}`);
}

main().catch(console.error);

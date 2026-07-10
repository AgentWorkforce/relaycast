/**
 * shareable-workspaces.ts
 *
 * Add shareable workspace IDs so multiple machines can join the same
 * relayfile workspace by ID — like sharing a Relaycast channel.
 *
 * Flow:
 *   Machine A: agent-relay on codex
 *     → creates workspace rw_a7f3x9k2
 *     → prints: "Join: agent-relay on <cli> --workspace rw_a7f3x9k2"
 *
 *   Machine B: agent-relay on claude --workspace rw_a7f3x9k2
 *     → joins same workspace, gets own scoped token
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/shareable-workspaces.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAY = '/Users/khaliqgant/Projects/AgentWorkforce/relay';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('shareable-workspaces')
  .description('Add shareable workspace IDs for multi-machine relay sessions')
  .pattern('dag')
  .channel('wf-shareable-ws')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('api-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Creates workspace create/join API endpoints in cloud',
    cwd: CLOUD,
  })
  .agent('id-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Implements short workspace ID generation with rw_ prefix',
    cwd: CLOUD,
  })
  .agent('cli-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Adds --workspace flag to agent-relay on for joining existing workspaces',
    cwd: RELAY,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Writes tests for workspace creation, joining, and ID generation',
    cwd: CLOUD,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-relaycast-snowflake', {
    type: 'deterministic',
    command: `cat /Users/khaliqgant/Projects/AgentWorkforce/relaycast/packages/server/src/engine/snowflake.ts`,
    captureOutput: true,
  })

  .step('read-relaycast-workspace', {
    type: 'deterministic',
    command: `head -80 /Users/khaliqgant/Projects/AgentWorkforce/relaycast/packages/server/src/engine/workspace.ts`,
    captureOutput: true,
  })

  .step('read-relay-file-access', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/relay-file-access.ts`,
    captureOutput: true,
  })

  .step('read-on-start', {
    type: 'deterministic',
    command: `cat ${RELAY}/src/cli/commands/on/start.ts 2>/dev/null || echo "NO START.TS YET"`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Four codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-workspace-id', {
    agent: 'id-worker',
    dependsOn: ['read-relaycast-snowflake'],
    task: `Implement short, shareable workspace ID generation.

RELAYCAST SNOWFLAKE (reference):
{{steps.read-relaycast-snowflake.output}}

Create ${CLOUD}/packages/core/src/workspace-id.ts:

Workspace IDs should be:
- Short and memorable (8 chars, like "a7f3x9k2")
- Prefixed with "rw_" (relay workspace)
- URL-safe (lowercase alphanumeric)
- Collision-resistant (crypto.randomBytes)

import crypto from 'node:crypto';

export function generateWorkspaceId(): string {
  // 8 chars of base36 from 5 random bytes = ~2.8 billion combinations
  const bytes = crypto.randomBytes(5);
  const id = bytes.toString('hex').slice(0, 8);
  return 'rw_' + id;
}

export function isValidWorkspaceId(id: string): boolean {
  return /^rw_[a-f0-9]{8}$/.test(id);
}

// Also support legacy wf- prefix for workflow-created workspaces
export function isValidWorkspaceIdAny(id: string): boolean {
  return isValidWorkspaceId(id) || /^wf-[a-f0-9-]+$/.test(id);
}

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-workspace-api', {
    agent: 'api-worker',
    dependsOn: ['read-relay-file-access', 'read-relaycast-workspace'],
    task: `Create workspace create/join API endpoints in cloud.

RELAY FILE ACCESS:
{{steps.read-relay-file-access.output}}

RELAYCAST WORKSPACE (reference pattern):
{{steps.read-relaycast-workspace.output}}

Create ${CLOUD}/packages/web/app/api/v1/workspaces/create/route.ts:

POST /api/v1/workspaces/create

Request:
{
  "name": "my-project",        // optional display name
  "permissions": {              // optional default permissions
    "ignored": [".env", "secrets/"],
    "readonly": ["README.md"]
  }
}

Response:
{
  "workspaceId": "rw_a7f3x9k2",
  "name": "my-project",
  "createdAt": "2026-03-27T...",
  "joinCommand": "agent-relay on <cli> --workspace rw_a7f3x9k2"
}

Implementation:
1. Generate workspace ID using generateWorkspaceId()
2. Create workspace in relayfile via API
3. If permissions specified, compile and seed ACL rules
4. Store workspace metadata (owner, name, created_at) in DB
5. Return workspace ID and join command

Create ${CLOUD}/packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts:

POST /api/v1/workspaces/:workspaceId/join

Request:
{
  "agentName": "claude",
  "scopes": ["relayfile:fs:read:*", "relayfile:fs:write:/src/*"]  // optional
}

Response:
{
  "workspaceId": "rw_a7f3x9k2",
  "token": "eyJ...",           // scoped to this agent
  "relayfileUrl": "https://api.relayfile.dev",
  "wsUrl": "wss://api.relayfile.dev/v1/workspaces/rw_a7f3x9k2/fs/ws"
}

Implementation:
1. Validate workspace exists
2. Mint scoped token for the joining agent
3. Apply workspace-level permissions (from create) + agent-specific overrides
4. Return connection config

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-cli-join', {
    agent: 'cli-worker',
    dependsOn: ['read-on-start'],
    task: `Add --workspace flag to agent-relay on for joining existing workspaces.

ON START:
{{steps.read-on-start.output}}

Edit ${RELAY}/src/cli/commands/on.ts (or on/start.ts):

Currently "agent-relay on <cli>" always creates a new workspace.
Add --workspace flag to join an existing one:

  agent-relay on codex                           # creates new workspace, prints ID
  agent-relay on claude --workspace rw_a7f3x9k2  # joins existing workspace

When --workspace is provided:
1. Skip workspace creation and file seeding
2. Call POST /api/v1/workspaces/{id}/join to get a scoped token
3. Mount the workspace using the returned relayfileUrl + token
4. Launch the agent in the mounted workspace

When no --workspace (new workspace):
1. Call POST /api/v1/workspaces/create
2. Seed files from current directory
3. Print the workspace ID and join command:
   "On the relay as codex"
   "  Workspace: rw_a7f3x9k2"
   "  Join from another machine:"
   "    agent-relay on <cli> --workspace rw_a7f3x9k2"
4. Mount and launch

Add the option to the Commander definition:
  .option('--workspace <id>', 'Join an existing relay workspace')

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-tests', {
    agent: 'test-worker',
    dependsOn: ['read-relay-file-access'],
    task: `Write tests for workspace ID generation and join flow.

Create ${CLOUD}/tests/shareable-workspaces.test.ts:

Tests:

1. TestGenerateWorkspaceId
   - ID starts with "rw_"
   - ID is 11 chars total (rw_ + 8 hex)
   - Two generated IDs are different

2. TestIsValidWorkspaceId
   - "rw_a7f3x9k2" → true
   - "rw_12345678" → true
   - "wf-abc123" → false for isValidWorkspaceId, true for isValidWorkspaceIdAny
   - "invalid" → false
   - "" → false

3. TestCreateWorkspace
   - Mock relayfile API
   - POST /api/v1/workspaces/create returns workspace ID
   - Response includes joinCommand

4. TestJoinWorkspace
   - Mock relayfile API
   - POST /api/v1/workspaces/{id}/join returns scoped token
   - Token contains correct workspace_id and agent_name

Use vitest.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-workspace-id', 'impl-workspace-api', 'impl-cli-join', 'impl-tests'],
    command: `echo "=== WORKSPACE ID ===" && test -f ${CLOUD}/packages/core/src/workspace-id.ts && echo "EXISTS" || echo "MISSING" && echo "=== CREATE API ===" && test -f ${CLOUD}/packages/web/app/api/v1/workspaces/create/route.ts && echo "EXISTS" || echo "MISSING" && echo "=== JOIN API ===" && test -f ${CLOUD}/packages/web/app/api/v1/workspaces/*/join/route.ts 2>/dev/null && echo "EXISTS" || find ${CLOUD}/packages/web/app/api/v1/workspaces -name "route.ts" 2>/dev/null | head -5 && echo "=== TESTS ===" && test -f ${CLOUD}/tests/shareable-workspaces.test.ts && echo "EXISTS" || echo "MISSING" && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'api-worker',
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

console.log(`\nShareable Workspaces: ${result.status}`);
}

main().catch(console.error);

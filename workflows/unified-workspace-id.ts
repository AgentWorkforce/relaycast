/**
 * unified-workspace-id.ts
 *
 * Single rw_ workspace ID that spans relaycast, relayfile, and relayauth.
 * One workspace, three services, one ID to share.
 *
 * - Cloud API creates unified workspace → entries in all three services
 * - SDK accepts workspaceId to link to existing workspace
 * - CLI passes workspace ID via --workspace flag
 * - Join by ID: all services resolve to the same workspace
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/unified-workspace-id.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAY = '/Users/khaliqgant/Projects/AgentWorkforce/relay';

async function main() {
const result = await workflow('unified-workspace-id')
  .description('Single rw_ workspace ID across relaycast, relayfile, and relayauth')
  .pattern('dag')
  .channel('wf-unified-ws')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('cloud-api-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Creates unified workspace API that provisions across all three services',
    cwd: CLOUD,
  })
  .agent('sdk-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Updates AgentRelay SDK to accept and propagate a unified workspaceId',
    cwd: RELAY,
  })
  .agent('id-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Implements workspace ID generation and cross-service mapping',
    cwd: CLOUD,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Writes tests for unified workspace creation and cross-service resolution',
    cwd: CLOUD,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-relay-sdk', {
    type: 'deterministic',
    command: `grep -n "workspaceId\\|workspaceKey\\|relayApiKey\\|RELAY_API_KEY\\|observerUrl" ${RELAY}/packages/sdk/src/relay.ts | head -20`,
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

  .step('read-launcher', {
    type: 'deterministic',
    command: `grep -n "workspaceId\\|relayfileUrl\\|relayApiKey\\|RELAY_API_KEY\\|RELAYFILE_WORKSPACE" ${CLOUD}/packages/core/src/bootstrap/launcher.ts | head -15`,
    captureOutput: true,
  })

  .step('read-on-start', {
    type: 'deterministic',
    command: `cat ${RELAY}/src/cli/commands/on/start.ts 2>/dev/null | head -60 || echo "NO START.TS"`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Four codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-workspace-id-and-mapping', {
    agent: 'id-worker',
    dependsOn: ['read-relaycast-workspace', 'read-relay-file-access'],
    task: `Implement unified workspace ID generation and cross-service mapping.

RELAYCAST WORKSPACE:
{{steps.read-relaycast-workspace.output}}

RELAY FILE ACCESS:
{{steps.read-relay-file-access.output}}

Create ${CLOUD}/packages/core/src/workspace/id.ts:

import crypto from 'node:crypto';

export function generateWorkspaceId(): string {
  return 'rw_' + crypto.randomBytes(5).toString('hex').slice(0, 8);
}

export function isValidWorkspaceId(id: string): boolean {
  return /^rw_[a-f0-9]{8}$/.test(id);
}

Create ${CLOUD}/packages/core/src/workspace/registry.ts:

A workspace registry that maps the unified rw_ ID to service-specific IDs.

interface WorkspaceEntry {
  id: string;                    // rw_a7f3x9k2
  name?: string;                 // display name
  relaycastApiKey: string;       // rk_live_... for messaging
  relayfileWorkspaceId: string;  // same as id (relayfile uses rw_ directly)
  relayauthWorkspaceId: string;  // same as id (relayauth wks claim)
  createdAt: string;
  createdBy: string;             // user or org ID
}

// In-memory for local, DB-backed for cloud
interface WorkspaceRegistry {
  create(opts: { name?: string; createdBy: string }): Promise<WorkspaceEntry>;
  get(id: string): Promise<WorkspaceEntry | null>;
  join(id: string, agentName: string): Promise<{
    entry: WorkspaceEntry;
    token: string;              // scoped JWT for this agent
  }>;
}

export class CloudWorkspaceRegistry implements WorkspaceRegistry {
  constructor(
    private relaycastBaseUrl: string,
    private relayfileBaseUrl: string,
    private jwtSecret: string,
  ) {}

  async create(opts) {
    const id = generateWorkspaceId();

    // 1. Create relaycast workspace → get API key
    const relaycastRes = await fetch(this.relaycastBaseUrl + '/v1/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.name || id }),
    });
    const { api_key } = await relaycastRes.json();

    // 2. Create relayfile workspace with same ID
    // (relayfile workspace creation happens on first file write,
    // or via the CLI seed command — no explicit create API needed)

    // 3. Return unified entry
    return {
      id,
      name: opts.name,
      relaycastApiKey: api_key,
      relayfileWorkspaceId: id,
      relayauthWorkspaceId: id,
      createdAt: new Date().toISOString(),
      createdBy: opts.createdBy,
    };
  }

  async get(id) { /* lookup from DB or cache */ }

  async join(id, agentName) {
    const entry = await this.get(id);
    if (!entry) throw new Error('workspace not found: ' + id);
    // Mint scoped token with wks = id
    const token = mintToken({ workspace: id, agentName, secret: this.jwtSecret });
    return { entry, token };
  }
}

export class LocalWorkspaceRegistry implements WorkspaceRegistry {
  // For agent-relay on (local mode)
  // Stores entries in .relay/workspaces.json
  // Creates relaycast workspace via API if RELAY_API_KEY available
  // Otherwise skips relaycast (messaging not available locally)
}

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-cloud-api', {
    agent: 'cloud-api-worker',
    dependsOn: ['read-relay-file-access', 'read-launcher'],
    task: `Create unified workspace API that provisions across all three services.

RELAY FILE ACCESS:
{{steps.read-relay-file-access.output}}

LAUNCHER CONTEXT:
{{steps.read-launcher.output}}

Create ${CLOUD}/packages/web/app/api/v1/workspaces/route.ts:

POST /api/v1/workspaces — create a unified workspace

Request:
{
  "name": "my-project",
  "permissions": {
    "ignored": [".env", "secrets/"],
    "readonly": ["README.md"]
  }
}

Response:
{
  "workspaceId": "rw_a7f3x9k2",
  "relaycastApiKey": "rk_live_...",
  "relayfileUrl": "https://api.relayfile.dev",
  "relayauthUrl": "https://api.relayauth.dev",
  "joinCommand": "agent-relay on <cli> --workspace rw_a7f3x9k2",
  "createdAt": "..."
}

GET /api/v1/workspaces/:id — get workspace details

POST /api/v1/workspaces/:id/join — join with agent identity

Request:
{
  "agentName": "claude",
  "permissions": { "readonly": ["*"] }  // optional overrides
}

Response:
{
  "workspaceId": "rw_a7f3x9k2",
  "token": "eyJ...",
  "relaycastApiKey": "rk_live_...",
  "relayfileUrl": "...",
  "wsUrl": "wss://..."
}

Implementation uses CloudWorkspaceRegistry from workspace/registry.ts.

Also update ${CLOUD}/packages/core/src/bootstrap/launcher.ts:
- When launching a workflow, create a unified workspace ID
- Pass the SAME rw_ ID to relayfile (RELAYFILE_WORKSPACE),
  relaycast (via RELAY_API_KEY mapping), and relayauth (wks in JWT)
- Replace the old 'wf-' + runId pattern with the unified rw_ ID

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-sdk-workspace', {
    agent: 'sdk-worker',
    dependsOn: ['read-relay-sdk', 'read-on-start'],
    task: `Update the AgentRelay SDK and CLI to accept and propagate a unified workspaceId.

SDK WORKSPACE REFERENCES:
{{steps.read-relay-sdk.output}}

ON START:
{{steps.read-on-start.output}}

1. Edit ${RELAY}/packages/sdk/src/relay.ts:

Add a workspaceId option to AgentRelayOptions:
  interface AgentRelayOptions {
    workspaceId?: string;  // unified rw_ workspace ID
    // ... existing options
  }

When workspaceId is provided:
- Use it as the relayfile workspace: RELAYFILE_WORKSPACE=rw_xxx
- Use it in JWT claims: wks=rw_xxx, workspace_id=rw_xxx
- Look up or create the relaycast API key for this workspace
- Pass to all spawned agents via env vars

When workspaceId is NOT provided (current behavior):
- Auto-generate one (generateWorkspaceId() or let relaycast create one)
- Store it for other agents to join

2. Edit ${RELAY}/src/cli/commands/on/start.ts:

When agent-relay on creates a workspace:
- Generate rw_ ID
- Print it clearly:
  "On the relay as codex"
  "  Workspace: rw_a7f3x9k2"
  "  Join: agent-relay on <cli> --workspace rw_a7f3x9k2"

When --workspace is provided:
- Skip workspace creation
- Call cloud join API (or locally: look up in .relay/workspaces.json)
- Use the returned token and relaycast key

3. Store workspace mapping locally in .relay/workspaces.json:
{
  "rw_a7f3x9k2": {
    "relaycastApiKey": "rk_live_...",
    "relayfileUrl": "http://127.0.0.1:8080",
    "createdAt": "...",
    "agents": ["codex", "claude"]
  }
}

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-tests', {
    agent: 'test-worker',
    dependsOn: ['read-relay-file-access'],
    task: `Write tests for unified workspace creation and cross-service resolution.

Create ${CLOUD}/tests/unified-workspace.test.ts:

Tests:

1. TestGenerateWorkspaceId
   - Starts with "rw_"
   - 11 chars total
   - Two IDs are different

2. TestCloudWorkspaceRegistryCreate
   - Mock relaycast API (returns api_key)
   - Verify workspace entry has all three service IDs
   - All three IDs reference the same rw_ value

3. TestCloudWorkspaceRegistryJoin
   - Create workspace, then join as "claude"
   - Verify returned token has wks=rw_xxx
   - Verify returned relaycastApiKey matches the workspace

4. TestUnifiedIdInJWT
   - Mint token for workspace rw_a7f3x9k2
   - Decode and verify: wks = "rw_a7f3x9k2", workspace_id = "rw_a7f3x9k2"

5. TestLauncherUsesUnifiedId
   - Mock launcher flow
   - Verify RELAYFILE_WORKSPACE env var uses rw_ ID (not wf- prefix)
   - Verify RELAY_API_KEY maps to the same workspace

Use vitest. Mock HTTP for relaycast/relayfile APIs.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-workspace-id-and-mapping', 'impl-cloud-api', 'impl-sdk-workspace', 'impl-tests'],
    command: `echo "=== WORKSPACE ID ===" && test -f ${CLOUD}/packages/core/src/workspace/id.ts && echo "EXISTS" || echo "MISSING" && echo "=== REGISTRY ===" && test -f ${CLOUD}/packages/core/src/workspace/registry.ts && echo "EXISTS" || echo "MISSING" && echo "=== API ===" && test -f ${CLOUD}/packages/web/app/api/v1/workspaces/route.ts && echo "EXISTS" || echo "MISSING" && echo "=== SDK ===" && grep -c "workspaceId" ${RELAY}/packages/sdk/src/relay.ts 2>/dev/null && echo "=== TESTS ===" && test -f ${CLOUD}/tests/unified-workspace.test.ts && echo "EXISTS" || echo "MISSING" && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'cloud-api-worker',
    dependsOn: ['verify'],
    task: `Fix any build failures.

VERIFY:
{{steps.verify.output}}

Fix TypeScript errors in both repos:
  cd ${CLOUD} && npx tsc --noEmit
  cd ${RELAY} && npx tsc --noEmit

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nUnified Workspace ID: ${result.status}`);
}

main().catch(console.error);

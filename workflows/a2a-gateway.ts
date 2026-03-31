/**
 * a2a-gateway.ts
 *
 * Phase 1 of the A2A Platform (RFC 001): A2A Gateway
 *
 * Makes relaycast an A2A-compliant gateway. External A2A agents register
 * their Agent Cards, get a Relay identity, and can communicate with
 * Relay agents using standard A2A JSON-RPC.
 *
 * Implements:
 *   - A2A agent registration (POST /v1/a2a/register)
 *   - Relay → A2A message translation (DM → JSON-RPC SendMessage)
 *   - A2A → Relay webhook handling (JSON-RPC → DM)
 *   - Agent Card serving (/.well-known/agent-card.json)
 *   - Health checking for external agents
 *   - SSE ↔ WebSocket streaming bridge
 *   - A2H (Agent-to-Human) bridging via INPUT_REQUIRED
 *   - SDK updates: registerA2a(), listA2aAgents()
 *
 * See: specs/001-a2a-platform.md (Sections 3, 8 Phase 1)
 *
 * Run: agent-relay run workflows/a2a-gateway.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';

async function main() {
const result = await workflow('a2a-gateway')
  .description('A2A Gateway — route between A2A agents and Relay workspaces')
  .pattern('dag')
  .channel('wf-a2a-gateway')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('gateway-architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design gateway internals, protocol translation, DB schema, review all code',
    cwd: RELAYCAST,
  })
  .agent('server-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement A2A routes, JSON-RPC handling, webhook endpoints',
    cwd: RELAYCAST,
  })
  .agent('engine-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement gateway engine — message translation, health checking, task state mapping',
    cwd: RELAYCAST,
  })
  .agent('sdk-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Update TypeScript and Python SDKs with A2A methods',
    cwd: RELAYCAST,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E and unit tests for the gateway',
    cwd: RELAYCAST,
  })
  .agent('integrator', {
    cli: 'claude',
    preset: 'lead',
    role: 'Wire everything together, fix types, run tests',
    cwd: RELAYCAST,
  })

  // ── Phase 1: Read existing code + spec ─────────────────────────────

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/specs/001-a2a-platform.md`,
    captureOutput: true,
  })

  .step('read-worker', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/worker.ts`,
    captureOutput: true,
  })

  .step('read-agent-routes', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/routes/agent.ts`,
    captureOutput: true,
  })

  .step('read-dm-routes', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/routes/dm.ts`,
    captureOutput: true,
  })

  .step('read-command-routes', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/routes/command.ts`,
    captureOutput: true,
  })

  .step('read-agent-do', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/durable-objects/agent.ts`,
    captureOutput: true,
  })

  .step('read-webhook-routes', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/routes/inboundWebhook.ts`,
    captureOutput: true,
  })

  .step('read-db-schema', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/packages/server/src/db/migrations/0000_broad_dagger.sql | head -100`,
    captureOutput: true,
  })

  .step('read-engine-agent', {
    type: 'deterministic',
    command: `ls ${RELAYCAST}/packages/server/src/engine/ && head -50 ${RELAYCAST}/packages/server/src/engine/agent.ts`,
    captureOutput: true,
  })

  .step('read-ts-sdk', {
    type: 'deterministic',
    command: `grep -n "class\|async\|export" ${RELAYCAST}/packages/sdk-typescript/src/index.ts | head -40`,
    captureOutput: true,
  })

  .step('read-wrangler', {
    type: 'deterministic',
    command: `cat ${RELAYCAST}/wrangler.toml`,
    captureOutput: true,
  })

  .step('read-e2e', {
    type: 'deterministic',
    command: `head -200 ${RELAYCAST}/scripts/e2e.ts`,
    captureOutput: true,
  })

  // ── Phase 2: Architect designs the gateway ─────────────────────────

  .step('design-gateway', {
    agent: 'gateway-architect',
    dependsOn: [
      'read-spec', 'read-worker', 'read-agent-routes', 'read-dm-routes',
      'read-command-routes', 'read-agent-do', 'read-webhook-routes',
      'read-db-schema', 'read-engine-agent', 'read-wrangler',
    ],
    task: `Design the A2A gateway implementation plan.

The spec (Sections 3, 3.1-3.12):
{{steps.read-spec.output}}

Existing infrastructure to build on:
- Agent routes: {{steps.read-agent-routes.output}}
- DM routes (message passing): {{steps.read-dm-routes.output}}
- Command routes (proto-tool-execution): {{steps.read-command-routes.output}}
- Webhook routes (inbound): {{steps.read-webhook-routes.output}}
- Agent DO: {{steps.read-agent-do.output}}
- DB schema: {{steps.read-db-schema.output}}
- Wrangler config: {{steps.read-wrangler.output}}

Write an implementation plan at ${RELAYCAST}/docs/a2a-gateway-implementation.md:

1. **DB migration** — new a2a_agents table (from spec Section 3.7)
2. **Engine layer** — packages/server/src/engine/a2a.ts:
   - registerA2aAgent(workspaceId, agentCard, auth)
   - translateRelayToA2a(dmMessage) → JSON-RPC SendMessage
   - translateA2aToRelay(jsonRpcMessage) → DM
   - mapTaskState(a2aState) → relaycast equivalent
   - healthCheck(agentUrl) → boolean
3. **Routes** — packages/server/src/routes/a2a.ts:
   - POST /v1/a2a/register
   - DELETE /v1/a2a/agents/:name
   - GET /v1/a2a/agents
   - GET /v1/a2a/agents/:name/card
   - GET /.well-known/agent-card.json (per-workspace)
   - POST /a2a/rpc (JSON-RPC 2.0 endpoint)
   - POST /a2a/webhook/:agent_name
4. **DM hook** — intercept DMs to A2A agents, translate to JSON-RPC, forward
5. **Webhook handler** — receive A2A JSON-RPC, translate to DM, route to target agent
6. **Health checker** — background job (DO alarm or Queue) pinging external agents every 5min
7. **SSE ↔ WebSocket bridge** — translate streaming between protocols

Be specific about which existing files need changes vs new files.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 3: Parallel implementation ──────────────────────────────

  .step('implement-db-migration', {
    agent: 'server-dev',
    dependsOn: ['design-gateway', 'read-db-schema'],
    task: `Create the D1 migration for A2A agents.

Implementation plan:
{{steps.design-gateway.output}}

Create ${RELAYCAST}/packages/server/src/db/migrations/0003_a2a_agents.sql:

Follow the schema from the spec (Section 3.7):
- a2a_agents table with all fields
- Index on workspace_id
- Foreign key to agents table (relay_agent_id)

Also update the Drizzle schema if one exists, or create the migration SQL directly.
Check the existing migration pattern in 0000_broad_dagger.sql.

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-engine', {
    agent: 'engine-dev',
    dependsOn: ['design-gateway', 'read-engine-agent', 'read-dm-routes'],
    task: `Implement the A2A gateway engine.

Implementation plan:
{{steps.design-gateway.output}}

Existing engine pattern:
{{steps.read-engine-agent.output}}

Create ${RELAYCAST}/packages/server/src/engine/a2a.ts:

1. registerA2aAgent(db, workspaceId, { agentCardUrl, agentCard, authScheme?, authCredential? }):
   - Fetch agent card from URL if not provided inline
   - Validate required Agent Card fields (name, url, version, skills)
   - Create a Relay agent identity for the external agent (prefix: "ext-")
   - Insert into a2a_agents table
   - Run Level 1 health check
   - Return { relayName, relayToken, webhookUrl, certification }

2. translateRelayToA2a(message: RelayDM): A2aJsonRpcRequest
   - Map DM text → A2A Message with TextPart
   - Map thread ID → contextId
   - Map attachments → FilePart or DataPart
   - Return JSON-RPC 2.0 envelope: { jsonrpc: "2.0", method: "message/send", params: { message } }

3. translateA2aToRelay(jsonRpc: A2aJsonRpcRequest): RelayDM
   - Extract message parts → DM text
   - Map contextId → thread ID
   - Map A2A artifacts → Relay attachments

4. sendToExternalAgent(agentUrl, jsonRpcPayload, auth): Promise<A2aResponse>
   - HTTP POST to external agent's URL
   - Handle auth (bearer token or API key)
   - Retry with backoff (3 attempts)
   - Parse A2A Task response

5. mapTaskState(a2aState): string
   - Map A2A task states to Relay equivalents (per spec Section 3.8)

6. healthCheckAgent(agentUrl): Promise<boolean>
   - GET {agentUrl}/.well-known/agent-card.json
   - Return true if 200, false otherwise

7. A2A type definitions (inline or separate file):
   - A2aAgentCard, A2aMessage, A2aPart, A2aTask, A2aTaskState
   - JsonRpcRequest, JsonRpcResponse

Write the complete engine to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-routes', {
    agent: 'server-dev',
    dependsOn: ['design-gateway', 'implement-db-migration', 'read-agent-routes', 'read-webhook-routes'],
    task: `Implement the A2A gateway routes.

Implementation plan:
{{steps.design-gateway.output}}

Existing route patterns:
Agent routes: {{steps.read-agent-routes.output}}
Webhook routes: {{steps.read-webhook-routes.output}}

Create ${RELAYCAST}/packages/server/src/routes/a2a.ts:

1. POST /v1/a2a/register — register external A2A agent
   - Auth required (requireAuth middleware)
   - Body: { agent_card_url?: string, agent_card?: object, auth_scheme?: string, auth_credential?: string }
   - Call engine.registerA2aAgent()
   - Return { ok: true, data: { relay_name, relay_token, webhook_url, certification } }

2. DELETE /v1/a2a/agents/:name — remove external A2A agent
   - Auth required
   - Delete from a2a_agents, deactivate relay agent

3. GET /v1/a2a/agents — list A2A agents in workspace
   - Auth required
   - Return { ok: true, data: agents[] }

4. GET /v1/a2a/agents/:name/card — get agent card
   - Auth required
   - Return the stored Agent Card JSON

5. GET /.well-known/agent-card.json — workspace Agent Card
   - No auth (public endpoint)
   - Extract workspace from hostname or path
   - Return composite Agent Card listing all agents in workspace

6. POST /a2a/rpc — JSON-RPC 2.0 endpoint
   - Validate JSON-RPC envelope
   - Route based on method: message/send, message/stream, task/get, task/cancel
   - Translate to Relay operations
   - Return JSON-RPC response

7. POST /a2a/webhook/:agent_name — receive A2A messages for proxied agents
   - Validate HMAC signature or bearer token
   - Translate A2A message to Relay DM
   - Route to target agent in workspace
   - Return A2A Task response

Also update ${RELAYCAST}/packages/server/src/worker.ts:
- Import and mount a2aRoutes
- Add the /.well-known route before other routes

Write all files to disk.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-dm-hook', {
    agent: 'engine-dev',
    dependsOn: ['implement-engine', 'implement-routes', 'read-dm-routes'],
    task: `Hook into the DM system to intercept messages to A2A agents.

DM routes:
{{steps.read-dm-routes.output}}

When a Relay agent sends a DM to an agent that is an external A2A agent:
1. Look up the target agent in a2a_agents table
2. If it's an A2A agent: translate the DM to JSON-RPC, forward to external URL
3. If it's a regular Relay agent: proceed normally

The cleanest approach: add a middleware/hook in the DM send path that checks
if the target is an A2A agent before the normal DM flow.

Edit the DM engine (not the route) to add this check. Find where DMs are
actually dispatched and add the A2A intercept there.

Also implement the reverse: when an A2A response comes back via webhook,
create a DM from the external agent to the original sender.

Write changes to disk. Be minimal — only touch what's necessary.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-health-checker', {
    agent: 'engine-dev',
    dependsOn: ['implement-engine'],
    task: `Implement periodic health checking for external A2A agents.

Use a DO alarm or Queue consumer to ping external agents every 5 minutes:
1. List all active a2a_agents
2. For each: GET {external_url}/.well-known/agent-card.json
3. Track consecutive failures
4. After 3 failures: mark agent as suspended
5. Update last_health timestamp

Create ${RELAYCAST}/packages/server/src/engine/a2a-health.ts

The simplest approach: use a Cloudflare Cron Trigger (wrangler.toml [triggers])
that runs every 5 minutes and iterates over active A2A agents.

Or add it to an existing DO's alarm cycle.

Write to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 4: SDK updates ──────────────────────────────────────────

  .step('update-ts-sdk', {
    agent: 'sdk-dev',
    dependsOn: ['implement-routes', 'read-ts-sdk'],
    task: `Update the TypeScript SDK with A2A methods.

Current SDK structure:
{{steps.read-ts-sdk.output}}

Add these methods to the SDK:

1. registerA2a(options: { agentCardUrl?: string, agentCard?: object, authScheme?: string, authCredential?: string }):
   POST /v1/a2a/register

2. listA2aAgents(): GET /v1/a2a/agents

3. removeA2aAgent(name: string): DELETE /v1/a2a/agents/:name

4. getA2aAgentCard(name: string): GET /v1/a2a/agents/:name/card

Read the SDK source to find the right file to edit:
ls ${RELAYCAST}/packages/sdk-typescript/src/

Add the methods following existing patterns. Include TypeScript types for
A2A Agent Cards and registration responses.

Write changes to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 5: Tests ─────────────────────────────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['implement-routes', 'implement-dm-hook', 'implement-health-checker'],
    task: `Write tests for the A2A gateway.

Read existing test patterns:
cat ${RELAYCAST}/packages/server/src/__tests__/test-helpers.ts
cat ${RELAYCAST}/packages/server/src/__tests__/index.test.ts | head -100

Create ${RELAYCAST}/packages/server/src/__tests__/a2a.test.ts:

1. Test A2A registration:
   - Register with agent card URL
   - Register with inline agent card
   - Verify relay agent is created
   - Verify webhook URL is returned

2. Test message translation:
   - Relay DM → A2A JSON-RPC SendMessage
   - A2A JSON-RPC response → Relay DM
   - Thread ID ↔ contextId mapping

3. Test webhook handling:
   - A2A JSON-RPC message arrives via webhook
   - Message is routed to correct Relay agent
   - Response flows back

4. Test health checking:
   - Healthy agent returns 200 → stays active
   - Unhealthy agent returns 500 3x → marked suspended

5. Test Agent Card serving:
   - GET /.well-known/agent-card.json returns valid A2A card

Also add A2A steps to the E2E test:
Read ${RELAYCAST}/scripts/e2e.ts and add a section that:
- Registers a mock A2A agent
- Sends a message to it
- Verifies the roundtrip

Write all tests to disk.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 6: Integration ──────────────────────────────────────────

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'update-ts-sdk'],
    command: `cd ${RELAYCAST} && echo "=== New/modified files ===" && \
ls -la packages/server/src/routes/a2a.ts packages/server/src/engine/a2a.ts packages/server/src/engine/a2a-health.ts 2>/dev/null && \
echo "" && echo "=== Migration ===" && \
ls packages/server/src/db/migrations/*a2a* 2>/dev/null || echo "No A2A migration" && \
echo "" && echo "=== Tests ===" && \
ls packages/server/src/__tests__/a2a* 2>/dev/null || echo "No A2A tests"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('integrate-and-typecheck', {
    agent: 'integrator',
    dependsOn: ['verify-files'],
    task: `Wire everything together and fix type errors.

File status:
{{steps.verify-files.output}}

1. Verify worker.ts imports and mounts a2aRoutes
2. Verify wrangler.toml has any needed triggers (cron for health check)
3. Run: cd ${RELAYCAST} && npx turbo build 2>&1 | tail -30
4. Fix any type errors
5. Run tests: npx turbo test 2>&1 | tail -30
6. Fix any test failures

Iterate until both build and tests pass.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYCAST,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nA2A Gateway workflow: ${result.status}`);
}

main().catch(console.error);

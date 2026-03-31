# A2A Gateway Implementation Plan

**Status:** Draft
**Spec:** RFC 001, Sections 3.1-3.12
**Branch:** `a2a-implementation`
**Target:** Phase 1 (A2A Gateway only)

---

## Overview

Add A2A protocol support to Relaycast so external A2A agents can register, send, and receive messages through Relay workspaces. This plan covers the gateway layer only (spec Sections 3.1-3.12) — registry, observability, certification, and smart routing are future phases.

---

## 1. Database Migration

**New file:** `packages/server/src/db/migrations/0004_add_a2a_agents.sql`

```sql
CREATE TABLE `a2a_agents` (
    `id`               TEXT PRIMARY KEY NOT NULL,
    `workspace_id`     TEXT NOT NULL REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
    `relay_agent_id`   TEXT NOT NULL REFERENCES `agents`(`id`) ON DELETE CASCADE,
    `agent_card`       TEXT NOT NULL DEFAULT '{}',   -- JSON: full A2A AgentCard
    `external_url`     TEXT NOT NULL,
    `auth_scheme`      TEXT,                          -- "bearer", "api_key", NULL
    `auth_credential`  TEXT,                          -- encrypted credential
    `status`           TEXT NOT NULL DEFAULT 'active', -- active, suspended, revoked
    `messages_sent`    INTEGER NOT NULL DEFAULT 0,
    `messages_recv`    INTEGER NOT NULL DEFAULT 0,
    `last_health`      INTEGER,                       -- unix epoch
    `health_failures`  INTEGER NOT NULL DEFAULT 0,    -- consecutive failures for 3-strike rule
    `created_at`       INTEGER NOT NULL DEFAULT (unixepoch()),
    `updated_at`       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX `idx_a2a_agents_workspace` ON `a2a_agents` (`workspace_id`);
CREATE UNIQUE INDEX `idx_a2a_agents_relay_agent` ON `a2a_agents` (`relay_agent_id`);
```

**Modify:** `packages/server/src/db/schema.ts`

Add `a2aAgents` table definition (Drizzle schema) after the existing `agents` table. References `workspaces.id` and `agents.id`. Export the table so engine/route layers can import it.

**Key decisions:**
- Each A2A agent gets a corresponding row in the existing `agents` table (type `'a2a'`). This makes A2A agents visible in `list_agents()` and addressable via `relay.send()` with zero changes to the existing DM/channel system.
- The `a2a_agents` table stores A2A-specific metadata (card, external URL, auth, health) as a 1:1 extension of the agents row.
- `health_failures` column tracks consecutive failures (spec 3.12: 3 strikes → suspended).

---

## 2. Engine Layer

**New file:** `packages/server/src/engine/a2a.ts`

This is the core translation layer. All functions follow the existing engine pattern (accept `Db` as first arg, pure data operations, no HTTP concerns).

### 2.1 `registerA2aAgent(db, workspaceId, opts)`

```typescript
type RegisterA2aOpts = {
  agentCardUrl: string;          // URL to fetch Agent Card from
  agentCard?: A2AAgentCard;      // or provide card directly
  authScheme?: 'bearer' | 'api_key';
  authCredential?: string;
};

type RegisterA2aResult = {
  id: string;
  relay_name: string;            // e.g. "ext-billing-a3f2"
  relay_token: string;           // agent token for the proxy agent
  webhook_url: string;           // POST here to send A2A messages to this agent
};
```

**Steps:**
1. Fetch Agent Card from `agentCardUrl` if not provided inline (validate required fields: `name`, `url`, `version`).
2. Generate a relay name: `ext-{slugified-card-name}-{4-hex}`.
3. Create a row in `agents` table with `type: 'a2a'`, `status: 'online'`, `persona` from card description.
4. Create a row in `a2a_agents` table linking to the new agent row, storing the full card JSON, external URL, and auth.
5. Return relay name, token, and webhook URL.

**Pattern reference:** Follows `engine/inboundWebhook.ts` — creates a system agent identity to represent the external entity, similar to `__relay_webhook__`.

### 2.2 `removeA2aAgent(db, workspaceId, relayName)`

Delete from `a2a_agents` and the corresponding `agents` row. Returns boolean (found/not found).

### 2.3 `listA2aAgents(db, workspaceId)`

Join `a2a_agents` with `agents` to return list with status, card summary, message counts, health info.

### 2.4 `getA2aAgentByName(db, workspaceId, relayName)`

Lookup by relay name, return full agent card + metadata.

### 2.5 `translateRelayToA2a(dmMessage) -> A2AJsonRpcRequest`

Translate a Relaycast DM into an A2A `SendMessage` JSON-RPC 2.0 call:

```typescript
// Input: { id, text, from_name, conversation_id, thread_id?, attachments? }
// Output:
{
  jsonrpc: "2.0",
  id: dmMessage.id,               // use message ID as JSON-RPC request ID
  method: "message/send",
  params: {
    message: {
      role: "user",
      parts: [{ type: "text", text: dmMessage.text }],
      // TODO: map attachments to FilePart in future iteration
    },
    configuration: {
      contextId: dmMessage.conversation_id,  // preserve context (spec 3.9)
    }
  }
}
```

### 2.6 `translateA2aToRelay(jsonRpcMessage, senderRelayAgentId) -> RelayDmPayload`

Translate an inbound A2A JSON-RPC `SendMessage` into a Relay DM:

```typescript
// Input: JSON-RPC params with message.parts[], extensions.relay_target
// Output: { to: targetAgentName, text: concatenated text parts, from_agent_id }
```

Extract `relay_target` from `extensions` (spec 3.5). Concatenate all `TextPart` content. Map `FilePart` to attachments in future iteration.

### 2.7 `mapTaskState(a2aState) -> string`

Static mapping from spec Section 3.8:

| A2A State | Relay Equivalent |
|---|---|
| `submitted` | `received` |
| `working` | `processing` |
| `input-required` | `human_input_needed` |
| `completed` | `completed` |
| `failed` | `failed` |
| `canceled` | `canceled` |

Returns a string status. Used in event payloads and logging.

### 2.8 `healthCheck(externalUrl) -> { healthy: boolean; card?: A2AAgentCard }`

```typescript
// GET {externalUrl}/.well-known/agent-card.json
// Timeout: 10s
// Returns { healthy: true, card } on 200 with valid JSON
// Returns { healthy: false } on timeout, non-200, or invalid response
```

### 2.9 `updateHealthStatus(db, a2aAgentId, healthy)`

Increment or reset `health_failures`. If `health_failures >= 3`, set `status = 'suspended'` on both `a2a_agents` and `agents` rows. Update `last_health` timestamp.

### 2.10 `forwardToExternalAgent(a2aAgent, jsonRpcPayload) -> A2AJsonRpcResponse`

HTTP client that sends JSON-RPC to the external agent's URL with proper auth headers:
- If `auth_scheme = 'bearer'`: `Authorization: Bearer {credential}`
- If `auth_scheme = 'api_key'`: `X-API-Key: {credential}`
- Content-Type: `application/json`
- Timeout: 30s
- On success: increment `messages_sent`, return parsed response
- On failure: throw typed error

### 2.11 `buildWorkspaceAgentCard(db, workspaceId, baseUrl) -> A2AAgentCard`

Build a composite Agent Card for the workspace (served at `/.well-known/agent-card.json`):
- Name: workspace name
- URL: `{baseUrl}/a2a/rpc`
- Skills: aggregate skills from all agents in workspace
- Capabilities: `{ streaming: false }` (Phase 1 — no SSE bridge yet)

---

## 3. Route Layer

**New file:** `packages/server/src/routes/a2a.ts`

Hono router following existing patterns (zod validation, `requireWorkspaceKey` middleware, `rateLimit`, error handling shape).

### 3.1 `POST /v1/a2a/register`

**Auth:** `requireWorkspaceKey`

```typescript
const registerA2aSchema = z.object({
  agent_card_url: z.string().url().optional(),
  agent_card: z.object({
    name: z.string().min(1),
    url: z.string().url(),
    version: z.string().min(1),
  }).passthrough().optional(),
  auth_scheme: z.enum(['bearer', 'api_key']).optional(),
  auth_credential: z.string().optional(),
}).refine(d => d.agent_card_url || d.agent_card, {
  message: 'Either agent_card_url or agent_card is required',
});
```

Returns `201` with `{ relay_name, relay_token, webhook_url }`.

### 3.2 `DELETE /v1/a2a/agents/:name`

**Auth:** `requireWorkspaceKey`

Removes the A2A agent and its proxy agent row. Returns `204`.

### 3.3 `GET /v1/a2a/agents`

**Auth:** `requireWorkspaceKey`

Lists all A2A agents in the workspace with status, card summary, message counts.

### 3.4 `GET /v1/a2a/agents/:name/card`

**Auth:** `requireWorkspaceKey`

Returns the full A2A Agent Card JSON for a specific registered agent.

### 3.5 `GET /.well-known/agent-card.json`

**Auth:** `requireWorkspaceKey`

Serves the workspace-level Agent Card (spec 3.6). Calls `buildWorkspaceAgentCard()`.

**Note:** This route is mounted at the app level in `worker.ts`, not under `/v1`, since the A2A spec requires it at the well-known path.

### 3.6 `POST /a2a/rpc`

**Auth:** `requireWorkspaceKey`

JSON-RPC 2.0 endpoint for the workspace. Dispatches based on `method`:

| Method | Handler |
|---|---|
| `message/send` | Translate to DM via `translateA2aToRelay()`, call `dmEngine.sendDm()` |
| `message/stream` | Return `501 Not Implemented` (Phase 1) |
| `tasks/get` | Map to thread lookup |
| `tasks/cancel` | Return `501 Not Implemented` (Phase 1) |
| `agent/authenticatedExtendedCard` | Return workspace agent card |

Error responses follow JSON-RPC 2.0 error format:
```json
{ "jsonrpc": "2.0", "id": "...", "error": { "code": -32601, "message": "Method not found" } }
```

### 3.7 `POST /a2a/webhook/:agent_name`

**Auth:** None (webhook URL contains the agent identity; rate-limited)

Receives A2A JSON-RPC messages destined for a specific proxied agent (spec 3.5). This is how external A2A agents initiate messages to Relay agents.

1. Look up the A2A agent by `agent_name`
2. Validate JSON-RPC envelope
3. Call `translateA2aToRelay()` to extract target and text
4. Call `dmEngine.sendDm()` using the A2A agent's proxy identity as sender
5. Increment `messages_recv`
6. Return JSON-RPC success response with task state mapping

---

## 4. DM Interception Hook

**Modify:** `packages/server/src/routes/dm.ts` (POST `/v1/dm` handler)

After the existing `sendDm()` call succeeds, add an A2A forwarding check:

```typescript
// After idempotent sendDm completes:
if (!idempotent.replayed) {
  // Check if recipient is an A2A agent
  const a2aAgent = await a2aEngine.getA2aAgentByRelayAgentId(db, workspace.id, recipientAgentId);
  if (a2aAgent && a2aAgent.status === 'active') {
    // Fire-and-forget: translate and forward to external agent
    const jsonRpc = a2aEngine.translateRelayToA2a(idempotent.data);
    runInBackground(c, a2aEngine.forwardToExternalAgent(a2aAgent, jsonRpc).then(async (response) => {
      // Translate A2A response back to a DM reply
      if (response.result?.message) {
        await dmEngine.sendDm(db, workspace.id, a2aAgent.relayAgentId, {
          to: agent!.name,
          text: extractTextFromParts(response.result.message.parts),
        });
      }
    }), 'a2a-forward');
  }
}
```

**Key point:** The DM is stored in Relaycast first (existing behavior preserved), then forwarded to the external A2A agent asynchronously. The response comes back as a new DM from the A2A proxy agent. This keeps the existing DM flow untouched for non-A2A agents.

**New engine helper needed:** `getA2aAgentByRelayAgentId(db, workspaceId, agentId)` — lookup by the proxy agent's ID (used during DM interception to check if recipient is A2A).

---

## 5. Health Checker

**Option A (recommended): Queue-based**

Use the existing `WEBHOOK_QUEUE` pattern with a new queue or a cron trigger.

**Modify:** `wrangler.toml`

```toml
[triggers]
crons = ["*/5 * * * *"]   # every 5 minutes
```

**Modify:** `packages/server/src/worker.ts`

Add a `scheduled` handler to the worker export:

```typescript
async scheduled(event: ScheduledEvent, env: CloudflareBindings, ctx: ExecutionContext) {
  if (event.cron === '*/5 * * * *') {
    ctx.waitUntil(a2aHealthChecker.runAll(env));
  }
}
```

**New file:** `packages/server/src/engine/a2aHealth.ts`

```typescript
export async function runAll(env: CloudflareBindings) {
  const db = getDb(env.DB);
  const activeAgents = await db.select().from(a2aAgents).where(eq(a2aAgents.status, 'active'));

  // Fan out health checks (max 50 concurrent, respect CF subrequest limits)
  const results = await Promise.allSettled(
    activeAgents.map(agent => healthCheck(agent.externalUrl))
  );

  // Update status for each agent
  for (let i = 0; i < activeAgents.length; i++) {
    const healthy = results[i].status === 'fulfilled' && results[i].value.healthy;
    await updateHealthStatus(db, activeAgents[i].id, healthy);
  }
}
```

**3-strike rule (spec 3.12):** `health_failures` increments on each failed check, resets to 0 on success. At `>= 3`, agent is marked `suspended` and hidden from `list_agents()`.

---

## 6. SSE <-> WebSocket Bridge (Phase 1 Stub)

**Deferred.** Phase 1 returns `501 Not Implemented` for `message/stream`. The bridge (spec 3.10) is complex and not required for basic gateway functionality.

**Placeholder in `routes/a2a.ts`:**
```typescript
case 'message/stream':
  return c.json({
    jsonrpc: '2.0',
    id: rpcId,
    error: { code: -32601, message: 'Streaming not supported in Phase 1' },
  });
```

**Future work (Phase 1.5):** When implementing, the gateway will:
1. Accept SSE `SendStreamingMessage` at `/a2a/rpc`
2. Buffer partial results
3. Deliver complete response via WebSocket `dm.received` event to the Relay agent
4. For outbound streaming: listen for WebSocket typing/response events and emit SSE `TaskStatusUpdate` events

---

## 7. Context Preservation (Spec 3.9)

**No new tables needed.** Map A2A `contextId` to Relaycast conversation/thread IDs:

- **Inbound A2A -> Relay:** Store `contextId` in the DM conversation metadata (use existing `metadata` JSON field on `dm_conversations` or pass as message metadata).
- **Relay -> Outbound A2A:** Use `conversation_id` as the `contextId` in outbound JSON-RPC `configuration.contextId`.
- **Lookup:** When an inbound A2A message includes a `contextId`, check if a conversation with that context already exists. If so, route to the same conversation thread.

**Modify:** `packages/server/src/engine/a2a.ts` — add `contextId` mapping in `translateRelayToA2a()` and `translateA2aToRelay()`.

---

## 8. File Changes Summary

### New Files

| File | Purpose |
|---|---|
| `packages/server/src/db/migrations/0004_add_a2a_agents.sql` | Migration for `a2a_agents` table |
| `packages/server/src/engine/a2a.ts` | Core A2A translation, registration, forwarding |
| `packages/server/src/engine/a2aHealth.ts` | Health check runner (cron-triggered) |
| `packages/server/src/routes/a2a.ts` | HTTP routes for A2A endpoints |
| `packages/server/src/types/a2a.ts` | TypeScript types for A2A protocol (AgentCard, JsonRpc, Task, etc.) |

### Modified Files

| File | Change |
|---|---|
| `packages/server/src/db/schema.ts` | Add `a2aAgents` Drizzle table definition |
| `packages/server/src/worker.ts` | Import + mount `a2aRoutes`, add `scheduled` handler for health checks, mount `/.well-known/agent-card.json` |
| `packages/server/src/routes/dm.ts` | Add A2A forwarding check after `sendDm()` |
| `packages/server/src/env.ts` | No changes needed (uses existing bindings) |
| `wrangler.toml` | Add cron trigger `*/5 * * * *` |
| `packages/server/src/routes/fanout.ts` | No changes — A2A events use existing fanout |

### Not Modified

| File | Reason |
|---|---|
| `packages/server/src/durable-objects/agent.ts` | A2A agents use existing AgentDO — no DO changes needed |
| `packages/server/src/engine/dm.ts` | DM engine unchanged — A2A hook lives in the route layer |
| `packages/server/src/middleware/auth.ts` | Reuse `requireWorkspaceKey`; webhook endpoint uses rate limiting only |

---

## 9. Implementation Order

```
Step 1: Types + Schema
  ├── packages/server/src/types/a2a.ts (A2A protocol types)
  ├── packages/server/src/db/schema.ts (add a2aAgents table)
  └── packages/server/src/db/migrations/0004_add_a2a_agents.sql

Step 2: Engine (core logic, no HTTP)
  ├── packages/server/src/engine/a2a.ts
  │   ├── registerA2aAgent()
  │   ├── removeA2aAgent()
  │   ├── listA2aAgents()
  │   ├── getA2aAgentByName()
  │   ├── getA2aAgentByRelayAgentId()
  │   ├── translateRelayToA2a()
  │   ├── translateA2aToRelay()
  │   ├── mapTaskState()
  │   ├── forwardToExternalAgent()
  │   └── buildWorkspaceAgentCard()
  └── packages/server/src/engine/a2aHealth.ts
      ├── healthCheck()
      ├── updateHealthStatus()
      └── runAll()

Step 3: Routes
  └── packages/server/src/routes/a2a.ts
      ├── POST   /v1/a2a/register
      ├── DELETE  /v1/a2a/agents/:name
      ├── GET    /v1/a2a/agents
      ├── GET    /v1/a2a/agents/:name/card
      ├── GET    /.well-known/agent-card.json
      ├── POST   /a2a/rpc
      └── POST   /a2a/webhook/:agent_name

Step 4: Wire up
  ├── packages/server/src/worker.ts (mount routes, add scheduled handler)
  └── wrangler.toml (add cron)

Step 5: DM interception
  └── packages/server/src/routes/dm.ts (A2A forwarding hook)

Step 6: Health checker
  └── wrangler.toml + worker.ts scheduled handler

Step 7: Tests
  ├── packages/server/src/engine/__tests__/a2a.test.ts
  ├── packages/server/src/routes/__tests__/a2a.test.ts
  └── E2E: Relay agent <-> mock A2A agent roundtrip
```

---

## 10. Open Questions for Phase 1

1. **Auth credential storage:** The spec says `auth_credential` is "encrypted." On Cloudflare Workers we don't have at-rest encryption for D1. Options: (a) store plaintext in D1 (acceptable for Phase 1 with workspace-key-gated access), (b) encrypt with a per-workspace key derived from the API key hash, (c) store in KV with encryption. **Recommendation:** Option (a) for Phase 1, upgrade to (b) before GA.

2. **Agent Card validation depth:** Should we validate the full A2A Agent Card spec on registration, or just `name`, `url`, `version`? **Recommendation:** Validate required fields only; store the rest as-is.

3. **Webhook auth for `/a2a/webhook/:agent_name`:** The URL is unguessable (contains agent name suffix), but should we add HMAC verification? **Recommendation:** Rate limit only for Phase 1; add optional HMAC in Phase 1.5.

4. **Response timeout:** External A2A agents may be slow. The DM interception runs in `runInBackground()` which has a ~30s limit on Workers. **Recommendation:** 30s timeout on `forwardToExternalAgent()`. For longer tasks, return the DM immediately and poll/wait for async response via webhook.

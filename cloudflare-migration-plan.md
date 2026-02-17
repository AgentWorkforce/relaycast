# Plan: Migrate from Fly.io to Cloudflare Workers + Durable Objects

## Context

The Relaycast server currently runs as a containerized Express app on Fly.io with Postgres, Redis, and Tigris. The goal is to migrate to a fully serverless Cloudflare-native architecture using Workers, Durable Objects, Queues, R2, and Hyperdrive, with Neon as managed Postgres. No data migration — fresh start.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Edge API Worker (Hono)                         │
│  REST: auth, channels, messages, files, search  │
│  Validates JWT/token, issues realtime tokens    │
└────────┬──────────┬──────────┬─────────┬────────┘
         │          │          │         │
    ┌────▼────┐ ┌───▼───┐ ┌───▼──┐ ┌───▼────┐
    │ Channel │ │AgentDO│ │Queues│ │  R2    │
    │   DO    │ │  WS   │ │async │ │ files  │
    │seq+fan  │ │ inbox │ │ jobs │ │        │
    └────┬────┘ └───▲───┘ └───┬──┘ └────────┘
         │          │          │
         └──────────┘          │
    ┌───────────┐              │
    │PresenceDO │              │
    │ heartbeat │              │
    └─────┬─────┘              │
          │                    │
    ┌─────▼────────────────────▼──────────────┐
    │  Neon Postgres (via Hyperdrive)          │
    │  messages, channels, agents, memberships │
    └─────────────────────────────────────────┘
```

### Single WebSocket per agent

Every agent connects to **one** WebSocket via their **AgentDO**. All event types (channel messages, DMs, reactions, presence) are delivered through this single connection.

```
Client ←── WS ──→ AgentDO ←── internal ── ChannelDO (seq + fanout)
                            ←── internal ── PresenceDO (heartbeat)
                            ←── internal ── Edge Worker (DMs)
```

| DO | Client WS? | Role |
|---|---|---|
| **AgentDO** | Yes (1 per agent) | Single WebSocket, receives ALL events |
| **ChannelDO** | No (internal only) | Sequencing (`channel_seq`) + fanout to member AgentDOs |
| **PresenceDO** | No (internal only) | Heartbeat tracking, broadcasts online/offline to AgentDOs |

## Decisions

| Concern | Decision |
|---------|----------|
| HTTP framework | Hono on Cloudflare Workers |
| Realtime/WebSocket | Durable Objects with WebSocket hibernation (1 WS per agent) |
| Database | Neon Postgres via Hyperdrive |
| Async jobs | Cloudflare Queues (webhooks, notifications, retries) |
| Scheduled tasks | DO Alarms (cleanup, digest flush) |
| File storage | Cloudflare R2 (presigned URLs) |
| Search | Postgres FTS (tsvector) for now |
| Rate limiting | In-Worker with KV-based counters |
| Idempotency | Postgres-based (upsert with idempotency key) |
| Static site | Cloudflare Pages (unchanged) |
| Dashboard | Cloudflare Pages with @cloudflare/next-on-pages |
| API domain | api.relaycast.dev (Cloudflare DNS, already there) |
| Deploy tool | Wrangler |
| Data migration | None — fresh start |

---

## Step 1: Project setup

### New file: `wrangler.toml`

```toml
name = "relaycast-api"
main = "packages/server/src/worker.ts"
compatibility_date = "2024-12-01"
node_compat = true

[vars]
ENVIRONMENT = "production"

# Hyperdrive (Neon Postgres)
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<hyperdrive-id>"
localConnectionString = "postgresql://relay:relay@localhost:5433/relay"

# R2 bucket
[[r2_buckets]]
binding = "FILES_BUCKET"
bucket_name = "relaycast-files"

# Queues - producers
[[queues.producers]]
binding = "WEBHOOK_QUEUE"
queue = "relaycast-webhooks"

[[queues.producers]]
binding = "NOTIFICATION_QUEUE"
queue = "relaycast-notifications"

# Queues - consumers
[[queues.consumers]]
queue = "relaycast-webhooks"
max_batch_size = 50
max_retries = 5
dead_letter_queue = "relaycast-webhooks-dlq"

[[queues.consumers]]
queue = "relaycast-notifications"
max_batch_size = 50
max_retries = 3

# Durable Objects
[durable_objects]
bindings = [
  { name = "CHANNEL_DO", class_name = "ChannelDO" },
  { name = "AGENT_DO", class_name = "AgentDO" },
  { name = "PRESENCE_DO", class_name = "PresenceDO" },
]

[[migrations]]
tag = "v1"
new_classes = ["ChannelDO", "AgentDO", "PresenceDO"]

# KV namespace (rate limiting)
[[kv_namespaces]]
binding = "KV"
id = "<kv-namespace-id>"

# Cron triggers
[triggers]
crons = ["0 * * * *"]  # Every hour (cleanup)

# Secrets (set via `wrangler secret put`)
# STRIPE_SECRET_KEY
# STRIPE_WEBHOOK_SECRET
# R2_ACCESS_KEY (for presigned URLs)
# R2_SECRET_KEY
```

### Setup steps:
1. Create Neon project + database
2. `wrangler hyperdrive create relaycast-db --connection-string="<neon-connection-string>"`
3. `wrangler r2 bucket create relaycast-files`
4. `wrangler queues create relaycast-webhooks`
5. `wrangler queues create relaycast-notifications`
6. `wrangler queues create relaycast-webhooks-dlq`
7. `wrangler kv namespace create RELAYCAST_KV`
8. `wrangler secret put STRIPE_SECRET_KEY`
9. `wrangler secret put STRIPE_WEBHOOK_SECRET`
10. `wrangler secret put R2_ACCESS_KEY`
11. `wrangler secret put R2_SECRET_KEY`

---

## Step 2: Worker entry point (Hono)

**New file: `packages/server/src/worker.ts`**

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ChannelDO } from './durable-objects/channel';
import { AgentDO } from './durable-objects/agent';
import { PresenceDO } from './durable-objects/presence';

// Type the Cloudflare bindings
type Env = {
  Bindings: {
    HYPERDRIVE: Hyperdrive;
    FILES_BUCKET: R2Bucket;
    WEBHOOK_QUEUE: Queue;
    NOTIFICATION_QUEUE: Queue;
    CHANNEL_DO: DurableObjectNamespace;
    AGENT_DO: DurableObjectNamespace;
    PRESENCE_DO: DurableObjectNamespace;
    KV: KVNamespace;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    ENVIRONMENT: string;
  };
};

const app = new Hono<Env>();

app.use('*', cors());
app.use('*', secureHeaders());

// Mount routes...
app.route('/health', healthRoutes);
app.route('/v1', v1Routes);
app.route('/mcp', mcpRoutes);
app.route('/.well-known', discoveryRoutes);

app.onError((err, c) => {
  return c.json({ ok: false, error: { code: 'internal_error', message: err.message } }, 500);
});

// Export Worker + DO classes + Queue consumer + Cron handler
export default {
  fetch: app.fetch,
  queue: async (batch, env) => { /* Queue consumer handler */ },
  scheduled: async (event, env, ctx) => { /* Hourly cleanup */ },
};
export { ChannelDO, AgentDO, PresenceDO };
```

### Database access pattern (Hyperdrive + Drizzle):

```ts
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

// In each request handler:
const sql = neon(c.env.HYPERDRIVE.connectionString);
const db = drizzle(sql);
```

**Key change:** Instead of a singleton DB connection (current `getDb()`), create a per-request connection via Hyperdrive. Hyperdrive handles pooling transparently. This requires modifying `packages/server/src/db/index.ts` to accept a connection string parameter rather than reading `process.env.DATABASE_URL`.

---

## Step 3: Durable Objects for realtime

### AgentDO — the single client-facing WebSocket actor

**New file: `packages/server/src/durable-objects/agent.ts`**

Each agent gets one DO instance. This is the **only** WebSocket connection an agent needs. All events flow through it.

Responsibilities:
- Accept the agent's WebSocket connection (with hibernation)
- Receive events from ChannelDO (channel messages, reactions, member events)
- Receive DMs from Edge Worker (1:1 and group)
- Receive presence events from PresenceDO
- Maintain `agent_seq` for ordering and resync across all event types
- Handle reconnect/resync via `last_seen_seq`

```ts
export class AgentDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      // WebSocket upgrade — the agent's single realtime connection
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Validate token, store agent metadata via serializeAttachment
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/deliver') {
      // Called by ChannelDO, PresenceDO, or Edge Worker to push an event
      const event = await request.json();
      const seq = await this.state.storage.get<number>('agent_seq') || 0;
      const nextSeq = seq + 1;
      await this.state.storage.put('agent_seq', nextSeq);

      const payload = JSON.stringify({ ...event, seq: nextSeq });
      for (const ws of this.state.getWebSockets()) {
        ws.send(payload);
      }
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    const data = JSON.parse(message);
    if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
    if (data.type === 'resync') {
      // Replay all missed events from Postgres where seq > data.last_seen_seq
      // Query across messages, DMs, reactions etc. ordered by timestamp
    }
  }

  async webSocketClose(ws: WebSocket) {}
  async webSocketError(ws: WebSocket) { ws.close(); }
}
```

### ChannelDO — internal sequencing + fanout (NO client WebSocket)

**New file: `packages/server/src/durable-objects/channel.ts`**

Each channel gets its own DO. It handles sequencing (`channel_seq`) and fans out events to each member's AgentDO. Clients never connect to it directly.

Responsibilities:
- Maintain monotonic `channel_seq` for message ordering
- Know channel members (cached from Postgres, refreshed on join/leave)
- Fan out events to each member's AgentDO

```ts
export class ChannelDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      // Called by Edge Worker after message write
      const { event, workspaceId } = await request.json();

      // Increment channel sequence
      const seq = await this.state.storage.get<number>('channel_seq') || 0;
      const nextSeq = seq + 1;
      await this.state.storage.put('channel_seq', nextSeq);

      const eventWithSeq = { ...event, channel_seq: nextSeq };

      // Get channel members (cached in DO storage)
      const members = await this.state.storage.get<string[]>('members') || [];

      // Fan out to each member's AgentDO
      const deliveries = members.map(agentId => {
        const doId = this.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
        const stub = this.env.AGENT_DO.get(doId);
        return stub.fetch(new Request('http://do/deliver', {
          method: 'POST',
          body: JSON.stringify(eventWithSeq),
        }));
      });
      await Promise.all(deliveries);

      return Response.json({ channel_seq: nextSeq });
    }

    if (url.pathname === '/update-members') {
      // Called when members join/leave
      const { members } = await request.json();
      await this.state.storage.put('members', members);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}
```

### PresenceDO — per-workspace presence tracking

**New file: `packages/server/src/durable-objects/presence.ts`**

- Tracks heartbeats per agent (via DO Alarm for TTL-based expiry)
- Publishes `agent.online` / `agent.offline` events to affected AgentDOs
- Uses DO Alarm: set alarm for earliest expiry, sweep stale agents on alarm fire

```ts
export class PresenceDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/heartbeat') {
      const { agentId, workspaceId } = await request.json();
      const wasOnline = await this.state.storage.get(`agent:${agentId}`);
      await this.state.storage.put(`agent:${agentId}`, Date.now());
      await this.state.storage.setAlarm(Date.now() + 65_000);

      // If newly online, notify all agents via their AgentDOs
      if (!wasOnline) {
        await this.broadcastPresence(workspaceId, {
          type: 'agent.online', data: { agent_id: agentId }
        });
      }
      return new Response('ok');
    }
    if (url.pathname === '/status') {
      const agents = await this.state.storage.list({ prefix: 'agent:' });
      const now = Date.now();
      const online = [];
      for (const [key, lastSeen] of agents) {
        if (now - (lastSeen as number) < 60_000) {
          online.push(key.replace('agent:', ''));
        }
      }
      return Response.json({ agents: online });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const agents = await this.state.storage.list({ prefix: 'agent:' });
    const workspaceId = await this.state.storage.get<string>('workspaceId');
    const now = Date.now();
    for (const [key, lastSeen] of agents) {
      if (now - (lastSeen as number) > 60_000) {
        const agentId = key.replace('agent:', '');
        await this.state.storage.delete(key);
        if (workspaceId) {
          await this.broadcastPresence(workspaceId, {
            type: 'agent.offline', data: { agent_id: agentId }
          });
        }
      }
    }
    if (agents.size > 0) {
      await this.state.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async broadcastPresence(workspaceId: string, event: any) {
    const agents = await this.state.storage.list({ prefix: 'agent:' });
    const now = Date.now();
    const deliveries = [];
    for (const [key, lastSeen] of agents) {
      if (now - (lastSeen as number) < 60_000) {
        const agentId = key.replace('agent:', '');
        const doId = this.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
        const stub = this.env.AGENT_DO.get(doId);
        deliveries.push(stub.fetch(new Request('http://do/deliver', {
          method: 'POST', body: JSON.stringify(event),
        })));
      }
    }
    await Promise.all(deliveries);
  }
}
```

---

## Step 4: WebSocket connection flow

### Connection model: ONE connection per agent

Agent connects to a single WebSocket URL. All events (channel messages, DMs, reactions, presence) are delivered through it.

```
wss://api.relaycast.dev/v1/ws?token=<short-lived-token>
```

### Client connection protocol:

1. Client calls `POST /v1/realtime/connect` with Bearer token
2. Edge Worker validates token, returns:
   ```json
   { "url": "wss://api.relaycast.dev/v1/ws?token=<short-lived-token>" }
   ```
3. Client connects to the single WebSocket
4. All events arrive with a global `seq` (for resync) and `channel_seq` (for per-channel ordering)
5. On reconnect, client sends `{ type: "resync", last_seen_seq: N }`
6. AgentDO replays missed events from Postgres

### Edge Worker WebSocket route:

```ts
app.get('/v1/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected WebSocket', 426);
  const { workspaceId, agentId } = validateToken(c.req.query('token'));
  const doId = c.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
  return c.env.AGENT_DO.get(doId).fetch(c.req.raw);
});
```

### Event flows:

**Channel message:**
```ts
// Edge Worker: POST /v1/channels/:name/messages
// 1. Write to Postgres
const message = await createMessage(db, { ... });
// 2. Tell ChannelDO to sequence + fan out to all members' AgentDOs
const doId = c.env.CHANNEL_DO.idFromName(`${workspaceId}:${channelId}`);
await c.env.CHANNEL_DO.get(doId).fetch(new Request('http://do/broadcast', {
  method: 'POST',
  body: JSON.stringify({ event: { type: 'message.created', data: message }, workspaceId }),
}));
// 3. Enqueue webhook delivery
await c.env.WEBHOOK_QUEUE.send({ type: 'message.created', workspaceId, data: message });
```

**DM (1:1):**
```ts
// Edge Worker: POST /v1/dm
// 1. Write to Postgres
const dm = await createDm(db, { senderId, recipientId, content });
// 2. Deliver directly to recipient's AgentDO (no ChannelDO needed)
const doId = c.env.AGENT_DO.idFromName(`${workspaceId}:${recipientId}`);
await c.env.AGENT_DO.get(doId).fetch(new Request('http://do/deliver', {
  method: 'POST',
  body: JSON.stringify({ type: 'dm.received', data: dm }),
}));
```

**Group DM:**
```ts
// Edge Worker: POST /v1/dm/:conversation_id/messages
// 1. Write to Postgres
const dm = await createGroupDm(db, { conversationId, senderId, content });
// 2. Fan out to all participants' AgentDOs
const participants = await getConversationParticipants(db, conversationId);
await Promise.all(
  participants
    .filter(id => id !== senderId)
    .map(agentId => {
      const doId = c.env.AGENT_DO.idFromName(`${workspaceId}:${agentId}`);
      return c.env.AGENT_DO.get(doId).fetch(new Request('http://do/deliver', {
        method: 'POST',
        body: JSON.stringify({ type: 'group_dm.received', data: dm }),
      }));
    })
);
```

**Presence:**
```ts
// Handled automatically by PresenceDO → broadcasts to all online AgentDOs
```

---

## Step 5: Migrate routes from Express to Hono

~70 endpoints across 20 route files. Mechanical migration — route signatures change, business logic (engine layer) stays mostly the same.

### Key differences from Express to Hono on Workers:

| Express | Hono on Workers |
|---------|----------------|
| `req.body` | `c.req.json()` (async) |
| `req.query.param` | `c.req.query('param')` |
| `req.params.name` | `c.req.param('name')` |
| `req.workspace` | `c.get('workspace')` |
| `res.json(data)` | `c.json(data)` |
| `res.status(404).json()` | `c.json(data, 404)` |
| `process.env.X` | `c.env.X` (bindings) |
| `getDb()` singleton | `getDb(c.env.HYPERDRIVE.connectionString)` per-request |

### Strategy:
- Keep `packages/server/src/engine/` business logic — modify to accept `db` parameter instead of using singleton
- Rewrite route handler wrappers to Hono syntax
- Port middleware to Hono middleware

### Middleware to port:

| Middleware | Change |
|-----------|--------|
| Auth (3 variants) | Hono middleware, `c.set()`/`c.get()` for workspace/agent |
| Rate limiting | KV-based counters (replace Redis INCR) |
| Idempotency | Postgres upsert with idempotency key column (replace Redis) |
| Presence refresh | Forward heartbeat to PresenceDO |
| Usage tracking | KV atomic counters or Postgres |
| Plan limits | Read usage from KV/Postgres |

### Route files to port (all in `packages/server/src/routes/`):
health, workspace, agents, channels, messages, threads, dm, reactions, files, search, inbox, receipts, presence, systemPrompt, webhooks, subscriptions, commands, dashboard, billing

---

## Step 6: Async jobs via Cloudflare Queues

### Replace `setInterval`-based event queue with Queues

**Current:** `setInterval` polls `pending_events` table every 2s, processes webhook deliveries.

**New:** When an event occurs, enqueue it immediately. Queue consumer processes it.

```ts
// Producer (in route handler):
await c.env.WEBHOOK_QUEUE.send({
  type: 'message.created',
  workspaceId,
  subscriptionId,
  payload: eventData,
});

// Consumer (in worker.ts export):
export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch, env: Env) => {
    for (const msg of batch.messages) {
      try {
        await deliverWebhook(env, msg.body);
        msg.ack();
      } catch (err) {
        msg.retry(); // Auto-retries with backoff, up to max_retries
      }
    }
  },
};
```

**Benefits over polling:**
- No 2s polling delay — events process immediately
- Built-in retries with backoff
- Dead-letter queue for failed deliveries
- No need for `pending_events` DB table (can remove it and its migration)

### Scheduled tasks:

| Current job | Replacement |
|------------|-------------|
| Event queue poller (2s) | Queues (immediate processing) |
| Agent stale sweep (60s) | PresenceDO alarm |
| Event cleanup (60min) | Cron Trigger (`scheduled` handler) |

---

## Step 7: File storage with R2

**Modify: `packages/server/src/engine/file.ts`**

**Simplest approach:** Keep using `@aws-sdk/client-s3` but point at R2's S3-compatible API:
```ts
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY },
});
```
This minimizes changes to the existing file.ts presigned URL logic.

For direct R2 binding operations (server-side reads/deletes):
```ts
const object = await c.env.FILES_BUCKET.get(key);
await c.env.FILES_BUCKET.delete(key);
```

---

## Step 8: Database changes

### Drizzle with Neon + Hyperdrive

**Modify: `packages/server/src/db/index.ts`**

Replace singleton Postgres connection with per-request Hyperdrive connection:

```ts
import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';

export function getDb(connectionString: string) {
  const sql = neon(connectionString);
  return drizzle(sql);
}

// In route handlers:
const db = getDb(c.env.HYPERDRIVE.connectionString);
```

**Schema changes:**
- Add `channel_seq` column to messages table (bigint, per-channel monotonic sequence)
- Add index on `(channel_id, channel_seq)` for resync queries
- Add `idempotency_keys` table (replaces Redis-based idempotency)
- Can remove `pending_events` table (replaced by Queues)

### Migrations:
- Migrations still use Drizzle Kit
- Run via `drizzle-kit push` against Neon directly (not on app startup)

---

## Step 9: Rate limiting + Idempotency (no Redis)

### Rate limiting via KV

```ts
async function rateLimit(c, next) {
  const key = `rate:${workspaceId}:${routeKey}:${window}`;
  const current = await c.env.KV.get(key, 'json') || { count: 0 };
  if (current.count >= limit) {
    return c.json({ ok: false, error: { code: 'rate_limited' } }, 429);
  }
  await c.env.KV.put(key, JSON.stringify({ count: current.count + 1 }), { expirationTtl: 60 });
  await next();
}
```

Note: KV is eventually consistent. For strict rate limiting, use a RateLimiting DO. For this use case, approximate (KV) is sufficient.

### Idempotency via Postgres

```sql
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_idem_expires ON idempotency_keys (expires_at);
```

Use `INSERT ... ON CONFLICT DO NOTHING` for lock acquisition, `SELECT` for replay.
Cleanup via scheduled cron: `DELETE FROM idempotency_keys WHERE expires_at < NOW()`.

---

## Step 10: MCP endpoint

MCP uses Streamable HTTP (SSE responses). On Workers, SSE streaming is supported natively.

**Approach:** Use a Durable Object per MCP session (`McpSessionDO`).
- Stores transport state in DO storage
- Each MCP request routes to the same DO via session ID
- DO hibernates between requests
- Natural fit for the actor model

```ts
export class McpSessionDO implements DurableObject {
  async fetch(request: Request) {
    // Load/create MCP transport
    // Process MCP request
    // Return SSE response
  }
}
```

Add to `wrangler.toml`:
```toml
{ name = "MCP_SESSION_DO", class_name = "McpSessionDO" }
```

---

## Step 11: Snowflake worker ID

**File: `packages/server/src/engine/snowflake.ts`**

On Workers, there's no `FLY_MACHINE_ID` or `HOSTNAME`. Use `crypto.randomUUID()` at module load:

```ts
const workerId = fnv1a10Bits(crypto.randomUUID());
```

Collision risk is low in the 10-bit space for the volume of IDs being generated. Alternatively, use Postgres sequences for guaranteed uniqueness.

---

## Step 12: Update GitHub Actions

**File: `.github/workflows/deploy.yml`**

Replace Fly.io deploy with Wrangler:

```yaml
deploy:
  name: Deploy to Cloudflare Workers
  runs-on: ubuntu-latest
  needs: ci
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npx wrangler deploy
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**Remove:** `FLY_API_TOKEN` secret
**Keep:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## Step 13: Cleanup

### Remove:
- `deploy/fly.toml`
- `deploy/Dockerfile`
- `deploy/scripts/` (migrate.sh, setup.sh, tigris-setup.sh)
- `packages/server/src/ws/` directory (replaced by AgentDO WebSocket)
- `packages/server/src/redis/` directory (replaced by KV + Postgres + DO)
- `packages/server/src/index.ts` (Express server entry, replaced by worker.ts)
- `packages/server/src/app.ts` (Express app, replaced by worker.ts)
- Fly.io-specific code (fly-replay headers)

### Keep:
- `docker-compose.yml` (local dev: Postgres + MinIO)
- `packages/server/src/engine/` (business logic, modified to accept db param)
- `packages/server/src/db/` (Drizzle schema + migrations)

### Update `packages/server/package.json`:
**Remove:** `express`, `@types/express`, `ws`, `@types/ws`, `helmet`, `cors`, `@types/cors`, `ioredis`, `postgres` (driver)
**Add:** `hono`, `@neondatabase/serverless`, `drizzle-orm/neon-http`, `wrangler` (devDep)

---

## Step 14: Dashboard (Next.js on Cloudflare Pages)

The dashboard (`packages/dashboard/`, `@relaycast/dashboard`) is a Next.js 14 app that provides a UI for viewing agents, channels, messages, threads, and reactions.

### Deploy to Cloudflare Pages with `@cloudflare/next-on-pages`:

1. Add `@cloudflare/next-on-pages` as devDep to `packages/dashboard/`
2. Add `wrangler.toml` for the dashboard Pages project
3. Update `next.config.js` for edge runtime compatibility
4. Dashboard API routes (`/api/data`, `/api/send`, etc.) become edge functions on Pages

**Dashboard wrangler config** (`packages/dashboard/wrangler.toml`):
```toml
name = "relaycast-dashboard"
compatibility_date = "2024-12-01"
pages_build_output_dir = ".vercel/output/static"
```

**Build command:** `npx @cloudflare/next-on-pages`

**Environment variables:**
- `RELAY_API_URL` — points to `https://api.relaycast.dev`

**GitHub Actions deploy step:**
```yaml
deploy-dashboard:
  name: Deploy Dashboard
  runs-on: ubuntu-latest
  needs: ci
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22, cache: npm }
    - run: npm ci
    - run: npx turbo build --filter=@relaycast/dashboard
    - run: npx wrangler pages deploy packages/dashboard/.vercel/output/static --project-name=relaycast-dashboard
      env:
        CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

---

## New dependencies

| Package | Where | Purpose |
|---------|-------|---------|
| `hono` | packages/server | HTTP framework for Workers |
| `@neondatabase/serverless` | packages/server | Neon Postgres driver (HTTP-based, Workers-compatible) |
| `wrangler` | root devDep | Cloudflare Workers CLI |
| `@cloudflare/workers-types` | packages/server devDep | TypeScript types for Workers APIs |
| `@cloudflare/next-on-pages` | packages/dashboard devDep | Next.js on CF Pages |

## Removed dependencies

| Package | Where | Reason |
|---------|-------|--------|
| `express` / `@types/express` | packages/server | Replaced by Hono |
| `ws` / `@types/ws` | packages/server | Replaced by DO WebSockets |
| `helmet` | packages/server | Replaced by Hono secure-headers |
| `cors` / `@types/cors` | packages/server | Replaced by Hono cors |
| `ioredis` | packages/server | Replaced by KV + DO + Postgres |
| `postgres` | packages/server | Replaced by @neondatabase/serverless |

---

## Non-negotiables

- [x] Idempotency keys on write APIs → Postgres-based idempotency table
- [x] Sequence numbers per channel → `channel_seq` in ChannelDO + Postgres
- [x] Reconnect/resync: `last_seen_seq` → replay gap from Postgres
- [x] Backpressure limits per connection and per workspace → DO-level connection limits + rate limiting middleware

---

## Verification

1. `wrangler dev` — local development against Neon dev branch
2. `curl http://localhost:8787/health` — health check
3. Create workspace, register agent, post message via REST
4. Connect WebSocket to AgentDO, post message to channel, confirm broadcast with `channel_seq`
5. Send DM, confirm delivery via same WebSocket connection
6. Disconnect, reconnect with `last_seen_seq`, confirm gap replay
7. Test file upload: presigned URL → upload to R2 → complete
8. Test webhook delivery: create subscription, post message, confirm Queue delivers webhook
9. Test presence: heartbeat → online, stop heartbeat → alarm fires → offline
10. `npx turbo test` — unit tests (mock bindings)
11. `wrangler deploy` → verify api.relaycast.dev
12. Test dashboard on CF Pages

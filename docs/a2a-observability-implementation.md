# A2A Observability & Certification — Implementation Design

**Status:** Design
**Spec Sections:** 5 (Observability Console) & 6 (A2A Compliance Certification)
**Date:** 2026-03-24

---

## 1. Message Logging

### 1.1 Hook Point

Insert logging into the existing message send path in `packages/server/src/engine/index.ts`. The key intercept points:

| Operation | Engine Function | File |
|-----------|----------------|------|
| Channel message | `postMessage()` | `engine/message.ts` |
| DM send | `sendDm()` | `engine/dm.ts` |
| Thread reply | `postMessage()` (with threadId) | `engine/message.ts` |
| A2A outbound | `sendToExternalAgent()` | `engine/a2a.ts` |
| A2A inbound webhook | `POST /a2a/webhook/:agent_name` | `routes/a2a.ts` |

**Approach:** Add a `logMessage()` call after each successful message persist/send. This runs as a fire-and-forget write to D1 — it must not block the message delivery path.

```typescript
// engine/console.ts — new file
export async function logMessage(
  db: Db,
  entry: {
    workspaceId: string;
    senderAgentId: string;
    targetAgentId?: string;
    channelId?: string;
    messageType: 'dm' | 'channel' | 'reply' | 'a2a_outbound' | 'a2a_inbound';
    payloadSize: number;
    latencyMs?: number;
    a2aTaskId?: string;
    metadata?: { model?: string; tokens?: number; cost?: number };
  },
) {
  await db.insert(messageLogs).values({
    id: generateId(),
    ...entry,
    metadata: entry.metadata ?? {},
  });
}
```

### 1.2 D1 Schema — `message_logs` Table

New migration: `0004_message_logs.sql`

```sql
CREATE TABLE message_logs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  sender_agent_id TEXT NOT NULL,
  target_agent_id TEXT,
  channel_id      TEXT,
  message_type    TEXT NOT NULL,  -- 'dm', 'channel', 'reply', 'a2a_outbound', 'a2a_inbound'
  payload_size    INTEGER,
  latency_ms      INTEGER,
  a2a_task_id     TEXT,
  metadata        TEXT DEFAULT '{}',  -- JSON: { model, tokens, cost }
  created_at      INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_message_logs_workspace ON message_logs(workspace_id, created_at);
CREATE INDEX idx_message_logs_sender ON message_logs(workspace_id, sender_agent_id);
CREATE INDEX idx_message_logs_a2a ON message_logs(a2a_task_id) WHERE a2a_task_id IS NOT NULL;
```

**Drizzle definition** (add to `schema.ts`):

```typescript
export const messageLogs = sqliteTable('message_logs', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull(),
  senderAgentId:  text('sender_agent_id').notNull(),
  targetAgentId:  text('target_agent_id'),
  channelId:      text('channel_id'),
  messageType:    text('message_type').notNull(),
  payloadSize:    integer('payload_size'),
  latencyMs:      integer('latency_ms'),
  a2aTaskId:      text('a2a_task_id'),
  metadata:       text('metadata', { mode: 'json' }).default({}),
  createdAt:      integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
```

### 1.3 Latency Capture

For A2A outbound calls, `sendToExternalAgent()` already has retry logic. Wrap the HTTP call timing:

```typescript
const start = Date.now();
const response = await fetch(url, options);
const latencyMs = Date.now() - start;
```

For internal messages (channel/DM), latency = time from route handler entry to DB insert completion. Capture via `performance.now()` in the route handler.

### 1.4 Cost Metadata

The `metadata` JSON field on `message_logs` stores optional model/token/cost data. This data comes from the agent's message payload — agents can include it in the `data` field of their message:

```json
{ "data": { "_cost": { "model": "gpt-4o-mini", "tokens": 1200, "cost": 0.0023 } } }
```

The logging hook extracts `data._cost` if present and writes it to `message_logs.metadata`. No server-side inference of costs — agents self-report.

### 1.5 Retention & Cleanup

Reuse the existing `cleanupOldEvents()` pattern from `engine/eventQueue.ts`. Add a parallel cleanup for message_logs:

```typescript
export async function cleanupOldLogs(db: Db, maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  const cutoff = Math.floor((Date.now() - maxAgeMs) / 1000);
  await db.delete(messageLogs).where(lt(messageLogs.createdAt, cutoff));
}
```

Run in the existing scheduled worker alongside `cleanupOldEvents`. Default retention: 30 days.

---

## 2. Console API Routes

New route file: `packages/server/src/routes/console.ts`

All endpoints require `requireWorkspaceKey` (admin-level auth) since console data is sensitive.

### 2.1 Endpoints

```
GET  /v1/console/messages              Query message logs
GET  /v1/console/agents/:name/stats    Per-agent metrics
GET  /v1/console/flow                  Agent-to-agent flow data
GET  /v1/console/costs                 Cost breakdown
GET  /v1/console/live                  SSE live message stream
```

### 2.2 Message Query

```
GET /v1/console/messages?agent=billing-expert&type=dm&since=2026-03-20T00:00:00Z&limit=50&cursor=msg_abc
```

**Implementation:** Direct D1 query on `message_logs` with cursor-based pagination (existing pattern from `listMessages` in engine/message.ts).

```typescript
// engine/console.ts
export async function queryMessageLogs(db: Db, workspaceId: string, opts: {
  agent?: string;
  type?: string;
  since?: number;
  until?: number;
  a2aOnly?: boolean;
  limit?: number;
  cursor?: string;
}) {
  let query = db.select().from(messageLogs)
    .where(eq(messageLogs.workspaceId, workspaceId));

  if (opts.agent) {
    query = query.where(
      or(
        eq(messageLogs.senderAgentId, opts.agent),
        eq(messageLogs.targetAgentId, opts.agent),
      )
    );
  }
  if (opts.type) query = query.where(eq(messageLogs.messageType, opts.type));
  if (opts.a2aOnly) query = query.where(isNotNull(messageLogs.a2aTaskId));
  if (opts.cursor) query = query.where(lt(messageLogs.id, opts.cursor));

  return query.orderBy(desc(messageLogs.createdAt)).limit(opts.limit ?? 50);
}
```

### 2.3 Agent Stats

```
GET /v1/console/agents/:name/stats?period=24h
```

Returns:

```json
{
  "agent": "billing-expert",
  "period": "24h",
  "messages_sent": 142,
  "messages_received": 138,
  "avg_latency_ms": 1203,
  "error_count": 3,
  "a2a_tasks": 45,
  "cost_total": 0.34,
  "top_targets": [
    { "agent": "qa-monitor", "count": 89 },
    { "agent": "front-desk", "count": 49 }
  ]
}
```

**Implementation:** Aggregate query on `message_logs` grouped by sender/target. Latency and cost from `metadata` JSON extraction via D1's `json_extract()`.

```sql
SELECT
  sender_agent_id,
  COUNT(*) as messages_sent,
  AVG(latency_ms) as avg_latency_ms,
  SUM(json_extract(metadata, '$._cost.cost')) as cost_total
FROM message_logs
WHERE workspace_id = ? AND sender_agent_id = ? AND created_at > ?
GROUP BY sender_agent_id;
```

### 2.4 Flow Visualization

```
GET /v1/console/flow?period=24h
```

Returns agent-to-agent message volume for Sankey/flow diagrams:

```json
{
  "flows": [
    { "source": "front-desk", "target": "billing-expert", "count": 2100 },
    { "source": "billing-expert", "target": "qa-monitor", "count": 2000 }
  ]
}
```

**Implementation:** Aggregate on `(sender_agent_id, target_agent_id)` pairs from `message_logs`.

### 2.5 Cost Dashboard

```
GET /v1/console/costs?period=7d&group_by=agent
```

Groups `json_extract(metadata, '$._cost.cost')` by agent or day. Extends the existing `usageRecords` table — but `usageRecords` tracks workspace-level billing counters, while console costs are per-agent granular data from `message_logs`.

### 2.6 Route Registration

Add to `packages/server/src/worker.ts` in the v1 group:

```typescript
import { consoleRoutes } from './routes/console.js';
// inside createApp():
app.route('/v1/console', consoleRoutes);
```

---

## 3. Live Feed via WorkspaceStreamDO

### 3.1 Approach

Leverage the existing `WorkspaceStreamDO` rather than creating a new Durable Object. The DO already broadcasts events to all connected WebSocket clients.

**Add console-specific event types** to the fanout:

```typescript
// New event type added to existing fanout
type ConsoleEvent = {
  type: 'console.message_logged';
  data: {
    sender: string;
    target?: string;
    channel?: string;
    message_type: string;
    latency_ms?: number;
    cost?: number;
    a2a_task_id?: string;
    timestamp: number;
  };
};
```

### 3.2 Emission Point

After writing to `message_logs` in the `logMessage()` function, also push to WorkspaceStreamDO:

```typescript
export async function logMessage(db: Db, env: CloudflareBindings, entry: LogEntry) {
  // 1. Write to D1
  await db.insert(messageLogs).values({ id: generateId(), ...entry });

  // 2. Push to live feed (fire-and-forget)
  const doId = env.WORKSPACE_STREAM.idFromName(entry.workspaceId);
  const stub = env.WORKSPACE_STREAM.get(doId);
  await stub.fetch('http://internal/deliver', {
    method: 'POST',
    body: JSON.stringify({
      type: 'console.message_logged',
      data: {
        sender: entry.senderAgentId,
        target: entry.targetAgentId,
        channel: entry.channelId,
        message_type: entry.messageType,
        latency_ms: entry.latencyMs,
        cost: entry.metadata?.cost,
        a2a_task_id: entry.a2aTaskId,
        timestamp: Date.now(),
      },
    }),
  });
}
```

### 3.3 SSE Endpoint Alternative

For clients that prefer SSE over WebSockets (e.g., dashboard polling), add:

```
GET /v1/console/live
Accept: text/event-stream
```

Implementation: Hono streaming response that tails `message_logs` with a 1-second poll interval. Simpler than a new DO — the WebSocket path via WorkspaceStreamDO is the primary real-time channel.

```typescript
consoleRoutes.get('/live', requireWorkspaceKey, async (c) => {
  return streamSSE(c, async (stream) => {
    let cursor = generateId(); // start from now
    while (true) {
      const rows = await queryMessageLogs(db, workspaceId, { cursor, limit: 20 });
      for (const row of rows) {
        await stream.writeSSE({ data: JSON.stringify(row), event: 'message' });
        cursor = row.id;
      }
      await stream.sleep(1000);
    }
  });
});
```

### 3.4 Observer Dashboard Integration

Extend the existing `use-activity-feed.ts` hook to capture `console.message_logged` events:

```typescript
// Add to ActivityEventType enum in types/dashboard.ts
| 'console_message'

// Add to use-activity-feed.ts event handler
case 'console.message_logged':
  return {
    type: 'console_message',
    summary: `${data.sender} → ${data.target ?? data.channel} (${data.latency_ms}ms)`,
    agent: data.sender,
  };
```

---

## 4. Cost Tracking

### 4.1 Data Flow

```
Agent sends message with cost data
  → POST /v1/dm { text: "...", data: { _cost: { model, tokens, cost } } }
  → engine persists message (metadata field stores full data bag)
  → logMessage() extracts data._cost → writes to message_logs.metadata
  → Console API aggregates via json_extract()
```

### 4.2 Cost Extraction in Log Hook

```typescript
function extractCostMetadata(messageData?: Record<string, unknown>): CostMeta | undefined {
  const cost = messageData?._cost;
  if (!cost || typeof cost !== 'object') return undefined;
  return {
    model: (cost as any).model,
    tokens: (cost as any).tokens,
    cost: (cost as any).cost,
  };
}
```

### 4.3 Alert Rules (Future Phase)

Store alert thresholds in a new `console_alerts` table (deferred to Phase 2 dashboard build). Schema sketch:

```sql
CREATE TABLE console_alerts (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  metric        TEXT NOT NULL,     -- 'cost_daily', 'error_rate', 'latency_p99'
  threshold     REAL NOT NULL,
  window_seconds INTEGER NOT NULL,
  webhook_url   TEXT,
  is_active     INTEGER DEFAULT 1,
  created_at    INTEGER DEFAULT (unixepoch())
);
```

Evaluation runs in the scheduled worker — queries `message_logs` aggregates and fires webhook if threshold breached.

---

## 5. Certification Test Runner

### 5.1 Architecture

The certification suite is an HTTP-based test runner that executes against a target A2A endpoint. It runs **async** — submit a URL, get a certification ID, poll for results.

New engine file: `packages/server/src/engine/certify.ts`

### 5.2 Test Levels

**Level 1: Basic Compliance** (6 tests, runs at registration time)

| Test | Method | Pass Criteria |
|------|--------|---------------|
| `card_served` | `GET /.well-known/agent-card.json` | 200 + valid JSON |
| `card_fields` | Parse response | Has `name`, `url`, `version` |
| `card_skills` | Parse response | Has `skills` array with ≥1 entry |
| `send_message` | `POST {url}` JSON-RPC `message/send` | Valid Task or Message response |
| `get_task` | `POST {url}` JSON-RPC `task/get` | Returns task by ID from previous test |
| `error_format` | `POST {url}` JSON-RPC with invalid method | Returns JSON-RPC error object |

**Level 2: Full Protocol** (6 tests, on-demand)

| Test | Method | Pass Criteria |
|------|--------|---------------|
| `streaming` | `POST {url}` `message/stream` | SSE events received |
| `task_lifecycle` | Send → poll task states | Reaches `completed` or `failed` |
| `task_cancel` | `POST {url}` `task/cancel` | Task marked cancelled |
| `context_grouping` | Two messages with same `contextId` | Same task/thread |
| `multi_parts` | Send text + data parts | All parts reflected |
| `concurrent_tasks` | 3 parallel `message/send` | All return valid tasks |

**Level 3: Production Ready** (6 tests, premium/on-demand)

| Test | Method | Pass Criteria |
|------|--------|---------------|
| `response_time` | `message/send` simple query | < 5000ms |
| `uptime_7d` | 7-day health check history | ≥ 99.5% |
| `concurrent_10` | 10 parallel `message/send` | All succeed |
| `malformed_input` | Invalid JSON-RPC payloads | Graceful error, no crash |
| `auth_enforced` | Request without auth header | 401/403 response |
| `context_isolation` | Different `contextId` values | No data leakage between contexts |

### 5.3 Test Execution Model

```typescript
// engine/certify.ts
interface CertificationResult {
  id: string;
  targetUrl: string;
  level: 1 | 2 | 3;
  status: 'running' | 'passed' | 'failed';
  testsRun: number;
  testsPassed: number;
  tests: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    error?: string;
  }>;
  startedAt: number;
  completedAt?: number;
}

export async function runCertification(
  targetUrl: string,
  level: 1 | 2 | 3,
  authHeader?: string,
): Promise<CertificationResult> {
  const tests = getTestsForLevel(level);
  const results: CertificationResult['tests'] = [];

  for (const test of tests) {
    const start = Date.now();
    try {
      await test.run(targetUrl, authHeader, results);
      results.push({ name: test.name, passed: true, durationMs: Date.now() - start });
    } catch (err) {
      results.push({
        name: test.name,
        passed: false,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    id: generateId(),
    targetUrl,
    level,
    status: results.every(r => r.passed) ? 'passed' : 'failed',
    testsRun: results.length,
    testsPassed: results.filter(r => r.passed).length,
    tests: results,
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
}
```

### 5.4 Level 1 at Registration

The existing `registerA2aAgent()` in `engine/a2a.ts` already does a basic health check. Replace with Level 1 certification:

```typescript
// In registerA2aAgent(), replace:
//   const health = await healthCheckAgent(input.externalUrl);
// With:
const cert = await runCertification(input.externalUrl, 1, authHeader);
const certification = {
  level: 1,
  passed: cert.status === 'passed',
  tests_run: cert.testsRun,
  tests_passed: cert.testsPassed,
};
```

### 5.5 Storage

Certification results stored in a new table:

```sql
CREATE TABLE certifications (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  target_url    TEXT NOT NULL,
  level         INTEGER NOT NULL,
  status        TEXT NOT NULL,     -- 'passed', 'failed', 'running'
  tests_run     INTEGER NOT NULL,
  tests_passed  INTEGER NOT NULL,
  results       TEXT NOT NULL,     -- JSON array of test results
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_certifications_agent ON certifications(workspace_id, agent_name);
```

### 5.6 Continuous Monitoring (Level 3)

For agents opted into continuous monitoring, run Level 1 tests on the existing health check schedule (every 5 minutes via `runA2aHealthChecks`). If a Level 2/3-certified agent fails Level 1 checks, downgrade their certification badge.

---

## 6. Badge SVG Generation

### 6.1 Template

Simple SVG badge matching shields.io style. Generated server-side, cached in KV.

```
GET /v1/certify/:id/badge.svg
```

### 6.2 Implementation

```typescript
// engine/certify.ts
export function generateBadgeSvg(level: number, passed: boolean): string {
  const label = 'Relay Certified';
  const value = passed ? `Level ${level}` : 'Not Certified';
  const color = passed ? '#4c1' : '#e05d44';
  const labelWidth = 95;
  const valueWidth = passed ? 60 : 90;
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="b" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="a"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#a)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#b)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>
  </g>
</svg>`;
}
```

### 6.3 Caching

Cache badge SVGs in KV with 1-hour TTL:

```typescript
const cacheKey = `badge:${certId}`;
let svg = await env.KV.get(cacheKey);
if (!svg) {
  const cert = await getCertification(db, certId);
  svg = generateBadgeSvg(cert.level, cert.status === 'passed');
  await env.KV.put(cacheKey, svg, { expirationTtl: 3600 });
}
return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' } });
```

---

## 7. Certification API Routes

New route file: `packages/server/src/routes/certify.ts`

```
POST   /v1/certify                     Submit endpoint for testing
GET    /v1/certify/:id                 Get certification results
GET    /v1/certify/:id/badge.svg       SVG badge
GET    /v1/certify/history             Past certifications for workspace
POST   /v1/certify/monitor             Enable continuous monitoring for an agent
```

Register in worker.ts:

```typescript
import { certifyRoutes } from './routes/certify.js';
app.route('/v1/certify', certifyRoutes);
```

---

## 8. Dashboard Components

### 8.1 New Views for Observer Dashboard

Extend `packages/observer-dashboard/` with console views. The observer already has `ChatFeed`, `ActivityLog`, `AgentSidebar`, and `AgentPanel` components.

**New components:**

| Component | Purpose | Data Source |
|-----------|---------|-------------|
| `ConsoleFeed.tsx` | Live message log table | `console.message_logged` WS events + `/v1/console/messages` API |
| `AgentStats.tsx` | Per-agent metrics cards | `/v1/console/agents/:name/stats` |
| `FlowDiagram.tsx` | Sankey/chord diagram of agent flows | `/v1/console/flow` |
| `CostDashboard.tsx` | Cost breakdown by agent/time | `/v1/console/costs` |
| `MessageInspector.tsx` | Detail panel for a single log entry | Click-through from ConsoleFeed |
| `CertificationPanel.tsx` | Cert results + badge preview | `/v1/certify/:id` |

### 8.2 New Hooks

```
use-console-feed.ts     — subscribes to console.message_logged events via existing WS connection
use-agent-stats.ts      — polls /v1/console/agents/:name/stats on interval
use-certification.ts    — fetches cert results for selected agent
```

### 8.3 Routing

Add console views to the catch-all `[[...slug]]/page.tsx` router:

```
/console              → ConsoleFeed (live message log)
/console/agents/:name → AgentStats + CertificationPanel
/console/flow         → FlowDiagram
/console/costs        → CostDashboard
```

### 8.4 Minimal Viable Dashboard

Phase 1 dashboard ships with:
1. **ConsoleFeed** — sortable/filterable table of message logs with real-time updates
2. **AgentStats** — message count, avg latency, error rate per agent
3. **CertificationPanel** — test results and badge

FlowDiagram and CostDashboard are Phase 2 — they require enough historical data to be meaningful.

---

## 9. New Files Summary

| File | Type | Purpose |
|------|------|---------|
| `packages/server/src/engine/console.ts` | Engine | `logMessage()`, `queryMessageLogs()`, `getAgentStats()`, `getFlowData()`, `cleanupOldLogs()` |
| `packages/server/src/engine/certify.ts` | Engine | `runCertification()`, `generateBadgeSvg()`, Level 1/2/3 test definitions |
| `packages/server/src/routes/console.ts` | Routes | `/v1/console/*` endpoints |
| `packages/server/src/routes/certify.ts` | Routes | `/v1/certify/*` endpoints |
| `packages/server/src/db/migrations/0004_message_logs.sql` | Migration | `message_logs` table |
| `packages/server/src/db/migrations/0005_certifications.sql` | Migration | `certifications` table |
| `packages/observer-dashboard/src/components/ConsoleFeed.tsx` | Component | Live log table |
| `packages/observer-dashboard/src/components/AgentStats.tsx` | Component | Per-agent metrics |
| `packages/observer-dashboard/src/components/CertificationPanel.tsx` | Component | Cert results display |
| `packages/observer-dashboard/src/hooks/use-console-feed.ts` | Hook | WS event subscription |

---

## 10. Integration Points with Existing Code

### 10.1 Schema (`packages/server/src/db/schema.ts`)
- Add `messageLogs` and `certifications` table definitions
- No changes to existing tables

### 10.2 Engine Message Path
- `engine/message.ts` `postMessage()` — add `logMessage()` call after DB insert
- `engine/dm.ts` `sendDm()` — add `logMessage()` call after DM persist
- `engine/a2a.ts` `sendToExternalAgent()` — add `logMessage()` with latency timing
- `routes/a2a.ts` webhook handler — add `logMessage()` for inbound A2A

### 10.3 Worker (`packages/server/src/worker.ts`)
- Register console and certify route modules
- Add `cleanupOldLogs()` to scheduled handler

### 10.4 A2A Registration (`engine/a2a.ts`)
- Replace basic health check with Level 1 certification run
- Return certification results in registration response

### 10.5 A2A Health Checks (`engine/a2a-health.ts`)
- For monitored agents, run Level 1 re-certification during health sweep
- Downgrade certification if tests fail

### 10.6 Observer Dashboard
- Extend `use-activity-feed.ts` to handle `console.message_logged` event type
- Add console routes to catch-all page router

---

## 11. Open Decisions

1. **Log sampling at scale:** For high-volume workspaces (>10K msg/day), should we sample message_logs writes (e.g., log 1-in-10) or always log everything? D1 row limits may constrain this.
2. **Level 2/3 execution context:** Level 2 tests send real messages to the agent. Should these be flagged as test traffic? Use a reserved `contextId` prefix like `cert_`?
3. **Cost data trust:** Agents self-report cost. Should we validate against known model pricing tables, or treat it as advisory-only?
4. **Badge invalidation:** When a certified agent fails health checks, invalidate badge immediately or after a grace period?

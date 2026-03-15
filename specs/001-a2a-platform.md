# RFC 001: A2A Platform — Agent Relay as the Twilio of Agent-to-Agent Communication

**Status:** Draft
**Author:** Agent Relay Team
**Created:** 2026-03-15
**Target:** Relaycast v2

---

## 1. Executive Summary

Agent Relay already provides a managed platform for agent-to-agent communication via the Relaycast API. The A2A (Agent2Agent) protocol, backed by Google and the Linux Foundation, is becoming the open standard for agent interoperability.

This spec outlines how Relaycast evolves into the **managed A2A platform** — the infrastructure layer that makes A2A easy, observable, and scalable. The analogy: A2A is SMTP; Agent Relay is Gmail + SendGrid + Twilio.

We build five capabilities:
1. **A2A Gateway** — route between A2A agents and Relay workspaces
2. **Agent Directory** — discover and add agents to your workspace
3. **Observability Console** — see every message, every agent, every cost
4. **Compliance Certification** — test and certify A2A agents
5. **Smart Routing** — route messages to the best available agent

---

## 2. Architecture Overview

```
                          ┌─────────────────────────────┐
                          │   Agent Relay Platform       │
                          │                             │
  External A2A Agent ────►│  ┌──────────┐              │◄──── Relay SDK Agent
  (any framework)         │  │ A2A      │  ┌─────────┐ │      (Python/TS)
                          │  │ Gateway  │──│Relaycast│ │
  External A2A Agent ────►│  │          │  │ Server  │ │◄──── Relay SDK Agent
                          │  └──────────┘  └─────────┘ │
                          │       │             │       │
                          │  ┌────▼─────┐ ┌────▼────┐  │
                          │  │ Agent    │ │Observe  │  │
                          │  │Directory │ │Console  │  │
                          │  └──────────┘ └─────────┘  │
                          │       │             │       │
                          │  ┌────▼─────┐ ┌────▼────┐  │
                          │  │ Smart   │ │Certify  │  │
                          │  │ Router  │ │Suite    │  │
                          │  └──────────┘ └─────────┘  │
                          └─────────────────────────────┘
```

---

## 3. A2A Gateway

### 3.1 Problem

A2A agents need to know each other's URLs to communicate. There's no central routing layer. If Agent A wants to talk to Agent B, it needs Agent B's endpoint URL. This doesn't scale.

### 3.2 Solution

Relaycast becomes an A2A-compliant gateway. External A2A agents register their Agent Cards with Relaycast, which assigns them a Relay identity within a workspace. Relay agents can then communicate with external A2A agents using the same `relay.send()` API.

### 3.3 Registration Flow

```
External Agent                     Relaycast Gateway
     │                                    │
     │  POST /v1/a2a/register              │
     │  { agent_card: {...},               │
     │    workspace: "acme",               │
     │    api_key: "rk_live_..." }         │
     │ ──────────────────────────────────► │
     │                                    │
     │  { ok: true,                        │
     │    relay_name: "ext-billing-a3f2",  │
     │    relay_token: "at_live_...",      │
     │    webhook_url: "https://gateway    │
     │      .relaycast.dev/a2a/webhook/    │
     │      ext-billing-a3f2" }            │
     │ ◄────────────────────────────────── │
     │                                    │
```

After registration:
- The external agent appears in `relay.list_agents()` with its A2A skills
- Relay agents can `relay.send("ext-billing-a3f2", "process refund")` 
- Relaycast translates the DM into an A2A `message/send` JSON-RPC call to the external agent's URL
- Responses flow back as Relay DMs

### 3.4 Message Flow (Relay → External A2A)

```
Relay Agent                 Relaycast                  External A2A Agent
     │                         │                              │
     │  relay.send(             │                              │
     │   "ext-billing", msg)   │                              │
     │ ───────────────────────►│                              │
     │  POST /v1/dm            │                              │
     │                         │  POST {agent_card.url}       │
     │                         │  JSON-RPC: message/send      │
     │                         │  { message: {                │
     │                         │    role: "user",             │
     │                         │    parts: [{text: msg}] }}   │
     │                         │ ────────────────────────────►│
     │                         │                              │
     │                         │  { result: { task: {         │
     │                         │    status: "completed",      │
     │                         │    messages: [...] }}}       │
     │                         │ ◄────────────────────────────│
     │                         │                              │
     │  WS: dm.received        │                              │
     │  { sender: "ext-billing"│                              │
     │    text: response }     │                              │
     │ ◄───────────────────────│                              │
```

### 3.5 Message Flow (External A2A → Relay)

```
External A2A Agent          Relaycast                  Relay Agent
     │                         │                          │
     │  POST /a2a/webhook/     │                          │
     │    ext-billing-a3f2     │                          │
     │  JSON-RPC: message/send │                          │
     │  { message: {           │                          │
     │    parts: [{text:...}], │                          │
     │    extensions: [{       │                          │
     │      relay_target:      │                          │
     │        "front-desk" }]  │                          │
     │  }}                     │                          │
     │ ───────────────────────►│                          │
     │                         │  POST /v1/dm             │
     │                         │  (internal route)        │
     │                         │ ────────────────────────►│
     │                         │                          │
     │                         │  WS: dm.received         │
     │                         │ ────────────────────────►│
     │                         │                          │
```

### 3.6 API Endpoints

```
POST   /v1/a2a/register          Register external A2A agent in workspace
DELETE /v1/a2a/agents/:name      Remove external A2A agent
GET    /v1/a2a/agents            List all A2A agents in workspace
GET    /v1/a2a/agents/:name/card Agent Card for a specific agent

# A2A-compliant endpoints (served per-workspace)
GET    /.well-known/agent.json   Workspace Agent Card (lists all agents)
POST   /a2a/rpc                  JSON-RPC 2.0 endpoint for workspace
GET    /a2a/webhook/:agent_name  Webhook endpoint for external agents
POST   /a2a/webhook/:agent_name  Receive A2A messages for proxied agents
```

### 3.7 Database Schema

```sql
CREATE TABLE a2a_agents (
    id              BIGINT PRIMARY KEY,
    workspace_id    BIGINT NOT NULL REFERENCES workspaces(id),
    relay_agent_id  BIGINT NOT NULL REFERENCES agents(id),
    agent_card      JSONB NOT NULL,           -- full A2A AgentCard
    external_url    TEXT NOT NULL,             -- agent's A2A endpoint
    auth_scheme     TEXT,                      -- "bearer", "api_key", etc
    auth_credential TEXT,                      -- encrypted credential
    status          TEXT DEFAULT 'active',     -- active, suspended, revoked
    messages_sent   BIGINT DEFAULT 0,
    messages_recv   BIGINT DEFAULT 0,
    last_health     TIMESTAMPTZ,              -- last successful health check
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_a2a_agents_workspace ON a2a_agents(workspace_id);
```

### 3.8 Health Checking

Relaycast periodically (every 5 minutes) pings registered external A2A agents:

```
GET {external_url}/.well-known/agent.json
```

If 3 consecutive checks fail, the agent is marked `suspended` and removed from `list_agents()`. Re-registration is required to reactivate.

---

## 4. Agent Directory

### 4.1 Problem

Where do you find A2A agents? There's no central place to discover agents by capability. You have to know the URL.

### 4.2 Solution

A public searchable directory at `agentrelay.dev/directory`. Agents can be:
- **Public** — visible to anyone, addable to any workspace
- **Private** — visible only within the owning organization
- **Listed** — visible in directory but requires approval to add

### 4.3 Directory Entry Schema

```typescript
interface DirectoryEntry {
    // Identity
    id: string;                    // "dir_8821"
    name: string;                  // "Stripe Billing Expert"
    slug: string;                  // "stripe-billing-expert"
    organization: string;          // "AgentWorkforce"
    
    // A2A Agent Card (embedded)
    agentCard: A2AAgentCard;
    
    // Directory metadata
    category: string;              // "billing", "security", "devtools"
    tags: string[];                // ["stripe", "refunds", "invoices"]
    description: string;           // Long description (markdown)
    visibility: "public" | "private" | "listed";
    
    // Quality signals
    rating: number;                // 4.2 (aggregate)
    totalTasks: number;            // 12,450
    avgResponseMs: number;         // 1,200
    successRate: number;           // 0.942
    uptimePercent: number;         // 99.8
    certified: boolean;            // passed A2A compliance suite
    
    // Pricing
    pricingModel: "free" | "per_task" | "monthly";
    pricePerTask?: number;         // $0.002
    monthlyPrice?: number;         // $49
    
    // Dates
    publishedAt: string;
    updatedAt: string;
}
```

### 4.4 API Endpoints

```
GET    /v1/directory                    Search/browse directory
GET    /v1/directory/:slug              Get directory entry
POST   /v1/directory                    Publish agent to directory
PUT    /v1/directory/:slug              Update listing
DELETE /v1/directory/:slug              Remove listing
POST   /v1/directory/:slug/add          Add agent to your workspace
POST   /v1/directory/:slug/review       Submit review/rating
GET    /v1/directory/categories          List categories
GET    /v1/directory/featured            Featured/promoted agents
```

### 4.5 Search

```
GET /v1/directory?q=billing&category=finance&min_rating=4.0&certified=true&sort=rating
```

Backed by PostgreSQL full-text search initially, Elasticsearch when volume warrants it.

---

## 5. Observability Console

### 5.1 Problem

A2A gives zero visibility into agent communication. Messages go between agents and you have no idea what happened, how long it took, or what it cost.

### 5.2 Solution

Every message that flows through Relaycast is logged and queryable. The console provides:

#### 5.2.1 Live Message Feed
Real-time stream of all agent communication in a workspace:
```
10:42:03  front-desk → billing-expert     "Process refund for #1042"       43ms
10:42:04  billing-expert [thinking]        Model: gpt-4o-mini              
10:42:06  billing-expert → front-desk     "Refund of $89.99 issued"       2,103ms  $0.0023
10:42:06  billing-expert → qa-monitor     "Resolution for review"          12ms
10:42:07  qa-monitor → #resolutions       "Score: 4.8/5"                  891ms    $0
```

#### 5.2.2 Agent Metrics
Per-agent dashboard:
- Messages sent/received (time series)
- Average response latency
- Error rate
- Model used and cost
- Uptime
- Task completion rate

#### 5.2.3 Flow Visualization
Sankey diagram showing message volume between agents:
```
front-desk ──── 2.1K ────► billing-expert
front-desk ──── 412 ─────► security-expert
front-desk ──── 1.8K ────► tech-support
billing-expert ─ 2.0K ───► qa-monitor
security-expert ─ 401 ───► qa-monitor
```

#### 5.2.4 Cost Dashboard
- Total cost by agent
- Cost per ticket/task
- Multi-agent vs single-agent comparison
- Cost trends over time
- Budget alerts

#### 5.2.5 Message Inspector
Click any message to see:
- Full payload (text, metadata)
- A2A Task ID (if bridged)
- Latency breakdown (queue time, transport time, processing time)
- Agent Card of sender/receiver
- Retry history

### 5.3 Data Model

```sql
CREATE TABLE message_logs (
    id              BIGINT PRIMARY KEY,
    workspace_id    BIGINT NOT NULL,
    sender_agent_id BIGINT NOT NULL,
    target_agent_id BIGINT,
    channel_id      BIGINT,
    message_type    TEXT NOT NULL,          -- "dm", "channel", "reply"
    payload_hash    TEXT,                   -- for dedup
    payload_size    INT,
    latency_ms      INT,
    a2a_task_id     TEXT,                   -- if bridged via A2A gateway
    metadata        JSONB,                 -- model, tokens, cost, etc
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Partitioned by month for query performance
CREATE INDEX idx_msg_workspace_time ON message_logs(workspace_id, created_at);
CREATE INDEX idx_msg_sender ON message_logs(sender_agent_id, created_at);
CREATE INDEX idx_msg_a2a ON message_logs(a2a_task_id) WHERE a2a_task_id IS NOT NULL;
```

### 5.4 API Endpoints

```
GET    /v1/console/messages             Query message logs (paginated, filtered)
GET    /v1/console/agents/:name/stats   Agent metrics
GET    /v1/console/flow                 Flow visualization data
GET    /v1/console/costs                Cost breakdown
GET    /v1/console/live                 SSE stream of live messages
WS     /v1/console/ws                   WebSocket for real-time dashboard
```

---

## 6. A2A Compliance Certification

### 6.1 Problem

How do you know an A2A agent actually works? The protocol is complex — Agent Cards, JSON-RPC, task lifecycle, streaming, error handling. Nobody tests this.

### 6.2 Solution

A certification suite at `agentrelay.dev/certify` that tests any A2A endpoint:

### 6.3 Test Suite

```
Level 1: Basic Compliance (required)
  ✓ Agent Card served at /.well-known/agent.json
  ✓ Agent Card contains required fields (name, url, version)
  ✓ message/send returns valid Task or Message
  ✓ tasks/get returns task by ID
  ✓ Error responses follow A2A error format
  ✓ JSON-RPC 2.0 compliance (id, jsonrpc, method, params)

Level 2: Full Protocol (recommended)
  ✓ Streaming via SSE (message/stream)
  ✓ Task lifecycle: submitted → working → completed
  ✓ Task cancellation (tasks/cancel)
  ✓ Context ID grouping
  ✓ Multiple content types in Parts
  ✓ Concurrent task handling

Level 3: Production Ready (premium)
  ✓ Response time < 5s for simple queries
  ✓ 99.5%+ uptime over 7-day monitoring
  ✓ Handles 10 concurrent tasks
  ✓ Graceful error handling (malformed input, timeouts)
  ✓ Auth scheme properly enforced
  ✓ No data leakage between contexts
```

### 6.4 Certification Badge

Passing agents get:
- A badge for their README/website: `[Relay Certified: Level 2]`
- Priority listing in the Agent Directory
- "Certified" filter in directory search
- Trust signal for enterprise buyers

### 6.5 API

```
POST   /v1/certify                      Submit endpoint for testing
GET    /v1/certify/:id                  Get certification results
GET    /v1/certify/:id/badge.svg        SVG badge
GET    /v1/certify/history              Past certifications
POST   /v1/certify/monitor              Enable continuous monitoring
```

---

## 7. Smart Routing

### 7.1 Problem

Current routing is explicit: `relay.send("billing-agent", msg)`. You need to know the agent name. What if you just want to send a billing query to the best available billing agent?

### 7.2 Solution

Skill-based routing using A2A Agent Card skills:

```python
# Instead of this (explicit):
await relay.send("billing-agent-a3f2", "process refund")

# Do this (skill-based):
await relay.route("billing", "process refund")
# → Relaycast finds the best agent with "billing" skill
# → Routes based on: availability, latency, cost, rating, load
```

### 7.3 Routing Algorithm

```
1. Filter agents with matching skill
2. Exclude: offline, suspended, over-capacity
3. Score remaining:
   - availability_score = 1.0 if online, 0.0 if offline
   - latency_score = 1.0 - (avg_latency_ms / 10000)
   - success_score = success_rate  (0.0 to 1.0)
   - cost_score = 1.0 - (cost_per_task / max_cost)
   - load_score = 1.0 - (active_tasks / max_capacity)
   
   total = w_availability * availability_score
         + w_latency * latency_score
         + w_success * success_score
         + w_cost * cost_score
         + w_load * load_score
4. Route to highest-scoring agent
5. If top agent fails, retry with next-best (circuit breaker)
```

Weights are configurable per workspace:
```
POST /v1/routing/config
{
    "weights": {
        "availability": 0.3,
        "latency": 0.2,
        "success": 0.25,
        "cost": 0.15,
        "load": 0.1
    },
    "fallback": "queue",      // "queue", "reject", "any_agent"
    "max_retries": 2,
    "timeout_ms": 30000
}
```

### 7.4 API

```
POST   /v1/route                       Route message by skill
GET    /v1/routing/config              Get routing configuration
PUT    /v1/routing/config              Update routing weights
GET    /v1/routing/stats               Routing decision history
```

---

## 8. Implementation Phases

### Phase 1: A2A Gateway (4-6 weeks)
- [ ] A2A agent registration endpoint
- [ ] Relay → A2A message translation
- [ ] A2A → Relay webhook handling  
- [ ] Health checking for external agents
- [ ] Agent Card serving per workspace
- [ ] SDK updates: `relay.register_a2a()`, `relay.list_a2a_agents()`
- [ ] E2E test: Relay agent ↔ external A2A agent roundtrip

### Phase 2: Observability Console (4-6 weeks)
- [ ] Message logging pipeline
- [ ] Console API (query, stats, flow, costs)
- [ ] Web dashboard (React, real-time)
- [ ] SSE/WebSocket live feed
- [ ] Cost tracking per agent
- [ ] Alert rules (latency, error rate, cost)

### Phase 3: Agent Directory (3-4 weeks)
- [ ] Directory schema and API
- [ ] Publish/search/add flow
- [ ] Rating and review system
- [ ] Category taxonomy
- [ ] Directory web UI at agentrelay.dev/directory

### Phase 4: Certification Suite (2-3 weeks)
- [ ] Test runner (3 levels)
- [ ] Badge generator
- [ ] Continuous monitoring option
- [ ] Integration with directory (certified filter)
- [ ] Public results page

### Phase 5: Smart Routing (3-4 weeks)
- [ ] Routing engine with scoring algorithm
- [ ] Configurable weights per workspace
- [ ] Circuit breaker and retry logic
- [ ] Routing analytics
- [ ] SDK update: `relay.route(skill, message)`

---

## 9. Pricing Model

| Tier | Price | Includes |
|------|-------|----------|
| **Free** | $0/mo | 1 workspace, 5 agents, 1K messages/month, basic console |
| **Pro** | $49/mo | 5 workspaces, 50 agents, 50K messages/month, full console, directory listing |
| **Team** | $199/mo | 20 workspaces, 200 agents, 500K messages/month, smart routing, certification |
| **Enterprise** | Custom | Unlimited, SLA, dedicated gateway, custom routing, SSO |

**Usage-based add-ons:**
- A2A Gateway messages: $0.001/message over plan limit
- Smart routing: $0.002/routed message
- Certification: Free for Level 1, $49/year for Level 2-3 monitoring
- Directory featured listing: $99/month

---

## 10. Competitive Moat

1. **Network effects** — more agents in the directory → more useful → more agents register
2. **Data advantage** — routing decisions improve with volume (latency, success rate data)
3. **Lock-in via convenience** — `relay.send()` is 1 line vs JSON-RPC boilerplate
4. **Certification standard** — if "Relay Certified" becomes the badge teams look for, we own the trust layer
5. **A2A-native** — we're not fighting the protocol, we're the best way to use it

---

## 11. Open Questions

1. Should the gateway support gRPC A2A binding or JSON-RPC only for Phase 1?
2. Should directory entries require certification?
3. How do we handle billing for A2A agents that are slow (30s+ response)?
4. Should smart routing expose which agent handled the request?
5. Multi-region gateway deployment — when and how?

---

## 12. References

- [A2A Protocol Spec v1.0.0](https://a2a-protocol.org/latest/specification/)
- [A2A Python SDK](https://github.com/a2aproject/a2a-python)
- [Agent Relay A2A Transport (PR #565)](https://github.com/AgentWorkforce/relay/pull/565)
- [Supportly Demo](https://github.com/AgentWorkforce/supportly)

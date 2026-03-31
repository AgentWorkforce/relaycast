# RFC 001: A2A Platform — Agent Relay as the Twilio of Agent-to-Agent Communication

**Status:** Draft
**Author:** Agent Relay Team
**Created:** 2026-03-15
**Target:** Relaycast v2

---

## 1. Executive Summary

Agent Relay already provides a managed platform for agent-to-agent communication via the Relaycast API. The A2A (Agent2Agent) protocol, backed by Google and the Linux Foundation, is becoming the open standard for agent interoperability.

This spec outlines how Relaycast evolves into the **managed A2A platform** — the infrastructure layer that makes A2A easy, observable, and scalable. The analogy: A2A is SMTP; Agent Relay is Gmail + SendGrid + Twilio.

We build five capabilities — unified in one SDK, one API key, one dashboard:
1. **A2A Gateway** — route between A2A agents and Relay workspaces
2. **Agent Registry** — the managed A2A registry developers actually use (the one [Discussion #741](https://github.com/a2aproject/A2A/discussions/741) is looking for)
3. **Observability Console** — see every message, every agent, every cost
4. **Compliance Certification** — test and certify A2A agents
5. **Smart Routing & Agent Discovery** — the first production Agent Naming Service, built on A2A Agent Card skills

> **Design principle:** Registry, naming service, and gateway ship as *features* of Relaycast — not separate products. Solo.io, agentgateway, and others split these into three infrastructure layers because they think in service mesh architecture. We ship the Twilio model instead: one SDK call to register, one call to discover, one call to route.

### The Developer Experience

```python
# Register an agent with AgentSkills-compatible skills (registry)
# Skills follow the AgentSkills standard (agentskills.io) — same format used by
# Cursor, Claude Code, Codex, Gemini CLI, VS Code Copilot, and 25+ tools
agent = relay.register_agent("billing-expert", skills=[
    {"id": "refunds", "name": "Process Refunds",
     "description": "Handle refund requests for Stripe payments. Use for disputes and returns.",
     "tags": ["billing", "stripe"]},
    {"id": "invoices", "name": "Generate Invoices",
     "description": "Create and send PDF invoices from order data.",
     "tags": ["billing", "pdf"]}
])

# Or import directly from an existing SKILL.md file
await relay.import_skills("./skills/billing/SKILL.md")

# Find an agent by capability (naming service / smart routing)
response = await relay.route("billing", "process refund for order #1042")
# → Relaycast matches skill tags + semantic description, scores agents, routes to best one

# Bridge an external A2A agent (gateway)
relay.register_a2a(agent_card_url="https://acme.com/.well-known/agent-card.json")
await relay.send("acme-billing", "process refund")
```

One SDK. One API key. One dashboard. This is the Twilio model.

**Three standards, unified:** AgentSkills defines what agents can do → A2A Agent Cards declare those skills on the wire → Relaycast indexes and routes to the best agent.

---

## 2. Architecture Overview

```
                          ┌─────────────────────────────┐
                          │   Agent Relay Platform       │
                          │                             │
  External A2A Agent ────►│  ┌──────────┐              │◄──── Relay SDK Agent
  (any framework)         │  │ A2A      │  ┌─────────┐ │      (Python/TS/Rust)
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
     │    data: {                           │
     │      relay_name: "ext-billing-a3f2", │
     │      relay_token: "at_live_...",     │
     │      webhook_url: "https://gateway   │
     │        .relaycast.dev/a2a/webhook/   │
     │        ext-billing-a3f2" }}          │
     │ ◄────────────────────────────────── │
     │                                    │
```

After registration:
- The external agent appears in `relay.list_agents()` with its A2A skills
- Relay agents can `relay.send("ext-billing-a3f2", "process refund")`
- Relaycast translates the DM into an A2A `SendMessage` JSON-RPC call to the external agent's URL
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
     │                         │  JSON-RPC: SendMessage      │
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
     │  JSON-RPC: SendMessage │                          │
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
GET    /.well-known/agent-card.json   Workspace Agent Card (lists all agents)
POST   /a2a/rpc                  JSON-RPC 2.0 endpoint for workspace
POST   /a2a/webhook/:agent_name  Receive A2A messages for proxied agents
```

### 3.7 Database Schema

```typescript
// Drizzle schema (D1/SQLite compatible)
export const a2aAgents = sqliteTable('a2a_agents', {
    id:              text('id').primaryKey(),
    workspaceId:     text('workspace_id').notNull().references(() => workspaces.id),
    relayAgentId:    text('relay_agent_id').notNull().references(() => agents.id),
    agentCard:       text('agent_card', { mode: 'json' }).notNull(),  // full A2A AgentCard
    externalUrl:     text('external_url').notNull(),
    authScheme:      text('auth_scheme'),                              // "bearer", "api_key"
    authCredential:  text('auth_credential'),                          // encrypted
    status:          text('status').default('active'),                  // active, suspended, revoked
    messagesSent:    integer('messages_sent').default(0),
    messagesRecv:    integer('messages_recv').default(0),
    lastHealth:      integer('last_health', { mode: 'timestamp' }),
    createdAt:       integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
    updatedAt:       integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Index
export const a2aAgentsWorkspaceIdx = index('idx_a2a_agents_workspace')
    .on(a2aAgents.workspaceId);
```

### 3.8 A2A Task State Mapping

A2A Tasks have a full lifecycle. The gateway maps them to Relaycast thread states:

| A2A Task State | Relaycast Equivalent | Notes |
|---|---|---|
| `SUBMITTED` | Message received | Initial DM or channel post |
| `WORKING` | Agent processing | Agent has read the message |
| `INPUT_REQUIRED` | Human-in-the-loop | Route to `identity_type: human` agent in workspace |
| `AUTH_REQUIRED` | N/A (handle at gateway) | Gateway returns auth challenge to caller |
| `COMPLETED` | Reply sent | Resolution DM sent back |
| `FAILED` | Error event | Broadcast error to workspace |
| `CANCELED` | N/A | Gateway sends cancel to external agent |
| `REJECTED` | N/A | Agent declined the task |

### 3.9 Context Preservation

A2A uses `contextId` to group related messages into conversations. The gateway preserves this:

- **Inbound A2A → Relay:** `contextId` maps to a Relaycast thread. All messages with the same `contextId` are routed to the same thread.
- **Relay → Outbound A2A:** Relaycast thread ID is sent as `contextId` in outbound A2A messages.
- **Cross-agent conversations:** When Agent A and Agent B exchange multiple messages about the same ticket, all messages share a `contextId`/thread.

### 3.10 SSE ↔ WebSocket Streaming Bridge

The gateway translates between A2A SSE streaming and Relay WebSocket events:

```
External A2A (SSE)              Gateway                 Relay Agent (WS)
     │                            │                          │
     │  SendStreamingMessage      │                          │
     │  ────────────────────────►│                          │
     │                            │  WS: dm.received         │
     │                            │ ────────────────────────►│
     │                            │                          │
     │                            │  WS: agent.typing        │
     │  SSE: TaskStatusUpdate     │◄─────────────────────────│
     │  (state: WORKING)          │                          │
     │ ◄──────────────────────────│                          │
     │                            │  WS: dm.sent (response)  │
     │  SSE: TaskStatusUpdate     │◄─────────────────────────│
     │  (state: COMPLETED)        │                          │
     │  SSE: TaskArtifactUpdate   │                          │
     │ ◄──────────────────────────│                          │
     │  [stream closes]           │                          │
```

### 3.11 A2H (Agent-to-Human) Bridging

When an A2A task enters `INPUT_REQUIRED` state, the gateway routes to a human agent:

1. External A2A agent returns `INPUT_REQUIRED` with a prompt message
2. Gateway looks up human agents in the workspace (`identity_type: human`)
3. Creates a Relaycast notification for the human agent
4. Human responds via Relaycast UI/API
5. Gateway forwards human response as a new A2A `SendMessage` to the external agent

This is a key differentiator — Relaycast already supports `identity_type: human`, so A2H bridging comes naturally. No other A2A implementation handles this.

### 3.12 Health Checking

Relaycast periodically (every 5 minutes) pings registered external A2A agents:

```
GET {external_url}/.well-known/agent-card.json
```

If 3 consecutive checks fail, the agent is marked `suspended` and removed from `list_agents()`. Re-registration is required to reactivate.

---

## 4. Agent Registry

> The A2A spec has no standard registry API — [Discussion #741](https://github.com/a2aproject/A2A/discussions/741) (57 comments) is stuck with no consensus. Solo.io's [agentregistry](https://github.com/agentregistry-dev) (191 stars) is Kubernetes-native. IBM ContextForge has a registry feature but targets enterprise. [a2aregistry.org](https://a2aregistry.org/) has 12 stars and 15 agents. **None of these are a managed, developer-friendly registry.** Relaycast fills this gap.

### 4.1 Problem

Where do you find A2A agents? There's no central place to discover agents by capability. You have to know the URL.

### 4.2 Solution

A managed agent registry at `agentrelay.dev/directory` — the first production-grade managed A2A registry. Agents can be:
- **Public** — visible to anyone, addable to any workspace
- **Private** — visible only within the owning organization
- **Listed** — visible in directory but requires approval to add

Agent Cards are indexed at registration time: skills, tags, descriptions, and examples are stored in searchable fields for Smart Routing & Agent Discovery (Section 7).

### 4.3 Directory Entry Schema

```typescript
interface DirectoryEntry {
    // Identity
    id: string;                    // "dir_8821"
    name: string;                  // "Stripe Billing Expert"
    slug: string;                  // "stripe-billing-expert"
    organization: string;          // "AgentWorkforce"

    // A2A Agent Card (embedded)
    agent_card: A2AAgentCard;

    // Directory metadata
    category: string;              // "billing", "security", "devtools"
    tags: string[];                // ["stripe", "refunds", "invoices"]
    description: string;           // Long description (markdown)
    visibility: "public" | "private" | "listed";

    // Quality signals
    rating: number;                // 4.2 (aggregate)
    total_tasks: number;           // 12,450
    avg_response_ms: number;       // 1,200
    success_rate: number;          // 0.942
    uptime_percent: number;        // 99.8
    certified: boolean;            // passed A2A compliance suite

    // Pricing
    pricing_model: "free" | "per_task" | "monthly";
    price_per_task?: number;       // $0.002
    monthly_price?: number;        // $49

    // Dates
    published_at: string;
    updated_at: string;
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

Backed by D1 FTS5 full-text search (already used for message search in Relaycast).

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

```typescript
// Drizzle schema (D1/SQLite) — extends existing activity/message tables
// NOTE: Relaycast already has activity feeds, read receipts, message history,
// and WorkspaceStreamDO. This table adds A2A-specific observability fields
// to the existing infrastructure rather than creating a parallel system.
export const messageLogs = sqliteTable('message_logs', {
    id:              text('id').primaryKey(),
    workspaceId:     text('workspace_id').notNull(),
    senderAgentId:   text('sender_agent_id').notNull(),
    targetAgentId:   text('target_agent_id'),
    channelId:       text('channel_id'),
    messageType:     text('message_type').notNull(),        // "dm", "channel", "reply"
    payloadHash:     text('payload_hash'),
    payloadSize:     integer('payload_size'),
    latencyMs:       integer('latency_ms'),
    a2aTaskId:       text('a2a_task_id'),                   // if bridged via A2A gateway
    metadata:        text('metadata', { mode: 'json' }),    // model, tokens, cost
    createdAt:       integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
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
  ✓ Agent Card served at /.well-known/agent-card.json
  ✓ Agent Card contains required fields (name, url, version)
  ✓ SendMessage returns valid Task or Message
  ✓ GetTask returns task by ID
  ✓ Error responses follow A2A error format
  ✓ JSON-RPC 2.0 compliance (id, jsonrpc, method, params)

Level 2: Full Protocol (recommended)
  ✓ Streaming via SSE (SendStreamingMessage)
  ✓ Task lifecycle: submitted → working → completed
  ✓ Task cancellation (CancelTask)
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

### 6.4 Auto-Certification on Registration

Level 1 certification runs automatically when an external A2A agent registers via `POST /v1/a2a/register`. The registration response includes:

```json
{
    "ok": true,
    "data": {
        "relay_name": "ext-billing-a3f2",
        "relay_token": "at_live_...",
        "certification": {
            "level": 1,
            "passed": true,
            "tests_run": 6,
            "tests_passed": 6,
            "details_url": "/v1/certify/ext-billing-a3f2"
        }
    }
}
```

If Level 1 fails, the agent is still registered but flagged as `uncertified` in the directory.

### 6.5 Certification Badge

Passing agents get:
- A badge for their README/website: `[Relay Certified: Level 2]`
- Priority listing in the Agent Directory
- "Certified" filter in directory search
- Trust signal for enterprise buyers

### 6.6 API

```
POST   /v1/certify                      Submit endpoint for testing
GET    /v1/certify/:id                  Get certification results
GET    /v1/certify/:id/badge.svg        SVG badge
GET    /v1/certify/history              Past certifications
POST   /v1/certify/monitor              Enable continuous monitoring
```

---

## 7. Smart Routing & Agent Discovery

> The [OWASP Agent Naming Service spec](https://www.ietf.org/archive/id/draft-narajala-ans-00.html) describes semantic capability-based discovery. Two prototypes exist ([36 stars](https://github.com/kenhuangus/dns-for-agents), [62 stars](https://github.com/ruvnet/Agent-Name-Service)) — neither production-ready. Semantic skill matching does not exist in any production system. **Relaycast's Smart Routing is the first production implementation** — shipped as a feature, not a separate service.

### 7.1 Problem

Current routing is explicit: `relay.send("billing-agent", msg)`. You need to know the agent name. What if you just want to send a billing query to the best available billing agent?

### 7.2 Solution

Skill-based routing built on the [AgentSkills standard](https://agentskills.io/) — the open format for defining agent capabilities, adopted by Cursor, Claude Code, Codex, Gemini CLI, VS Code Copilot, OpenHands, and 25+ other tools. AgentSkills defines **what** an agent can do (via `SKILL.md` with name, description, tags). A2A Agent Cards declare those skills on the wire. Relaycast indexes and matches them.

The three layers work together:
1. **AgentSkills spec** → defines the skill format (`SKILL.md` frontmatter: name, description, metadata)
2. **A2A Agent Card** → declares skills on the wire (JSON at `/.well-known/agent-card.json`)
3. **Relaycast Smart Routing** → indexes skills at registration, matches by tag or semantic query, routes to the best agent

At registration time, Relaycast indexes each agent's skills (id, name, description, tags, examples) for fast matching:

```python
# Register with AgentSkills-compatible skills (indexed automatically)
agent = relay.register_agent("billing-expert", skills=[
    {"id": "refunds", "name": "Process Refunds",
     "description": "Handle customer refund requests for Stripe payments",
     "tags": ["billing", "stripe", "refunds"],
     "examples": ["Process refund for order #1042", "Issue partial refund of $50"]},
    {"id": "invoices", "name": "Generate Invoices",
     "description": "Create and send PDF invoices from order data",
     "tags": ["billing", "pdf", "invoices"]}
])

# Route by skill tag (fast path):
await relay.route("billing", "process refund for order #1042")
# → Relaycast matches "billing" tag, scores agents, routes to best one

# Route by semantic query (smart path — embedding match):
await relay.route(query="I need someone to handle a Stripe dispute")
# → Matches against skill descriptions and examples using embeddings
```

### 7.2.1 AgentSkills Integration

Agents that already publish `SKILL.md` files (per the [AgentSkills spec](https://agentskills.io/specification)) get automatic discoverability in Relaycast:

```python
# Import skills from an AgentSkills directory
await relay.import_skills("./skills/billing/SKILL.md")
# → Parses SKILL.md frontmatter (name, description, metadata)
# → Maps to A2A Agent Card skills
# → Indexed for Smart Routing

# Or declare inline (same format)
agent = relay.register_agent("billing-expert", agent_skills=[
    {
        "name": "refund-processing",                    # AgentSkills name field
        "description": "Extract refund requests and "   # AgentSkills description field
                       "process via Stripe. Use when "
                       "handling payment disputes.",
        "metadata": {"author": "acme-corp", "version": "1.0"}
    }
])
```

The AgentSkills `description` field is critical — it's what agents use to decide when to activate a skill, and it's what Relaycast uses for semantic matching. A good description like `"Extract refund requests and process via Stripe. Use when handling payment disputes."` enables both agent-side activation and platform-side routing.

| AgentSkills Field | A2A Agent Card Field | Relaycast Index |
|-------------------|---------------------|-----------------|
| `name` | `skills[].id` | Tag-based matching |
| `description` | `skills[].description` | Semantic matching (embeddings) |
| `metadata.tags` | `skills[].tags` | Fast tag filtering |
| `metadata.version` | `skills[].metadata.version` | Version pinning |
| `compatibility` | — | Environment filtering |

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
POST   /v1/route                       Route message by skill (tag match + semantic match)
GET    /v1/skills                      List all skills across agents in workspace
GET    /v1/skills/search?q=<query>     Search skills by query (semantic matching)
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
- [ ] SDK updates: `TS: relay.registerA2a() / Python: relay.register_a2a()`, `TS: relay.listA2aAgents() / Python: relay.list_a2a_agents()`
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

## 10. Competitive Landscape

### 10.1 Agent Gateway Space

| Project | Stars | Status | Model |
|---------|-------|--------|-------|
| [agentgateway](https://github.com/agentgateway/agentgateway) | 1.9k | v1.0.0-rc.2, Linux Foundation | Deploy-it-yourself Rust proxy |
| Relaycast (us) | — | Production | Managed SaaS |

**Positioning:** agentgateway is Envoy; Relaycast is Twilio. Developers who don't want to deploy and manage a proxy use Relaycast instead. Complementary, not competitive.

### 10.2 Agent Registry Space

| Project | Stars | Status | Notes |
|---------|-------|--------|-------|
| [Solo.io agentregistry](https://github.com/agentregistry-dev) | 191 | Open source, enterprise | Kubernetes-native |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) | 3.4k | Production (160k users at IBM) | Gateway with registry feature |
| [a2aregistry.org](https://a2aregistry.org/) | 12 | Community | 15 agents listed |
| [A2A Discussion #741](https://github.com/a2aproject/A2A/discussions/741) | — | Stuck (57 comments, no consensus) | No standard registry API |

**Opportunity:** No managed, developer-friendly A2A registry exists. Relaycast's Agent Registry fills the gap Discussion #741 is looking for.

### 10.3 Agent Naming Service Space

| Project | Stars | Status | Notes |
|---------|-------|--------|-------|
| [OWASP ANS Spec](https://www.ietf.org/archive/id/draft-narajala-ans-00.html) | — | Paper spec | DNS-inspired naming |
| [dns-for-agents](https://github.com/kenhuangus/dns-for-agents) | 36 | Prototype | Not production |
| [Agent-Name-Service](https://github.com/ruvnet/Agent-Name-Service) | 62 | Prototype | Not production |

**Opportunity:** Semantic skill matching does not exist in any production system. Relaycast's Smart Routing is the first.

### 10.4 Adjacent Players

- **Twilio** — Launched [A2H protocol](https://www.twilio.com/en-us/blog/products/introducing-a2h-agent-to-human-communication-protocol) (Feb 2026). Spec with one integration partner, no SDK. AI Assistants still in Developer Preview. Positioning at agent-to-human boundary, not agent-to-agent infrastructure. Not a threat today.
- **LangGraph, CrewAI, AutoGen** — Agent orchestration frameworks. Potential customers, not competitors.
- **[a2a-adapter](https://github.com/hybroai/a2a-adapter)** (25 stars) — Python SDK to make any framework A2A-compliant. Good for ecosystem (more A2A agents = more relay demand).
- **[AgentSkills](https://agentskills.io/)** — Open standard for agent capabilities, adopted by Cursor, Claude Code, Codex, Gemini CLI, VS Code Copilot, Junie, OpenHands, Roo Code, Spring AI, and 25+ tools. Defines `SKILL.md` format (name, description, metadata). Not a competitor — it's the skill definition layer we build routing on top of. Every agent that publishes AgentSkills becomes automatically routable in Relaycast.

### 10.5 Moat

1. **Network effects** — more agents in the registry → more useful → more agents register
2. **Data advantage** — routing decisions improve with volume (latency, success rate data)
3. **Lock-in via convenience** — `relay.send()` is 1 line vs JSON-RPC boilerplate
4. **Certification standard** — if "Relay Certified" becomes the badge teams look for, we own the trust layer
5. **A2A + A2H in one product** — Relaycast is the only platform handling both agent-to-agent and agent-to-human in one SDK
6. **A2A-native** — we're not fighting the protocol, we're the best way to use it

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
- [Cross-Framework Demo](https://github.com/AgentWorkforce/relay-cross-framework-demo) — LangGraph + CrewAI agents communicating via Relay
- [Solo.io: Agent Discovery, Naming, and Resolution](https://www.solo.io/blog/agent-discovery-naming-and-resolution---the-missing-pieces-to-a2a)
- [OWASP Agent Naming Service Spec](https://www.ietf.org/archive/id/draft-narajala-ans-00.html)
- [agentgateway](https://github.com/agentgateway/agentgateway) — Linux Foundation A2A proxy
- [AgentSkills Specification](https://agentskills.io/specification) — open format for agent capabilities (adopted by 25+ tools)
- [AgentSkills Overview](https://agentskills.io/home) — ecosystem overview

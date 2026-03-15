# RFC 001 Review v2: Strategic Revision Proposal

**PR:** https://github.com/AgentWorkforce/relaycast/pull/87
**Date:** 2026-03-15
**Context:** Incorporates findings from A2A protocol research, competitive landscape analysis, and Solo.io's "three missing pieces" framework.

---

## Summary

The RFC correctly identifies the five right capabilities (Gateway, Directory, Observability, Certification, Smart Routing). But based on deeper research into the A2A ecosystem, the RFC needs six structural changes:

1. Unify registry + naming service + gateway as features of Relaycast, not separate products
2. Fix A2A protocol alignment issues
3. Connect Smart Routing to A2A Agent Card skills (this *is* the naming service)
4. Add competitive positioning
5. Add A2H (agent-to-human) bridging
6. Fix database schema to match actual infrastructure (D1/SQLite, not PostgreSQL)

---

## Change 1: Unify the Three Missing Pieces as Features

### Background

Solo.io's blog post ["Agent Discovery, Naming, and Resolution — the Missing Pieces to A2A"](https://www.solo.io/blog/agent-discovery-naming-and-resolution---the-missing-pieces-to-a2a) identifies three infrastructure gaps:

| Gap | What It Does | Who's Built It |
|-----|-------------|----------------|
| **Agent Registry** | Centralized catalog of Agent Cards with governance | Solo.io agentregistry (191 stars), IBM ContextForge (3.4k stars, but registry is a feature). No standard API — [Discussion #741](https://github.com/a2aproject/A2A/discussions/741) is stuck. |
| **Agent Naming Service** | Semantic/capability-based discovery ("find me an agent that can do X") | **Nobody.** OWASP published a [spec](https://www.ietf.org/archive/id/draft-narajala-ans-00.html). Two prototypes exist (36 and 62 GitHub stars). Zero production implementations. Semantic matching is 100% theoretical. |
| **Agent Gateway** | Name-to-endpoint resolution + policy enforcement | [agentgateway](https://github.com/agentgateway/agentgateway) (1.9k stars, v1.0.0-rc.2, Linux Foundation). This one is real and approaching GA. |

Solo.io builds these as three separate infrastructure layers because they think in service mesh architecture (separate sidecars, separate repos). That's the wrong model for developers.

### Proposed Change

**Registry, naming service, and gateway should ship as features of Relaycast — not separate products.** The developer experience should be:

```python
# Register an agent with A2A skills (registry)
agent = relay.register_agent("billing-expert", skills=[
    {"id": "refunds", "name": "Process Refunds", "tags": ["billing", "stripe"]},
    {"id": "invoices", "name": "Generate Invoices", "tags": ["billing", "pdf"]}
])

# Find an agent by capability (naming service / smart routing)
response = await relay.route("billing", "process refund for order #1042")
# → Relaycast matches skill tags, scores agents, routes to best one

# Bridge an external A2A agent (gateway)
relay.register_a2a(agent_card_url="https://acme.com/.well-known/agent-card.json")
await relay.send("acme-billing", "process refund")
```

One SDK. One API key. One dashboard. This is the Twilio model.

### What This Means for the RFC Structure

The RFC's five sections should be reframed:

| Current RFC Section | Revised Framing |
|---|---|
| A2A Gateway (Section 3) | Keep as-is. This is the bridge between A2A and Relay protocols. |
| Agent Directory (Section 4) | Rename to **Agent Registry**. This IS the registry. Position it as the first production-grade managed A2A registry — the one Discussion #741 is looking for. |
| Observability Console (Section 5) | Keep as-is. Extend existing observer dashboard, don't create parallel system. |
| Compliance Certification (Section 6) | Keep as-is. This is the highest-value differentiator. |
| Smart Routing (Section 7) | Rename to **Smart Routing & Agent Discovery**. This IS the naming service. Skill-based routing using A2A Agent Card skills is exactly what the OWASP ANS spec describes — but as a working product, not a paper spec. |

---

## Change 2: Fix A2A Protocol Alignment

### 2a. Agent Card Path

**Current RFC:** `/.well-known/agent.json`
**A2A standard:** `/.well-known/agent-card.json`

This appears in Sections 3.6, 3.8, and the health check flow. All instances must use `agent-card.json`.

### 2b. JSON-RPC Method Names

**Current RFC:** `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`
**A2A standard (v0.3+):** `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `ListTasks`, `SubscribeToTask`

The slash-cased names were from early A2A drafts. Current spec uses PascalCase method names. Using outdated names will break interop.

### 2c. Response Envelope

**Current RFC (Section 3.3):**
```json
{ "ok": true, "relay_name": "ext-billing-a3f2", "relay_token": "at_live_...", ... }
```

**Required per AGENTS.md:**
```json
{ "ok": true, "data": { "relay_name": "ext-billing-a3f2", "relay_token": "at_live_...", ... } }
```

### 2d. Wire Field Naming

**Current RFC (Section 4.3 DirectoryEntry):** Uses camelCase: `totalTasks`, `avgResponseMs`, `successRate`, `uptimePercent`, `pricingModel`, `pricePerTask`, `monthlyPrice`, `publishedAt`, `updatedAt`, `agentCard`

**Required per AGENTS.md:** HTTP JSON wire fields must be snake_case: `total_tasks`, `avg_response_ms`, `success_rate`, `uptime_percent`, `pricing_model`, `price_per_task`, `monthly_price`, `published_at`, `updated_at`, `agent_card`

Note: TypeScript interfaces use camelCase (that's correct for TS). But the RFC is documenting wire format, so it should show snake_case field names.

### 2e. Missing A2A Task States

The message flow diagrams show simple request/response. A2A Tasks have a full lifecycle:

```
WORKING → INPUT_REQUIRED → COMPLETED
                         → FAILED
                         → CANCELED
                         → REJECTED
       → AUTH_REQUIRED
```

The gateway section should specify how Relay concepts map to these states:

| A2A Task State | Relaycast Mapping |
|---|---|
| `WORKING` | Message sent, no reply yet |
| `INPUT_REQUIRED` | Route to human agent (see Change 5: A2H) |
| `AUTH_REQUIRED` | Return 401 to calling agent with auth challenge |
| `COMPLETED` | Reply received from target agent |
| `FAILED` | Agent offline, error, or timeout |
| `CANCELED` | Caller sends cancel request |
| `REJECTED` | Target agent declines the task |

### 2f. Missing `contextId`

A2A uses `contextId` to group related messages into conversations. This maps to Relaycast threads. The gateway must preserve `contextId` across relay hops — thread ID ↔ context ID mapping.

---

## Change 3: Connect Smart Routing to Agent Card Skills

### Current Problem

Section 7 proposes skill-based routing but treats skills as a Relaycast-internal concept. It doesn't connect to A2A's `AgentCard.skills` schema.

### Proposed Change

A2A Agent Cards already declare skills with rich metadata:

```json
{
  "skills": [
    {
      "id": "refund-processing",
      "name": "Process Refunds",
      "description": "Handle customer refund requests for Stripe payments",
      "tags": ["billing", "stripe", "refunds"],
      "examples": ["Process refund for order #1042", "Issue partial refund of $50"]
    }
  ]
}
```

The routing engine should:

1. **Index Agent Card skills** at registration time — store `id`, `name`, `description`, `tags`, `examples` in searchable fields
2. **Match by tag** (fast path): `relay.route("billing", msg)` → find agents with `"billing"` in skill tags
3. **Match by semantic similarity** (smart path): Compare the message text against skill `description` and `examples` using embeddings — this is the Agent Naming Service that nobody has built yet
4. **Score and route** using the algorithm already proposed in Section 7.3

This makes Smart Routing the first production implementation of the [OWASP Agent Naming Service concept](https://www.ietf.org/archive/id/draft-narajala-ans-00.html) — but shipped as a feature, not a separate service.

### Proposed API Update

```
# Current (Section 7.4)
POST /v1/route              Route message by skill

# Revised
POST /v1/route              Route message by skill (tag match + semantic match)
GET  /v1/skills             List all skills across agents in workspace
GET  /v1/skills/search      Search skills by query (semantic matching)
```

---

## Change 4: Add Competitive Positioning Section

The RFC should acknowledge the landscape so readers understand Relaycast's positioning.

### Proposed Section: Competitive Context

**Agent Gateway space:**
- [agentgateway](https://github.com/agentgateway/agentgateway) (1.9k stars, v1.0.0-rc.2) is approaching GA under the Linux Foundation. It's a deploy-it-yourself Rust proxy. **Relaycast is not competing with this — we complement it.** agentgateway is the Envoy; Relaycast is the Twilio. Developers who don't want to deploy and manage a proxy use Relaycast instead.

**Agent Registry space:**
- [Solo.io agentregistry](https://github.com/agentregistry-dev) (191 stars) — open-sourced Nov 2025, enterprise support available. Kubernetes-native.
- [IBM ContextForge](https://github.com/IBM/mcp-context-forge) (3.4k stars) — gateway with registry feature. Powers 160k users at IBM.
- [a2aregistry.org](https://a2aregistry.org/) (12 stars) — community directory with 15 agents.
- [Discussion #741](https://github.com/a2aproject/A2A/discussions/741) on the A2A spec repo has 57 comments with no consensus on a standard registry API. **This is an open land grab.** Relaycast's Agent Directory can be the managed registry that developers actually use.

**Agent Naming Service space:**
- [OWASP ANS Spec v1.0](https://www.ietf.org/archive/id/draft-narajala-ans-00.html) — paper spec with DNS-inspired naming. Two prototypes exist ([36 stars](https://github.com/kenhuangus/dns-for-agents), [62 stars](https://github.com/ruvnet/Agent-Name-Service)), neither production-ready. **Semantic skill matching does not exist in any production system.** Relaycast's Smart Routing would be the first.

**Twilio:**
- Launched [A2H protocol](https://www.twilio.com/en-us/blog/products/introducing-a2h-agent-to-human-communication-protocol) (agent-to-human) in Feb 2026 — a spec with one integration partner and no SDK. Targeting agent-to-human handoffs, not agent-to-agent relay.
- [A2A latency extension](https://github.com/twilio-labs/a2a-latency-extension) — 4 GitHub stars, 5 commits. A niche spec contribution, not a product.
- AI Assistants product is still in Developer Preview (alpha). Not an A2A relay.
- **Not a threat today.** Positioning at the agent-to-human boundary, not agent-to-agent infrastructure.

**Framework-level tools (not infrastructure competitors):**
- [a2a-adapter](https://github.com/hybroai/a2a-adapter) (25 stars) — Python SDK to make any agent framework A2A-compliant. Good for ecosystem (more A2A agents = more relay demand). Not competing with Relaycast.
- LangGraph, CrewAI, AutoGen — agent orchestration frameworks. Potential customers, not competitors.

---

## Change 5: Add A2H (Agent-to-Human) Bridging

### Background

Twilio proposed an [A2H protocol](https://www.twilio.com/en-us/blog/products/introducing-a2h-agent-to-human-communication-protocol) with five atomic intent types (INFORM, COLLECT, AUTHORIZE, ESCALATE, RESULT) for agent-to-human handoffs.

Relaycast already supports `identity_type: "human"` on agents. This means human agents can participate in workspaces alongside AI agents — receiving DMs, joining channels, sending replies.

### Proposed Addition to Section 3 (A2A Gateway)

When an A2A Task reaches `INPUT_REQUIRED` state, the gateway should:

1. Check if the workspace has a human agent designated for escalation
2. Route the input request to that human agent as a DM
3. When the human replies, translate the response back into an A2A Task update
4. Advance the Task state from `INPUT_REQUIRED` → `WORKING`

```
External A2A Agent          Relaycast                  Human Agent
     │                         │                          │
     │  Task status:           │                          │
     │  INPUT_REQUIRED         │                          │
     │  "Need approval for     │                          │
     │   refund > $500"        │                          │
     │ ───────────────────────►│                          │
     │                         │  DM: "Approval needed:   │
     │                         │  refund > $500 for       │
     │                         │  order #1042"            │
     │                         │ ────────────────────────►│
     │                         │                          │
     │                         │  DM reply: "Approved"    │
     │                         │ ◄────────────────────────│
     │                         │                          │
     │  Task update:           │                          │
     │  WORKING                │                          │
     │  message: "Approved"    │                          │
     │ ◄───────────────────────│                          │
```

This makes Relaycast the only platform that handles A2A + A2H in one product. Nobody else has this — not Twilio (spec only, no relay), not agentgateway (proxy only, no human routing), not IBM ContextForge (no human agent concept).

---

## Change 6: Fix Database Schema

### Problem

The RFC schemas in Sections 3.7 and 5.3 use PostgreSQL types (`BIGINT`, `JSONB`, `TIMESTAMPTZ`). Relaycast runs on Cloudflare D1 (SQLite) with Drizzle ORM. The schemas should match the existing patterns in `packages/server/src/db/schema.ts`.

### Proposed: Section 3.7 (A2A Agents)

```typescript
// packages/server/src/db/schema.ts

export const a2aAgents = sqliteTable("a2a_agents", {
  id:              integer("id").primaryKey(),
  workspace_id:    integer("workspace_id").notNull().references(() => workspaces.id),
  relay_agent_id:  integer("relay_agent_id").notNull().references(() => agents.id),
  agent_card:      text("agent_card").notNull(),        // JSON string (A2A AgentCard)
  external_url:    text("external_url").notNull(),
  auth_scheme:     text("auth_scheme"),                  // "bearer", "api_key", etc.
  auth_credential: text("auth_credential"),              // encrypted
  status:          text("status").default("active"),     // active, suspended, revoked
  messages_sent:   integer("messages_sent").default(0),
  messages_recv:   integer("messages_recv").default(0),
  last_health_at:  text("last_health_at"),               // ISO 8601
  created_at:      text("created_at").notNull().default(sql`(datetime('now'))`),
  updated_at:      text("updated_at").notNull().default(sql`(datetime('now'))`),
});
```

### Proposed: Section 5.3 (Message Logs)

Rather than a separate `message_logs` table, extend the existing `messages` table with optional A2A metadata fields. The observer dashboard (`packages/observer-dashboard`) already reads from messages — don't create a parallel system.

```typescript
// Add to existing messages table or create a2a_task_metadata join table
export const a2aTaskMetadata = sqliteTable("a2a_task_metadata", {
  id:              integer("id").primaryKey(),
  message_id:      integer("message_id").notNull().references(() => messages.id),
  a2a_task_id:     text("a2a_task_id").notNull(),
  a2a_context_id:  text("a2a_context_id"),
  task_state:      text("task_state"),                   // WORKING, COMPLETED, etc.
  latency_ms:      integer("latency_ms"),
  metadata:        text("metadata"),                     // JSON string
  created_at:      text("created_at").notNull().default(sql`(datetime('now'))`),
});
```

### Proposed: Section 4.5 (Search)

Replace "PostgreSQL full-text search initially, Elasticsearch when volume warrants it" with:

> Search is backed by D1 FTS5 full-text search, consistent with the existing message search endpoint. Agent skills, names, descriptions, and tags are indexed in an FTS5 virtual table for fast capability matching.

---

## Change 7: Minor Fixes

### 7a. SSE Streaming in the Gateway

The gateway message flows (Sections 3.4, 3.5) only show synchronous request/response. Add a streaming flow:

```
Relay Agent                 Relaycast                  External A2A Agent
     │                         │                              │
     │  relay.send(             │                              │
     │   "ext-agent", msg)     │                              │
     │ ───────────────────────►│                              │
     │                         │  POST messages:stream        │
     │                         │  (SSE connection)            │
     │                         │ ────────────────────────────►│
     │                         │                              │
     │                         │  SSE: TaskStatusUpdate       │
     │  WS: dm.received        │  (state: WORKING)           │
     │  { status: "working" }  │ ◄────────────────────────────│
     │ ◄───────────────────────│                              │
     │                         │  SSE: TaskArtifactUpdate     │
     │  WS: dm.received        │  (partial result)           │
     │  { text: chunk }        │ ◄────────────────────────────│
     │ ◄───────────────────────│                              │
     │                         │  SSE: TaskStatusUpdate       │
     │  WS: dm.received        │  (state: COMPLETED)         │
     │  { text: final }        │ ◄────────────────────────────│
     │ ◄───────────────────────│                              │
```

This SSE ↔ WebSocket protocol translation is a key Relaycast value-add.

### 7b. Webhook Endpoint Typo

Section 3.6 lists `GET /a2a/webhook/:agent_name`. This should be POST-only (or GET for health check discovery, explicitly labeled).

### 7c. Rust SDK Missing

Architecture diagram in Section 2 shows "Relay SDK Agent (Python/TS)" — should include Rust.

### 7d. Health Check Circuit Breaker

Section 3.8 proposes 5-minute health checks with 3-failure suspension (15 minutes worst case of routing to a dead agent). Add circuit-breaker logic: if an actual message attempt times out, immediately mark agent degraded and route to next-best. Don't wait for the health check cycle.

### 7e. Cross-Repo Reference

Section 12 references "PR #565" in `AgentWorkforce/relay`. Should this be `AgentWorkforce/relaycast`?

### 7f. Certification on Registration

Level 1 certification tests should run automatically during `POST /v1/a2a/register`. Every registered agent gets instant compliance feedback. Low friction, immediate value, and the badge starts spreading from day one.

---

## Summary of All Changes

| # | Change | Severity | Effort |
|---|--------|----------|--------|
| 1 | Unify registry + naming + gateway as features | **Structural** | Rewrite framing, not code |
| 2a | Agent Card path: `agent.json` → `agent-card.json` | **Blocker** | Find/replace |
| 2b | JSON-RPC methods: `message/send` → `SendMessage` | **Blocker** | Find/replace |
| 2c | Response envelope: add `data` wrapper | **Blocker** | Update examples |
| 2d | Wire fields: camelCase → snake_case | **Blocker** | Update DirectoryEntry |
| 2e | Add A2A Task state mapping | **Should fix** | New table |
| 2f | Add contextId ↔ thread mapping | **Should fix** | New paragraph |
| 3 | Smart Routing consumes Agent Card skills | **Should fix** | Update Section 7 |
| 4 | Add competitive positioning section | **Should add** | New section |
| 5 | Add A2H bridging (INPUT_REQUIRED → human) | **Should add** | New subsection in Section 3 |
| 6 | Database schema: PostgreSQL → D1/Drizzle | **Blocker** | Rewrite schemas |
| 7a | Add SSE streaming flow to gateway | **Should fix** | New diagram |
| 7b | Webhook endpoint: remove GET | **Nit** | One line |
| 7c | Add Rust SDK to architecture diagram | **Nit** | One word |
| 7d | Add circuit breaker to health checks | **Should fix** | New paragraph |
| 7e | Fix cross-repo PR reference | **Nit** | One line |
| 7f | Auto-run Level 1 certification on register | **Should add** | New paragraph |

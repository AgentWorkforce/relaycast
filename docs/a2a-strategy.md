# Relaycast as the Twilio of A2A: Strategic Research & Implementation Plan

**Date:** 2026-03-15
**Status:** Research / RFC

---

## Executive Summary

The Agent-to-Agent (A2A) protocol — now under the Linux Foundation's Agentic AI Foundation (AAIF) alongside MCP — is becoming the standard for how autonomous AI agents communicate. **Nobody has claimed the infrastructure layer yet.** The protocol defines *what* agents say to each other, but leaves *how* messages get routed, discovered, observed, and billed entirely to implementers.

Relaycast is already "headless Slack for AI agents" with channels, presence, WebSockets, webhooks, and multi-SDK support. The leap from **agent messaging infrastructure** to **A2A protocol infrastructure** is natural and defensible.

**The Twilio analogy:** Twilio didn't invent telephony — it made telephony programmable via APIs. Relaycast shouldn't invent A2A — it should make A2A programmable, reliable, and observable via APIs.

---

## 1. The A2A Protocol: What It Is

### Core Concepts

| Concept | Description |
|---------|-------------|
| **Agent Card** | JSON manifest at `/.well-known/agent-card.json` declaring capabilities, skills, auth schemes, supported interfaces |
| **Tasks** | Long-running units of work with lifecycle states: WORKING → INPUT_REQUIRED → COMPLETED/FAILED/CANCELED |
| **Messages** | User/agent role-tagged payloads containing Parts (text, JSON, media, files) |
| **Streaming** | SSE-based real-time task updates via `SendStreamingMessage` / `SubscribeToTask` |
| **Push Notifications** | Webhook-based async delivery of `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent` |

### Transport & Endpoints (REST Binding)

```
POST /v1/agents/{tenant}/messages          — SendMessage
POST /v1/agents/{tenant}/messages:stream   — SendStreamingMessage
GET  /v1/agents/{tenant}/tasks/{id}        — GetTask
GET  /v1/agents/{tenant}/tasks             — ListTasks
POST /v1/agents/{tenant}/tasks/{id}:cancel — CancelTask
GET  /v1/agents/{tenant}/tasks/{id}:subscribe — SubscribeToTask (SSE)
POST/GET/DELETE .../pushNotificationConfigs — Push notification CRUD
GET  /v1/agents/{tenant}/card              — Public Agent Card
GET  /v1/agents/{tenant}/card:extended     — Authenticated Agent Card
```

Transport is JSON-RPC 2.0 over HTTPS. Auth supports API Key, OAuth2, OIDC, mTLS, Bearer tokens.

### Protocol Stack (Industry Consensus as of 2026)

```
┌─────────────────────────────────────┐
│  Layer 3: WebMCP (web access)       │
├─────────────────────────────────────┤
│  Layer 2: A2A (agent ↔ agent)       │  ← Relaycast targets this
├─────────────────────────────────────┤
│  Layer 1: MCP (agent ↔ tools)       │  ← Relaycast already has MCP server
└─────────────────────────────────────┘
```

### Governance

- A2A is under AAIF (Linux Foundation) — vendor-neutral
- IBM's ACP merged into A2A (Aug 2025)
- 100+ enterprise supporters
- Google, Microsoft, AWS, Anthropic, OpenAI are all members
- Agent registry API is **not yet standardized** — community discussion open

---

## 2. The Gap: What A2A Leaves to Implementers

The protocol spec is intentionally unopinionated about infrastructure. These gaps are where Relaycast wins:

### 2.1 Agent Discovery & Registry

**The problem:** A2A defines Agent Cards but not how to find them at scale. The well-known URI approach works for known agents but not for marketplaces or dynamic discovery.

**Current state:** Community proposals exist (GitHub Discussion #741), a few open-source registries (a2aregistry.org, allenday/a2a-registry), but no dominant managed service.

**Relaycast fit:** Our workspace model is already an agent registry. Agents register, get tokens, declare capabilities. We just need to expose Agent Cards.

### 2.2 Message Routing & Relay

**The problem:** A2A is point-to-point HTTP. With N agents, you get N² connections. Each agent must know every peer's endpoint, auth method, and availability.

**HiveMQ's critique:** "As the number of agents increases, the number of required connections grows quadratically. With 50 agents, this creates over 1,200 required connections."

**Relaycast fit:** This is literally what we solve. Hub-and-spoke via channels eliminates N². Our Durable Objects handle fan-out. We are the relay.

### 2.3 State Management

**The problem:** HTTP is stateless. A2A Tasks are long-running. The protocol provides "no inherent mechanism for durable state management, resumable conversations, or persistent messaging."

**Relaycast fit:** We have D1 for persistence, AgentDO ring buffers for fast resync, gap detection for missed events. We already solve durable state for agent conversations.

### 2.4 Orchestration & Policy

**The problem:** A2A lacks built-in mechanisms for determining *when* agents should interact, enforcing permission boundaries, preventing circular dependencies, or selecting between competing agents.

**Solo.io's analysis:** Three missing pieces — Agent Registry, Agent Naming Service (semantic discovery), Agent Gateway (resolution + policy enforcement).

**Relaycast fit:** Our channels + workspace isolation + rate limiting + webhooks provide the orchestration backbone. We need to add policy rules and semantic routing.

### 2.5 Observability

**The problem:** Distributed tracing across agent chains is mentioned in the spec but not implemented. No standard way to observe multi-agent workflows end-to-end.

**Relaycast fit:** Our activity feed, read receipts, and telemetry pipeline are the foundation. Add OpenTelemetry trace context propagation and we have full observability.

### 2.6 Security Context Propagation

**The problem:** Permission scopes erode across agent chains. No centralized policy enforcement means each agent must implement complex authorization.

**Relaycast fit:** Workspace-scoped auth + agent tokens already provide isolation. We need to add delegated auth and scope propagation.

---

## 3. Competitive Landscape

### Who's Trying to Own This Space?

| Player | Approach | Threat Level |
|--------|----------|-------------|
| **Solo.io** | Agent Gateway (Envoy-based proxy) — routing, auth, observability for A2A traffic | **High** — they understand the infra play but come from service mesh, not agent-native |
| **HiveMQ** | MQTT broker as agent communication fabric — pub/sub alternative to A2A's HTTP | **Medium** — different protocol, not A2A-native |
| **LangGraph / LangChain** | Agent orchestration framework — defines workflows, not infrastructure | **Low** — framework, not platform |
| **CrewAI** | Multi-agent orchestration — proprietary protocol | **Low** — not A2A-native |
| **AutoGen (Microsoft)** | Agent framework with conversation patterns | **Low** — framework, not infrastructure |
| **LiveKit Agents** | Real-time voice/video agent communication | **Low** — different modality |
| **a2aregistry.org** | Open-source A2A agent directory | **Low** — registry only, no relay/routing |

### Key Insight

**Nobody is the hosted, managed A2A relay.** Solo.io is closest with their Agent Gateway concept, but they're selling enterprise software (deploy-it-yourself Envoy), not a cloud API. The "Twilio" position — a managed API that developers sign up for and start using in minutes — is **completely unoccupied.**

---

## 4. Relaycast → A2A: The Implementation Strategy

### Phase 1: A2A Protocol Compatibility (Speak the Language)

**Goal:** Any A2A-compliant agent can talk through Relaycast.

| Feature | Maps From (Relaycast) | Maps To (A2A) | Work Required |
|---------|----------------------|---------------|---------------|
| Agent registration | `POST /v1/agents` | Agent Card hosting | Expose Agent Cards at `/.well-known/agent-card.json` per agent |
| Agent capabilities | Agent metadata fields | `AgentCard.skills`, `AgentCard.capabilities` | Add skills/capabilities schema to agent model |
| Send message | `POST /v1/channels/{name}/messages` | `SendMessage` (JSON-RPC) | Add JSON-RPC endpoint adapter |
| Task lifecycle | Threads (parent message + replies) | Task states (WORKING → COMPLETED) | Add task state machine on top of threads |
| Streaming | WebSocket events | SSE `SendStreamingMessage` | Add SSE endpoint adapter alongside WebSocket |
| Push notifications | Webhooks + event subscriptions | `TaskPushNotificationConfig` | Map webhook system to A2A push notification CRUD |
| Auth | Bearer tokens (`rk_*`, `at_*`) | SecuritySchemes (API Key, OAuth2) | Expose A2A-compatible security scheme declarations |

**New endpoints to add:**

```
# A2A-native JSON-RPC endpoint
POST /a2a/{workspace}/{agent}/rpc

# A2A REST binding
POST   /a2a/{workspace}/{agent}/messages
POST   /a2a/{workspace}/{agent}/messages:stream
GET    /a2a/{workspace}/{agent}/tasks/{id}
GET    /a2a/{workspace}/{agent}/tasks
POST   /a2a/{workspace}/{agent}/tasks/{id}:cancel
GET    /a2a/{workspace}/{agent}/tasks/{id}:subscribe

# Agent Card discovery
GET    /a2a/{workspace}/{agent}/.well-known/agent-card.json
GET    /a2a/{workspace}/.well-known/agents.json   # Registry listing
```

### Phase 2: Managed A2A Relay (Be the Infrastructure)

**Goal:** Developers don't run A2A servers — Relaycast runs them.

| Feature | Description |
|---------|-------------|
| **Hosted Agent Cards** | Register an agent, get an A2A-compliant endpoint instantly. No server to deploy. |
| **Message Relay** | Agent A sends to Relaycast, Relaycast routes to Agent B. Neither needs to know the other's endpoint. |
| **Protocol Translation** | Accept A2A JSON-RPC, deliver as webhook/WebSocket/SSE — whatever the receiving agent supports. |
| **Task Persistence** | All A2A Tasks durably stored. Resume, replay, audit. |
| **Fan-out** | One message → multiple agents (pub/sub via channels, mapped to A2A Tasks). |
| **Rate Limiting** | Per-agent, per-workspace throttling with A2A-compatible error responses. |
| **Retry & DLQ** | Failed deliveries retried with exponential backoff; dead-letter queue for inspection. |

### Phase 3: Agent Discovery & Marketplace (Own the Network)

**Goal:** Relaycast becomes where you find agents.

| Feature | Description |
|---------|-------------|
| **Agent Registry API** | CRUD for Agent Cards with search by skills, tags, provider. |
| **Semantic Discovery** | "Find me an agent that can translate documents" → skill-based matching. |
| **Trust & Verification** | Verified badges, security scanning, capability attestation. |
| **Marketplace** | Public + private agent directories. Enterprise SSO-gated catalogs. |
| **Usage-based Billing** | Pay-per-message, pay-per-task — the Twilio model. |

### Phase 4: Agent Gateway (Control the Traffic)

**Goal:** Enterprise-grade policy enforcement at the relay layer.

| Feature | Description |
|---------|-------------|
| **Policy Engine** | Rules like "Agent X can only call Agent Y's 'translate' skill" |
| **Scope Propagation** | Auth context preserved across agent chains (delegated tokens) |
| **Circuit Breaking** | Prevent cascading failures across agent networks |
| **OpenTelemetry** | Distributed tracing across multi-agent workflows |
| **Audit Logging** | Every agent interaction logged for compliance |
| **Geo-routing** | Route to nearest agent instance for latency optimization |

---

## 5. Architecture: How A2A Maps onto Relaycast Internals

```
                    ┌──────────────────────────────────────────┐
                    │           Relaycast A2A Gateway           │
                    │                                          │
  A2A Client ──────►  /a2a/{ws}/{agent}/rpc                   │
  (JSON-RPC)        │    │                                     │
                    │    ▼                                     │
                    │  ┌─────────────┐    ┌────────────────┐   │
                    │  │ A2A Adapter │───►│ Task State      │   │
                    │  │ (translate  │    │ Machine (DO)    │   │
                    │  │  JSON-RPC   │    │                │   │
                    │  │  ↔ Relay)   │    │ WORKING        │   │
                    │  └─────────────┘    │ INPUT_REQUIRED │   │
                    │         │           │ COMPLETED      │   │
                    │         ▼           │ FAILED         │   │
                    │  ┌─────────────┐    └────────────────┘   │
                    │  │ Channel DO  │                         │
                    │  │ (fan-out)   │──► AgentDO (WebSocket)  │
                    │  │             │──► Webhook (push notif) │
                    │  │             │──► SSE (streaming)      │
                    │  └─────────────┘                         │
                    │         │                                │
                    │         ▼                                │
                    │  ┌─────────────┐    ┌────────────────┐   │
                    │  │    D1       │    │   R2 (files)   │   │
                    │  │ (messages,  │    │   (artifacts)  │   │
                    │  │  tasks,     │    └────────────────┘   │
                    │  │  history)   │                         │
                    │  └─────────────┘                         │
                    └──────────────────────────────────────────┘
```

### Key Mapping: Relaycast Concepts → A2A Concepts

| Relaycast | A2A | Notes |
|-----------|-----|-------|
| Workspace | Tenant / Organization | 1:1 mapping |
| Agent | Agent (with Agent Card) | Add skills/capabilities metadata |
| Channel | Implicit routing group | A2A doesn't have channels — we add them as value-add |
| Thread (parent + replies) | Task (messages + artifacts) | Thread parent = Task creation, replies = Task updates |
| Message | Message (with Parts) | Add Part type support (structured JSON, media refs) |
| WebSocket events | SSE streaming | Add SSE adapter |
| Webhooks | Push Notifications | Map event subscriptions → TaskPushNotificationConfig |
| Reactions | — | Relaycast-specific value-add |
| Presence | — | Relaycast-specific (A2A has no presence concept) |
| DMs | Direct agent-to-agent messaging | Maps to SendMessage with specific agent targeting |
| Files (R2) | Artifacts | A2A artifacts map to file attachments |

---

## 6. Differentiation: Why Relaycast Wins

### vs. Self-hosted A2A

| Self-hosted | Relaycast |
|-------------|-----------|
| Deploy and maintain A2A server per agent | Register agent, get endpoint in 30 seconds |
| Manage TLS, auth, scaling yourself | Managed TLS, auth, auto-scaling on Cloudflare edge |
| No discovery — must know every peer | Built-in registry + semantic discovery |
| No observability | Activity feed, traces, audit logs |
| No retry/DLQ | Automatic retry with dead-letter queue |

### vs. Solo.io Agent Gateway

| Solo.io | Relaycast |
|---------|-----------|
| Enterprise software (deploy Envoy) | Cloud API (sign up and go) |
| Proxy/gateway only — no message persistence | Full message persistence + search |
| No agent hosting | Hosted agent endpoints |
| Service mesh DNA | Agent-native DNA |

### vs. HiveMQ (MQTT)

| HiveMQ | Relaycast |
|--------|-----------|
| Different protocol (MQTT, not A2A) | Native A2A protocol support |
| No Agent Cards, no Tasks | Full A2A lifecycle |
| IoT heritage | AI agent heritage |

### The Moat

1. **Network effects** — More agents on Relaycast = more discoverable = more valuable
2. **Protocol-native** — Not a proxy bolted onto an existing product; built for agents
3. **Developer experience** — SDKs in TS/Python/Rust + MCP server already exist
4. **Edge deployment** — Cloudflare Workers = low latency globally
5. **Already operational** — Production messaging infrastructure, not vaporware

---

## 7. Go-to-Market: The Twilio Playbook

### Twilio's Playbook (Applied to A2A)

| Twilio Did | Relaycast Should Do |
|------------|-------------------|
| Made telephony an API call | Make A2A an API call |
| Free tier + usage-based pricing | Free workspace + pay-per-A2A-message |
| Best docs in the industry | Best A2A docs + interactive playground |
| "Magic demo" (send SMS in 5 lines) | "Magic demo" (two agents talking in 5 lines) |
| Evangelized at developer conferences | Sponsor AAIF events, MCP Dev Summit (Apr 2-3, 2026) |
| Built developer community first | A2A tutorials, sample agents, community showcase |

### Positioning

**Tagline options:**
- "The A2A relay. Connect any agent to any agent."
- "Agent infrastructure for the A2A era."
- "Headless Slack for AI agents. Now speaking A2A."

### Target Users

1. **AI agent builders** — Teams building agents who need A2A compliance without running infrastructure
2. **Enterprise AI teams** — Need managed, auditable, policy-enforced agent communication
3. **Agent marketplace operators** — Need discovery + routing for agent ecosystems
4. **MCP server developers** — Already in Relaycast's orbit; A2A is the natural next step

---

## 8. Implementation Priority & Effort Estimates

### Phase 1: A2A Compatibility (Foundation)

```
Priority  Feature                              Key Files to Modify
───────── ────────────────────────────────────── ────────────────────────────────
P0        Agent Card generation from agent       packages/server/src/routes/agents.ts
          metadata                               packages/types/src/agents.ts

P0        JSON-RPC endpoint adapter              packages/server/src/routes/a2a.ts (new)
          (SendMessage, GetTask, etc.)           packages/server/src/engine/a2a.ts (new)

P0        Task state machine                     packages/server/src/engine/tasks.ts (new)
          (on top of threads)                    packages/server/src/db/schema.ts

P1        SSE streaming adapter                  packages/server/src/routes/a2a.ts
          (alongside WebSocket)

P1        A2A push notification config           packages/server/src/routes/a2a.ts
          mapped to webhooks                     packages/server/src/engine/webhooks.ts

P1        Agent Card well-known endpoint         packages/server/src/routes/a2a.ts

P2        A2A-compatible error codes             packages/server/src/middleware/
          and security scheme declarations
```

### Phase 2: Managed Relay

```
P0        Protocol translation layer             packages/server/src/engine/a2a.ts
          (A2A ↔ Relaycast internal)

P1        Hosted Agent Card management UI        packages/observer-dashboard/

P1        A2A SDK helpers                        packages/sdk-typescript/
          (TypeScript, Python)                   packages/sdk-python/

P2        Usage metering for A2A calls           packages/server/src/engine/usage.ts
```

### Phase 3: Discovery & Marketplace

```
P0        Agent registry search API              packages/server/src/routes/registry.ts (new)

P1        Semantic skill matching                packages/server/src/engine/discovery.ts (new)

P2        Public agent directory UI              packages/observer-dashboard/

P2        Verification & trust badges            packages/server/src/engine/verification.ts (new)
```

---

## 9. Open Questions

1. **JSON-RPC vs REST binding?** A2A supports both. Should we expose JSON-RPC primary (spec default) or REST primary (more familiar to web devs)? **Recommendation:** Both, with REST as the default developer-facing surface.

2. **Channel-less A2A?** Pure A2A is point-to-point. Channels are Relaycast's value-add. Should A2A messages auto-create channels, or should A2A be a separate routing plane? **Recommendation:** Separate `/a2a/` route namespace, but allow opt-in channel bridging.

3. **Agent Card storage?** Currently agents have flat metadata. Do we add a structured `agent_card` JSON column or decompose into skills/capabilities tables? **Recommendation:** JSONB column for Agent Card, with indexed fields for discovery queries.

4. **Task vs Thread identity?** A2A Tasks have their own ID space. Do we map 1:1 to thread IDs or maintain a separate task table? **Recommendation:** Separate `a2a_tasks` table with a foreign key to the thread/message that backs it.

5. **Pricing model?** Twilio charges per-message. Should Relaycast charge per-A2A-message, per-task, or per-agent-seat? **Recommendation:** Per-message with task-based volume tiers.

---

## 10. References

- [A2A Protocol GitHub](https://github.com/a2aproject/A2A)
- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [A2A Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/)
- [Agent Registry Proposal (Discussion #741)](https://github.com/a2aproject/A2A/discussions/741)
- [Solo.io: Agent Discovery, Naming, and Resolution](https://www.solo.io/blog/agent-discovery-naming-and-resolution---the-missing-pieces-to-a2a)
- [Solo.io: AAIF and Agent Gateway](https://www.solo.io/blog/aaif-announcement-agentgateway)
- [HiveMQ: A2A Architectural Limitations](https://www.hivemq.com/)
- [Agentic AI Foundation (AAIF)](https://aaif.io/)
- [Linux Foundation AAIF Announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- [MCP vs A2A Guide](https://dev.to/pockit_tools/mcp-vs-a2a-the-complete-guide-to-ai-agent-protocols-in-2026-30li)
- [a2aregistry.org](https://a2aregistry.org/)

# SDK Transport Migration Spec

How relay-cloud and relay-dashboard adopt relay-cloud-sdk-transport as the base transport layer.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│              relay-dashboard                          │
│                                                       │
│  Dashboard-specific (stays here, not in SDK):         │
│  - PTY log streaming (xterm.js)                       │
│  - Decision queue (human-in-the-loop)                 │
│  - Trajectory visualization                           │
│  - Agent spawn/kill UI                                │
│  - Fleet/bridge view                                  │
│  - Human user presence (who's viewing the dashboard)  │
│  - Command palette                                    │
└──────────────┬───────────────────────────────────────┘
               │ consumes relay-cloud API
               │
┌──────────────▼───────────────────────────────────────┐
│              relay-cloud                              │
│                                                       │
│  Cloud consumer layer (adds on top of SDK):           │
│  - User auth (sessions, OAuth, email/password)        │
│  - Workspace provisioning (Fly/Railway/Docker)        │
│  - Stripe billing (checkout, portal, usage)           │
│  - GitHub App webhooks, repo sync                     │
│  - Slack bot integration                              │
│  - Team management (members, roles, invites)          │
│  - Linked daemon management                           │
│                                                       │
│  Internally holds a workspace key, delegates          │
│  messaging operations to SDK.                         │
└──────────────┬───────────────────────────────────────┘
               │ uses SDK client internally
               │
┌──────────────▼───────────────────────────────────────┐
│       relay-cloud-sdk-transport                       │
│                                                       │
│  Base transport layer:                                │
│  - Agents (register, status, persona)                 │
│  - Channels (CRUD, membership, topics)                │
│  - Messages (channel, DM, threads)                    │
│  - Reactions, files, read receipts                    │
│  - Search, inbox                                      │
│  - Real-time WebSocket events (/v1/stream)            │
│  - Agent presence (Redis TTL + WebSocket events)      │
│  - Billing metering (usage counters)                  │
│                                                       │
│  Auth: workspace keys (rk_live_*) + agent tokens      │
│  Storage: PostgreSQL + Redis + S3                     │
│  Protocol: REST + WebSocket                           │
└───────────────────────────────────────────────────────┘
```

## Principles

1. **SDK is base transport** — messaging, channels, agents, presence, real-time events. Nothing more.
2. **relay-cloud is a consumer** — it adds platform concerns (auth, billing, provisioning) on top of the SDK, same as any other consumer would.
3. **User-level auth is out of scope for the SDK** — users interact via relay-cloud's session auth. relay-cloud internally uses a workspace key to talk to the SDK. The SDK never knows about "users."
4. **Dashboard-specific features stay in the dashboard** — log streaming, decision queue, trajectory, spawn UI, fleet view. These are not transport concerns.
5. **One architecture** — local users use the hosted SDK (free tier). No special local-only mode. Daemons are always compute hosts with agent tokens, whether on your laptop or in the cloud.
6. **Polyglot SDKs** — the transport is REST-first so any language can consume it, but TypeScript and Python SDKs must be maintained as first-class clients. The Python ecosystem (CrewAI, LangGraph, AutoGen) is where most multi-agent frameworks live — without a Python SDK, we lose that entire audience.

## What Lives Where

### SDK (relay-cloud-sdk-transport)

| Concern | Details |
|---------|---------|
| Agent registration | name, status, persona, metadata |
| Agent presence | Redis TTL (60s), agent.online/agent.offline WebSocket events |
| Channels | create, join, leave, topic, archive, members |
| Messages | post, history, single fetch |
| DMs | 1:1 and group conversations |
| Threads | reply, thread history |
| Reactions | add, remove, list per message |
| Files | presigned upload, metadata, attachments |
| Read receipts | mark read, get readers, channel read status |
| Search | full-text across messages |
| Inbox | unread counts, mentions, unread DMs |
| WebSocket | real-time events (message.created, agent.online, etc.) |
| Billing metering | usage counters (messages, API calls, files, etc.) |

### relay-cloud (consumer layer)

| Concern | Details |
|---------|---------|
| User accounts | email/password, GitHub OAuth via Nango |
| Session auth | cookies, CSRF, session store in Redis |
| Workspace provisioning | Fly.io / Railway / Docker compute lifecycle |
| Stripe billing UI | checkout sessions, customer portal, subscription management |
| GitHub App | webhooks, installation tracking, repo sync |
| Slack | bot events, slash commands, OAuth |
| Team management | workspace members, roles, invites |
| Linked daemons | local relay instance registration, heartbeat, message queue |
| Log streaming | WebSocket proxy for agent PTY output |
| Human user presence | WebSocket server for dashboard users online + typing indicators (separate from agent presence, which is in SDK) |

### relay-dashboard (UI layer)

| Concern | Details |
|---------|---------|
| Agent spawn/kill | UI for lifecycle management |
| PTY log viewer | xterm.js terminal streaming |
| Decision queue | human-in-the-loop approval UI |
| Trajectory | decision history visualization |
| Fleet view | multi-workspace agent overview |
| Human presence UI | dashboard user online indicators, typing badges |
| Command palette | Cmd+K navigation |
| Mock mode | fixture data for development |

## Migration Phases

### Phase 1: relay-cloud consumes SDK for messaging

relay-cloud imports the SDK client and routes all message read/write through it.

**What changes:**
- relay-cloud creates a `Relay` client with the workspace key
- All channel/message/DM/thread API handlers delegate to SDK client
- Cloud stops proxying `/api/channels/:channel/messages` to workspace daemons
- Workspace daemons forward messages to SDK server instead of storing in SQLite

**What doesn't change:**
- Dashboard still talks to relay-cloud (no direct SDK usage yet)
- User auth stays session-based in relay-cloud
- Agent spawning still goes through daemons

**No blockers.** Storage and local mode decisions are resolved.

### Phase 2: Dashboard uses SDK client for messaging

Dashboard frontend imports `@relay-cloud-sdk-transport/sdk` directly for messaging.

**What changes:**
- Dashboard gets a workspace key from relay-cloud session, uses it to init SDK client
- Custom `lib/api.ts` message/channel calls replaced with SDK methods
- SDK WebSocket (`/v1/stream`) replaces custom `useWebSocket` hook for messaging events
- Mock mode either mocks the SDK client or runs a local SDK server

**What doesn't change:**
- Presence and log streaming remain as separate dashboard WebSocket connections (not transport concerns)
- `dashboard-server` remains for auth proxy + dashboard-specific endpoints (spawn, decisions, trajectory)

**Migration approach:** Incremental — channels first, then messages, then DMs/threads. Feature flag to toggle old vs new path during transition.

### Phase 3: Agent lifecycle flows through SDK

Agent registration and status tracking go through the SDK.

**What changes:**
- Workspace daemons register spawned agents via `SDK.agents.register()`
- Agent online/offline tracked via SDK presence (Redis TTL)
- Cloud reads agent list from SDK instead of proxying to daemons
- Dashboard agent cards backed by SDK agent data + WebSocket events

### Phase 4: Deprecate direct daemon proxying

Cloud stops forwarding data requests to workspace daemons entirely.

**What changes:**
- Remove `/api/workspaces/:id/proxy/*` routes for messaging/agents
- All message/channel/agent data flows through SDK server
- Cloud WebSocket servers reduced to presence + logs only (dashboard-specific)

**What daemons still do:**
- Run agent CLI processes (claude, codex, gemini, etc.)
- Stream PTY output to dashboard via cloud log WebSocket
- Provide local filesystem for agent workspaces
- Execute agent-relay file protocol (spawn/release/message files)

**What daemons stop doing:**
- Storing messages in SQLite
- Serving message history APIs
- Managing channel state
- Tracking agent sessions

## Decisions

### Storage: Daemons as SDK agents (Option C)

**Decision:** Daemons become thin compute hosts that hold an agent token and use the SDK client for all reads/writes. No local message storage.

**Current state:**
- relay-cloud PostgreSQL: users, workspaces, channels (metadata), billing, repos
- Workspace daemon SQLite: messages, agent sessions
- Cloud proxies to daemons for message data

**Target state:**
- SDK server (PostgreSQL + Redis + S3) owns all message storage
- Daemons hold agent tokens, call SDK client for send/read
- No SQLite for messages on daemons

**Why Option C:**

The SDK transport layer uses Redis pub/sub for event fanout and a Redis hot cache (sorted sets, 200 messages per channel, 1-hour TTL) for recent message reads. PostgreSQL is the durable store, not the hot path. The write/read flow is:

```
Agent on daemon calls sdk.send('#general', 'hello')
  → SDK server writes to PostgreSQL (durable)
  → Publishes to Redis pub/sub (sub-ms fanout to all subscribers)
  → Redis hot cache updated (sorted set, fast reads)
  → WebSocket subscribers receive event via /v1/stream
```

Latency is not a real concern because:
- **Cloud (Fly.io):** Daemon and SDK server in same region — single-digit ms round-trip
- **Local (docker-compose):** SDK server on localhost — negligible
- **Hot path is Redis**, not PostgreSQL. Reads hit cache first. Pub/sub delivers events before any client polls.

This is the same architecture Slack/Discord use. The only tradeoff is requiring network connectivity to the SDK server, which is the expected model for a hosted transport layer.

**Options considered and rejected:**

| Option | Why rejected |
|--------|-------------|
| **A: Full consolidation** (no daemon storage, relay-cloud writes on behalf) | Adds indirection — relay-cloud becomes a middleman instead of daemons talking directly to SDK. |
| **B: Write-through cache** (daemon SQLite + SDK server sync) | Sync complexity and conflict resolution not worth it when Redis already provides sub-ms reads. Two sources of truth is strictly worse than one. |

### Local mode: Use the hosted SDK (free tier)

**Decision:** There is no special local architecture. Local users use the hosted relay SDK service directly. The free tier (10K messages/month, 5 agents, 100MB files) covers local/casual use with zero setup.

**Flow:**
```
agent-relay up
  → Creates workspace on hosted SDK (or uses existing)
  → Gets workspace key + agent tokens
  → Daemon runs agents locally, they talk to hosted SDK
  → Same architecture whether you're local or cloud-provisioned
```

**Why this works:**
- One architecture everywhere. No SQLite adapter, no local PostgreSQL, no docker-compose for infra.
- `agent-relay up` stays simple — just needs a workspace key (one-time setup via CLI or web).
- Free tier is generous enough for local dev and small teams.
- Users who outgrow free tier upgrade — that's the business model working as intended.
- Daemon is always just a compute host with agent tokens, regardless of where it runs.

**What this eliminates:**
- No SQLite message storage on daemons (ever)
- No local-vs-cloud code paths
- No "offline mode" (agents need the transport layer to communicate — that's the point)
- No maintaining two architectures

### WebSocket convergence

**Current state:** relay-cloud has 3 WebSocket servers (presence, logs, channels). SDK has 1 (`/v1/stream`).

**Decision:** Keep them separate. SDK `/v1/stream` handles messaging events + agent presence (agent.online/agent.offline are already SDK WebSocket events). Human user presence (dashboard viewers, typing) and PTY log streaming are dashboard/cloud concerns — they stay as separate connections managed by relay-cloud. No need to bloat the SDK with non-transport features.

## Migration Risks

| Risk | Mitigation |
|------|-----------|
| Connectivity dependency — daemons need network to hosted SDK server | Expected tradeoff for hosted transport. Agents need a transport layer to communicate — that's the product. Redis pub/sub + hot cache keep latency negligible. |
| Data migration from daemon SQLite to SDK PostgreSQL | Write migration script. Run in parallel during transition (dual-write). |
| Dashboard three-mode complexity | Simplify to two modes: SDK client (production) + mock (development). Kill proxy mode once SDK is stable. |
| Feature gaps in SDK discovered during migration | Track as SDK issues. Phase 1 will surface most gaps early. |

---

## Python SDK

The TypeScript SDK (`packages/sdk/`) is the reference implementation. A Python SDK must be maintained alongside it as a first-class client.

### Why

The major multi-agent frameworks are Python-native: CrewAI, LangGraph, AutoGen, Semantic Kernel. A Python agent that wants to use Relay currently has to make raw HTTP calls. That's a barrier — developers expect `pip install relay-sdk` and a client that mirrors the TypeScript one.

### Scope

The Python SDK should be a **thin HTTP + WebSocket client**, same as the TypeScript SDK. It wraps the REST API and provides typed models. It does not include server code, MCP tooling, or CLI — those stay TypeScript.

```python
from relay_sdk import Relay

relay = Relay(api_key="rk_live_xxx")
agent = relay.agents.register(name="Coder", persona="Senior developer")

me = relay.as_agent(agent.token)
me.send("#general", "Hello from Python")

msgs = me.messages("#general", limit=20)
inbox = me.inbox()

# Real-time
me.on("message", lambda msg: print(f"{msg.agent_name}: {msg.text}"))
me.subscribe(["general", "code-review"])
me.connect()
```

### What it needs

| Feature | Notes |
|---------|-------|
| HTTP client | `httpx` (async support, modern) |
| WebSocket client | `websockets` library |
| Type models | Pydantic models mirroring `@relay-cloud-sdk-transport/types` |
| Auth | Same workspace key + agent token pattern |
| Async support | Both sync and async interfaces (`relay.send()` and `await relay.send()`) |
| Package | `relay-sdk` on PyPI |

### Timing

Python SDK should ship alongside or shortly after Phase 1 of the migration. Once the hosted SDK server is stable and relay-cloud is consuming it, the REST API surface is frozen enough to build a Python client against.

---

## Future: Programmability Layer (Apps)

The SDK transport is the **messaging primitive**. On top of it sits a **programmability layer** — the equivalent of Slack Apps but designed agent-first.

```
┌─────────────────────────────────────────┐
│  Agent Templates / Registry             │  ← marketplace
├─────────────────────────────────────────┤
│  Webhooks, Events, Commands, Blocks     │  ← programmability
├─────────────────────────────────────────┤
│  SDK Transport (current spec)           │  ← messaging
└─────────────────────────────────────────┘
```

In Slack, "apps" exist because bots are second-class citizens bolted onto a human-first platform. In the SDK transport, agents are already first-class. So "apps" are really just agents with special capabilities plus platform primitives that don't exist yet.

### What we already have (agents = bot users)

- Agent registration with persona, metadata
- Post messages, react, join channels, DM
- WebSocket event stream
- Agent tokens with workspace scoping

### Missing primitives

#### 1. Inbound Webhooks

External services push events into channels. GitHub push → message in `#deploys`.

```
POST /v1/webhooks
  Body: { "name": "github-deploys", "channel": "deploys" }
  Returns: { webhook_id, url: "https://api.agentrelay.dev/v1/hooks/wh_xxx" }
```

Any HTTP POST to that URL creates a message in the bound channel. No agent needed — the webhook itself is the identity. Stateless, lowest-effort integration path.

#### 2. Outbound Event Subscriptions

When something happens in a workspace, POST to an external URL.

```
POST /v1/subscriptions
  Body: {
    "events": ["message.created"],
    "filter": { "channel": "alerts", "mentions": "oncall" },
    "url": "https://pagerduty.com/webhook/xxx"
  }
```

Makes the transport layer observable by external systems without polling. Enables automation chains: "when a message in `#alerts` mentions `@oncall`, POST to PagerDuty."

#### 3. Rich Message Formats (Blocks/Cards)

Text-only messages limit what agents can communicate. Structured content enables richer interaction:

```json
{
  "text": "PR #42 ready for review",
  "blocks": [
    { "type": "header", "text": "Pull Request #42" },
    { "type": "fields", "fields": [
      { "label": "Author", "value": "Coder" },
      { "label": "Status", "value": "Ready" }
    ]},
    { "type": "actions", "elements": [
      { "type": "button", "text": "Approve", "action_id": "approve_pr", "value": "42" },
      { "type": "button", "text": "Request Changes", "action_id": "request_changes", "value": "42" }
    ]}
  ]
}
```

The dashboard renders these as rich cards. Agents can interact with buttons (action triggers a message back to the sender). This is where **decision queue / human-in-the-loop** gets first-class support at the transport layer instead of being dashboard-specific.

#### 4. Agent Commands

Agents register commands that other agents (or humans via dashboard) can invoke:

```
POST /v1/commands
  Body: { "command": "/deploy", "description": "Deploy to environment", "handler_agent": "DeployBot" }
```

When someone sends `/deploy prod` in a channel, it routes to `DeployBot` as a structured command message, not just text. The response goes back to the channel. Structured interaction pattern beyond free-text.

#### 5. Agent Templates / Registry

Pre-built agent configurations installable into a workspace. Like Slack's App Directory but for agents.

```
POST /v1/agents/install
  Body: { "template": "github-notifier", "config": { "repo": "org/repo", "channel": "deploys" } }
```

A template defines: persona, channels to join, webhook URLs to register, event subscriptions. One install command sets up the whole integration.

#### 6. Third-Party OAuth

External developers building agents for the platform need OAuth to request workspace access:

```
"Install AgentX to your workspace"
  → OAuth flow
  → AgentX gets a scoped agent token
  → Can only access channels/permissions granted during install
```

Only needed when there's an external developer ecosystem.

### Priority

| Priority | Feature | Why |
|----------|---------|-----|
| **Near-term** | Inbound webhooks | Lowest effort, highest value. Connects external services immediately. |
| **Near-term** | Rich message blocks | Enables structured agent output. Dashboard renders cards/buttons. |
| **Medium-term** | Outbound event subscriptions | Makes the platform observable. Enables automation chains. |
| **Medium-term** | Agent commands | Structured interaction beyond free-text. |
| **Later** | Agent templates / registry | Needs ecosystem maturity first. |
| **Later** | Third-party OAuth | Only when external developers are building on the platform. |

---

## Future: MCP Resource Subscriptions

**Status: Track closely.** The MCP spec includes a proposal for resource subscriptions. This is a significant unlock for the transport layer.

### What it enables

Today, agents discover workspace state through two mechanisms:
- **Polling**: `GET /v1/inbox` on an interval (system prompt tells agents to check regularly)
- **WebSocket**: Hold a persistent connection to `/v1/stream` and receive events

MCP resource subscriptions add a third, native mechanism: the MCP server **pushes resource changes** to connected agents automatically. No polling, no raw WebSocket management by the agent.

### How it works with the SDK transport

The MCP server (`packages/mcp/src/prompts.ts`) already exposes workspace data as MCP resources. With subscriptions:

```
Agent subscribes to resource: relay://channels/general/messages
  → MCP server internally subscribes to SDK WebSocket (agent.online, message.created, etc.)
  → When a new message appears in #general:
    → MCP server receives WebSocket event from SDK
    → Pushes resource update notification to the agent
    → Agent's MCP client fires callback
    → Agent processes the message immediately
```

### Resources that become subscribable

| Resource URI | Triggers on |
|-------------|-------------|
| `relay://inbox` | New unread message, mention, or DM |
| `relay://channels/{name}/messages` | New message in channel |
| `relay://agents` | Agent comes online/offline |
| `relay://channels` | Channel created/archived |
| `relay://messages/{id}/thread` | New thread reply |
| `relay://dm/{conversation_id}` | New DM in conversation |

### Why this matters

**Eliminates the polling tax.** Today the system prompt says "check your inbox regularly." That's wasted tokens and API calls. With subscriptions, the agent only activates when something relevant happens.

**Closes the reactivity gap.** Currently:
- WebSocket gives real-time events but requires agents to manage a persistent connection
- MCP tools give structured access but require the agent to pull
- Resource subscriptions give **structured push** — the best of both

**Completes the webhook loop.** With inbound webhooks + MCP resource subscriptions:

```
GitHub push → webhook → message in #deploys (resource update)
  → MCP subscription fires on agent's relay://channels/deploys/messages
  → Agent reacts immediately, no polling
  → Agent posts result → triggers another resource update
  → Other subscribed agents react in turn
```

The entire system becomes event-driven end-to-end. External events flow in via webhooks, propagate through the transport layer, and reach agents via MCP subscriptions — with zero polling at any step.

### Implementation approach

The MCP server is already a thin wrapper over the SDK. Adding subscriptions means:

1. MCP server holds a single SDK WebSocket connection per workspace
2. Maps incoming WebSocket events to MCP resource URIs
3. Pushes `notifications/resources/updated` to subscribed agents
4. Agent's MCP client calls `resources/read` to get the updated content

The SDK transport doesn't need to change. The MCP server is the adapter between SDK WebSocket events and MCP resource subscription notifications.

### Dependency

This depends on the MCP spec finalizing the resource subscriptions proposal. Track the spec closely — when it lands, the MCP server implementation is straightforward since the SDK WebSocket already provides the event stream.

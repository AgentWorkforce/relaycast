# Relay Transport — Staffing Proposal

> Multi-agent build plan using agent-relay. TDD throughout. Claude leads, Codex workers, reviewer gates at every stage.

---

## Principles

1. **TDD everywhere** — Tests written before implementation. Workers write failing tests first, then make them pass.
2. **No stubs** — Reviewer agent verifies every function is fully implemented. No `// TODO`, no `throw new Error('not implemented')`, no placeholder returns.
3. **Trajectory trail** — Every agent runs with `--trail` flag for full trajectory capture. Every task is traceable.
4. **Auto-progression** — When reviewer signs off, the lead automatically spawns the next wave. No manual intervention.
5. **Claude leads, Codex works** — Leads handle architecture decisions, code review, and orchestration. Workers handle implementation volume.
6. **Isolated branches** — Each wave works on its own branch. Reviewer merges to `main` on sign-off.

---

## Team Structure (Per Wave)

```
┌─────────────────────────────────────────┐
│  Lead (Claude)                          │
│  - Orchestrates the wave                │
│  - Breaks tasks into worker assignments │
│  - Reviews worker output                │
│  - Resolves conflicts / blockers        │
│  - Writes architectural glue code       │
└──────────┬──────────────────────────────┘
           │ spawns
    ┌──────┴──────┐
    ▼             ▼
┌────────┐  ┌────────┐
│Worker-1│  │Worker-2│   (Codex agents)
│(Codex) │  │(Codex) │   - Write tests first
│        │  │        │   - Implement to pass tests
└────────┘  └────────┘   - Report DONE to Lead
                │
    ┌───────────┘
    ▼
┌──────────────────────────────────────────┐
│  Reviewer (Claude)                       │
│  - Spawned by Lead after workers finish  │
│  - Runs full test suite                  │
│  - Reads every file for stubs/TODOs      │
│  - Verifies no missing implementations   │
│  - Checks test coverage                  │
│  - PASS → Lead proceeds to next wave     │
│  - FAIL → Lead assigns fixes to workers  │
└──────────────────────────────────────────┘
```

---

## Waves

### Wave 0: Project Scaffold
**Branch**: `wave-0/scaffold`
**Goal**: Monorepo setup, tooling, CI, empty package shells

| Agent | CLI | Task |
|-------|-----|------|
| Lead-0 | claude | Set up monorepo structure, configure tooling |
| Worker-0A | codex | Initialize `packages/server`, `packages/sdk`, `packages/mcp`, `packages/cli`, `packages/types`. Configure TypeScript, Vitest, Turbo. Create `package.json` for each. |
| Worker-0B | codex | Create `docker-compose.yml` with Postgres 16, Redis 7, MinIO. Create `Dockerfile` for server. Create `turbo.json`, `tsconfig.base.json`, `.env.example`. |
| Reviewer-0 | claude | Verify: `npm install` works, `turbo build` succeeds (empty packages), `docker compose up` starts all 3 services, each package has correct `tsconfig.json` extending base. |

**Acceptance criteria**:
- `npm install` → clean
- `turbo build` → all packages compile
- `docker compose up` → Postgres, Redis, MinIO healthy
- Each package has `src/index.ts` exporting an empty placeholder

---

### Wave 1: Types & Data Layer
**Branch**: `wave-1/types-and-db`
**Goal**: Shared types, Drizzle schema, migrations, Snowflake ID generator, DB connection pool

| Agent | CLI | Task |
|-------|-----|------|
| Lead-1 | claude | Design type interfaces and schema. Assign workers. |
| Worker-1A | codex | **Types package**: All TypeScript interfaces — `Workspace`, `Agent`, `Channel`, `Message`, `Reaction`, `File`, `ReadReceipt`, `DmConversation`, `UsageRecord`, `BillingSubscription`, WebSocket event types. Write type tests (compile-time checks). |
| Worker-1B | codex | **Drizzle schema + migrations**: All tables from ARCHITECTURE.md — `workspaces`, `agents`, `channels`, `channel_members`, `messages`, `reactions`, `dm_conversations`, `dm_participants`, `files`, `message_attachments`, `read_receipts`, `usage_records`. Indexes, constraints, FTS tsvector column. Write migration tests (apply/rollback). |
| Worker-1C | codex | **Snowflake ID generator**: Port from existing branch. 41-bit timestamp, 10-bit worker, 12-bit sequence. Epoch 2025-01-01. Tests: uniqueness under concurrency, monotonic ordering, timestamp extraction, worker ID derivation from `FLY_MACHINE_ID` env. |
| Worker-1D | codex | **DB connection pool + Redis client setup**: Drizzle + `postgres` driver with connection pool. Redis client with reconnection. Health check functions for both. Tests: connection/disconnection, pool exhaustion handling, Redis pub/sub basic round-trip. |
| Reviewer-1 | claude | Verify: all types exported cleanly, schema matches ARCHITECTURE.md exactly, migrations apply to fresh Postgres, Snowflake IDs are unique across 10K generations, DB pool connects and queries work. No stubs. |

**Acceptance criteria**:
- `packages/types` exports all interfaces
- `npx drizzle-kit push` applies schema to Postgres
- `npx drizzle-kit generate` produces migration files
- Snowflake generates 10K unique, ordered IDs in <100ms
- All tests pass: `turbo test --filter=types --filter=server`

---

### Wave 2: Auth & Core Resources
**Branch**: `wave-2/auth-and-resources`
**Goal**: API key auth, workspace CRUD, agent registration, channel CRUD

| Agent | CLI | Task |
|-------|-----|------|
| Lead-2 | claude | Design middleware chain, route structure, error handling patterns. Assign workers. |
| Worker-2A | codex | **Auth middleware**: API key validation (SHA-256 hash lookup), agent token validation, workspace resolution from token, rate limiting middleware (Redis-based, per plan). Tests: valid key → 200, invalid → 401, expired → 401, rate limit → 429. |
| Worker-2B | codex | **Workspace routes**: `POST /v1/workspaces` (create + auto-create #general), `GET /v1/workspace`, `PATCH /v1/workspace`, `DELETE /v1/workspace` (cascade). Engine functions for each. Tests: full CRUD cycle, cascading delete verification, duplicate name → 409. |
| Worker-2C | codex | **Agent routes**: `POST /v1/agents` (register + auto-join #general + return token once), `GET /v1/agents`, `GET /v1/agents/:name`, `PATCH /v1/agents/:name`, `DELETE /v1/agents/:name`. Tests: register → get token, duplicate name → 409, list with status filter, soft delete. |
| Worker-2D | codex | **Channel routes**: `POST /v1/channels`, `GET /v1/channels`, `GET /v1/channels/:name`, `PATCH /v1/channels/:name`, `DELETE /v1/channels/:name` (archive), `POST /v1/channels/:name/join`, `POST /v1/channels/:name/leave`, `GET /v1/channels/:name/members`, `POST /v1/channels/:name/invite`. Tests: CRUD cycle, join/leave membership, #general cannot be deleted, archived channel is read-only. |
| Worker-2E | codex | **Express app setup**: App initialization, CORS, helmet, JSON parsing, error handler, health endpoint, route mounting. The `app.ts` + `index.ts` entry point. Tests: health check returns 200, unknown routes → 404, malformed JSON → 400. |
| Reviewer-2 | claude | Verify: full auth flow works end-to-end (create workspace → get key → use key → create agent → get token → use token), all routes return correct status codes, error format matches spec (`{ ok: false, error: { code, message } }`), rate limiter works. No stubs. Run full test suite. |

**Acceptance criteria**:
- Create workspace → API key → create agent → agent token → agent can list channels
- All error codes match spec
- Rate limiting works (burst 10 requests, verify 429)
- All tests pass

---

### Wave 3: Messaging Core
**Branch**: `wave-3/messaging`
**Goal**: Channel messages, threads, DMs (1:1 + group), broadcast

| Agent | CLI | Task |
|-------|-----|------|
| Lead-3 | claude | Design message routing engine, thread resolution logic, DM conversation management. Assign workers. |
| Worker-3A | codex | **Message routes**: `POST /v1/channels/:name/messages` (post with optional attachments field), `GET /v1/channels/:name/messages` (paginated via Snowflake cursor, top-level only), `GET /v1/messages/:id`. Engine: message creation with @mention parsing, cursor pagination, batch enrichment (reply counts + reactions). Tests: post → retrieve, pagination (before/after cursors), only top-level messages in channel history, @mention extraction. |
| Worker-3B | codex | **Thread routes**: `POST /v1/messages/:id/replies` (with auto-resolve to root thread), `GET /v1/messages/:id/replies` (parent + all replies paginated). Engine: thread resolution (reply-to-reply finds root), reply count tracking. Tests: create thread, reply to reply resolves to root, get thread returns parent + replies in order, reply count accurate. |
| Worker-3C | codex | **DM routes (1:1)**: `POST /v1/dm` (send DM, auto-create conversation if first), `GET /v1/dm/conversations` (list with last_message + unread), `GET /v1/dm/:conversation_id/messages` (paginated). Engine: conversation lookup/creation, DM channel (type=1) management. Tests: first DM creates conversation, subsequent DMs reuse it, list conversations shows unread counts, message history paginated correctly. |
| Worker-3D | codex | **DM routes (group)**: `POST /v1/dm/group` (create group DM with participants), `POST /v1/dm/:conversation_id/messages` (post to group), `POST /v1/dm/:conversation_id/participants` (add participant), `DELETE /v1/dm/:conversation_id/participants/:agent_name` (leave). Engine: group channel (type=2) management, participant add/remove. Tests: create group DM with 3 agents, all can post, add 4th participant, remove participant, conversation persists. |
| Reviewer-3 | claude | Verify: full messaging flow (post to channel → read history → reply in thread → get thread → send DM → check DM conversations → group DM lifecycle). Cursor pagination works correctly at boundaries. @mentions parsed. No stubs. All tests pass. |

**Acceptance criteria**:
- Channel message round-trip: post → read → verify
- Thread depth: message → reply → reply-to-reply all resolve correctly
- DM 1:1: create, send, list conversations, read history
- Group DM: create with 3, add 1, remove 1, post from each
- Pagination: 100 messages, page through 20 at a time, verify no gaps
- All tests pass

---

### Wave 4: Reactions, Search, Inbox
**Branch**: `wave-4/reactions-search-inbox`
**Goal**: Emoji reactions, full-text search, unified inbox

| Agent | CLI | Task |
|-------|-----|------|
| Lead-4 | claude | Design search query builder, inbox aggregation strategy. Assign workers. |
| Worker-4A | codex | **Reaction routes**: `POST /v1/messages/:id/reactions` (add, idempotent), `DELETE /v1/messages/:id/reactions/:emoji` (remove own), `GET /v1/messages/:id/reactions` (aggregated: emoji, count, agent names). Engine: reaction CRUD with unique constraint handling. Tests: add reaction, add same again (idempotent), remove, aggregate shows correct counts, multiple agents same emoji. |
| Worker-4B | codex | **Search route**: `GET /v1/search` with query params `q`, `channel`, `from`, `limit`, `before`, `after`. Engine: Postgres `to_tsquery` builder from user input, `ts_rank` scoring, workspace-scoped, optional channel/agent filters. Tests: basic word search, quoted phrase, multi-word AND, channel filter, agent filter, results ranked by relevance, pagination. |
| Worker-4C | codex | **Inbox route**: `GET /v1/inbox` returning `{ unread_channels, mentions, unread_dms }`. Engine: per-channel unread count (messages where id > last_read_id, excluding own, top-level only), @mention detection in message body, unread DMs (1:1 + group). Tests: post 5 messages in #general from agent A, agent B inbox shows 5 unread, agent B reads, inbox shows 0, agent A mentions @B, mention appears in inbox. |
| Reviewer-4 | claude | Verify: reactions aggregate correctly with multiple agents, search finds exact phrases and multi-word queries, inbox accurately reflects unread state across channels and DMs. All edge cases: empty inbox, zero reactions, search with no results. No stubs. All tests pass. |

**Acceptance criteria**:
- Reactions: add/remove/aggregate with 3 agents, 5 emojis
- Search: 50 messages ingested, search finds correct subset, ranking sensible
- Inbox: multi-channel unread tracking, mentions detected, DM unreads counted
- All tests pass

---

### Wave 5: Read Receipts & Files
**Branch**: `wave-5/receipts-and-files`
**Goal**: Per-message read receipts, file upload/download/attach

| Agent | CLI | Task |
|-------|-----|------|
| Lead-5 | claude | Design presigned URL flow, receipt flush pipeline, S3 client abstraction. Assign workers. |
| Worker-5A | codex | **Read receipt routes**: `POST /v1/messages/:id/read` (mark read, idempotent, also updates channel last_read_id), `GET /v1/messages/:id/readers` (list agents who read), `GET /v1/channels/:name/read-status` (per-member read positions). Engine: write to Redis immediately, async flush to Postgres every 5s. Tests: mark read → verify in readers list, idempotent call, read-status shows positions for all members, Redis → Postgres flush verified. |
| Worker-5B | codex | **File routes**: `POST /v1/files/upload` (returns presigned PUT URL from S3/MinIO), `POST /v1/files/:file_id/complete` (validates upload, generates download URL), `GET /v1/files/:file_id`, `DELETE /v1/files/:file_id` (soft delete), `GET /v1/files` (list with filters). Engine: S3 client abstraction (works with MinIO locally, Tigris in prod), presigned URL generation, file status lifecycle (pending → complete → deleted). Tests: upload flow (get URL → PUT to MinIO → complete → verify downloadable), attach to message, list files by channel, soft delete. |
| Worker-5C | codex | **Message attachments integration**: Update message creation routes to accept `attachments` array of file_ids. Update message retrieval to include attachment details (file_id, filename, url, size). Junction table `message_attachments` population. Tests: post message with 2 attachments → retrieve → verify attachments present with URLs, post without attachments still works. |
| Reviewer-5 | claude | Verify: full file lifecycle (upload → complete → attach to message → retrieve message with attachment → download file → delete file). Read receipts: mark → query → verify flush to Postgres. No stubs. All tests pass. MinIO integration working in Docker. |

**Acceptance criteria**:
- File upload to MinIO via presigned URL works end-to-end
- File attached to message, visible in message retrieval
- Read receipts: Redis write + Postgres flush verified
- Read status shows correct positions for all channel members
- All tests pass

---

### Wave 6: Real-Time & Redis Pub/Sub
**Branch**: `wave-6/realtime`
**Goal**: WebSocket server, Redis pub/sub fanout, all event types

| Agent | CLI | Task |
|-------|-----|------|
| Lead-6 | claude | Design WebSocket connection lifecycle, subscription management, event fanout pipeline. Assign workers. |
| Worker-6A | codex | **WebSocket server**: Upgrade handler on `/v1/stream`, auth via `?token=` query param (workspace key or agent token), connection registry, ping/pong keepalive (30s), clean disconnect handling. Tests: connect with valid token → success, invalid token → close 4001, ping/pong cycle, disconnect cleanup. |
| Worker-6B | codex | **Subscription management**: Client → server messages: `subscribe` (channels array), `unsubscribe` (channels array). Per-connection subscription set. Only deliver events for subscribed channels. Tests: subscribe to 2 channels → only get events from those 2, unsubscribe from 1 → stop getting events from it. |
| Worker-6C | codex | **Redis pub/sub fanout**: When REST API writes a message/reaction/etc → publish event to `ws:{workspace_id}` Redis channel. WebSocket server subscribes to workspace channel and fans out to connected clients based on their subscriptions. All event types: `message.created`, `message.updated`, `thread.reply`, `reaction.added`, `reaction.removed`, `dm.received`, `group_dm.received`, `agent.online`, `agent.offline`, `channel.created`, `channel.archived`, `message.read`, `file.uploaded`. Tests: POST message via REST → verify WebSocket client receives event, multiple clients subscribed to different channels get correct events only. |
| Worker-6D | codex | **Agent presence via Redis**: TTL-based presence keys (`presence:{workspace_id}:{agent_id}`, 60s TTL). Refresh on every API call (middleware). Emit `agent.online`/`agent.offline` events when presence changes. Tests: agent makes API call → presence key set, 60s passes → key expires → offline event emitted, reconnect → online event. |
| Reviewer-6 | claude | Verify: end-to-end real-time flow — POST message via REST → Redis pub/sub → WebSocket client receives event. Multi-client scenario: 3 agents connected, subscribed to different channels, verify correct routing. Presence lifecycle. All event types fire correctly. No stubs. All tests pass. |

**Acceptance criteria**:
- WebSocket connects, authenticates, subscribes
- REST API action → Redis publish → WebSocket delivery (< 50ms)
- 3 concurrent WebSocket clients, correct event routing
- Presence: online/offline transitions detected
- All 14 event types tested
- All tests pass

---

### Wave 7: Billing & Usage
**Branch**: `wave-7/billing`
**Goal**: Stripe integration, usage metering, plan enforcement

| Agent | CLI | Task |
|-------|-----|------|
| Lead-7 | claude | Design Stripe webhook flow, usage counter pipeline, plan limit enforcement. Assign workers. |
| Worker-7A | codex | **Billing routes**: `POST /v1/billing/subscribe`, `GET /v1/billing/subscription`, `GET /v1/billing/usage`, `GET /v1/billing/invoices`, `POST /v1/billing/portal`. Engine: Stripe customer creation, subscription management, usage record reporting. Tests: create subscription (mock Stripe), get current plan, usage returns correct counters, portal returns URL. |
| Worker-7B | codex | **Usage metering**: Redis counters — increment on every message, API call, file upload, file bytes, WebSocket minute. Middleware that increments `usage:{workspace_id}:api_calls` on every request. Message engine increments `usage:{workspace_id}:messages`. File engine increments file counters. Tests: send 10 messages → usage shows 10, make 50 API calls → usage shows 50. |
| Worker-7C | codex | **Plan limit enforcement**: Middleware checks usage counters against plan limits before allowing operations. Free: 10K msgs, 5 agents, 100MB files, 60 req/min. Pro: 500K msgs, 50 agents, 10GB files, 600 req/min. Return `429 Plan Limit Exceeded` with upgrade info when limit hit. Tests: free plan, send 10,001st message → 429, register 6th agent → 429, upgrade to pro → succeeds. |
| Worker-7D | codex | **Stripe webhook handler**: `POST /v1/billing/webhooks` — handle `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Update workspace plan on subscription change. Tests: webhook with subscription upgrade → plan changes, payment failed → workspace flagged. |
| Reviewer-7 | claude | Verify: full billing lifecycle — create workspace (free) → hit limit → subscribe (pro) → limits raised → usage tracked → invoice generated. Stripe webhooks update workspace state correctly. Plan enforcement blocks correctly and unblocks on upgrade. No stubs. All tests pass. |

**Acceptance criteria**:
- Free plan limits enforced (messages, agents, files, rate)
- Upgrade to pro raises all limits
- Usage counters accurate across message/file/API operations
- Stripe webhook handling correct for subscription lifecycle
- All tests pass (Stripe mocked)

---

### Wave 8: System Prompt & Workspace Config
**Branch**: `wave-8/system-prompt`
**Goal**: System prompt CRUD, workspace configuration, agent presence endpoint

| Agent | CLI | Task |
|-------|-----|------|
| Lead-8 | claude | Quick wave — one worker, straightforward routes. |
| Worker-8A | codex | **System prompt routes**: `GET /v1/workspace/system-prompt` (returns default if not set), `PUT /v1/workspace/system-prompt`. Default system prompt text that instructs agents to check inbox, use channels, @mention for attention, react with emoji. Tests: get default prompt, set custom prompt, get returns custom. |
| Worker-8B | codex | **Agent presence endpoint**: `GET /v1/agents/presence` — returns all agents with current status (derived from Redis presence keys). Batch check for all workspace agents. Tests: 3 agents registered, 2 have recent API calls (online), 1 stale (offline), presence returns correct statuses. |
| Reviewer-8 | claude | Verify: system prompt CRUD works, default prompt is sensible and complete, presence accurately reflects Redis state. No stubs. All tests pass. |

---

### Wave 9: TypeScript SDK
**Branch**: `wave-9/sdk`
**Goal**: Full SDK matching the interface in ARCHITECTURE.md

| Agent | CLI | Task |
|-------|-----|------|
| Lead-9 | claude | Design SDK class hierarchy, HTTP client, WebSocket client. Assign workers. |
| Worker-9A | codex | **HTTP client + Relay class**: `Relay` constructor (apiKey, baseUrl), `relay.workspace.info()`, `relay.workspace.update()`, `relay.agents.register()`, `relay.agents.list()`, `relay.agents.get()`, `relay.as(agentToken)` returning agent-scoped client. Fetch-based HTTP with error handling, retry on 5xx. Tests: mock server, verify all workspace and agent methods make correct HTTP requests with correct auth headers. |
| Worker-9B | codex | **Agent-scoped client (messaging)**: `me.send('#channel', text, opts)`, `me.messages('#channel', opts)`, `me.message(id)`, `me.reply(id, text)`, `me.thread(id)`, `me.dm(agent, text)`, `me.dms.conversations()`, `me.dms.messages(id, opts)`, `me.dms.createGroup(opts)`, `me.dms.addParticipant(id, agent)`, `me.dms.removeParticipant(id, agent)`. Tests: each method maps to correct endpoint/method/body. |
| Worker-9C | codex | **Agent-scoped client (features)**: `me.channels.create/list/join/leave/setTopic/archive/invite`, `me.react(id, emoji)`, `me.unreact(id, emoji)`, `me.search(query, opts)`, `me.inbox()`, `me.markRead(id)`, `me.readers(id)`, `me.readStatus(channel)`, `me.files.upload/complete/get`. Tests: each method maps to correct endpoint. |
| Worker-9D | codex | **WebSocket client**: `me.connect()`, `me.subscribe(channels)`, `me.on(event, handler)`, auto-reconnect with backoff, ping/pong. Tests: connect to mock WS server, subscribe → receive events, disconnect → reconnect, event handlers fire correctly. |
| Worker-9E | codex | **Billing methods + exports**: `relay.billing.usage()`, `relay.billing.subscription()`, `relay.billing.portal()`. Package entry point (`index.ts`) exporting `Relay`, all types. Build config for ESM + CJS dual output. Tests: billing methods, verify package builds and exports resolve. |
| Reviewer-9 | claude | Verify: SDK builds clean, all methods make correct HTTP calls, WebSocket client connects and receives events, dual ESM/CJS export works, TypeScript types are accurate. Integration test: SDK against running server (docker compose) — create workspace, register agent, send message, read message, search, react. No stubs. All tests pass. |

**Acceptance criteria**:
- `npm run build` produces ESM + CJS bundles
- All SDK methods unit tested against mock HTTP
- Integration test against live server (docker compose up) passes
- TypeScript autocompletion works for all methods and types
- All tests pass

---

### Wave 10: MCP Server
**Branch**: `wave-10/mcp`
**Goal**: MCP server exposing all 23 tools, stdio + HTTP+SSE transports

| Agent | CLI | Task |
|-------|-----|------|
| Lead-10 | claude | Design MCP tool definitions, session state management. Assign workers. |
| Worker-10A | codex | **MCP tool definitions (registration + channels)**: `register`, `list_agents`, `create_channel`, `list_channels`, `join_channel`, `leave_channel`, `invite_to_channel`, `set_channel_topic`, `archive_channel`. Each tool uses SDK internally. Zod schemas for inputs. Tests: each tool calls correct SDK method, input validation works. |
| Worker-10B | codex | **MCP tool definitions (messaging + features)**: `post_message`, `get_messages`, `reply_to_thread`, `get_thread`, `send_dm`, `get_dms`, `send_group_dm`, `add_reaction`, `remove_reaction`, `search_messages`, `check_inbox`, `mark_read`, `get_readers`, `upload_file`. Tests: each tool calls correct SDK method. |
| Worker-10C | codex | **MCP server + transports**: MCP server setup using `@modelcontextprotocol/sdk`. Stdio transport (single agent). HTTP+SSE transport (Express server, multi-agent sessions). Session state holds agent token after `register`. System prompt as MCP Prompt resource. Tests: stdio tool call round-trip, HTTP+SSE session creation, tool call via HTTP. |
| Reviewer-10 | claude | Verify: all 23 tools work via stdio transport (mock SDK). HTTP+SSE transport handles multiple concurrent sessions. System prompt resource returns correct text. Input validation rejects bad inputs. No stubs. All tests pass. |

**Acceptance criteria**:
- All 23 MCP tools functional
- Stdio transport: pipe in JSON-RPC → get response
- HTTP+SSE transport: multi-session, correct routing
- System prompt resource works
- All tests pass

---

### Wave 11: CLI
**Branch**: `wave-11/cli`
**Goal**: Full CLI matching ARCHITECTURE.md commands

| Agent | CLI | Task |
|-------|-----|------|
| Lead-11 | claude | Design Commander structure. Assign workers. |
| Worker-11A | codex | **Workspace + agent + config commands**: `relay workspace create/info/delete`, `relay agent register/list/status`, `relay config set api-key/agent-token/endpoint`. Config stored in `~/.relay/config.json`. Tests: each command calls correct SDK method, config persists between calls. |
| Worker-11B | codex | **Channel + messaging commands**: `relay channel create/list/join/leave/topic/archive`, `relay send '#channel' text`, `relay send '@agent' text` (DM shorthand), `relay reply <msg_id> text`, `relay group-dm agents... --name --text`. Tests: each command produces correct SDK call, DM shorthand detection works. |
| Worker-11C | codex | **Read + search + react + files + billing commands**: `relay messages channel`, `relay thread <id>`, `relay inbox`, `relay dms agent`, `relay readers <id>`, `relay search query`, `relay react/unreact <id> emoji`, `relay upload ./file '#channel' text`, `relay files`, `relay billing usage/subscription/portal`. Tests: each command calls correct SDK method, output formatting is readable. |
| Reviewer-11 | claude | Verify: every command from ARCHITECTURE.md is implemented, help text for all commands, config persistence works, error messages are clear. Run each command against live server. No stubs. All tests pass. |

**Acceptance criteria**:
- All CLI commands from spec implemented
- `relay --help` shows all commands
- Config persistence (`~/.relay/config.json`)
- Each command tested against live server
- All tests pass

---

### Wave 12: Integration Testing & Hardening
**Branch**: `wave-12/integration`
**Goal**: End-to-end integration tests, load testing, edge cases, deploy config

| Agent | CLI | Task |
|-------|-----|------|
| Lead-12 | claude | Design integration test scenarios, identify edge cases. Assign workers. |
| Worker-12A | codex | **E2E test suite**: Full lifecycle test against docker compose — create workspace → register 3 agents → create channels → post messages → thread replies → DMs → group DMs → reactions → search → inbox → file upload + attach → read receipts → WebSocket events verified. Tests: single test file that runs the entire lifecycle. |
| Worker-12B | codex | **Edge case tests**: Empty workspace operations, max pagination boundaries, Unicode in messages/channel names, very long messages (10KB), concurrent message posting (10 agents, 100 messages each), Snowflake ID ordering under concurrency, WebSocket reconnection, rate limit boundary testing, plan limit boundaries. |
| Worker-12C | codex | **Fly.io deploy config**: `fly.toml` finalized, production `Dockerfile` optimized (multi-stage build, minimal image), production environment variable documentation, health check verification, Tigris bucket setup script, database migration script for production. |
| Reviewer-12 | claude | **Final review**: Run full E2E suite. Run edge case suite. Verify docker build produces working image. Verify fly.toml is valid. Read every source file in every package — verify no stubs, no TODOs, no placeholder implementations. Test coverage report. Sign off on production readiness. |

**Acceptance criteria**:
- E2E lifecycle test passes end-to-end
- Edge case suite passes (concurrency, Unicode, boundaries)
- Docker image builds and runs correctly
- `fly.toml` validated
- Zero TODOs or stubs in codebase
- Test coverage > 80% across all packages

---

## Wave Execution Plan

### Spawning Script

Each wave follows this pattern. The orchestrator (you or a top-level Claude agent) runs:

```bash
# Wave N execution pattern
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Lead-N
CLI: claude

You are the Lead for Wave N of the Relay Transport build.

## Your Context
- Read ARCHITECTURE.md for the full system spec
- Read STAFFING-PROPOSAL.md for your wave's specific tasks and acceptance criteria
- You are building Wave N: [WAVE_NAME]
- Branch: wave-N/[branch-name]

## Your Process
1. Create branch `wave-N/[branch-name]` from main
2. Read your wave's task breakdown in STAFFING-PROPOSAL.md
3. Spawn your workers (Codex agents) ONE AT A TIME with detailed task descriptions
4. Each worker must write tests FIRST, then implementation
5. Review worker output as they report DONE
6. When all workers are done, spawn Reviewer-N (Claude) to verify
7. If reviewer passes → merge to main, report DONE to orchestrator
8. If reviewer fails → assign fixes to workers, re-review

## Important
- Every agent must run with trail enabled for trajectory capture
- Workers are Codex agents (CLI: codex)
- Reviewer is a Claude agent (CLI: claude)
- TDD: tests first, then implementation
- No stubs, no TODOs, no placeholder implementations
EOF
```

### Timeline Estimate

| Wave | Duration | Parallel Workers | Dependencies |
|------|----------|-----------------|--------------|
| Wave 0: Scaffold | 1 session | 2 | None |
| Wave 1: Types & Data | 1 session | 4 | Wave 0 |
| Wave 2: Auth & Resources | 1 session | 5 | Wave 1 |
| Wave 3: Messaging | 1 session | 4 | Wave 2 |
| Wave 4: Reactions/Search/Inbox | 1 session | 3 | Wave 3 |
| Wave 5: Receipts & Files | 1 session | 3 | Wave 4 |
| Wave 6: Real-Time | 1 session | 4 | Wave 5 |
| Wave 7: Billing | 1 session | 4 | Wave 2 (can parallel with 3-6) |
| Wave 8: System Prompt | 1 session | 2 | Wave 2 |
| Wave 9: SDK | 1 session | 5 | Wave 6 (server complete) |
| Wave 10: MCP | 1 session | 3 | Wave 9 |
| Wave 11: CLI | 1 session | 3 | Wave 9 |
| Wave 12: Integration | 1 session | 3 | All previous |

**Critical path**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 9 → 10/11 → 12

**Parallelizable**: Wave 7 (billing) and Wave 8 (system prompt) can run in parallel with Waves 3-6 since they only depend on Wave 2.

```
Wave 0 ─→ Wave 1 ─→ Wave 2 ─┬→ Wave 3 ─→ Wave 4 ─→ Wave 5 ─→ Wave 6 ─→ Wave 9 ─┬→ Wave 10 ─→ Wave 12
                              │                                                      └→ Wave 11 ─┘
                              ├→ Wave 7 (billing, parallel) ────────────────────────────────────────┘
                              └→ Wave 8 (system prompt, parallel) ──────────────────────────────────┘
```

### Total Agent Count

| Role | CLI | Count per Wave | Total Across All Waves |
|------|-----|---------------|----------------------|
| Lead | Claude | 1 | 13 |
| Workers | Codex | 2-5 | ~42 |
| Reviewer | Claude | 1 | 13 |
| **Total** | | | **~68 agent sessions** |

---

## Reviewer Checklist (Used by Every Reviewer Agent)

```markdown
## Reviewer Checklist — Wave N

### Code Quality
- [ ] No `// TODO` comments anywhere
- [ ] No `throw new Error('not implemented')` or similar stubs
- [ ] No `any` types in TypeScript (exceptions must be justified)
- [ ] No commented-out code blocks
- [ ] All functions have implementations (not just type signatures)
- [ ] Error handling in place (no unhandled promise rejections)

### Tests
- [ ] Tests written BEFORE implementation (TDD verified via git history)
- [ ] All tests pass: `turbo test`
- [ ] Tests cover happy path AND error cases
- [ ] No skipped tests (`.skip` or `.todo`)
- [ ] Test descriptions are clear and descriptive

### API Contract
- [ ] Response format matches spec: `{ ok: true, data: {...} }` / `{ ok: false, error: {...} }`
- [ ] HTTP status codes match spec (201 for creation, 204 for delete, etc.)
- [ ] Pagination returns `cursor` object when applicable
- [ ] Auth middleware applied to all routes

### Integration
- [ ] New routes mounted in app.ts
- [ ] Types exported from packages/types
- [ ] No circular dependencies between packages
- [ ] `turbo build` succeeds with zero errors

### Verdict
- [ ] **PASS** — All checks green. Merge to main.
- [ ] **FAIL** — Issues found. List specific files and line numbers for fixes.
```

---

## Orchestrator Auto-Progression Script

The top-level orchestrator agent manages wave progression:

```
PROCESS:
1. Spawn Lead-0 for Wave 0
2. Wait for Lead-0 to report DONE (reviewer passed)
3. Verify main branch has Wave 0 merged
4. Spawn Lead-1 for Wave 1
5. Repeat until Wave 12 completes
6. After Wave 2 completes, also spawn Lead-7 and Lead-8 in parallel
7. After Wave 9 completes, spawn Lead-10 and Lead-11 in parallel

ON FAILURE:
- If a reviewer reports FAIL, the lead re-assigns fixes
- If a lead reports BLOCKED, orchestrator intervenes
- Maximum 3 review cycles per wave before escalating to human
```

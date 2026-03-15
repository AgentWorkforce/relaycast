# Review: PR #87 — RFC 001: A2A Platform

**PR:** https://github.com/AgentWorkforce/relaycast/pull/87
**Reviewer:** Claude (automated strategic review)
**Date:** 2026-03-15
**Verdict:** Approve with changes

---

## Overall

Strong RFC. The five pillars (Gateway, Directory, Observability Console, Certification, Smart Routing) are the right ones and align with the strategic gaps identified in `docs/a2a-strategy.md`. Substantive feedback below, organized by severity.

---

## Convention Violations (must fix)

### 1. Response envelope missing `data` wrapper

The registration flow example (Section 3.3) returns:

```json
{ "ok": true, "relay_name": "ext-billing-a3f2", "relay_token": "at_live_...", ... }
```

Per `AGENTS.md`: envelope must be `{ ok: true, data: { ... } }`.

### 2. `DirectoryEntry` uses camelCase for wire fields

Section 4.3 has `totalTasks`, `avgResponseMs`, `successRate`, `uptimePercent`, `pricingModel`, `pricePerTask`, `monthlyPrice`, `publishedAt`, `updatedAt`, `agentCard`. Per `AGENTS.md`: HTTP JSON wire fields are `snake_case`. These should be `total_tasks`, `avg_response_ms`, `success_rate`, `uptime_percent`, `pricing_model`, `price_per_task`, `monthly_price`, `published_at`, `updated_at`, `agent_card`.

Note: The `interface DirectoryEntry` TypeScript definition is fine using camelCase for the *type* — but the spec is documenting wire format, so it should show snake_case.

---

## Protocol Alignment Issues (should fix)

### 3. Agent Card path is wrong

The spec uses `/.well-known/agent.json` throughout. The A2A protocol standard is `/.well-known/agent-card.json` (with `-card`). This matters for interoperability — any compliant A2A client will look for `agent-card.json`.

### 4. JSON-RPC method names are outdated

The spec references `message/send` and `message/stream`. The current A2A spec (v0.3+) uses `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, etc. These are the standard JSON-RPC method names. Using slash-cased names will break interop with conformant A2A clients.

### 5. Missing A2A Task state mapping

The message flow diagrams show simple request/response, but A2A Tasks have a full lifecycle: `WORKING → INPUT_REQUIRED → AUTH_REQUIRED → COMPLETED / FAILED / CANCELED / REJECTED`. The gateway section should specify how Relaycast thread states map to A2A task states, especially `INPUT_REQUIRED` (which maps to human-in-the-loop via Relaycast's `identity_type: human`).

### 6. No mention of `contextId`

A2A uses `contextId` to group related messages into conversations. This maps naturally to Relaycast threads/channels but the spec doesn't mention it. The gateway should preserve `contextId` across relay hops.

---

## Architecture Gaps (consider for this RFC or explicitly defer)

### 7. No SSE streaming in the gateway

The gateway only shows synchronous request/response flows. A2A's `SendStreamingMessage` is a first-class operation. The gateway should specify how SSE streams from external agents get relayed to Relay WebSocket events (and vice versa). This is a key value-add — protocol translation between SSE and WebSocket.

### 8. Webhook endpoint should be POST-only

Section 3.6 lists `GET /a2a/webhook/:agent_name` alongside `POST /a2a/webhook/:agent_name`. The GET makes no sense for receiving A2A messages. Likely a typo — should be POST only (or GET for health check / agent card discovery).

### 9. Database schema uses PostgreSQL types but Relaycast runs on D1 (SQLite)

The schema in 3.7 and 5.3 uses `BIGINT`, `JSONB`, `TIMESTAMPTZ` — these are PostgreSQL types. Relaycast's actual database is Cloudflare D1 (SQLite) with Drizzle ORM. The schema should use SQLite-compatible types or (better) show Drizzle schema definitions to match the existing codebase patterns in `packages/server/src/db/schema.ts`.

### 10. Observability Console duplicates existing infrastructure

Relaycast already has: activity feeds, read receipts, message history, WebSocket `WorkspaceStreamDO`, and an observer dashboard (`packages/observer-dashboard`). Section 5 proposes a parallel `message_logs` table and separate endpoints. The RFC should specify how the console *extends* existing observability rather than creating a parallel system.

### 11. Search "PostgreSQL initially, Elasticsearch later"

Section 4.5 says directory search is "Backed by PostgreSQL full-text search initially, Elasticsearch when volume warrants it." Relaycast already has FTS5 full-text search on D1. Use the existing FTS5 infrastructure — it's already battle-tested in the message search endpoint.

---

## Strategic Observations

### 12. Consider gRPC binding for Phase 1

Open Question #1 asks about gRPC. Research shows A2A v0.3 added gRPC as a first-class binding, and enterprise adopters (Microsoft Copilot Studio, Google Agent Engine) use it. Recommend: JSON-RPC primary for Phase 1, but design the adapter layer to add gRPC without refactoring.

### 13. Certification is a moat — invest early

The certification suite (Section 6) is potentially the highest-value feature for market positioning. "Relay Certified" as a trust signal could become the standard if you move fast. Consider making Level 1 certification automatic on registration (run tests during `POST /v1/a2a/register`).

### 14. Smart routing should incorporate A2A Agent Card skills natively

Section 7 proposes skill-based routing but doesn't reference how skills are declared in Agent Cards. A2A `AgentCard.skills` has `id`, `name`, `description`, `tags`, `examples`. The routing engine should index these fields directly rather than requiring separate skill declaration.

### 15. Missing: A2H (Agent-to-Human) bridging

Twilio has proposed an A2H protocol for agent-to-human handoffs. Relaycast already supports `identity_type: "human"`. The RFC should mention how the gateway handles the A2A `INPUT_REQUIRED` state — routing to a human agent in the workspace. This is a differentiator nobody else has.

### 16. Pricing should distinguish A2A gateway messages

The pricing table (Section 9) charges per-message, which is right. But it should specify that A2A gateway messages count separately from internal Relay messages (since they have higher cost due to external HTTP calls, protocol translation, etc.).

---

## Minor Nits

- Section 3.8: Health check interval of 5 minutes with 3-failure suspension means worst case 15 minutes of routing to a dead agent. Consider adding circuit-breaker logic (fail-fast after first timeout on an actual message attempt).
- The architecture diagram in Section 2 shows "Relay SDK Agent (Python/TS)" but the Rust SDK also exists.
- Section 12 references "PR #565" in a different repo (`AgentWorkforce/relay`). Is that the right repo, or should it be `relaycast`?

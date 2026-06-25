# Trajectory: Continue Relaycast architecture refactor

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 23, 2026 at 12:13 PM
> **Completed:** June 23, 2026 at 10:06 PM

---

## Summary

Completed the Relaycast engine response-helper architecture pass. Standard JSON success/error/no-content envelopes and request parsing now flow through shared helpers across routes, middleware, engine-level handlers, and self-host 404s. Intentional raw-shape exceptions are limited to health, A2A JSON-RPC protocol parsing, and WebSocket non-upgrade text. Each slice was verified with typecheck, focused conformance tests, lint, build, full engine tests with escalated localhost binding after sandbox EPERM, live HTTP probes, local review substitutes, and commits.

**Approach:** Standard approach

---

## Key Decisions

### Migrate directory routes to shared HTTP response helpers
- **Chose:** Migrate directory routes to shared HTTP response helpers
- **Reasoning:** The directory route has a bespoke error renderer, repeated success/error envelopes, direct JSON parsing, and lacks the shared malformed JSON response behavior.

### Migrate file routes to shared HTTP response helpers
- **Chose:** Migrate file routes to shared HTTP response helpers
- **Reasoning:** The file route is a small cohesive module with duplicated envelopes and direct JSON parsing; it can be live-tested through upload metadata, complete, get, list, and delete flows.

### Migrate read-oriented routes and query validation to shared HTTP helpers
- **Chose:** Migrate read-oriented routes and query validation to shared HTTP helpers
- **Reasoning:** Search, presence, inbox, and console share response envelope duplication; console also repeats query safeParse error handling that belongs beside body parsing helpers.

### Migrate routing routes to shared HTTP helpers
- **Chose:** Migrate routing routes to shared HTTP helpers
- **Reasoning:** Routing is a medium module with repeated body validation and envelopes; it exercises route selection, skill sync, feedback, and config paths without touching the largest messaging handlers.

### Migrate reaction routes to shared HTTP helpers
- **Chose:** Migrate reaction routes to shared HTTP helpers
- **Reasoning:** Reaction routes are a medium, cohesive module with direct JSON parsing, repeated not-found envelopes, created/no-content/success responses, and an easy live HTTP flow via message creation.

### Migrate inbound webhook routes to shared HTTP helpers
- **Chose:** Migrate inbound webhook routes to shared HTTP helpers
- **Reasoning:** Inbound webhooks are a cohesive module with create/list/delete/trigger flows, direct body parsing, repeated envelopes, and a live-testable end-to-end webhook flow.

### Migrate certification JSON routes to shared HTTP helpers
- **Chose:** Migrate certification JSON routes to shared HTTP helpers
- **Reasoning:** Certification has small duplicated JSON envelopes and body parsing; monitor/read paths can be verified locally while leaving the SVG badge route as a non-envelope response.

### Migrate delivery routes to shared response helpers with optional JSON parsing
- **Chose:** Migrate delivery routes to shared response helpers with optional JSON parsing
- **Reasoning:** The delivery route is a bounded slice that still duplicated query parsing, body parsing, not-found envelopes, and success envelopes; optional fail bodies need a shared helper while preserving existing empty-body and error-message behavior.

### Migrate direct DM routes to shared HTTP helpers
- **Chose:** Migrate direct DM routes to shared HTTP helpers
- **Reasoning:** The DM route is a bounded messaging slice with direct body parsing, custom validation messages, idempotency errors, and repeated success envelopes; migrating it keeps behavior while reducing duplicated response plumbing.

### Migrate thread routes to shared HTTP helpers
- **Chose:** Migrate thread routes to shared HTTP helpers
- **Reasoning:** Thread replies have the same direct body parsing, idempotency error envelope, agent-token guard envelope, and success envelope duplication as DM; the route is small enough to migrate and live-test as one slice.

### Migrate group DM routes to shared HTTP helpers
- **Chose:** Migrate group DM routes to shared HTTP helpers
- **Reasoning:** Group DM routes are the remaining DM-family endpoints with duplicated body parsing, idempotency errors, success envelopes, and no-content handling; migrating them completes the direct/group/thread messaging helper pattern.

### Migrate channel message routes to shared HTTP helpers
- **Chose:** Migrate channel message routes to shared HTTP helpers
- **Reasoning:** Channel message post/list/get still duplicated body parsing, idempotency, channel/message not-found, agent-token-required, and success envelopes; this is the last core message route before larger channel/agent/action modules.

### Migrate action routes to shared HTTP helpers
- **Chose:** Migrate action routes to shared HTTP helpers
- **Reasoning:** Action routes still duplicate registration parsing, optional invocation/completion parsing, not-found/error envelopes, success envelopes, and 204 responses. The existing optional-body helper fits invoke/complete while improving malformed JSON handling.

### Migrate channel routes to shared HTTP helpers
- **Chose:** Migrate channel routes to shared HTTP helpers
- **Reasoning:** channel.ts is the next large route-level duplicate surface: create/update/topic/invite parse bodies manually, several endpoints hand-roll not-found and agent-token-required envelopes, and success/no-content envelopes are repeated. The change can stay scoped by preserving channelEngine behavior and fanout/webhook side effects.

### Migrate agent routes to shared HTTP helpers
- **Chose:** Migrate agent routes to shared HTTP helpers
- **Reasoning:** agent.ts still hand-rolls standard Relaycast success/error envelopes, no-content responses, and body parsing across register/update/spawn/events/release. The migration can preserve custom spawn and status-event messages while reducing route-local response construction.

### Migrate workspace routes to shared HTTP helpers
- **Chose:** Migrate workspace routes to shared HTTP helpers
- **Reasoning:** workspace.ts is the last large standard-envelope route: workspace create/update/delete, activity, workspace-wide DM views, token rotation, stream config, and fleet-node config all duplicate success/error envelopes and body parsing. A scoped migration can preserve public lookup rate-limiting and config override semantics while reducing route-local response construction.

### Migrate standard middleware errors to shared HTTP helper
- **Chose:** Migrate standard middleware errors to shared HTTP helper
- **Reasoning:** After route migrations, the remaining standard Relaycast envelopes were middleware errors in auth, rate limiting, plan limits, and fleet-node gating. Reusing jsonError keeps status codes/messages unchanged and leaves health plus A2A protocol responses as intentional non-envelope exceptions.

---

## Chapters

### 1. Work
*Agent: default*

- Migrate directory routes to shared HTTP response helpers: Migrate directory routes to shared HTTP response helpers
- Directory route migration completed with shared response helpers and live HTTP verification; remaining route duplication can continue in similar cohesive slices.
- Migrate file routes to shared HTTP response helpers: Migrate file routes to shared HTTP response helpers
- File route migration completed and verified; route helper pattern is now proven across directory and file modules, with larger message/channel/action routes remaining as future slices.
- Migrate read-oriented routes and query validation to shared HTTP helpers: Migrate read-oriented routes and query validation to shared HTTP helpers
- Read-oriented routes now share response helpers and query validation; remaining duplication is concentrated in larger state-changing route modules like channel, message, dm, action, agent, delivery, and a2a.
- Migrate routing routes to shared HTTP helpers: Migrate routing routes to shared HTTP helpers
- Routing route migration completed with live route resolution and config verification; helper coverage now spans small, read-oriented, file, directory, and routing modules.
- Migrate reaction routes to shared HTTP helpers: Migrate reaction routes to shared HTTP helpers
- Reaction route migration completed with malformed-body coverage and live add/list/delete verification; response helper pattern now covers another state-changing module.
- Migrate inbound webhook routes to shared HTTP helpers: Migrate inbound webhook routes to shared HTTP helpers
- Inbound webhook migration completed with live create/list/trigger/delete verification; helper pattern now covers webhook ingress alongside route, reaction, file, directory, and read modules.
- Migrate certification JSON routes to shared HTTP helpers: Migrate certification JSON routes to shared HTTP helpers
- Certification JSON routes now use the shared HTTP helpers; final checks and live certification monitor/read/badge exercise passed, with external autoreview still blocked by tenant policy.
- Migrate delivery routes to shared response helpers with optional JSON parsing: Migrate delivery routes to shared response helpers with optional JSON parsing
- Delivery routes now share response, query, JSON, and optional-body parsing helpers; focused/full tests and live delivery list/ack/fail/defer flows passed, with external autoreview still policy-blocked.
- Migrate direct DM routes to shared HTTP helpers: Migrate direct DM routes to shared HTTP helpers
- Direct DM routes now use shared response and JSON helpers; live malformed/validation/idempotency/send/replay/list flows passed, external autoreview remains policy-blocked.
- Migrate thread routes to shared HTTP helpers: Migrate thread routes to shared HTTP helpers
- Thread routes now use shared response and JSON helpers; focused/full checks and live malformed/validation/agent-token/idempotent reply/list flows passed, with external autoreview still policy-blocked.
- Migrate group DM routes to shared HTTP helpers: Migrate group DM routes to shared HTTP helpers
- Group DM routes now use shared response, JSON, and no-content helpers; focused/full checks and live create/message/replay/participant/leave flows passed, external autoreview remains policy-blocked.
- Migrate channel message routes to shared HTTP helpers: Migrate channel message routes to shared HTTP helpers
- Channel message routes now use shared response and JSON helpers; focused/full checks and live post/replay/list/get flows passed, external autoreview remains policy-blocked.
- Migrate action routes to shared HTTP helpers: Migrate action routes to shared HTTP helpers
- Action route now uses shared response helpers across registration, invoke, completion, lookup, and delete. Validation and live HTTP checks passed; malformed non-empty invoke and completion bodies now consistently return invalid_json while empty bodies remain valid.
- Migrate channel routes to shared HTTP helpers: Migrate channel routes to shared HTTP helpers
- Channel routes now use shared response and body helpers across create, update, topic, archive, membership, invite, and mute flows. The side-effect paths were left intact and verified with live HTTP coverage for validation, not-found, invite auth, no-content, and archived-list behavior.
- Migrate agent routes to shared HTTP helpers: Migrate agent routes to shared HTTP helpers
- Agent routes now use shared response and body helpers across identity, registration, update, delete, spawn, session events, event listing, and release. Custom spawn and status-event validation messages were preserved and verified live across 48 HTTP checks.
- Migrate workspace routes to shared HTTP helpers: Migrate workspace routes to shared HTTP helpers
- Workspace routes now use shared response and body helpers across workspace lifecycle, public lookup, activity, workspace-wide DM reads, token rotation, and stream/fleet feature overrides. The corrected live HTTP run passed 43 checks and confirmed config override semantics and no-content delete behavior.
- A2A routes now use shared helpers for management envelopes while preserving raw Agent Card and JSON-RPC wire shapes. Live validation confirmed registration/list/card/delete envelopes, raw workspace card responses, and JSON-RPC error behavior.
- Migrate standard middleware errors to shared HTTP helper: Migrate standard middleware errors to shared HTTP helper
- Standard middleware error envelopes now use shared jsonError across auth, rate limiting, plan limits, and fleet-node gating. Live validation confirmed auth and fleet error shapes while leaving health as an intentional raw status response.
- Engine-level JSON errors now use shared helpers, and self-host parent 404s return the standard envelope instead of Hono's default text response. Residual raw responses are limited to protocol-shaped health, A2A JSON-RPC parsing, and WebSocket non-upgrade text.
- A2A management and workspace feature-config catches now delegate coded-error response rendering to errorResponse, leaving local coded-error narrowing only for logging or JSON-RPC protocol body construction.

---

## Artifacts

**Commits:** 0c13f59, 084f65e, 56b160e, 5243538, 1dca675, b911ce5, 832ab4c, e8e6dfc, fc5aaa8, 7f56e8f, 75ed092, a5bd31a, c6832cd, 8fc77b2, fa720ed, 7602c63, a3b8104, eb25632, 94a491d, 9260d99
**Files changed:** 30

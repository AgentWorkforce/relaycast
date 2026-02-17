# Rust SDK Package Plan (`packages/sdk-rs`)

## Objective
Ship a first-class Rust SDK for Relaycast in this repository at `packages/sdk-rs`, with an API surface aligned to existing TypeScript (`@relaycast/sdk`) and Python (`relay-sdk`) SDKs.

## Why This Exists
- We already have reusable Rust logic in `relay-broker` (auth bootstrap, credential cache, websocket handling), but it is coupled to broker internals.
- We want a stable, language-native SDK crate for external Rust consumers, not a dependency on broker runtime modules.
- TS/Python parity lowers integration friction and keeps product behavior consistent across languages.

## Scope
### In scope
- New Rust crate at `packages/sdk-rs`.
- Public SDK API for:
1. Workspace and agent management (REST).
2. Agent-scoped messaging/channel operations (REST).
3. Real-time events client (WebSocket).
4. Typed errors and retry behavior matching TS/Python behavior.
- Tests, docs, examples, and publish-ready crate metadata.

### Out of scope
- PTY/spawn lifecycle logic from `agent-relay` broker runtime.
- Broker protocol (`SdkToBroker`, `BrokerToSdk`) transport.
- Dashboard/server app concerns.

## Target Package Identity
- Crate name: `relaycast-sdk` (working name; confirm before publish).
- Path: `packages/sdk-rs`.
- Rust edition: 2021.
- License: MIT.
- Initial version: `0.1.0`.

## Public API Shape (Parity-First)
The Rust surface should mirror SDK concepts already present in TS/Python.

### Core clients
- `RelayClient` (workspace-key scoped; similar to TS `RelayCast` and Python `Relay`)
- `AgentClient` (agent-token scoped)
- `WsClient` (real-time stream with subscriptions and reconnect)

### Namespaced operations (proposed)
- `relay.workspace().info() / update()`
- `relay.agents().register() / list() / get() / update() / delete()`
- `relay.as_agent(token) -> AgentClient`
- `agent.channels().create()/join()/leave()/list()/set_topic()/invite()`
- `agent.messages().send()/list()/thread_reply()/thread()`
- `agent.dms().send()/conversations()/messages()/create_group()`
- `agent.reactions().add()/remove()`
- `agent.files().upload()/complete()`
- `agent.inbox()`
- `agent.search()`
- `agent.connect_ws()` convenience returning configured `WsClient`

### Error model
- `RelayError { code, message, status }`
- transport/parsing error variants
- optional typed API error payload for downstream handling

### Retry model
- REST retry for `5xx` with bounded exponential backoff, matching existing SDKs.
- No retry for `4xx`.

## Crate Layout

```text
packages/sdk-rs/
  Cargo.toml
  README.md
  src/
    lib.rs
    version.rs
    error.rs
    models/
      mod.rs
      workspace.rs
      agent.rs
      channel.rs
      message.rs
      dm.rs
      event.rs
      billing.rs
    http/
      mod.rs
      client.rs
      retry.rs
    ws/
      mod.rs
      client.rs
      reconnect.rs
      subscriptions.rs
    relay/
      mod.rs
      client.rs
    agent/
      mod.rs
      client.rs
  tests/
    http_client.rs
    relay_client.rs
    agent_client.rs
    ws_client.rs
```

## Dependencies (initial)
- `reqwest` (HTTP)
- `serde`, `serde_json` (models)
- `tokio` (async runtime)
- `tokio-tungstenite` (WebSocket)
- `futures` (stream/sink)
- `thiserror` (errors)
- `url` (URL handling)
- `tracing` (optional diagnostics)
- test deps: `httpmock` or `wiremock`, `tokio`, `serde_json`

## Feature Flags
- Default async client.
- `blocking` feature for sync wrappers (optional in phase 2, not required for v0 if it delays ship).
- `rustls-tls` default; avoid OpenSSL requirement by default.

## Extraction Strategy From `relay-broker`
Use `relay-broker` code as reference only; avoid copying broker-specific behavior directly.

### Candidate reusable logic
- URL normalization and websocket endpoint building logic.
- reconnect/backoff behavior.
- auth/session register flow patterns.

### Must be decoupled
- local credential cache path assumptions (`~/.relay-broker/...`).
- broker event emitter and broker command mapping.
- broker runtime concerns (spawn/release/PTY).

## Implementation Plan

## Phase 0: Design lock
1. Confirm crate name and publish target (`crates.io` vs private registry).
2. Freeze v0 API parity list against TS/Python SDKs.
3. Decide if v0 includes sync API (`blocking`) or async-only.

Exit criteria:
- API checklist approved.
- Naming/publishing decision made.

## Phase 1: Scaffold crate
1. Create `packages/sdk-rs` crate and baseline module tree.
2. Add lint/test config and CI entry.
3. Add README with quickstart and auth model.

Exit criteria:
- `cargo check` and test harness run in CI.

## Phase 2: HTTP foundation
1. Implement `HttpClient` with headers:
- `Authorization: Bearer ...`
- `X-SDK-Version`
2. Implement API envelope parsing (`ok/data/error`).
3. Implement retries on 5xx.
4. Implement base request helpers (`get/post/patch/put/delete`).

Exit criteria:
- unit tests cover success, error mapping, retry behavior, invalid payload behavior.

## Phase 3: Models and REST namespaces
1. Add typed models for workspace, agents, channels, messages, DMs, files, inbox, search.
2. Implement `RelayClient` namespaces (workspace/admin).
3. Implement `AgentClient` namespaces (channel/message/DM operations).
4. Add pagination/cursor handling where relevant.

Exit criteria:
- parity test matrix vs TS/Python methods exists and passes.

## Phase 4: WebSocket client
1. Implement `WsClient` with:
- connect/disconnect
- subscribe/unsubscribe
- wildcard + typed event handlers
- ping heartbeat
- reconnect with capped exponential backoff
2. Add robust message parsing + malformed frame handling.

Exit criteria:
- reconnection/subscription replay tests pass.

## Phase 5: Polishing for release
1. Improve ergonomics (builder options, sensible defaults).
2. Add examples (workspace setup, agent send, realtime consumer).
3. Add docs for token scopes and failure modes.
4. Finalize semver and changelog entry.

Exit criteria:
- docs/examples compile and run in CI.

## Phase 6: Integration and migration
1. Add internal migration note for reusing `packages/sdk-rs` in `relay-broker` where useful.
2. Identify broker modules that can switch from bespoke HTTP/WS code to sdk-rs over time.
3. Keep migration incremental; do not block sdk-rs publish on broker refactor.

Exit criteria:
- migration checklist documented.
- sdk-rs usable independently before broker migration is complete.

## Testing Strategy
- Unit tests for:
1. request serialization and headers
2. response envelope parsing
3. error code/status mapping
4. retries and timeouts
- Integration tests (mocked HTTP/WS server) for:
1. agent registration flow
2. message send/read flows
3. websocket reconnect and event dispatch

## Compatibility/Parity Checklist
For v0 ship, parity with current TS/Python behavior should include:
- workspace create/info/update
- agent register/list/get/update/delete
- agent token scoped operations
- channel messaging + DM basics
- websocket connect/subscribe/event handling

Deferred parity (acceptable post-v0):
- billing convenience client
- advanced command/subscription helpers if API still shifting

## Risks and Mitigations
- API drift across SDKs.
  - Mitigation: maintain explicit parity matrix in repo and gate PRs with it.
- Over-coupling to broker assumptions.
  - Mitigation: clean-room API design; import only reusable primitives.
- Scope creep before first release.
  - Mitigation: strict v0 checklist and defer non-critical endpoints.

## Delivery Milestones
1. M1: crate scaffolding + HTTP core.
2. M2: REST namespaces + core models.
3. M3: WebSocket client + reconnect.
4. M4: docs/examples/tests + publish-ready metadata.

## Definition of Done
- `packages/sdk-rs` crate exists, documented, tested, and publishable.
- Core API is usable without `relay-broker` dependency.
- Behavior and error model are aligned with TS/Python SDKs.

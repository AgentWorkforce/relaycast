# Multi-Workspace Support Spec

## Repo scope
This repo provides the Relaycast server plus the TypeScript and Rust SDKs that the runtime layers build on. For the Phase 1 MVP, the important work in this repo is **SDK-side multiplexing** and **server-side contract clarity** rather than a server schema rewrite.

## Relevant plan slice
- Keep the existing Relaycast identity model intact: one backend agent identity per workspace, one workspace key, one agent token, one websocket connection.
- Add a `MultiWorkspaceSessionManager` in both SDK stacks so one runtime process can hold many existing workspace memberships concurrently.
- Merge inbound events into one workspace-scoped stream, with workspace context attached based on **which websocket delivered the event**.
- Make outbound send APIs workspace-aware via `workspaceId` or `workspaceAlias`.
- Do **not** change the production Relaycast schema for the Phase 1 MVP.
- Preserve current wire behavior where `relaycast/packages/server/src/engine/wsTransform.ts` omits `workspace_id` for known websocket events; document and test that the client multiplexer must restore workspace context client-side.

## Current single-workspace flow

### Top-level system view
```text
Agent Process -> Broker -> 1 WebSocket -> 1 Relaycast Workspace
```

### Through this repo today
```text
Inbound
-------
Relaycast Workspace
  -> Relaycast Server
  -> wsTransform strips/normalizes event payload
  -> 1 SDK client instance (TS or Rust)
  -> Broker runtime receives event with one implicit workspace
  -> Agent process / local handlers

Outbound
--------
Agent process command
  -> Broker runtime send call
  -> 1 SDK client instance
  -> Relaycast HTTP/WebSocket API
  -> 1 Relaycast Workspace
```

### Current repo-internal shape
```text
TS SDK / Rust SDK
  Single workspace config
    -> 1 AgentClient
    -> 1 WsClient
    -> callbacks/events assume one implicit workspace

Server
  worker.ts
    -> websocket session keyed by workspaceId:agentId
  wsTransform.ts
    -> known websocket payloads omit workspace_id
```

## Proposed multi-workspace flow

### Top-level system view
```text
Agent Process -> MultiWorkspaceSessionManager -> N WebSockets -> N Relaycast Workspaces
                                              |
                                              v
                                       Merged Event Stream
                                       (workspace-tagged)
```

### Message flow with inbound and outbound paths
```text
Inbound
-------
Workspace A event ----> WebSocket A --\
                                        \
Workspace B event ----> WebSocket B -----+--> MultiWorkspaceSessionManager
                                         /        -> tag event with workspace_id / alias
Workspace N event ----> WebSocket N ----/         -> emit merged WorkspaceScopedEvent stream
                                                   -> Broker runtime routes by (workspace_id, target)
                                                   -> Agent process / local handlers

Outbound
--------
Agent process send request
  -> Broker runtime send({ workspaceId | workspaceAlias, to, message })
  -> MultiWorkspaceSessionManager resolves membership
  -> selected AgentClient / HTTP sender for that workspace
  -> Relaycast API
  -> exactly one target workspace
```

### Proposed repo-internal shape
```text
TS SDK / Rust SDK
  MultiWorkspaceSessionManager
    -> memberships: Map<workspace_id, WorkspaceMembership>
    -> one AgentClient per workspace
    -> one WsClient per workspace
    -> merged inbound stream of WorkspaceScopedEvent<T>
    -> workspace-aware send resolution

Server
  existing auth + schema unchanged for Phase 1
  existing worker websocket handling unchanged for Phase 1
  wsTransform contract explicitly tested/documented
```

## Exact files to modify
- `relaycast/packages/sdk-typescript/src/types.ts`
  - Add `WorkspaceRef`, `WorkspaceMembershipConfig`, `WorkspaceScopedEvent`, `WorkspaceSendTarget`, and `MultiWorkspaceStatus`.
- `relaycast/packages/sdk-typescript/src/multi-workspace.ts`
  - New manager that owns one `AgentClient` / `WsClient` per membership and emits merged workspace-scoped events.
- `relaycast/packages/sdk-typescript/src/index.ts`
  - Export the new manager and related types.
- `relaycast/packages/sdk-typescript/src/agent.ts`
  - Add helper hooks for lifecycle and wildcard event subscription so the manager reuses existing logic.
- `relaycast/packages/sdk-rust/src/types.rs`
  - Add Rust equivalents of workspace refs, membership config, workspace-scoped websocket events, and workspace-aware send target types.
- `relaycast/packages/sdk-rust/src/multi_workspace.rs`
  - New Rust `MultiWorkspaceSessionManager` built over `AgentClient` / `WsClient`.
- `relaycast/packages/sdk-rust/src/lib.rs`
  - Export the new module.
- `relaycast/packages/sdk-rust/src/agent.rs`
  - Add minimal helpers required by the manager while preserving current single-workspace behavior.
- `relaycast/packages/server/src/engine/wsTransform.ts`
  - Keep current wire behavior, but document/test that clients must restore workspace context from the connection that delivered the event.
- `relaycast/packages/server/src/routes/__tests__/fanout.test.ts` or a new websocket transform test file
  - Add a contract test that proves merged clients cannot rely on `workspace_id` in the event body.

## Acceptance criteria
- TypeScript SDK exports a `MultiWorkspaceSessionManager` and the new multi-workspace types.
- Rust SDK exports a matching `MultiWorkspaceSessionManager` and workspace-scoped event types.
- Each workspace membership owns its own `AgentClient`, `WsClient`, credentials, and subscriptions.
- Inbound events from multiple Relaycast workspaces are merged into one `WorkspaceScopedEvent` stream tagged with `workspace_id` and optional alias.
- Outbound send APIs support `workspaceId` and `workspaceAlias`, and reject ambiguous sends when the workspace cannot be resolved.
- Existing server auth, schema, and websocket routing remain unchanged for the Phase 1 MVP.
- Server-side tests lock in the `wsTransform` contract that `workspace_id` is not reliably present in known websocket payloads.

## Backwards compatibility notes
- Single-workspace SDK consumers continue to work unchanged.
- No Phase 1 database migration is required in this repo.
- Existing Relaycast server identity semantics remain one agent membership per workspace.
- Existing websocket wire payloads remain unchanged; the client manager adds workspace context based on connection provenance.
- Older callers can still behave as a one-membership session, with multi-workspace support layered on top.

# Multi-Workspace Support Spec

## Repo scope
This repo provides the Relaycast server plus the TypeScript and Rust SDKs that the runtime layers build on. For the Phase 1 MVP, the important work in this repo is **SDK-side multiplexing** and **server-side contract clarity** rather than a server schema rewrite.

## Relevant plan slice
- Keep the existing Relaycast identity model intact: one backend agent identity per workspace, one workspace key, one agent token, one websocket connection.
- Add a `MultiWorkspaceSessionManager` in both SDK stacks so one runtime process can hold many existing workspace memberships concurrently.
- Merge inbound events into one workspace-scoped stream, with workspace context attached based on **which websocket delivered the event**.
- Make outbound send APIs workspace-aware via `workspaceId` or `workspaceAlias`.
- Do **not** change the production Relaycast schema for the Phase 1 MVP.
- Preserve current wire behavior where `packages/server/src/engine/wsTransform.ts` omits `workspace_id` for known websocket events; document and test that the client multiplexer must restore workspace context client-side.

## Current single-workspace flow

The current single-workspace behavior is already concentrated in a few source files:

- `packages/sdk-typescript/src/agent.ts` and `packages/sdk-rust/src/agent.rs` each manage one workspace membership at a time: one `AgentClient`, one websocket connection, and one implicit workspace for subscriptions and inbound events.
- `packages/server/src/worker.ts` owns the current websocket/session routing on the server side.
- `packages/server/src/engine/wsTransform.ts` normalizes known websocket payloads and omits `workspace_id`, so any multi-workspace client has to restore workspace context from the connection that delivered the event.

Phase 1 multi-workspace support layers a client-side multiplexer on top of that existing behavior instead of changing the server schema or websocket contract.

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
- `packages/sdk-typescript/src/types.ts`
  - Add `WorkspaceRef`, `WorkspaceMembershipConfig`, `WorkspaceScopedEvent`, `WorkspaceSendTarget`, and `MultiWorkspaceStatus`.
- `packages/sdk-typescript/src/multi-workspace.ts`
  - New manager that owns one `AgentClient` / `WsClient` per membership and emits merged workspace-scoped events.
- `packages/sdk-typescript/src/index.ts`
  - Export the new manager and related types.
- `packages/sdk-typescript/src/agent.ts`
  - Add helper hooks for lifecycle and wildcard event subscription so the manager reuses existing logic.
- `packages/sdk-rust/src/types.rs`
  - Add Rust equivalents of workspace refs, membership config, workspace-scoped websocket events, and workspace-aware send target types.
- `packages/sdk-rust/src/multi_workspace.rs`
  - New Rust `MultiWorkspaceSessionManager` built over `AgentClient` / `WsClient`.
- `packages/sdk-rust/src/lib.rs`
  - Export the new module.
- `packages/sdk-rust/src/agent.rs`
  - Add minimal helpers required by the manager while preserving current single-workspace behavior.
- `packages/server/src/engine/wsTransform.ts`
  - Keep current wire behavior, but document/test that clients must restore workspace context from the connection that delivered the event.
- `packages/server/src/routes/__tests__/fanout.test.ts` or a new websocket transform test file
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

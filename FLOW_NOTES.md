# Node reconnect delivery replay — findings

Branch: `fix/node-reconnect-delivery-replay`
Incident: workspace `rw_7ccfea89`, `cast.agentrelay.com`, engine 8.11.3 — a message
fanned out to a channel at 04:27 while a node's delivery socket was down was never
pushed after the node reconnected at 04:33.

## Root cause

`inventory.sync` (`packages/engine/src/engine/node.ts`, `handleNodeControlMessage`)
was the reconnect-replay trigger for cursor-negotiated brokers, but it derived its
replay scope from a *state transition* instead of from the certification itself:

```ts
const newlyReadyAgentIds = result.reconciledAgentIds.filter((agentId) =>
  !isProviderAgentDeliveryReady(registry, workspaceId, nodeId, providerName, agentId));
...
const replayAgentIds = [...new Set([...newlyReadyAgentIds, ...result.newlyRoutedAgentIds])];
await deliverPendingToNode(db, registry, workspaceId, nodeId, { providerName, agentIds: replayAgentIds });
```

Why that strands a reconnect:

- Per the PR #443 contract, a cursor-negotiated `node.register` deliberately does
  **not** replay (`if (!cursorHandshake)` guards the drain), because no identity is
  cursor-ready yet. The certification frame is therefore the node's *only*
  reconnect-replay trigger.
- `newlyReadyAgentIds` is non-empty only when the registry reports the listed
  identities as *not yet* delivery-ready at sync time. That holds for the in-process
  adapter (a reconnect creates a fresh `NodeConn` with an empty ready-set) — which is
  why every in-tree reconnect test passed — but not for a socket owner whose
  ready-set is keyed per node+provider rather than per connection. (A registry
  that omits the optional readiness hooks is not affected: `node.register`
  rejects its cursor negotiation, so it stays on immediate replay.)
- `newlyRoutedAgentIds` is non-empty only when the agent's binding *moved*. After a
  transport-only reconnect the agent row still points at the same node/provider, so
  it is empty too.

Both terms empty ⇒ `agentIds: []` ⇒ `deliverPendingToNode` short-circuits
(`if (wantedIds?.size === 0) return 0`). Nothing is replayed, nothing is logged, and
the queued rows sit in the mailbox until their TTL. The engine had made replay of a
certified session contingent on registry bookkeeping it does not own.

Reproduced in-process before the fix (scratch test, now folded into the conformance
suite): reconnect a cursor-negotiated node whose identities the socket owner already
reports delivery-ready, sync the inventory ⇒ 0 deliver frames, delivery row still
`queued`. With the fix ⇒ the frame is pushed and the row moves to `delivered`.

This also matches the live shape exactly: the message stayed durably in the channel,
the node came back online, no `deliver` frame ever reached the broker, and a later
message would not have unblocked it either — the broker's monotonic-seq gate holds
any higher `seq` as a Gap while `seq 1` is missing.

## Fix

`packages/engine/src/engine/node.ts`, `inventory.sync` case:

- **Cursor-negotiated connection** → replay the full certified set
  (`result.reconciledAgentIds`), exactly as `agent.register` / `agent.recover` replay
  the single identity they just made ready. This is what README already documents:
  "an `inventory.sync` certifies that the listed provider-owned sessions retained
  their in-memory cursors and may replay".
- **Legacy immediate-delivery connection** → unchanged behaviour: `node.register`
  already flushed the whole node to it and nothing gates its later sends, so only
  identities this sync newly routed to the node are replayed. Replaying more there
  would duplicate the register-time flush (two existing conformance tests assert the
  exactly-once frame counts and caught this during development).
- The handshake mode is recovered from the connection it was negotiated on —
  see the review round below, which replaced the first cut of this (an inference
  from the provider's persisted capabilities) after it proved sensitive to
  heartbeat roster updates.
- The dropped `isProviderAgentDeliveryReady` filter was provably a no-op on the
  legacy branch (immediate mode reports every identity ready), so removing it changes
  nothing there.

Invariants preserved: dedupe is still the cumulative delivery cursor
(`seq > agents.delivery_ack_seq`, status in `queued`/`delivered`), ordering is still
ascending `seq` with bounded 50-row pages under a per-identity high-water mark, and
`replayPendingToNode` still re-checks `isProviderAgentDeliveryReady` before *every*
frame, so a certified-but-not-ready identity is still never flushed (PR #443).

### Callsites touched

- `packages/engine/src/engine/node.ts`
  - `handleNodeControlMessage` → `case 'inventory.sync'`: replay scope (the fix).
  - new `providerAdvertisesDeliveryCursor()`; `registerAgentViaNode` and
    `recoverAgentViaNode` now use it in place of their two duplicated inline
    capability lookups (behaviour identical).
- `packages/engine/src/__tests__/conformance/delivery.test.ts`: new
  `reconnect replay of an outage backlog` block (4 tests). Three of them fail on the
  pre-fix code; the acked-not-re-sent one is a guard that must pass both ways.
- `CHANGELOG.md`, `packages/engine/CHANGELOG.md`: `[Unreleased - Patch]` entries.

Untouched: `openapi.yaml`, `README.md` — no wire-visible change. The fix makes
behaviour match the reconnect/replay contract README already states.

## Paths checked and cleared

- `node-reconnect.ts` / `handleNodeReconnect` → thin delegate to
  `deliverPendingToNode` with node-wide scope; correct, and unaffected.
- Channel fanout **does** create per-node pending rows: `buildChannelDeliveryWrite`
  inserts one `deliveries` row per channel member regardless of socket state, with
  `route_node_*` resolved from the active binding. Root-cause shape 3 ruled out.
- `deliverPendingToNode` itself (bounded drain, in-flight coalescing, readiness and
  ACK re-checks per page and per row) behaves correctly; the bug was purely in the
  scope its caller passed.

## Remaining risks / follow-ups (not fixed here)

1. **Duplicate-connection arbitration vs. a half-open socket.** Reproduced in-process:
   if the engine never observes the old socket's close, the fan-out's live send lands
   in the dead socket, `sendToProvider` returns `true`, and the row is marked
   `delivered` — which makes it invisible to `sweepDueNodeDeliveries`, whose candidate
   query filters `status = 'queued'`. Reconnect replay is then the only recovery path
   (it does include `delivered`-but-unacked rows, so the fix above recovers these once
   the surviving connection certifies its sessions).
2. **Reconnect classified as a duplicate instance.** For a broker that sends no
   `provider` identity, `resolveProviderIdentity` synthesizes `instance_id` from the
   *connection id*, so every reconnect looks like a different instance. If the dead
   incumbent framed within `PROVIDER_ATTACH_LIVENESS_MS` (35 s), the reconnecting
   socket's `node.register` is rejected `provider_instance_conflict` and cannot bind
   at all; it self-heals only once the incumbent goes stale. Left as-is deliberately:
   with no client-asserted instance id the engine genuinely cannot separate a
   reconnect from a second live process, and the current policy (spec §3.1, shared
   with the cloud NodeDO via `providerAttachDecision`) fails closed. The real fix is
   for provider-less brokers to assert a stable `instance_id`.
3. **Repeated certifications re-send unacked frames.** On a cursor-negotiated
   connection, a second `inventory.sync` before the node acks will re-push rows with
   `seq > delivery_ack_seq` (including ones already marked `delivered`). That is the
   documented at-least-once contract and the broker's monotonic-seq gate drops the
   duplicate, but a broker that certifies on a short timer will see redundant frames.
   If that shows up in production, gate the certified replay on a per-connection
   "already resumed" marker rather than re-narrowing the scope.
4. The out-of-process socket owner (relaycast-cloud NodeDO) is not testable from this
   repo. The fix removes the engine's dependence on that owner's readiness
   bookkeeping, so it is correct for either mirroring choice — but confirming the
   NodeDO's ready-set lifetime across reconnects is still worth doing.

## Verification

- `npx vitest run` in `packages/engine`: 99 files, 1148 tests passed.
- `npm run typecheck` (engine) and `npm run lint` (engine): clean.
- `npx turbo test` (repo): 18/18 tasks successful.
- New tests confirmed failing on the pre-fix `node.ts` (3 of 4, by design).
- Note for local runs: `better-sqlite3@11` has no bindings for Node 26 — the suite
  was run on Node 22.23.2.

## Review round

Reviewer verdict (`REVIEW_VERDICT.json`) on `7d5eceb4`: not approved, one P1.

### [P1] Replay scope inferred from mutable provider capabilities

The first cut recovered the handshake mode with
`providerAdvertisesDeliveryCursor()`, reading `node_providers.capabilities` —
a row `heartbeatNode` rewrites wholesale whenever a `node.heartbeat` carries a
`capabilities` roster. The mode is a property of the *connection*
(`node.register` negotiates it and hands it to the registry per connection), so
deriving it from roster state let a heartbeat silently renegotiate it:

- Cursor-negotiated reconnect → heartbeat advertising only `spawn:claude` →
  `inventory.sync`: `cursorGated` false, `newlyRoutedAgentIds` empty, so the
  certification replayed nothing — the exact strand the branch set out to fix,
  reachable again through a different door.
- The inverse: a heartbeat adding `relay:delivery-cursor-v1` to an
  immediate-delivery connection made a later sync replay the unacked frames
  `node.register` had already flushed.

Fixed in `dd6582d7`, on both axes the reviewer offered:

1. **Connection-scoped mode (primary).** New optional
   `NodeConnectionRegistry.providerDeliveryReadinessMode()` returns the mode
   `setProviderDeliveryReadiness()` configured for the provider's *current*
   connection (`undefined` when none is bound, or when the caller's
   `connectionId` is no longer current). The in-process adapter reads it off the
   same `NodeConn.deliveryReadyAgentIds` encoding readiness already uses —
   `null` is immediate, a `Set` is agent-scoped, `undefined` is "never
   registered on this connection". `inventory.sync` asks the registry through
   the new `connectionNegotiatedDeliveryCursor()` helper.
2. **Registration-owned capability (fallback).** A registry on the older port
   contract (the out-of-process `relaycast-cloud` NodeDO, which cannot be
   updated from this repo) has no mode to report, so the helper still falls back
   to the persisted advertisement — and `heartbeatNode` now keeps that
   advertisement out of a heartbeat's reach:
   `withRegisteredProtocolCapabilities()` carries the registered
   `relay:delivery-cursor-v1` entry over a roster refresh and drops one a
   heartbeat tries to introduce. Protocol capabilities are negotiated at
   `node.register` and answered in its acceptance list; a heartbeat only
   refreshes spawn/action capacity. This also stabilises the same inference in
   `registerAgentViaNode` / `recoverAgentViaNode`, which decide whether their
   reply carries `delivery_ack_seq`.

Either fix alone holds the behaviour: with the adapter's new method stubbed out,
the whole delivery suite still passes on the fallback path (checked), which is
what certifies the out-of-process owner.

### Coverage added

Three tests in `delivery.test.ts` → `reconnect replay of an outage backlog`, all
three failing against the pre-fix `node.ts` (verified by swapping in `7d5eceb4`'s
file) and passing after:

- `replays the certified backlog when a heartbeat roster omits the cursor
  capability` — the reviewer's reproduction: cursor-negotiated reconnect, empty
  connection readiness, roster-only heartbeat, then `inventory.sync` ⇒ 1 frame.
- `does not re-flush an immediate connection whose heartbeat roster adds the
  cursor capability` — the inverse ⇒ still exactly the 1 register-time frame.
- `keeps the registered cursor advertisement out of reach of a heartbeat roster
  refresh` — asserts the persisted `node_providers.capabilities` directly, so
  the fallback axis is covered independently of the registry method.

### Notes corrected (reviewer's non-blocking accuracy points)

- The root-cause section and the engine changelog claimed a registry omitting
  the optional readiness hooks was also stranded, "because the shared
  `isProviderAgentDeliveryReady` helper defaults to `true`". Wrong: such a
  registry is refused the cursor capability at `node.register`
  (`delivery_readiness_unsupported`) and stays on immediate replay, which
  flushes at register time. Both texts now say only what holds — an owner whose
  ready-set is keyed per node+provider rather than per connection.
- Scope of this review, per the verdict: the engine's delivery path only. The
  branch contains no CLI enrollment/claim changes, so CLI stale-claim and
  crash-safety behaviour is not certified by it. Transport delivery remains
  at-least-once by contract; the exactly-once test pins suppression after a
  cumulative ACK, not broker-side dedupe.
- Follow-ups 1–4 above stand unchanged; none was in the blocking set.

### Verify gate (re-run, Node 22.23.2)

- `npx vitest run` in `packages/engine`: 99 files, 1151 tests passed (1148 + 3).
- `npm run typecheck` and `npm run lint` (engine): clean.
- `npx turbo test` (repo): 18/18 tasks successful.
- Not pushed.

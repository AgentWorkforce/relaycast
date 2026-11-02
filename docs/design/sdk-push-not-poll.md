# SDK agents: push, not poll

Hosted Relaycast (`cast.agentrelay.com`) runs one D1 primary. After the node-heartbeat and action-catalog work, HTTP delivery polling is its largest remaining D1 source. This document covers who polls, what the push transport already guarantees, and the change that makes idle agents cost no D1 reads.

## Who polls

Production `wrangler tail` of the API worker, 70 s, 2026-11-02 14:35Z, edge HTTP requests only:

| Route | Requests | Share |
|---|---:|---:|
| `GET /v1/deliveries` | 137 | 27% |
| `GET /v1/messages/:id/replies` | 78 | 15% |
| `POST /v1/agents/heartbeat` | 51 | 10% |
| `GET /v1/agent` | 43 | 8% |
| `GET /v1/inbox` | 21 | 4% |

`GET /v1/deliveries` by `x-relaycast-origin-client` / `x-sdk-version`:

| Origin client | SDK | Polls | Notes |
|---|---|---:|---|
| `relay-desktop` (2026.10.37 – .67) | `relaycast` crate 10.0.0 / 8.0.1 | 108 | 79%; `limit=50` |
| none | none | 19 | raw HTTP |
| `@relaycast/sdk` | 8.16.0 | 10 | `limit=100` |

The dominant poller is relay-desktop (`crates/probe` in the `relay` repo), not the TypeScript CLI path. Its delivery loop (`probe/src/relay/delivery.rs`) reads every agent's queue on a pass interval of 3 s whenever any registration's push socket is not live or any connect session is open (backoff 3 → 6 → 12 → 15 s on empty reads), and 30 s as a safety read when every socket is live. A successful read also refreshes REST presence, which the loop relies on.

Each poll costs 2 D1 statements in steady state (relaycast-cloud `hot-path-d1-statements.test.ts`): agent credential resolution and `deliveries.list`. Workspace plan and presence holds already come from KV and the workspace ledger.

## What the push transport already gives

Every SDK already attaches an agent as its own direct node:

| SDK | Attach | Socket ack |
|---|---|---|
| TypeScript | `AgentClient.connect()` → `POST /v1/agent/node-token` → `/v1/node/ws` `node.register` (`max_agents: 1`, tags `implicit,direct,sdk`) | `autoAckDeliveries: true` |
| Rust | `AgentClient` → `/v1/agent/node-token` → `WsClient` node mode | acks on arrival |
| Swift | `AgentClient.connect()` → `/v1/agent/node-token` → `WsClient` node mode | acks on arrival |

`ensureDirectNodeForAgent` creates that implicit node as `kind = 'ws', role = 'direct'`, one per agent. `direct_ws` is the legacy spelling of the same shape (`normalizeLegacyNodeShape` maps it to `ws` + `direct`); migration `0080_nodes_context_reachable_index.sql`, `nodeDeliver.ts` and the redrive sweeps treat `ws`, `fleet_ws` and `direct_ws` alike as `ws.node.v1` targets. A direct socket's behavior matches the HTTP queue:

| HTTP poll behavior | Push equivalent |
|---|---|
| Backlog on reconnect (`queued` + `delivered`, unexpired, FIFO) | `node.register` → `deliverPendingToNode`: replays `queued` + `delivered` rows above `agents.delivery_ack_seq`, ascending `seq`, unexpired, readiness-checked |
| Ordering | `seq` per agent; a failed lower send stops the page so a higher seq never overtakes it |
| Redelivery of an unacked row | Rows stay `delivered` until acked; every reconnect replays them; `sweepDueNodeDeliveries` redrives `queued` rows whose live send failed |
| `ack` | `delivery.ack` frame with `up_to_seq` → `ackDeliveriesUpToSeq` (cumulative) |
| `limit` | Replay pages of 50, bounded by the high-water `seq` read at register |
| `mode` / `reason` / `deadline` | `deliver` frame carries `mode` (`wait` / `steer`); `reason`, `deadline` and `expires_at` stay on the row and gate replay |
| `fail` / `defer` | HTTP only (`POST /v1/deliveries/:id/fail|defer`); a socket client calls them exactly like a poller |
| Presence (`POST /v1/agents/heartbeat`) | `node.heartbeat` every ≤30 s; the correlated presence ack lets the SDK skip REST heartbeats (`confirmedPresenceRemainingMs`). NodeDO answers an unchanged direct beat with 0 D1 statements and checkpoints every 4 min |

So an agent with a live socket needs no HTTP poll at all. Polling survives in two places: clients that cannot or do not hold the socket, and clients that ack only after side effects (relay-desktop acks over HTTP after the message is in the session, because the published Rust `WsClient` acks every `deliver` frame on arrival). Both are what the long-poll serves.

## Long-poll: `GET /v1/deliveries?wait=<ms>`

`wait` is an integer 0 – 25 000 (milliseconds). Without it, or with 0, the route behaves exactly as today.

```
GET /v1/deliveries?limit=50&wait=25000
  → rows pending          : 200 immediately (one list read)
  → empty                 : park until the agent's queue gains a row, the wait expires, or the client disconnects
       woken              : list again, 200 with rows
       expired / aborted  : 200 [] (no second read)
```

25 s keeps the parked request under the Rust SDK's 30 s HTTP timeout and common proxy idle limits.

### The wake signal

Every row creation goes through `routeDeliveryOutcomes` (message post, thread reply, DM, group DM, inbound webhook, relayfile inbound). That is the same call that pushes `deliver` frames to node sockets, so it is the one place to signal. It now calls the `DeliveryWaiters` port with the recipient agent ids before routing:

```ts
export interface DeliveryWaiters {
  /** Resolve 'notified' once notify() names this agent at or after `since` (epoch ms), else 'timeout'. */
  wait(args: { workspaceId: string; agentId: string; since: number; timeoutMs: number; signal?: AbortSignal }): Promise<'notified' | 'timeout'>;
  notify(workspaceId: string, agentIds: readonly string[]): Promise<void>;
}
```

Only creation needs a signal: a parked request exists only when the active list was empty, and ack, fail, expiry and dead-lettering only shrink it. The one shrink-to-grow transition, deferring a `failed` row back to `queued`, is made by the agent itself.

Race: the route reads, finds nothing, then registers. A row committed between the two would notify before the waiter exists. `since` is the time the read started; the waiter holder keeps each agent's last notify time for a minute and resolves a registration immediately when that time is at or after `since`. A wake that is still lost (holder evicted between notify and register) costs latency up to `wait`, never a delivery: the row stays in the queue and the next poll reads it.

### Self-host and the actor adapter

`InProcessDeliveryWaiters` (engine) keeps waiters and last-notify times in memory. The Node runtime and the per-workspace actor run every request for a workspace in one process, so in-process is exact. A host that omits the port answers `wait` immediately, which is today's behavior.

### Cloudflare

The waiter lives in the workspace's `WorkspaceStreamDO`, and the parked request lives in the Worker:

```
Worker (GET /v1/deliveries?wait)         WorkspaceStreamDO(workspace)
  list → empty
  fetch /delivery-waiters/wait ───────▶  acceptWebSocket(server, ['delivery-wait:<agentId>'])
    ?agent_id&since  (Upgrade)           lastNotify[agent] ≥ since ? send 'notified'
  await message | timer | abort ◀──────  (hibernates)
                                         
routeDeliveryOutcomes                    
  notify(ws, agentIds) ───────────────▶  POST /delivery-waiters/notify
                                         lastNotify[agent] = now
                                         getWebSockets('delivery-wait:<agent>') → send 'notified', close
```

- One notify per routed batch (a channel post with N recipients is one DO request), not one per agent.
- The DO accepts waiter sockets with the hibernation API, so a parked request bills neither DO duration nor Worker CPU while idle. The Worker's wait is wall-clock only.
- Waiter sockets carry their own attachment kind; observer fanout (`/deliver`) and session telemetry skip them.
- `lastNotify` is in-memory and pruned after 60 s; eviction only loses the race guard (latency, not loss).

## Cost per idle agent-minute

D1 statements an agent with an empty queue causes per minute, from the hot-path statement tests (2 per poll: credential + list; a parked poll that expires adds nothing):

| Client behavior | Polls / min | D1 statements / min |
|---|---:|---:|
| relay-desktop, any socket not live (3 → 15 s backoff, steady 15 s) | 4 – 20 | 8 – 40 |
| relay-desktop, all sockets live (30 s safety read) | 2 | 4 |
| Long-poll, `wait=25000` | 2.4 | 4.8 |
| Direct socket, no HTTP poll | 0 | 0 (NodeDO direct checkpoint: 2 per 4 min = 0.5) |

The long-poll removes the fast-poll tier (the 3 – 15 s reads that exist only to cut latency) without raising latency. The idle floor comes from the socket, which is why push is the default and long-poll the fallback.

## Rollout

1. **Engine** (`relaycast`, minor): `wait` on `GET /v1/deliveries`, the `DeliveryWaiters` port and in-process implementation, notify in `routeDeliveryOutcomes`, `wait` on `deliveries()` in the TypeScript, Rust and Swift SDKs, OpenAPI and README.
2. **relaycast-cloud**: pin the engine release; `WorkspaceStreamDO` waiter endpoints; `createCloudflareEngineDeps` binds the DO-backed `DeliveryWaiters`; hot-path statement test for a parked poll.
3. **relay**: bump `@relaycast/sdk` / `relaycast`; relay-desktop's queue read passes `wait` while a socket is not live and drops the 3 s fast tier.

Old clients keep their current cost until they update; relay-desktop auto-updates (seven versions within October in the sample), so its share moves with its release train.

## Not in this change

- **Server-side empty answers for old clients.** The same notify signal could let `WorkspaceStreamDO` remember "agent's queue known empty since T" and answer a plain poll without `deliveries.list`, halving an unchanged old client's cost. It is a correctness-bearing cache (a lost notify hides rows until its TTL), so it is a separate decision.
- **Socket ack after side effects in the Rust SDK.** relay-desktop keeps its own socket because `WsClient` acks on arrival. A `WsClient` option to leave acking to the caller lets it drop `sdk_gaps`' socket and the safety read. Tracked as an SDK parity gap.

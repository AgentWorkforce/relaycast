# Delivery confirmation

Trustworthy, bounded confirmation that a message reached the software on the
other side — not just a socket — with one sender-facing state vocabulary, a
short wait budget on the send, and a later status route.

## Design findings (what existed, what changed)

Before this change the delivery row had three signals:

| Stored `status` | Set by | What it proved |
| --- | --- | --- |
| `queued` | the send's admission write | the row exists; delivery continues |
| `delivered` | `markDeliveriesDelivered` after `nodeConnections.sendToProvider` returned `true` (a ws socket write accepted by the host) or an `http_push` 2xx | for ws: the host wrote bytes to a socket. Nothing about the receiver. |
| `acked` | `POST /v1/deliveries/:id/ack`, the node frame `delivery.ack { up_to_seq }` (cumulative), `http_push` `on_2xx` / `response` ack modes | the recipient acknowledged |

**When the TypeScript SDK sends `delivery.ack`.** `WsClient.handleNodeMessage`
dispatches the `deliver` frame's payload to the user's handlers synchronously
(`emitServerLikeEvent` → `emit`), then sends `delivery.ack { up_to_seq: seq }`
in the same tick. Handlers run first, but an async handler's promise is not
awaited, so the ack lands right after dispatch — on receipt from the
sender's point of view. It therefore meant "dispatched to handlers", not "the
model answered". It keeps that role as the **consumed** signal; the new
`delivery.accepted` frame is sent *before* dispatch and is the receipt.

**What the hosted NodeDO does with inbound frames.** relaycast-cloud's
`NodeDO.webSocketMessage` hands the raw frame string to the engine's
`handleNodeControlMessage` (`@relaycast/engine/node-control`). The worker
parses it only to recover a request id for error correlation and to recognise
a heartbeat (`parseFleetBrokerToRelaycastMessage` inside a `try`); an unknown
type is not rejected by the worker. So a new frame type is handled by adding
it to `FleetBrokerToRelaycastMessageSchema` (`@relaycast/types`) and to the
engine's `handleNodeControlMessage` switch — which this change does — and the
hosted gateway picks it up when it bumps engine + types. `fleet/wire.ts` in
the cloud repo only holds outbound (relaycast → broker) types. The cloud repo
must also copy migration `0081_delivery_confirmation.sql` into its
`src/db/migrations/` (its CLAUDE.md lockstep rule).

Decisions:

- **Acceptance is the only `delivered`.** `accepted_at` is stamped by
  `delivery.accepted` or an `http_push` 2xx (the receiving server's own
  answer). A ws socket write still moves the raw `status` to `delivered`
  (compatibility with #620 consumers) and still emits the sender's
  `delivery.delivered`, but with `accepted: false`, and the derived `state`
  stays `queued`: only `accepted: true` / `accepted_at` means the client has
  it. The SDK sends the acceptance only after an application-supplied
  persistence hook stored the frame; a client with no durable inbox sends
  nothing and is reported `queued` → `consumed`, never `delivered`.
- **`delivery.ack` stays the consumed signal**, stored as `acked`, exposed as
  `state: consumed`. An ack also stamps `accepted_at` if the receiver never
  sent the acceptance (consumed implies held).
- **`replied` is explicit correlation only.** A DM names what it answers
  with `reply_to_message_id` (verified: the recipient's own message, in that
  conversation, else `400 invalid_request`); a thread reply answers its
  parent. Exactly that message's delivery to the replier is marked. Nothing
  is inferred from conversation order (the earlier draft's "mark every
  unanswered DM" heuristic was dropped entirely), and a row still raw
  `queued` — never handed to the recipient's software — is never marked: the
  reply is accepted as a message, but the row cannot claim the recipient
  answered what it never received. The correlation is stored on the reply
  (`messages.reply_to_message_id`, exposed on message and DM history
  responses).
- **`wait_ms` waits for acceptance or better** (`state` past `queued`:
  delivered, consumed, replied, failed), never for a socket write: a legacy
  receiver that sends no `delivery.accepted` runs the budget out and the
  response says `state: queued` (raw `status: delivered`, `accepted_at:
  null`). A reply that lands during the wait answers it with `replied`.
- **`client_message_id` was not added.** `messages` has no dedicated column
  for a caller-supplied id (only `metadata` JSON and the deliveries'
  `idempotency_key`), and the brief rules out a second migration for it.
  `Idempotency-Key` on the send is the dedupe handle; the response's
  `message.id` + `delivery.id` are the lookup keys for
  `GET /v1/messages/:id/deliveries`.

## State vocabulary (sender-facing)

`state` is derived from the row on every read; `status` is the stored enum.

| `state` | Derived from | Meaning |
| --- | --- | --- |
| `failed` | `status` in `failed`, `dead_lettered` | not delivered; `error` says why |
| `replied` | `replied_at` set | the recipient explicitly answered it: a DM with `reply_to_message_id`, or a thread reply (`reply_message_id`) |
| `consumed` | `status = acked` | the recipient acknowledged (REST ack, node `delivery.ack`, `http_push` ack modes) |
| `delivered` | `accepted_at` set | the receiving software durably holds it (`delivery.accepted`, or an `http_push` 2xx) |
| `queued` | otherwise — including raw `status = delivered` with `accepted_at: null` | the row exists; delivery continues. A host-side socket write is not a receipt |

Carried on: `POST /v1/dm` → `delivery`, `POST /v1/channels/:name/messages` →
`deliveries[]` (`{ id, agent_id, status, state, accepted_at, replied_at, reply_message_id, error, expires_at }`),
`GET /v1/messages/:id/deliveries` → `deliveries[]` (adds `created_at`,
`delivered_at`, `acked_at`, `replied_at`, `reply_message_id`,
`dead_lettered_at`, `read_at`).

## Wire contract: `delivery.accepted` (broker / SDK → relaycast)

**Definition.** `delivery.accepted` means: *the receiving software holds this
delivery and will process it*, sent before any handler runs. It is not a
socket write (which proves only that bytes left the server) and not
consumption (the later `delivery.ack`).

**Where the durability of the claim comes from.** relaycast keeps the row
unacked and re-delivers it on reconnect until the client's `delivery.ack`,
so a client crash between acceptance and consumption is a re-delivery,
never a loss. A client may therefore send the acceptance once the delivery
is in its durable inbox **or** in an in-process queue that is backed by that
server-side retention. The Relay Desktop spawn node does the latter: it
queues, then acks only after writing the delivery into the agent session.
The TypeScript SDK dispatches synchronously to handlers with no queue, so
it sends the acceptance only behind the `acceptDelivery` persist hook; an
in-memory handler client reports `queued` → `consumed`, never `delivered`.

**Capability gate — never parse versions.** A successful `node.register`
reply lists the inbound frames the engine understands beyond the baseline in
`data.capabilities` (`string[]`); this engine answers
`"capabilities": ["delivery.accepted"]`. Send `delivery.accepted` only when
the `node.register` reply lists the capability; an older engine omits the
field (or the entry) and would answer the frame with
`error { code: invalid_message }`. Later frame types get their own entry.
Re-read it on every connection: a reconnect may land on a different engine.

```json
{"v":1,"type":"reply","id":"r1","ok":true,"data":{"provider":{"name":"default","instance_id":"…"},"accepted_capabilities":[],"capabilities":["delivery.accepted"],"…":"…"}}
```

Send it only once the delivery is held as defined above (a durable inbox,
or a retention-backed in-process queue — not merely parsed in memory on
the way to a handler) and **before** any handler or model runs. A client
that holds neither must not send it; its deliveries are then reported
`queued` until consumed, which is the truth. Cumulative by `up_to_seq` like `delivery.ack`, or a
single row by `delivery_id`; at least one is required, both may be given.

```json
{"v":1,"type":"delivery.accepted","agent":"bob","delivery_id":"del_01J7FLEET000000000000201","up_to_seq":42}
```

```json
{"v":1,"type":"delivery.accepted","agent":"bob","up_to_seq":42}
```

Effect: every matching row of that agent (hosted by this node and provider)
that is still `queued` or `delivered` and not yet accepted moves to
`delivered` (`delivered_at` set if unset) with `accepted_at = now`. Rows
already acked, failed or dead-lettered are untouched. Repeats are no-ops. The
frame is fire-and-forget (no reply); a malformed one gets the usual
`error { code: invalid_message }`. It is admitted on a superseded socket and
after workspace expiry, like `delivery.ack`.

Then keep sending `delivery.ack { agent, up_to_seq }` once the delivery was
handled, as today.

Sender-side events (workspace stream + the sender's node `context.update`):

```json
{"type":"delivery.delivered","delivery_id":"del_…","message_id":"msg_…","agent_id":"agt_…","agent_name":"bob","status":"delivered","accepted":true,"at":"2026-11-04T04:00:00.000Z"}
{"type":"delivery.acked","delivery_id":"del_…","message_id":"msg_…","agent_id":"agt_…","agent_name":"bob","status":"acked","at":"…"}
{"type":"delivery.replied","delivery_id":"del_…","message_id":"msg_…","agent_id":"agt_…","agent_name":"bob","status":"replied","reply_message_id":"msg_…","at":"…"}
```

A ws socket write emits `delivery.delivered` with `accepted: false` (kept
for #620 consumers; the row's `state` is still `queued`); the acceptance
then emits a second one with `accepted: true` (unless the acceptance landed
before the host's batch was read, in which case only the accepted one is
sent). Only `accepted: true` means the client has the message.

### Rust and Swift SDKs, Relay Desktop probe

Neither SDK sends the frame yet; the engine treats them as legacy receivers
(socket-write `delivered`, `accepted_at: null`, `wait_ms` runs out). To adopt:
remember `data.capabilities` from the `node.register` reply; if it contains
`"delivery.accepted"`, then on receipt of a `deliver` frame, after storing it
and before invoking the handler, write the first JSON above with the frame's
`agent`, `delivery_id` and `seq` as `up_to_seq`; keep `delivery.ack` after
the handler. The Relay Desktop probe can assert the order on the socket:
`node.register` reply lists the capability, `deliver` in,
`delivery.accepted` out, handler, `delivery.ack` out — and no
`delivery.accepted` at all when the reply does not list it.

## Bounded wait on send: `wait_ms`

`POST /v1/dm` and `POST /v1/channels/:name/messages` accept `wait_ms` in the
body or as `?wait_ms=` (body wins), integer 0–2000, default 0 (compat). **1000
is the recommended value**: one acceptance round trip for a live receiver,
short enough to sit inside a tool call.

- The route creates the rows and starts routing as before, then parks on the
  engine's `DeliveryWaiters.waitForDeliveryState` for the named rows (DM: the
  one; channel: the first 50 the response names). Each wake re-reads the rows
  (no transaction is held while parked) and parks again on the ones still
  short. It returns once every row is accepted or settled (consumed, replied,
  failed), or when the budget ends — then with the rows as they stand.
- Wakes come from: `delivery.accepted`, every ack path, `http_push` 2xx, the
  REST fail route, and the host-side socket write (which re-reads and keeps
  waiting, since it is not an acceptance).
- Idempotent replays never park and repeat the stored receipt (`queued`).
- Hosts without a `DeliveryWaiters` that can park (the workspace actor; a
  Cloudflare host until its waiter implements `waitForDeliveryState`) answer
  at once; the client falls back to the events or
  `GET /v1/messages/:id/deliveries`.
- `wait_ms` is not part of the idempotency fingerprint.

The TypeScript SDK sends `delivery.accepted` only when all three hold:
`autoAcceptDeliveries: true` (default `false` — set it only when you persist
deliveries durably before handlers run), an `acceptDelivery(delivery)`
persistence hook is configured and has resolved for that frame, and the
`node.register` reply listed the capability. A hook that throws or rejects
sends no acceptance; the delivery is still dispatched to handlers and acked
(an acceptance failure is not a delivery failure — the sender simply never
sees `delivered` for that row). Frames are processed in arrival order behind
a pending hook.

TypeScript: `agent.dm('bob', text, { waitMs: 1000, replyTo: theirMessageId })`,
`agent.reply(parentId, text)` (thread reply; answers the parent),
`agent.send('#general', text, { waitMs: 1000 })`; read `delivery.state` /
`deliveries[].state`.

## Dedupe

Retries of a send dedupe on `Idempotency-Key` (scope `dm:direct` /
`channel-message:<channel>`, 24 h); the replay carries the same `message.id`
and `delivery.id`, which are the keys for `GET /v1/messages/:id/deliveries`.
Node delivery is at-least-once; the SDK dedupes redelivered frames by event
id, and `delivery.accepted` / `delivery.ack` for an already-settled row are
no-ops.

## Storage

Migration `0081_delivery_confirmation.sql` adds nullable
`deliveries.accepted_at`, `replied_at`, `reply_message_id` and
`messages.reply_to_message_id` (no backfill, no index: rows are reached
through the delivery's id or the message's deliveries). Reply marking is one
UPDATE on the answered message's delivery to the replier; acceptance
settles a cumulative range in id-indexed pages of 50.

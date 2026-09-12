# Workspace capacity regression

Build ENGINE, then run `node packages/engine/scripts/capacity-http-regression.mjs`
from the repository root with Node 22, engine runtime dependencies, and
`miniflare@4.20260617.1` available. Set `CAPACITY_RESULTS` for the JSON output path.
The fixture imports this checkout's compiled engine, uses its actual migrations,
and sends requests through `createEngine`. SQLite uses real memory/file Node
transactions and native Drizzle D1 batches against local workerd D1. Authentication
uses the real token provider. Only async `workspaceDelivery.resolve` is configured.
The fixture supplies local queue/KV/rate-limit ports and captures outbound A2A
transport calls. This is not a live notification or complete HOST composition test.

Run `node packages/engine/scripts/public-consumer-compile.mjs` after building to
compile a strict consumer against the packed public ENGINE and `/ports` exports.
The normal ENGINE typecheck also includes the async resolver consumer fixture.

## Release composition

Apply ENGINE migration `0057_a2a_egress.sql` before serving this engine version.
It adds a durable accepted-egress table, no quota counter or extra capacity.
The same atomic write commits the intent, message, attachments, session, delivery,
and applicable message log. A failed admission rolls all those rows back before
transport. Harmless conversation metadata can remain from earlier resolution.

Outbound DM retries should retain `Idempotency-Key`. A previously admitted intent
is reusable at full capacity; the SQL unique identity protects against concurrent
KV lock misses. The transport lease claims one sender, uses bounded HTTP timeouts,
and records terminal acceptance with its counter atomically. A transport failure
keeps the accepted message; a retryable intent is eligible again after 30 seconds.
An upstream rejection remains terminal with its original status/code. The remote
request retains its original message ID across recovery. A crash after remote
acceptance can repeat transport; receiver idempotency is still required.

Node calls `sweepPendingA2aEgress(db)` in its existing maintenance timer. HOST must
apply the new migration, upgrade its engine pin, and call the same exported helper
from its existing scheduled recovery path. These are explicit parent-owned release
dependencies. Direct RPC gateway forwarding that creates no local delivery retains
its existing transport contract; both A2A producers of local DMs resolve policy.

## Message and intent lifecycle

Accepted message/delivery rows retain the existing workspace message-retention
policy and quotas. The separate egress intent has a **24-hour retry window from
admission**, matching HTTP idempotency. Pending payloads live only within that
window and while the original source message and registered target/endpoint exist.
Before every transport attempt (including internal retries), the engine reads the
source, original registration ID, endpoint, recipient, and current credentials as
one tuple. A deleted/recreated registration or changed endpoint returns terminal
410 `a2a_target_gone`; a deleted source returns 410 `a2a_message_not_retained`.
Same-endpoint auth rotation uses the current scheme/credential pair. Credentials
and raw upstream error bodies are never copied into the intent or error logs.

Success and terminal failure immediately clear the duplicated payload. The small
identity/outcome record remains until the window ends, even if message retention
runs earlier. A retained sent intent with a deleted message still returns 410.
Before cleanup, an expired intent returns 410 `a2a_egress_expired`; a previously
terminal failure preserves its typed outcome. After cleanup the old key is fresh,
so callers must stop automatic retries after 24 hours; a late request may create a
new message subject to ordinary capacity and recipient checks. Existing KV success
records retain their independent 24-hour response-cache behavior.

`cleanupA2aEgress(db, limit = 20)` deletes expired records using the indexed
`created_at, id` horizon in a single bounded DELETE with a subquery. The limit is
clamped to 1–100. It runs inside the existing `sweepPendingA2aEgress` maintenance
entrypoint, requiring no new timer. Concurrent cleanups cannot select then delete
stale batches. A live sending lease is excluded until settlement or its 120-second
expiry; a crashed expired lease never dispatches an expired payload. The host must
keep its existing scheduled sweep enabled to physically reclaim expired records.
A transport already issued before source deletion/expiry cannot be recalled; no
subsequent attempt is issued after validation observes the change.

Run `pending-retention-regression.mjs` for the parent's retention probe (portable
imports and new-index baseline filtering only); run `a2a-lifecycle-regression.mjs`
for Node memory/file and workerd D1 caller retries, target deletion/recreation,
endpoint/auth rotation, internal retry mutations, expiry, indexed bounded cleanup,
and concurrent cleanup/transport controls. Set `CAPACITY_RESULTS` separately.

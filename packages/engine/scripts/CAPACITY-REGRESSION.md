# Workspace capacity regression

Run `npm ci`, `npm run build`, then `npm run test:engine:regression` from the
repository root with Node 22. CI runs this command after its normal build. It runs
the capacity, pending-retention, lifecycle, review-regression, and packed-public-consumer scripts
sequentially using the declared dependencies, including pinned test-only Miniflare.
Set `ENGINE_REGRESSION_RESULTS_DIR` to retain separate JSON results in a chosen
directory; by default the runner prints a new results directory under the OS temp
directory. For an individual fixture, run
`node packages/engine/scripts/capacity-http-regression.mjs` and set
`CAPACITY_RESULTS` for its JSON output path.
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

Apply ENGINE migrations `0057_a2a_egress.sql`, `0058_a2a_egress_context.sql`, and `0059_a2a_inbound_admission.sql` before serving this engine version.
It adds a durable accepted-egress table, no quota counter or extra capacity.
The same atomic write commits the intent, message, attachments, session, delivery,
applicable message log, public response context, webhook outbox row, and workspace
event log row. A failed admission rolls all those rows back before
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

Success and terminal failure immediately clear the transport payload. The egress
identity/outcome record remains until the window ends, even if message retention
runs earlier. Separately, `a2a_egress_context` retains the original public response,
including message body, user metadata, sender name, conversation, and attachment
descriptors. This is content, not merely identity bookkeeping. It has no copied
transport credentials and is bounded by the same 24-hour egress horizon: indexed
egress cleanup cascades its deletion. Source-message deletion and workspace
deletion also cascade context deletion. Sent retries validate source retention and
the retry horizon before returning the snapshot, without re-resolving recipients,
attachments, conversation membership or external credentials. For pre-0058 rows
without a snapshot, compatibility reads the original retained message/log and
attachment junctions without recreating relationships; historical descriptors that
changed before the upgrade cannot be recovered retroactively. A retained sent intent with a deleted message still returns 410.
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

## Durable local acceptance notifications

Outbound A2A admission commits one `pending_events` identity and one monotonic
`workspace_events` cursor alongside the message and delivery, before external
transport starts. The route only publishes those already committed identities;
completed caller retries never append them again. Lost queue sends use the existing
webhook outbox sweep/consumer. Lost observer publication uses workspace cursor
replay. Queued node deliveries use the existing delivery maintenance/reconnect
contracts. These recovery paths do not depend on the A2A transport outcome.
External delivery retains the existing retry/deduplication contract; a receiver
may see a repeated attempt after a crash. No new HOST timer or event kind is needed.

`a2a-review-regression.mjs` exercises actual routes with Node memory/file databases
and workerd D1: injected transport and lost fast paths recovered only through
sweeps/cursor replay, SQL notification-write rollback, atomic capacity refusal,
SQL counter failure/retry on both local inbound producers, immutable completed
responses after recipient/attachment/roster/endpoint churn, and an actual concurrent
SQL admission collision. It also applies 0058 twice to the prior schema and proves
context cleanup under message deletion, 24-hour egress cleanup and workspace deletion.

## Inbound identity and second-feedback controls

The SQL inbound identity hashes workspace, authenticated actor, route scope and
caller message key. Its transaction includes the message, receive counter,
delivery, message log, public response, webhook outbox and workspace event.
Concurrent losers return the committed response, or typed conflict for a changed
payload. KV completion stores only identity/digest; SQL decides replay even when
that cache is warm. Source deletion clears the response atomically and nulls the
source FK while retaining a content-free tombstone for the 24-hour window. Retry
then returns typed 410. Workspace deletion cascades identities; the existing
bounded recovery sweep expires them using an indexed query. 0057/0058 are unchanged.

The review script checks concurrent Node memory/file and D1 batches, actual KV
completion failures, injected SQL failures, source-prune replay with/without KV,
retention and auth/payload controls. It also covers resolver-outage replay,
JSON-RPC capacity IDs, and terminal malformed responses. Unit controls exercise
actual Node timer overlap and transport retry/HTTPS boundaries. Capacity fixtures
observe background errors explicitly; ordinary promise settlement alone does not
prove caught fast-path work succeeded. Existing lost-fast-path recovery controls
assert SQL identities plus webhook/node/cursor recovery separately.

The migration test constructs a real pre-0057 database by applying the migration
plan through 0056, including the explicit 0048/0049 supersessions, then compares
original table SQL, foreign keys and unique-index metadata after additive DDL.

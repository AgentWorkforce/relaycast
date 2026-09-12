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

The accepted-egress ledger is retained for workspace lifetime (workspace deletion
cascades it); no automatic TTL is introduced that could silently revoke durable
request identity. This increases storage for outbound A2A and needs a separate
retention policy if deployments require bounded idempotency history. The table
contains payload/target identity, not copied credentials.

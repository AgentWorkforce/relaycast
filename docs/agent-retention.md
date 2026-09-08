# Agent registry retention

`POST /v1/agents/retention` is workspace-key-only maintenance. It defaults to a
dry-run and a 30-day retention window. Set `delete: true` explicitly to physically
delete eligible identities. It runs no maintenance on roster reads and is not a
remedy for the contention tracked in relaycast#389.

## Eligibility and protection

An eligible row must satisfy **all** of these conditions at deletion time:

- Persisted status is `offline` or `released` (derived roster presence is insufficient).
- Both `last_seen` and `created_at` are valid, nonnegative integer timestamps
  strictly before the retention cutoff. Equality is protected.
- Location is `self_connected`, with no location node, origin node, node binding
  of any status, or implicit direct node. Metadata is an object (or SQL NULL),
  without `fleet`, `broker`, or `node_id` ownership evidence.
- No message, channel, file, or webhook retains the identity as author/creator.

**An offline broker does not prove that its agents were released.** All node
associations remain protected, including inactive bindings, disconnected nodes,
legacy fleet metadata, and incomplete location records. No liveness RPC or
caller-provided inventory is used to infer absence. Missing ownership tables or
failed database checks abort the operation; malformed metadata is protected.

This intentionally reclaims only unowned identities. Current registrations have
implicit direct nodes and are protected too. It does **not** automatically reclaim
every old roster row: broker-owned identities need a separate authoritative
release protocol, and historical authors need an archival identity design before
physical removal. Do not clear ownership fields to make a dry-run count larger.

Deleting an eligible identity revokes its credentials and applies existing
foreign-key actions: memberships, deliveries, reactions, receipts, session events,
message logs, actions, ratings, routing failures and recovery credentials cascade;
directory sources and invocation callers become null. Identity audit entries
survive. The four author/creator references above are preserved, never rewritten.

## Preview and execution

Apply migration `0052_agent_retention_indexes.sql` before enabling the endpoint.
It adds six agent-reference indexes so history checks and SQLite foreign-key
probes avoid unrelated full-table scans. Index creation consumes storage and
must fit the deployment's migration capacity; this tool does not apply migrations.
Deletion refuses to run if any of these indexes is missing. Preview instead
reports otherwise-unowned candidates as `history_unverified`, without scanning
history or declaring them eligible.

From a checkout with dependencies installed:

```sh
# RELAYCAST_API_KEY is supplied through the environment, not command arguments.
npx tsx scripts/retain-agents.mts --base-url https://cast.agentrelay.com \
  --retention-days 30 --state-file preview-state.json

# After reviewing the report, an explicit deletion uses a NEW traversal.
npx tsx scripts/retain-agents.mts --base-url https://your-engine.example \
  --retention-days 30 --delete --state-file deletion-state.json

# Read-only SQLite preview; does not create a database or run migrations.
npx tsx scripts/retain-agents.mts --sqlite /path/to/relay.db \
  --workspace-id ws_example --retention-days 30

# Hosted preview before the endpoint is deployed. This mode refuses --delete.
# Supply CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID via the environment.
npx tsx scripts/retain-agents.mts --d1-database-id <production-database-id> \
  --workspace-id ws_example --retention-days 30 --state-file d1-preview.json
```

Each call examines at most `limit` registry rows (default/cap 100) and performs
at most one bulk `DELETE ... RETURNING`, rather than a request per agent. The
candidate read is materialized before ownership/history probes. Cascading child
rows are not bounded by the registry page size; use a smaller `limit` for identities
with large dependent histories.

The response contains `dry_run`, `cutoff`, `scanned`, mutually exclusive `counts`,
eligible `candidates` (id/name/last_seen only), `deleted`, `skipped_changed`, and
`next_cursor`. Counts describe the preview; `deleted` counts actual registry rows
returned by the guarded write. Changes after preview can reduce that number.
The delete statement repeats every safety predicate atomically.

Pass `next_cursor` unchanged in the next request's `cursor`. It freezes the cutoff
and traversal's highest id; protected pages advance too. The server rejects a
different workspace or a cutoff newer than the requested retention window allows.
A null cursor ends the traversal. New rows inserted behind the cursor are examined
by a later traversal. The CLI stops after 50 pages by default (`--max-pages` changes
this); its summary states whether the traversal finished.

`--state-file` saves progress after each successful page using atomic rename. On
failure, reuse the same command and file. A failed/uncertain request can be replayed
without deleting an identity twice; actual deletion counts after an uncertain
response may undercount the previous attempt. A completed file is not restarted
automatically. A new preview is observational, not authorization to delete that
snapshot later: execution always rechecks current durable state.

For D1, resolve the database through the hosted deployment's `RelaycastDatabase`
binding: similarly named databases exist. D1 mode uses only the SELECT statements
from the same engine retention implementation and does not deploy code, migrate,
or delete. Before the indexes are deployed, unowned rows are reported as
`history_unverified`. No client accepts a production deletion flag on this direct
D1 path.

## Recorded dry-run

The [September 8 evidence](evidence/agent-retention-2026-09-08.json) includes a
production preview and a reproducible synthetic fixture run. The production
traversal stopped on D1 HTTP 429 after 1,700 rows: 1,256 ownership-protected,
434 recent/unknown-age, 8 other statuses, 2 history-unverified, and 0 eligible.
It deleted **zero** rows. This is a partial traversal, not a claim that the
remaining registry has nothing reclaimable. Required indexes were not deployed;
unverified rows need a new preview after migration.

The local fixture preview scanned 2,628 rows and identified 2,500 eligible rows,
without changing the database. A separate explicit local deletion removed 100
rows, resumed from disk, removed another 2,400, and preserved all 128 protected
rows. Reproduce it with an unused fixture path:

```sh
npm run -w @relaycast/engine build
node scripts/test-support/seed-agent-retention.mjs /tmp/retention-demo.db
npx tsx scripts/retain-agents.mts --sqlite /tmp/retention-demo.db \
  --workspace-id ws_retention_demo --retention-days 7
```

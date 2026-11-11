# Design: Postgres backend for self-hosted Relaycast

Status: **draft for review. Nothing in this document is implemented.**
Decision on record (Khaliq): self-host search must work on Postgres alone.
ClickHouse is an opt-in upgrade only, never a requirement.

## Goals

1. A self-hosted Relaycast can run on Postgres instead of SQLite. It must keep
   the same HTTP/WebSocket API, the same behaviour, and the same conformance
   suite.
2. `GET /v1/search` and directory, routing and mention search work with
   Postgres full-text search alone. No external search service is needed.
3. Multiple engine replicas can serve one deployment, so a pod restart or node
   drain no longer drops the service, and the Helm chart can drop its
   `replicas: 1` pin.
4. SQLite stays the default and keeps working unchanged for single-node
   installs.

## Non-goals

- Changing the hosted gateway (Durable Objects + D1). It is a separate adapter
  and not in this repo.
- ClickHouse or any analytics store as a dependency. A later opt-in search
  backend is allowed behind the same search port (see [Search](#search)).
- Online migration of an existing SQLite deployment with zero downtime. The
  first version offers an offline export/import (see [Migration path](#migration-path)).

## Where the engine is today

The facts below come from `packages/engine/src` at `v12.2.1`.

- **Dialect-bound storage type.** `EngineDb` is
  `BaseSQLiteDatabase<'async', …, typeof schema>` from `drizzle-orm/sqlite-core`
  (`ports/database.ts:45`). The schema is written with `sqliteTable`
  (`db/schema.ts`, ~1.5k lines). The engine is not written against a
  dialect-neutral interface.
- **SQLite-specific SQL is pervasive.** Across 177 non-test files:
  - `unixepoch()`: 78 uses in 12 files (50 in the schema defaults).
  - `json_extract`/`json_each`/`json_object`/`json_set`: 43 uses in 10 files.
  - `julianday`/`strftime`/`datetime`/`rowid`: 49 uses in 9 files.
  - 413 raw `` sql`…` `` templates.
  - 132 `RETURNING` uses. Postgres supports this directly.
  - 33 `ON CONFLICT` / `INSERT OR IGNORE|REPLACE` uses. These map to Postgres
    `ON CONFLICT`.
- **Constraint sentinels as admission control.** `databaseConstraintKind`
  (`ports/database.ts:197`) recognises refusals by matching SQLite's
  `NOT NULL constraint failed: <table.col>` text. A batch writes a NULL into a
  NOT NULL column to roll back atomically on capacity or registration changes.
  The same idiom appears in `node.ts`, `dm.ts`, `inboundWebhook.ts` and
  `internalAdmin.ts`.
- **Atomicity port.** `runAtomicWrites` uses `withTransaction` when the handle
  offers it and D1 `batch()` otherwise. Statements must not depend on each
  other's results, because ids are app-generated snowflakes. The Node adapter
  serialises every write through one async gate (`adapters/node/database.ts`).
- **Migrations.** There are 80 drizzle-kit SQLite DDL files
  (`db/migrations/0000…0078`) with supersessions. They include 28 triggers that
  carry invariants (for example `deliveries_advance_sequence_high_water`,
  0029:73, and the node-liveness revision triggers, 0071). The Node adapter
  applies them on boot, tracked in `_engine_migrations`.
- **Search.** `engine/search.ts` queries the FTS5 external-content table
  `messages_fts` (0001) with `MATCH` + `bm25`, and triggers keep it in sync.
  `directory_agents_fts` / `directory_skills_fts` (0007) and
  `messages_mention_fts` (0075) follow the same pattern. Routing does part of
  its ranking in JS. There is no search port.
- **Process-local state.** `EnginePorts` already abstracts most of it:
  - `RealtimeBus`, `ConnectionRegistry`, `NodeConnectionRegistry`:
    `InProcessRealtime`, in-memory socket and provider maps.
  - `PresenceTracker`: `InProcessPresence`, a map plus an interval sweep.
  - `RateLimiter`: a fixed-window `Map`.
  - `KeyValueStore`: a TTL `Map`, used as a replay cache.
  - `EventQueue`: `DurableEventQueue`, already SQL with lease claims.
  - `NodeLivenessAuthority`: optional, per handle.
  - **Not behind a port:** the 15 s maintenance `setInterval`
    (`adapters/node/index.ts:198`). It runs the stale-agent, offline-node,
    invocation-timeout, expired-workspace, delivery-maintenance and A2A egress
    sweeps, and it is only serialised within a process.
- **Already durable in SQL**, so this work does not need to change them:
  delivery sequences (`agents.delivery_seq`, unique
  `deliveries(workspace_id, agent_id, seq)`), DM and workspace-create
  idempotency, the webhook outbox, and the workspace stream log.
  `docs/self-hosting.md` §8 still calls "sequence counters" in-memory; that
  line should be corrected when this lands.
- **Files.** `FileStorage` has only `LocalFileStorage`, which uses local disk
  and HMAC-signed URLs. Multiple replicas need a shared object store.

## Design

### 1. Storage adapter behind the existing engine interfaces

The engine keeps calling Drizzle query builders. We make the database
**dialect a property of the adapter, not of the engine**, in three steps that
can each land on their own.

**Step A — a dialect-neutral `EngineDb`.**

- Replace the `BaseSQLiteDatabase` alias with a narrow interface: the Drizzle
  query-builder surface the engine actually uses, plus `runAtomicWrites`,
  `withTransaction`, and a `dialect: 'sqlite' | 'postgres'` tag.
- Define the schema twice from one source. Generate `schema.sqlite.ts`
  (`sqliteTable`) and `schema.pg.ts` (`pgTable`) from a table description
  module, so column names, types and indexes cannot drift.
  - Timestamps stay epoch seconds (`integer`/`bigint`), so the wire format and
    the comparisons do not change.
  - JSON columns become `jsonb` on Postgres.
- A CI check fails when the two generated schemas differ in tables, columns,
  nullability or unique keys.

**Step B — a SQL dialect helper for raw fragments.**

- Move the ~400 raw `` sql`…` `` fragments behind a small `sqlx` helper that
  emits the right dialect:
  - `sqlx.now()`: `unixepoch()` / `extract(epoch from now())::bigint`.
  - `sqlx.jsonGet(col, path)`: `json_extract` / `->>`.
  - `sqlx.jsonEach(col)`: `json_each` / `jsonb_array_elements`.
  - date math
  - `INSERT OR IGNORE` mapped to `ON CONFLICT DO NOTHING`.
- Mechanical, file by file, guarded by the existing conformance suite running
  against both dialects.
- Fragments that cannot be expressed portably stay as two explicit branches in
  the same function, each covered by a dialect-specific test.

**Step C — constraint sentinels become a portable admission error.**

- Keep the NULL-into-NOT-NULL idiom; it works on Postgres inside a transaction.
- Postgres reports the violated column as structured fields: SQLSTATE `23502`
  with `table` and `column`. `databaseConstraintKind` gets a Postgres branch
  that reads those fields instead of matching error text. The engine-facing
  kinds (`mailbox_capacity`, `node_capacity`, …) stay unchanged.
- Each sentinel gets one conformance test per dialect.

**Postgres adapter (`adapters/postgres`).**

- `node-postgres` pool with Drizzle `pg-core`.
- `runAtomicWrites`: a real `BEGIN … COMMIT` on one pooled client. This
  replaces both the D1 batch semantics and the Node write gate. Postgres
  row-level locking makes the single global write gate unnecessary.
- Statements whose correctness relied on that gate are the ones that read and
  then write without a guard. For example, `serializeMachineEnroll` keys a
  per-machine queue in process memory. Each one must become one of:
  - a guarded single statement (`UPDATE … WHERE <expected>` / `ON CONFLICT`),
  - `SELECT … FOR UPDATE` inside the transaction,
  - a transaction-scoped advisory lock (`pg_advisory_xact_lock(hashtext(key))`).
- An inventory of every in-process serialiser (`serialize*`, per-key promise
  chains, the write gate's implicit ordering) is the first deliverable of
  step D. Each one maps to one of the above.
- **Isolation level:** `READ COMMITTED` plus explicit guards and locks. Do not
  run blanket `SERIALIZABLE`: it would turn routine contention into retries
  throughout.

**Migrations.**

- A separate Postgres migration line, `db/migrations-pg/`, generated by
  drizzle-kit from `schema.pg.ts` and applied on boot under
  `pg_advisory_lock(<constant>)`, so concurrent replicas cannot race.
- **Triggers:** port the 28 SQLite triggers as PL/pgSQL. Where a trigger only
  maintains a derived value, prefer moving it into the write path. The
  sequence high-water trigger is the exception: it stays a trigger because it
  is a correctness invariant under concurrency.
- **Release gate:** a new SQLite migration must ship with its Postgres
  counterpart in the same release. A CI check compares the two migration
  ledgers by feature id.

### 2. Search on Postgres alone

Introduce a `SearchIndex` port with today's FTS5 code as the SQLite
implementation. The engine calls the port. It no longer issues `MATCH`
directly.

```ts
interface SearchIndex {
  searchMessages(q: SearchQuery): Promise<SearchPage>;  // GET /v1/search
  searchDirectory(q: DirectoryQuery): Promise<Ranked[]>; // directory + routing
  searchMentions(q: MentionQuery): Promise<SearchPage>;  // inbox mentions
}
```

The Postgres implementation:

- **Messages:** add a generated column,
  `messages.search tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED`,
  with a `GIN` index.
  - Generated columns remove the sync triggers, and with them the
    external-content drift class that FTS5 has.
  - Use the `'simple'` configuration by default, which tokenises without
    stemming, so results do not depend on language. Expose
    `RELAYCAST_SEARCH_LANGUAGE` for an operator who wants stemming.
- **Query:** translate the existing `buildFtsQuery` grammar (terms, quoted
  phrases, prefix) to `websearch_to_tsquery`, or to `to_tsquery` with `:*`
  when the user wrote a prefix.
- **Ranking:** `ts_rank_cd(search, query)` replaces `bm25`, keeping today's
  `ORDER BY rank, id DESC` tie-break. `relevance_score` stays on the wire but
  its scale changes; the OpenAPI already documents it as relative.
- **Scope filters:** apply workspace, channel, DM visibility and time window in
  the same query. Add a composite `(workspace_id, created_at)` B-tree so the
  planner can combine it with the GIN index (bitmap AND). Workspace isolation
  must be enforced in SQL, never after the query.
- **Directory and skills:** use the same generated-`tsvector` pattern. Routing
  keeps its JS ranking step, now fed by `ts_rank_cd`.
- **Optional fuzzy matching:** `pg_trgm`, if installed, for agent-name lookup.
  If the extension is absent, the feature degrades silently and the core
  stays available.
- **Acceptance:** run the existing search conformance tests unchanged against
  Postgres. Add a relevance-order parity test on a fixed corpus that asserts
  the same top-k membership as FTS5, not identical scores. Add a load check:
  p95 under 100 ms for a 1M-message workspace on a 2-vCPU Postgres.
- **ClickHouse later:** a third `SearchIndex` implementation, enabled
  explicitly, fed from the durable event queue. The default stays on
  Postgres.

### 3. Multi-replica requirements

Postgres makes the data shared. The following must also hold before the chart
may run more than one replica. Each item names its port.

| Concern | Today (in process) | Multi-replica design |
|---|---|---|
| Realtime fanout (`RealtimeBus`) | in-memory publish | Postgres `LISTEN/NOTIFY` on a per-workspace channel. The payload is only `(workspace_id, stream_seq)`. Each replica reads the event from the durable stream log by `seq`, which avoids NOTIFY's 8 KB limit and lost-payload issues. A replica that missed notifications (reconnect, slow consumer) resyncs from its last `seq`. |
| Agent delivery (`NodeConnectionRegistry`) | in-memory socket map | Deliveries stay in `deliveries`, which are already durable and sequenced. A `node_sessions(node_id, replica_id, lease_until)` row records which replica holds a node's socket; the lease is renewed by heartbeat. A write notifies `node:<id>`, and only the owning replica pushes. On a takeover after lease expiry, the new owner calls `deliverPendingToNode` from the acked high-water. Existing at-least-once + cumulative `delivery.ack` semantics make duplicate pushes during a takeover harmless. |
| Observer sockets (`ConnectionRegistry`) | in-memory | Local to each replica. The fanout above delivers to them. |
| Presence (`PresenceTracker`) | map + sweep | Rows with a `last_seen` lease in Postgres. Online means a lease is newer than the TTL. Reads are cached per replica for 1–2 s. The sweep moves to the maintenance leader (below). |
| Rate limits (`RateLimiter`) | fixed-window map | Postgres fixed-window counters (`INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n`), partitioned by minute and pruned by the leader. The per-replica limit divided by N is documented as an acceptable fallback for small installs. |
| KV / replay cache (`KeyValueStore`) | TTL map | Can stay per replica, because the durable idempotency tables are the authority (`direct_dm_idempotency`, `workspace_create_idempotency`). The cache only saves a round trip, so a per-replica miss is correct. |
| Webhook outbox (`EventQueue`) | SQL with leases | Already safe across replicas. Keep it; claim with `FOR UPDATE SKIP LOCKED`. |
| Maintenance sweeps (`setInterval`) | every replica, process-serialised | Wrap them in a `MaintenanceScheduler` port. On Postgres one leader runs them: `pg_try_advisory_lock` held on a dedicated connection, so leadership follows connection loss. Every sweep must also be idempotent, so a leadership flip mid-sweep is harmless. Most already are, by design for D1. |
| In-process serialisers (`serializeMachineEnroll`, write gate) | process memory | Advisory locks or guarded statements, from the inventory in §1. |
| Files (`FileStorage`) | local disk | An `S3FileStorage` (S3/MinIO/GCS-interop presigned URLs). With more than one replica it is required. Local disk stays the default for one replica. |
| Workspace-stream override and resync ring (`self-hosting.md` §8) | memory | Persist the override flag on the workspace row. The ring becomes reads from the stream log. |

Proof gate before the chart allows `replicas > 1` (in the helm-charts kind
smoke):

- Two replicas behind one Service.
- An agent connected to replica A receives a DM sent through replica B.
- An observer on B sees a channel post made on A.
- Killing the replica that owns a node socket loses no delivery and duplicates
  none past the ack.
- Maintenance runs on exactly one replica, verified with a counter.
- Rate limits hold across replicas within the documented tolerance.

### 4. Configuration and chart

- `RELAYCAST_DATABASE_URL=postgres://…`, with a `_FILE` form. Its presence
  selects the Postgres adapter; otherwise the engine uses SQLite at `--db`.
- `RELAYCAST_FILE_STORE=s3` with bucket, endpoint and credential `_FILE`
  variables.
- **Chart:**
  - `runtime.backend: postgres` becomes valid only with `database.existingSecret`.
  - `replicaCount > 1` is allowed only with `backend: postgres` and an S3 file
    store.
  - The Deployment switches to `RollingUpdate` for Postgres.
  - The PVC and the SQLite backup CronJob are not rendered for Postgres.
    Backups become the operator's Postgres backups (documented, with a restore
    drill) plus the object store's versioning.

## Migration path (SQLite → Postgres)

An offline `relaycast-engine export --db relaycast.db | relaycast-engine import
--database-url …` (JSONL per table, in dependency order) that preserves:

- ids
- key hashes and generations
- sequences and high-water values
- delivery ack state

After import, a verification step compares row counts and per-agent `delivery_seq`
and rejects any mismatch. The procedure is to take a backup, stop the
single-replica release, export and import, then start the Postgres release.

## Delivery plan

Each step lands behind the conformance suite and keeps SQLite green.

1. `SearchIndex` port with FTS5 as its implementation. This is a pure
   refactor.
2. Schema single source and `sqlx` dialect helper. Migrate the raw fragments
   file by file.
3. Postgres adapter, migrations, sentinel decoding, and search. The full
   conformance suite runs against Postgres in CI (service container).
   **Single replica only.**
4. `S3FileStorage`, plus export and import.
5. Multi-replica ports: fanout, node-session leases, presence, rate limits,
   the maintenance leader, and the serialiser inventory. Each ships with the
   proof gate above.
6. Chart: Postgres backend, then `replicaCount > 1`.

Steps 1–4 make search and storage work on Postgres alone. Step 5 is the large
one and is where most of the risk is.

## Risks and open questions

- **Behavioural drift between dialects.** Mitigation: one conformance suite,
  both dialects, on every PR. Release-gate on parity.
- **Hidden reliance on the global write gate.** Mitigation: the inventory in
  step 5, plus a stress test with concurrent writers on Postgres before
  multi-replica ships.
- **Ranking differences** (`bm25` vs `ts_rank_cd`). The wire contract keeps
  `relevance_score` relative; this is documented in the changelog.
- **Two migration lines.** This doubles schema-change cost. The CI ledger
  check keeps them from diverging silently.
- **Open:** do we need per-workspace language configuration for FTS, or is one
  deployment-wide setting enough?
- **Open:** is `LISTEN/NOTIFY` enough for the expected fanout, or do larger
  installs need an optional Redis bus behind the same `RealtimeBus` port?
  The proposed default is NOTIFY. Redis would be an opt-in later.

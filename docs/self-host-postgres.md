# Self-hosting the engine on PostgreSQL (connection layer)

Status: the server serves from PostgreSQL when any `RELAYCAST_DATABASE_*`
variable is set: it verifies the runtime identity and migration ledger before
listening, and never touches SQLite. Single replica only; realtime, presence
and rate limits are in-process, and files stay on local disk.

## What the platform provides

Relaycast runs in its own database, in schema `public`. The engine never
creates databases, schemas or roles and never grants on them. Before the first
`migrate`, the platform (DBA, operator, Terraform) must create:

```sql
-- Run as a privileged role, once, in the service's own database.
CREATE ROLE relaycast_owner   LOGIN PASSWORD '...';   -- migration Job only
CREATE ROLE relaycast_runtime LOGIN PASSWORD '...';   -- the server and verify-db
ALTER SCHEMA public OWNER TO relaycast_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO relaycast_runtime;

-- Runtime gets DML on everything the owner creates there, nothing more.
ALTER DEFAULT PRIVILEGES FOR ROLE relaycast_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relaycast_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE relaycast_owner IN SCHEMA public
  GRANT SELECT, USAGE, UPDATE ON SEQUENCES TO relaycast_runtime;

-- Lock down the database.
REVOKE TEMP, CREATE ON DATABASE app FROM PUBLIC;
GRANT TEMP ON DATABASE app TO relaycast_owner;
```

Neither role may be SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or
BYPASSRLS. Neither role may be a member of any other role at all - including
NOINHERIT memberships that are usable only through `SET ROLE` - so in
particular `relaycast_runtime` must not be a member of `relaycast_owner`.
Neither role may have USAGE or CREATE on other application schemas in the
same database, or CREATE on the database. Only `relaycast_owner` may hold
TEMP on the database, by a direct grant.

The migration ledger is the one exception to the default privileges.
`migrate` revokes everything on `public._engine_migrations` and grants
the runtime role SELECT only. Those are table-level grants on a table the
owner just created, not grants on schemas or roles.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `RELAYCAST_DATABASE_URL` / `RELAYCAST_DATABASE_URL_FILE` | yes | `postgres://user:password@host:port/database`. One TCP host. The password is required: there is no `PGPASSWORD` or `.pgpass` fallback. The only accepted query parameter is `sslmode=verify-full`. |
| `RELAYCAST_DATABASE_CA_FILE` (or `NODE_EXTRA_CA_CERTS`) | yes | PEM CA bundle that signs the server certificate. `RELAYCAST_DATABASE_CA_FILE` wins when both are set. It must contain certificates only (no private key), with at least one `CA:TRUE`. |
| `RELAYCAST_DATABASE_SCHEMA` | no | Must be `public` (the default). The bundled migrations target only that schema. |
| `RELAYCAST_DATABASE_OWNER_ROLE` | no | Default `relaycast_owner`. |
| `RELAYCAST_DATABASE_RUNTIME_ROLE` | no | Default `relaycast_runtime`. Must differ from the owner role. |
| `RELAYCAST_DATABASE_POOL_MAX` | no | 1-100. Default is the node-postgres default (10). |
| `RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS` | no | 0-86400000. Unset leaves the server default. |

TLS is always on and always verify-full. The chain is verified against
that file only, not the system store. The server name must
match the URL host; IP-literal hosts are checked against IP SANs. The minimum
version is TLS 1.2. The configuration refuses these URL parameters by name:
`sslmode` other than `verify-full`, `sslrootcert`, `sslcert`, `sslkey`,
`sslpassword`, `sslcrl`, `ssl`, `options`, target-altering parameters such as
`host`, `port`, `user`, `dbname` or `application_name`, and any other parameter.

The driver never sees the URL. The adapter parses it, then hands node-postgres
discrete `host`, `port`, `database`, `user` and `password` fields plus an
explicit `ssl` object (CA, `rejectUnauthorized`, server name, TLS 1.2 minimum,
and a hostname check bound to the URL host). A connection string therefore
cannot override the TLS settings. The fields the adapter does not set itself
would otherwise fall back to `PG*` environment variables, so the configuration
refuses to load while `PGREPLICATION`, `PGBINARY`, `PGCLIENT_ENCODING` or
`PGSSLNEGOTIATION` are set. The other `PG*` variables (`PGHOST`, `PGSSLMODE`,
`PGOPTIONS`, `PGPASSWORD` and so on) are overridden by the discrete fields and
have no effect.

The URL and password are never logged and never appear in error messages.
The commands log host, port, database, schema, expected role and the sha256
of the CA file.

The expected role comes from the mode, not from the URL. `migrate` must
connect as the owner role and `verify-db` as the runtime role, and both check
`session_user` and `current_user` against that role.

## Commands

```sh
# Migration Job (owner credentials)
RELAYCAST_DATABASE_URL_FILE=/run/secrets/owner-url \
RELAYCAST_DATABASE_CA_FILE=/etc/relaycast/db-ca.pem \
  relaycast-engine migrate

# Readiness / pre-start check (runtime credentials)
RELAYCAST_DATABASE_URL_FILE=/run/secrets/runtime-url \
RELAYCAST_DATABASE_CA_FILE=/etc/relaycast/db-ca.pem \
  relaycast-engine verify-db
```

| Exit | Meaning |
| --- | --- |
| 0 | Success. |
| 64 | Configuration refused (bad or missing URL, CA, schema, roles, limits). No connection is attempted. |
| 65 | Connected, but the identity is wrong. Every check is printed and each failing one is named (for example `FAIL not_superuser`). |
| 1 | Connection failure, migration failure, or a database that is not migrated for this image. |

### Identity checks

The checks first enumerate every role the session can reach: roles it
inherits from, roles it can `SET ROLE` to, and NOINHERIT memberships
(`pg_has_role(current_user, role, 'MEMBER')` over `pg_roles`, plus a
recursive walk of `pg_auth_members`; only the role itself is excluded, and
PUBLIC is not a role row). Any reachable role fails `no_role_memberships`,
which names the roles only. Every privilege check below is also evaluated
with each reachable role as the subject (`has_schema_privilege`,
`has_database_privilege`, ownership), and a problem found that way is
reported under the same check name as "... via role X". A NOINHERIT
membership grants the member nothing through the privilege functions, so
without this a role that can `SET ROLE relaycast_creator` would look clean.

Both modes check:

- `session_user` and `current_user` are the expected role
- `login`
- `not_superuser`, `not_createrole`, `not_createdb`, `not_replication`, `not_bypassrls`
- `no_privileged_memberships`: no reachable role has one of those attributes
- `no_role_memberships`: no reachable role at all
- `no_foreign_schema_access`
- `public_schema_locked`
- `no_database_create`
- `schema_exists`, which is reported only when the schema is missing

Owner mode also checks `owns_schema`, `schema_create` and `database_temp`
(TEMP only by the owner's own grant, never through another role).

Runtime mode also checks:

- `not_member_of_owner` (neither MEMBER nor USAGE)
- `not_schema_owner`
- `schema_usage`
- `no_schema_create`
- `owns_no_objects_in_schema`
- `no_database_temp`
- `ledger_read_only`: SELECT but no write on the ledger. While the ledger does
  not exist yet the check is reported as `skip` ("not applicable") with the
  reason, not as a pass.

### Migrations

The bundled files live in `@relaycast/engine`'s `dist/db/migrations-pg`:

- `0000_init.sql` is generated by drizzle-kit from `src/db/schema.pg.ts`.
- `0001_triggers.sql` is hand-written: PL/pgSQL ports of the SQLite triggers
  plus the FTS mirror tables.

`migrate` works as follows:

1. It checks out one dedicated connection and holds it for the whole run.
2. On that connection it looks up the schema's OID and takes the session-level
   advisory lock `pg_advisory_lock(1380143175, <schema oid>)`. The first key is
   a fixed namespace (`0x52435047`, "RCPG"). The lock is scoped to the schema,
   not the database: migrators for the same schema serialise (the second waits,
   then finds nothing to do), and migrators for different schemas do not
   contend. The lock is released in a `finally`. If the connection breaks, it
   is discarded, and the server releases the lock when the session ends.
3. In its own transaction, it creates `public._engine_migrations` if it is
   missing, confirms the owner role owns the ledger, sets the ledger grants
   (runtime: SELECT only), and validates the ledger.
4. It applies each pending file in its own transaction. The file's DDL and its
   ledger row commit together, and the ledger is re-validated inside that
   transaction first. A crash leaves a file either fully applied and recorded
   or not applied and not recorded. A generation is never recorded without its
   DDL.

The ledger has these columns, each enforced by a `CHECK` constraint:

- `name`: the file name, `NNNN_name.sql`
- `applied_at`: epoch seconds
- `generation`: the 1-based file position, an integer, unique
- `min_compatible_generation`: between 1 and `generation`
- `checksum`: the sha256 of the file

Ordering and compatibility use the integer `generation` only, never a
comparison of names, SHAs or image digests. Both `migrate` and `verify-db`
refuse a ledger when:

- any row has missing or malformed metadata
- generations repeat, or there is a gap below the highest one (dirty or
  interrupted history)
- the row at a bundled generation has a different name (divergent history)
- an applied file's sha256 differs from the bundled file (bundled migrations
  never change)
- an applied row's `min_compatible_generation` is above this image's
  generation (the database was migrated by an incompatible newer image)

An image's generation is the number of files it bundles. A migration's
`min_compatible_generation` defaults to its own generation, so by default each
new migration refuses every older image. A purely additive migration can lower
the floor with a `-- min_compatible_generation: N` header. Images at
generation N or higher then still verify against the newer database; they
report the newer rows as notes. The header is read only from the file's
leading comment block (the consecutive `--` lines at the top); the key
anywhere else in the file, a malformed value or a duplicate makes the bundle
refuse to load.

Every bundled file is also scanned when it is loaded, and the bundle is
refused if any file contains schema or role DDL (including `ALTER ROLE` /
`ALTER USER`), a statement-level `GRANT`/`REVOKE`, `DROP OWNED`,
`REASSIGN OWNED`, transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`,
`START TRANSACTION`, `SAVEPOINT`, ...: the migrator owns the transaction per
file), `SECURITY DEFINER`, `SET ROLE`, `SET SESSION AUTHORIZATION`, or any
`search_path` change other than the trigger-function guard
`LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$`.

`verify-db` is read-only. It takes no lock and runs no DDL. It checks every
bundled file name and checksum. It fails when the ledger is missing, when a
bundled file is pending, or when any of the refusals above applies.

## Deploy ordering

These commands provide the checks a deploy barrier needs. They are not the
barrier, and no chart changes ship with this work. The intended shape is:

- **Migration Job:** an ordinary Kubernetes Job (not a Helm hook) whose name
  includes a hash of its rendered template, so each new image or
  configuration gets a new Job. It runs `relaycast-engine migrate` with its
  own owner credential and its own ServiceAccount; the server never receives
  owner credentials. The Job completes only on exit `0`. Exits `64`
  (configuration), `65` (identity) and `1` (connection or migration failure,
  including a refused ledger) are failures and must stop the rollout. Do not
  retry `64` or `65`: they need an operator fix.
- **Server pods:** start only after the migration Job for the target image
  has completed with exit `0`, and only once the server's own
  `relaycast-engine verify-db` (runtime credentials) has exited `0` before
  the HTTP listener opens. Any non-zero exit (`64`, `65`, `1`) means the pod
  does not start and does not become ready.

Helm does not order a Job and a Deployment in the same release, so Helm alone
is not the barrier. The ordering has to come from rollout tooling that waits
for the Job to complete before rolling the Deployment, or from an init step
in the server pod that waits for the Job to complete; `verify-db` then gates
the listener. The server verifies identity and the ledger before it opens the listener
and exits `64`/`65`/`1` otherwise, so a separate pre-start `verify-db` is optional.

Behaviour when the compatibility floor rises while an older server is running:

- The older server is not notified and keeps serving with its existing
  connections until it restarts. Nothing in this layer stops it. Its queries
  run against a schema it may not understand.
- On restart, its `verify-db` exits `1` (`requires image generation >= N`), so
  the pod does not become ready.
- An older image's `migrate` against a newer database also exits `1`.

These are startup-time checks only. This document makes no claim that rolling
upgrades or rollbacks are safe.

## Schema notes

- All tables are in `public`; connections set `search_path=public`, and migrate/verify check the schema by OID, not by search_path.
- Every table has `rowid bigint GENERATED ALWAYS AS IDENTITY` with a unique
  index, standing in for SQLite's implicit rowid, which the engine reads.
- Timestamps stay epoch seconds (`bigint`). Unbounded integers are `bigint`
  read as JS numbers; values beyond `Number.MAX_SAFE_INTEGER` raise instead
  of rounding. Small bounded counters are `integer`.
- JSON columns are `jsonb`, except the three replay-snapshot columns, which
  are `json` so the stored bytes are returned verbatim.
- Column defaults, nullability and CHECK constraints follow the migrated
  SQLite database (the result of every SQLite migration, not `schema.ts`
  alone); `src/db/__tests__/schema.pg.test.ts` compares them table by table.
  The SQLite-only `workspaces.stripe_customer_id` / `stripe_subscription_id`
  columns are intentionally absent: `schema.ts` does not declare them.
- The `(workspace_id, length(id), id)` style indexes use `id COLLATE "C"` so
  their order is byte order, like SQLite's. Queries must order and compare by
  the same expression (`length("id"), "id" COLLATE "C"`) to use them.
- `task_state.deadline` is an ISO-8601 UTC string, so the deadline indexes
  are on `(("task_state" ->> 'deadline') COLLATE "C")`: byte order is
  chronological order for that format. Queries must use the same expression,
  for example `("task_state" ->> 'deadline') COLLATE "C" <= $1` with an
  ISO-8601 `$1`. (A `::bigint` expression index would fail every insert that
  carries a deadline.)
- The FTS mirror tables (`messages_fts`, `messages_mention_fts`,
  `directory_agents_fts`, `directory_skills_fts`) use a generated
  `tsvector` with the `simple` configuration. Triggers maintain them and
  message, directory and skill search query them; terms are ANDed and
  `"quoted phrases"` match adjacent words. Relevance is `-ts_rank` (lower is
  better, like bm25). Mention lookups use the workspace-scoped scan.

## Regenerating migrations (contributors)

```sh
cd packages/engine
npm run generate:pg-migrations -- --name <name>   # after editing schema.pg.ts
npm run check:pg-migrations                       # CI: no drift, no forbidden statements
```

The generator strips drizzle-kit's `CREATE SCHEMA` and fails if any file
contains a forbidden statement (the list under [Migrations](#migrations); the
migrator applies the same list again at load time).

`check:pg-migrations` changes nothing and fails when:

- drizzle-kit, run against a scratch copy of the committed migrations, would
  generate a new migration from `schema.pg.ts` (schema drift; the pending SQL
  is printed);
- a committed generated migration differs from the SQL drizzle-kit derives
  from the committed snapshots (a hand-edited generated file); hand-written
  `--custom` migrations, whose snapshots carry no change, are exempt;
- any committed file contains a forbidden statement.

CI runs it in the "Lint, Build & Test" job. Never edit an applied migration;
add a new one.

## Engine handle (runtime verification)

`openPostgresEngineDb` (`src/adapters/postgres/engineDb.ts`) builds the PostgreSQL engine handle. The server calls it at startup, before the listener opens. Before it returns a handle it:

1. refuses any config not loaded in runtime mode;
2. runs the runtime [identity checks](#identity-checks) (the same checks as
   `verify-db`);
3. verifies the migration ledger against the bundled migrations (the same
   check as `verify-db`).

It takes no lock, runs no DDL and never creates a schema or role. A failure
closes the pool and throws a typed error (`PostgresUnavailableError`,
`PostgresIdentityError` or `PostgresMigrationStateError`); there is no SQLite
fallback. Error messages name the failed checks and never include the
connection string or password.

The handle binds the engine tables to `schema.pg.ts`, whose tables are in the
default schema `public` (connections set `search_path=public`).
`withTransaction` runs on one pooled client from `BEGIN` to `COMMIT`/`ROLLBACK`.
int8 values are parsed to JavaScript numbers and throw beyond
`Number.MAX_SAFE_INTEGER`. That parser is installed on the process-global
`pg.types`, because drizzle-orm ignores per-pool type parsers.

Database errors are decoded by SQLSTATE and constraint name, never by message
text, except for the `agent_node_bindings` workspace trigger. That trigger
raises `23000` with only a message, so its two exact messages are matched.
Only constraints in schema `public` are decoded:

| SQLSTATE | Decoded as |
| --- | --- |
| `23502` on one of the six sentinel columns | the same constraint kind the SQLite message maps to |
| `23505` on a known unique constraint or index | table and columns (`databaseUniqueViolation`) |
| `23000` with an exact `agent_node_bindings` trigger message | `binding_agent_workspace_mismatch` / `binding_node_workspace_mismatch` |

The engine's own code does not use the unique and trigger decoders yet.

## Testing against a real database

```sh
cd packages/engine
RELAYCAST_PG_TEST_URL_OWNER=postgres://relaycast_owner:...@localhost:5432/app \
RELAYCAST_PG_TEST_URL_RUNTIME=postgres://relaycast_runtime:...@localhost:5432/app \
RELAYCAST_PG_TEST_CA_FILE=/path/to/ca.crt \
  npx vitest run src/adapters/postgres
```

Without those variables the integration tests skip. **They drop every object
the owner role owns in schema `public`**, so point them only at a
disposable database. See the header of
`src/adapters/postgres/__tests__/postgres.integration.test.ts` for the
refusal roles the fixture needs.

Two of those tests also create a temporary LOGIN role (`relaycast_setrole_<hex>`,
as `relaycast_admin`), log in as it over TLS, and grant it `SET ROLE` to
`relaycast_owner` or `relaycast_creator` without inheritance. They check that
the `SET ROLE` really works, that `not_member_of_owner` / `no_role_memberships`,
`openPostgresEngineDb` and `verify-db` (exit 65) refuse it, and, after `REVOKE`,
that `SET ROLE` fails with `42501` and those checks pass. The role is dropped
afterwards and the suite fails if any `relaycast_setrole_` role remains.

`src/bin/__tests__/serveStartup.test.ts` needs no database. It spawns the server
with `RELAYCAST_DATABASE_URL` (or `_URL_FILE`) set and checks that it exits 64
without creating the SQLite file or accepting on its port. The same command
without those variables serves `/health` (the control).

### Conformance suite in PostgreSQL mode

```sh
cd packages/engine
RELAYCAST_TEST_DATABASE_URL=postgres://relaycast_runtime:...@localhost:5432/app?sslmode=verify-full \
RELAYCAST_TEST_DATABASE_OWNER_URL=postgres://relaycast_owner:...@localhost:5432/app?sslmode=verify-full \
RELAYCAST_TEST_DATABASE_CA_FILE=/path/to/ca.crt \
  npm run test:conformance:pg
```

This runs `src/__tests__/conformance` through `vitest.conformance-pg.config.ts`.
All three variables are required; without them, or if the database is
unreachable or the handle fails verification, the run fails. It never falls
back to SQLite.

- **Once per run, as the owner:** hold the fixture advisory lock, drop the
  owner's objects in schema `public`, then migrate with the product
  migrator. At the end it drops them again and releases the lock.
- **Per test file:** open the runtime handle through `openPostgresEngineDb`,
  as the runtime role.
- **Before every test:** `TRUNCATE ... RESTART IDENTITY CASCADE` every engine
  table, as the owner.

Files run one at a time (`fileParallelism: false`) because they share the
schema. Tests that need the SQLite handle (`runtime.handle`) fail in this mode
with an explicit error. The pg-mode result is a baseline for the query-surface
work, not a gate. As with the integration tests, use only a disposable
database.

## Moving a deployment to durable-actors

A PostgreSQL deployment moves to the durable-actors runtime (one workspace
actor per workspace, behind `relaycast-actors-gateway`) with every row and
file, under the same workspace ids. The orchestration (snapshot, quiesce,
chart changes, verification) lives in the deployment tooling; these are the
pieces it runs:

1. **Credentials first.** The actor gateway routes only `ar_` credentials.
   Run this server with `RELAYCAST_CREDENTIAL_FORMAT=ar` and the keyring the
   actor gateway will use, and upgrade every legacy credential
   (`POST /v1/credentials/upgrade`; workspace keys through
   `POST /internal/workspaces/:id/api-key`). Their hashes are copied as is,
   so upgraded holders keep working after the move.
2. `relaycast-engine migration-preflight --ar-since <epoch s> [--file-dir <files dir>]
   [--export-dir <dir>] [--allow-legacy]`: read-only per-workspace counts,
   missing file objects, principals still on legacy credentials (agents,
   nodes, observer tokens and webhooks created before `--ar-since` and never
   upgraded, and a workspace key neither created nor rotated since), and with
   `--export-dir` its free space against twice the database's size. Exit 1
   when anything blocks; legacy principals block unless `--allow-legacy`
   (their holders then re-register after the move).
3. Stop every writer, then `relaycast-engine export-for-actors --out <dir>
   --run-id <id>` (needs `RELAYCAST_INTERNAL_SECRET` or `_FILE`): one
   `REPEATABLE READ` snapshot, per workspace a `manifest.json` (tables in plan
   order, columns, row count, digest) and one NDJSON file per table. Blocks
   are bounded by rows and bytes so each fits one import request. Rows carry
   credential hashes but also subscription signing secrets and headers, so
   every line is sealed (AES-256-GCM, key derived from the internal secret
   and the run id, the line's table and position bound in) and the export is
   owner-only (directories 0700, files 0600).
4. On the durable-actors deployment, with the same internal secret:
   `relaycast-migrate files --dir <dir> --from <files dir>` (copies completed
   files into the gateway's file store, verified by sha256), then
   `relaycast-migrate import --dir <dir> --gateway <url>`
   (`POST /internal/workspaces/:id/import`: the actor verifies every block it
   stores, then every table's count and digest; the workspace stays closed,
   503, while verified), `relaycast-migrate verify-realtime --gateway <url>`
   (a throwaway workspace streams a post over `/v1/ws`), and finally
   `relaycast-migrate open --dir <dir> --gateway <url>` (go-live). Reruns
   resume or skip finished workspaces; `relaycast-migrate abort` empties a
   workspace that is not open yet. `--gateway` must be https unless it is a
   cluster-local Service or loopback: the internal secret is sent to it.

The files dir is where the server kept uploads: `relaycast-files` under its
working directory (`/data/relaycast-files` in the container image).

Both sides must run the same engine schema: `begin` refuses an export whose
column lists differ from the actor's.

## Not yet supported

- More than one replica. Realtime, presence and rate limits are in-process.
- Retention pruning (`RELAYCAST_MESSAGE_TTL_DAYS`, workspace retention) is not exercised by the PostgreSQL test suite; leave it unset for now.
- The standalone (bun-compiled) binary does not embed `migrations-pg`.
- Chart wiring of the migration Job and its barrier. No rolling-upgrade or
  rollback safety is claimed.

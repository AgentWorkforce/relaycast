# Self-hosting the engine on PostgreSQL (connection layer)

Status: **connection, identity, TLS, schema and migrations only.** The engine
query surface still runs on SQLite; `relaycast-engine` (the server) does not
yet read `RELAYCAST_DATABASE_URL`. This layer lets a platform provision and
verify a PostgreSQL database ahead of the Postgres query backend.

## What the platform provides

The engine never creates schemas or roles and never grants on them. Before
the first `migrate`, the platform (DBA, operator, Terraform) must create:

```sql
-- Run as a privileged role, once per database.
CREATE ROLE relaycast_owner   LOGIN PASSWORD '...';   -- migration Job only
CREATE ROLE relaycast_runtime LOGIN PASSWORD '...';   -- the server and verify-db
CREATE SCHEMA relaycast AUTHORIZATION relaycast_owner;
GRANT USAGE ON SCHEMA relaycast TO relaycast_runtime;

-- Runtime gets DML on everything the owner creates there, nothing more.
ALTER DEFAULT PRIVILEGES FOR ROLE relaycast_owner IN SCHEMA relaycast
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relaycast_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE relaycast_owner IN SCHEMA relaycast
  GRANT SELECT, USAGE, UPDATE ON SEQUENCES TO relaycast_runtime;

-- Lock down the database and public.
REVOKE TEMP, CREATE ON DATABASE app FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Neither role may be SUPERUSER, CREATEROLE, CREATEDB, REPLICATION or
BYPASSRLS, or a member of a role that is. `relaycast_runtime` must not be a
member of `relaycast_owner`. Neither role may have USAGE or CREATE on other
application schemas in the same database.

The migration ledger is the one exception to the default privileges.
`migrate` revokes everything on `relaycast._engine_migrations` and grants
the runtime role SELECT only. Those are table-level grants on a table the
owner just created, not grants on schemas or roles.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `RELAYCAST_DATABASE_URL` / `RELAYCAST_DATABASE_URL_FILE` | yes | `postgres://user:password@host:port/database`. One TCP host. The password is required: there is no `PGPASSWORD` or `.pgpass` fallback. The only accepted query parameter is `sslmode=verify-full`. |
| `RELAYCAST_DATABASE_CA_FILE` | yes | PEM CA bundle that signs the server certificate. It must contain certificates only (no private key), with at least one `CA:TRUE`. |
| `RELAYCAST_DATABASE_SCHEMA` | no | Must be `relaycast` (the default). The bundled migrations target only that schema. |
| `RELAYCAST_DATABASE_OWNER_ROLE` | no | Default `relaycast_owner`. |
| `RELAYCAST_DATABASE_RUNTIME_ROLE` | no | Default `relaycast_runtime`. Must differ from the owner role. |
| `RELAYCAST_DATABASE_POOL_MAX` | no | 1-100. Default is the node-postgres default (10). |
| `RELAYCAST_DATABASE_STATEMENT_TIMEOUT_MS` | no | 0-86400000. Unset leaves the server default. |

TLS is always on and always verify-full. The chain is verified against
`RELAYCAST_DATABASE_CA_FILE` only, not the system store. The server name must
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
| 1 | Connection failure, migration failure, or (for `verify-db`) a database that is not migrated for this image. |

### Identity checks

Both modes check:

- `session_user` and `current_user` are the expected role
- `login`
- `not_superuser`, `not_createrole`, `not_createdb`, `not_replication`, `not_bypassrls`
- `no_privileged_memberships`
- `no_foreign_schema_access`
- `public_schema_locked`
- `schema_exists`, which is reported only when the schema is missing

Owner mode also checks `owns_schema` and `schema_create`.

Runtime mode also checks:

- `not_member_of_owner` (neither MEMBER nor USAGE)
- `not_schema_owner`
- `schema_usage`
- `no_schema_create`
- `owns_no_objects_in_schema`
- `no_database_temp`
- `no_database_create`
- `ledger_read_only`: SELECT but no write on the ledger; passes while the ledger does not exist yet

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
3. In its own transaction, it creates `relaycast._engine_migrations` if it is
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
report the newer rows as notes.

`verify-db` is read-only. It takes no lock and runs no DDL. It checks every
bundled file name and checksum. It fails when the ledger is missing, when a
bundled file is pending, or when any of the refusals above applies.

## Deploy ordering

These commands provide the checks a deploy barrier needs. They are not the
barrier. Helm does not order a Job and a Deployment in the same release by
itself, and no chart changes ship with this work. Whoever wires the chart must
provide the ordering:

- **Migration Job:** runs `relaycast-engine migrate` with owner credentials. It
  completes only on exit `0`. Exits `64` (configuration), `65` (identity) and
  `1` (connection or migration failure, including a refused ledger) are
  failures and must stop the rollout. Do not retry `64` or `65`: they need an
  operator fix.
- **Server pods:** must not start serving until that Job has completed for
  the target image, for example through a Helm `pre-install,pre-upgrade` hook
  Job, or an init container that waits for it. Each pod runs
  `relaycast-engine verify-db` with runtime credentials before it opens its
  HTTP listener, and starts the server only on exit `0`. Any non-zero exit
  (`64`, `65`, `1`) means do not start. The server cannot open the listener
  until verification passes.

Behaviour when the compatibility floor rises while an older server is running:

- The older server is not notified and keeps serving with its existing
  connections until it restarts. Nothing in this layer stops it. Its queries
  run against a schema it may not understand.
- On restart, its `verify-db` exits `1` (`requires image generation >= N`), so
  it does not start again.
- An older image's `migrate` against a newer database also exits `1`.

These are startup-time checks only. They do not make rolling upgrades or
rollbacks safe. A floor-raising migration needs the old pods stopped (or
drained) before it runs. Rolling back an image after its database has moved
past the old image's floor is refused, not handled.

## Schema notes

- Every table has `rowid bigint GENERATED ALWAYS AS IDENTITY` with a unique
  index, standing in for SQLite's implicit rowid, which the engine reads.
- Timestamps stay epoch seconds (`bigint`). Unbounded integers are `bigint`
  read as JS numbers; values beyond `Number.MAX_SAFE_INTEGER` raise instead
  of rounding. Small bounded counters are `integer`.
- JSON columns are `jsonb`, except the three replay-snapshot columns, which
  are `json` so the stored bytes are returned verbatim.
- The FTS mirror tables (`messages_fts`, `messages_mention_fts`,
  `directory_agents_fts`, `directory_skills_fts`) use a generated
  `tsvector` with the `simple` configuration. Their shape is provisional
  until the Postgres search implementation lands.

## Regenerating migrations (contributors)

```sh
cd packages/engine
npm run generate:pg-migrations -- --name <name>   # after editing schema.pg.ts
npm run generate:pg-migrations -- --check         # CI: schema.pg.ts matches the snapshots
```

The script strips drizzle-kit's `CREATE SCHEMA`. It fails if a generated file
contains schema/role DDL, a statement-level GRANT/REVOKE, `DROP OWNED` or
`REASSIGN OWNED`. Never edit an applied migration; add a new one.

## Testing against a real database

```sh
cd packages/engine
RELAYCAST_PG_TEST_URL_OWNER=postgres://relaycast_owner:...@localhost:5432/app \
RELAYCAST_PG_TEST_URL_RUNTIME=postgres://relaycast_runtime:...@localhost:5432/app \
RELAYCAST_PG_TEST_CA_FILE=/path/to/ca.crt \
  npx vitest run src/adapters/postgres
```

Without those variables the integration tests skip. **They drop every object
the owner role owns in schema `relaycast`**, so point them only at a
disposable database. See the header of
`src/adapters/postgres/__tests__/postgres.integration.test.ts` for the
refusal roles the fixture needs.

## Not yet supported

- The server itself on PostgreSQL. The query surface, dialect helpers and
  search are separate work.
- `migrate` / `verify-db` through the container image. `docker/entrypoint-core.mjs`
  launches the pinned engine without subcommand dispatch, so run them through
  the `relaycast-engine` bin.
- The standalone (bun-compiled) binary does not embed `migrations-pg`.
- The server's own pre-listener `verify-db` call. The server does not run on
  PostgreSQL yet. Until it does, run `verify-db` as a separate pre-start step,
  as described in [Deploy ordering](#deploy-ordering).
- Chart wiring of the Job barrier, and any rolling-upgrade or rollback
  guarantee.

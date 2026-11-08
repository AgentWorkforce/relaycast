import type { PostgresMode } from "./config.js";

/** Anything that can run a parameterised query (pg.Client, pg.PoolClient, pg.Pool). */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface IdentityCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface IdentityResult {
  ok: boolean;
  checks: IdentityCheck[];
}

export interface VerifyIdentityOptions {
  /** The role this session must be (never taken from the connection URL). */
  expectedRole: string;
  mode: PostgresMode;
  /** The engine schema (relaycast). */
  schema: string;
  /** Owner role name; runtime mode checks the session cannot reach it. Defaults to the schema owner. */
  ownerRole?: string;
  /** Ledger table name inside `schema`. */
  ledgerTable?: string;
}

const SYSTEM_SCHEMA_FILTER = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

/**
 * Verify the session's database identity and privileges. Every check runs
 * (no short-circuit) so the report names every problem. All inputs are bound
 * as parameters; only pg_catalog and privilege functions are queried.
 *
 * Common: session_user and current_user equal `expectedRole`; the role can
 * LOGIN and has none of SUPERUSER, CREATEROLE, CREATEDB, REPLICATION,
 * BYPASSRLS; it is not a member of any role that has one of those.
 *
 * Runtime: not a member of (and cannot SET ROLE to) the owner role; does not
 * own the schema or any relation/sequence/function in it; USAGE but no
 * CREATE on the schema; no TEMP or CREATE on the database; no USAGE/CREATE
 * on other non-system schemas (control, pipeline, ...), no CREATE on public
 * and no table privileges there; SELECT but not INSERT/UPDATE/DELETE/TRUNCATE
 * on the migration ledger.
 *
 * Owner: owns the schema and has CREATE on it; no USAGE/CREATE on other
 * non-system schemas; no CREATE on public and no table privileges there.
 *
 * `public` is treated separately because Postgres grants USAGE on it to
 * PUBLIC by default; holding that grant alone is harmless once CREATE is
 * revoked and nothing in it is readable.
 */
export async function verifyIdentity(
  client: Queryable,
  opts: VerifyIdentityOptions,
): Promise<IdentityResult> {
  const checks: IdentityCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });
  const { expectedRole, mode, schema } = opts;
  const ledgerTable = opts.ledgerTable ?? "_engine_migrations";

  const who = (
    await client.query<{ session_user: string; current_user: string }>(
      "SELECT session_user::text AS session_user, current_user::text AS current_user",
    )
  ).rows[0];
  add(
    "session_user",
    who.session_user === expectedRole,
    `session_user=${who.session_user}, expected ${expectedRole}`,
  );
  add(
    "current_user",
    who.current_user === expectedRole,
    `current_user=${who.current_user}, expected ${expectedRole}`,
  );

  const role = (
    await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
       FROM pg_catalog.pg_roles WHERE rolname = current_user`,
    )
  ).rows[0];
  add(
    "login",
    role.rolcanlogin,
    role.rolcanlogin ? "LOGIN" : "role lacks LOGIN",
  );
  for (const [name, flag, attr] of [
    ["not_superuser", role.rolsuper, "SUPERUSER"],
    ["not_createrole", role.rolcreaterole, "CREATEROLE"],
    ["not_createdb", role.rolcreatedb, "CREATEDB"],
    ["not_replication", role.rolreplication, "REPLICATION"],
    ["not_bypassrls", role.rolbypassrls, "BYPASSRLS"],
  ] as const) {
    add(name, !flag, flag ? `role has ${attr}` : `no ${attr}`);
  }

  const privilegedMemberships = (
    await client.query<{ rolname: string }>(
      `SELECT r.rolname::text AS rolname FROM pg_catalog.pg_roles r
       WHERE r.rolname <> current_user
         AND pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
         AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
       ORDER BY 1`,
    )
  ).rows.map((r) => r.rolname);
  add(
    "no_privileged_memberships",
    privilegedMemberships.length === 0,
    privilegedMemberships.length === 0
      ? "not a member of any privileged role"
      : `member of privileged role(s): ${privilegedMemberships.join(", ")}`,
  );

  const schemaRow = (
    await client.query<{ owner: string; usage: boolean; create: boolean }>(
      `SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,
              pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE') AS usage,
              pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') AS create
       FROM pg_catalog.pg_namespace n WHERE n.nspname = $1`,
      [schema],
    )
  ).rows[0];
  if (!schemaRow) {
    add(
      "schema_exists",
      false,
      `schema ${schema} does not exist (the platform must create it)`,
    );
  }

  // Other non-system schemas: no USAGE or CREATE (public handled below).
  const foreign = (
    await client.query<{ nspname: string; usage: boolean; create: boolean }>(
      `SELECT n.nspname::text AS nspname,
              pg_catalog.has_schema_privilege(current_user, n.oid, 'USAGE') AS usage,
              pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') AS create
       FROM pg_catalog.pg_namespace n
       WHERE ${SYSTEM_SCHEMA_FILTER} AND n.nspname <> $1 AND n.nspname <> 'public'
       ORDER BY 1`,
      [schema],
    )
  ).rows.filter((r) => r.usage || r.create);
  add(
    "no_foreign_schema_access",
    foreign.length === 0,
    foreign.length === 0
      ? "no USAGE/CREATE on other schemas"
      : `has ${foreign.map((r) => `${[r.usage && "USAGE", r.create && "CREATE"].filter(Boolean).join("+")} on ${r.nspname}`).join(", ")}`,
  );

  const pub = (
    await client.query<{ create: boolean; readable: string[] }>(
      `SELECT pg_catalog.has_schema_privilege(current_user, n.oid, 'CREATE') AS create,
              ARRAY(
                SELECT c.relname::text FROM pg_catalog.pg_class c
                WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
                  AND pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
                ORDER BY 1
              ) AS readable
       FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'`,
    )
  ).rows[0];
  if (pub) {
    const problems = [
      ...(pub.create ? ["CREATE on public"] : []),
      ...pub.readable.map((t) => `privileges on public.${t}`),
    ];
    add(
      "public_schema_locked",
      problems.length === 0,
      problems.length === 0
        ? "no CREATE or table privileges in public"
        : problems.join(", "),
    );
  } else {
    add("public_schema_locked", true, "no public schema");
  }

  if (mode === "owner") {
    if (schemaRow) {
      add(
        "owns_schema",
        schemaRow.owner === who.current_user,
        `schema ${schema} owner is ${schemaRow.owner}`,
      );
      add(
        "schema_create",
        schemaRow.create,
        schemaRow.create ? `CREATE on ${schema}` : `no CREATE on ${schema}`,
      );
    }
  } else {
    const ownerRole = opts.ownerRole ?? schemaRow?.owner;
    if (ownerRole) {
      const owner = (
        await client.query<{ member: boolean | null; usage: boolean | null }>(
          `SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') AS member,
                  pg_catalog.pg_has_role(current_user, r.oid, 'USAGE') AS usage
           FROM pg_catalog.pg_roles r WHERE r.rolname = $1`,
          [ownerRole],
        )
      ).rows[0];
      if (!owner) {
        add(
          "not_member_of_owner",
          false,
          `owner role ${ownerRole} does not exist`,
        );
      } else {
        const reach = owner.member || owner.usage;
        add(
          "not_member_of_owner",
          !reach,
          reach
            ? `can ${owner.usage ? "use privileges of" : "SET ROLE to"} ${ownerRole}`
            : `not a member of ${ownerRole}`,
        );
      }
    }

    if (schemaRow) {
      add(
        "not_schema_owner",
        schemaRow.owner !== who.current_user,
        `schema ${schema} owner is ${schemaRow.owner}`,
      );
      add(
        "schema_usage",
        schemaRow.usage,
        schemaRow.usage ? `USAGE on ${schema}` : `no USAGE on ${schema}`,
      );
      add(
        "no_schema_create",
        !schemaRow.create,
        schemaRow.create ? `has CREATE on ${schema}` : `no CREATE on ${schema}`,
      );
    }

    const owned = (
      await client.query<{ kind: string; name: string }>(
        `SELECT 'relation' AS kind, c.relname::text AS name FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         UNION ALL
         SELECT 'function', p.proname::text FROM pg_catalog.pg_proc p
         JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         UNION ALL
         SELECT 'type', t.typname::text FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typrelid = 0
           AND t.typowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
         ORDER BY 1, 2 LIMIT 20`,
        [schema],
      )
    ).rows;
    add(
      "owns_no_objects_in_schema",
      owned.length === 0,
      owned.length === 0
        ? `owns nothing in ${schema}`
        : `owns ${owned.map((o) => `${o.kind} ${o.name}`).join(", ")}`,
    );

    const db = (
      await client.query<{ temp: boolean; create: boolean }>(
        `SELECT pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP') AS temp,
                pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE') AS create`,
      )
    ).rows[0];
    add(
      "no_database_temp",
      !db.temp,
      db.temp ? "has TEMP on the database" : "no TEMP on the database",
    );
    add(
      "no_database_create",
      !db.create,
      db.create ? "has CREATE on the database" : "no CREATE on the database",
    );

    const ledger = (
      await client.query<{
        present: boolean;
        sel: boolean | null;
        write: boolean | null;
      }>(
        `SELECT c.oid IS NOT NULL AS present,
                CASE WHEN c.oid IS NULL THEN NULL ELSE pg_catalog.has_table_privilege(current_user, c.oid, 'SELECT') END AS sel,
                CASE WHEN c.oid IS NULL THEN NULL
                     ELSE pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') END AS write
         FROM (SELECT 1) one
         LEFT JOIN (
           -- Catalog lookup, not to_regclass(): that needs USAGE on the schema
           -- and would throw for exactly the roles this check must report on.
           SELECT c.oid FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2
         ) c ON true`,
        [schema, ledgerTable],
      )
    ).rows[0];
    if (!ledger.present) {
      add(
        "ledger_read_only",
        true,
        `${schema}.${ledgerTable} absent (no migrations applied yet)`,
      );
    } else {
      const problems = [
        ...(ledger.sel ? [] : ["cannot SELECT"]),
        ...(ledger.write ? ["can write"] : []),
      ];
      add(
        "ledger_read_only",
        problems.length === 0,
        problems.length === 0
          ? `SELECT only on ${schema}.${ledgerTable}`
          : `${schema}.${ledgerTable}: ${problems.join(", ")}`,
      );
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

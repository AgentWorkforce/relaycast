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
  /** True when the check passed or was skipped; only `ok: false` fails verification. */
  ok: boolean;
  detail: string;
  /** Set when the check does not apply yet; `detail` says why. Never set on a failure. */
  skipped?: true;
}

export interface IdentityResult {
  ok: boolean;
  checks: IdentityCheck[];
}

export interface VerifyIdentityOptions {
  /** The role this session must be (never taken from the connection URL). */
  expectedRole: string;
  mode: PostgresMode;
  /** The engine schema. */
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
 * Every role the session can reach, other than itself: roles it inherits
 * privileges from, roles it can SET ROLE to, and NOINHERIT memberships it can
 * only use through SET ROLE. pg_has_role(..., 'MEMBER') covers direct and
 * indirect membership regardless of INHERIT/SET options; the recursive walk
 * over pg_auth_members additionally lists every granted role so no path is
 * missed. PUBLIC is not a row in pg_roles, so it never appears.
 */
const REACHABLE_ROLES_SQL = `WITH RECURSIVE me AS (
         SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
       ), granted(oid) AS (
         SELECT m.roleid FROM pg_catalog.pg_auth_members m WHERE m.member = (SELECT oid FROM me)
         UNION
         SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN granted g ON m.member = g.oid
       )
       SELECT r.rolname::text AS rolname,
              (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS privileged
       FROM pg_catalog.pg_roles r
       WHERE r.oid <> (SELECT oid FROM me)
         AND (pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') OR r.oid IN (SELECT oid FROM granted))
       ORDER BY 1`;

/**
 * The privileges each listed role holds in its own right (has_*_privilege
 * with that role as subject), so a session that can SET ROLE - or inherits
 * from - a role is judged by what that role can do too.
 */
const ROLE_PRIVILEGES_SQL = `SELECT s.rolname AS subject,
              COALESCE((SELECT pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
                        FROM pg_catalog.pg_namespace n WHERE n.nspname = $1), false) AS schema_create,
              COALESCE((SELECT n.nspowner = r.oid
                        FROM pg_catalog.pg_namespace n WHERE n.nspname = $1), false) AS schema_owner,
              ARRAY(
                SELECT c.relname::text FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relowner = r.oid
                UNION ALL
                SELECT p.proname::text FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = $1 AND p.proowner = r.oid
                ORDER BY 1 LIMIT 5
              ) AS owned,
              pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'TEMP') AS temp,
              pg_catalog.has_database_privilege(r.oid, pg_catalog.current_database(), 'CREATE') AS db_create,
              ARRAY(
                SELECT n.nspname::text FROM pg_catalog.pg_namespace n
                WHERE ${SYSTEM_SCHEMA_FILTER} AND n.nspname <> $1 AND n.nspname <> 'public'
                  AND (pg_catalog.has_schema_privilege(r.oid, n.oid, 'USAGE')
                       OR pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE'))
                ORDER BY 1
              ) AS foreign_schemas,
              COALESCE((SELECT pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
                        FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'), false) AS public_create
       FROM unnest($2::text[]) WITH ORDINALITY AS s(rolname, ord)
       JOIN pg_catalog.pg_roles r ON r.rolname = s.rolname
       ORDER BY s.ord`;

interface RolePrivileges {
  subject: string;
  schema_create: boolean;
  schema_owner: boolean;
  owned: string[];
  temp: boolean;
  db_create: boolean;
  foreign_schemas: string[];
  public_create: boolean;
}

/**
 * Verify the session's database identity and privileges. Every check runs
 * (no short-circuit) so the report names every problem. All inputs are bound
 * as parameters; only pg_catalog and privilege functions are queried.
 *
 * Reachable roles: every role the session can reach - inherited, SET ROLE
 * targets and NOINHERIT memberships alike (see REACHABLE_ROLES_SQL). Both
 * modes refuse any such membership (`no_role_memberships`, naming the roles
 * only), and every privilege check below is also evaluated with each
 * reachable role as the subject, so a failure "via role X" is reported under
 * the same check name as the session's own.
 *
 * Common: session_user and current_user equal `expectedRole`; the role can
 * LOGIN and has none of SUPERUSER, CREATEROLE, CREATEDB, REPLICATION,
 * BYPASSRLS; no reachable role has one of those; no role memberships; no
 * USAGE/CREATE on other non-system schemas (control, pipeline, ...), no
 * CREATE on public and no table privileges there; no CREATE on the database.
 *
 * Runtime: not a member of (and cannot SET ROLE to) the owner role; does not
 * own the schema or any relation/sequence/function in it; USAGE but no
 * CREATE on the schema; no TEMP on the database; SELECT but not
 * INSERT/UPDATE/DELETE/TRUNCATE on the migration ledger (skipped, not
 * passed, while the ledger does not exist yet).
 *
 * Owner: owns the schema and has CREATE on it; TEMP on the database only by
 * its own grant (the platform grants it to the owner), never through another
 * role.
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

  const reachable = (
    await client.query<{ rolname: string; privileged: boolean }>(
      REACHABLE_ROLES_SQL,
    )
  ).rows;
  const privilegedMemberships = reachable
    .filter((r) => r.privileged)
    .map((r) => r.rolname);
  add(
    "no_privileged_memberships",
    privilegedMemberships.length === 0,
    privilegedMemberships.length === 0
      ? "cannot reach any privileged role"
      : `can reach privileged role(s): ${privilegedMemberships.join(", ")}`,
  );
  add(
    "no_role_memberships",
    reachable.length === 0,
    reachable.length === 0
      ? "member of no other role"
      : `can reach role(s) by membership or SET ROLE: ${reachable.map((r) => r.rolname).join(", ")}`,
  );

  // The same privilege checks with each reachable role as the subject.
  const viaRoles: RolePrivileges[] =
    reachable.length === 0
      ? []
      : (
          await client.query<RolePrivileges & Record<string, unknown>>(
            ROLE_PRIVILEGES_SQL,
            [schema, reachable.map((r) => r.rolname)],
          )
        ).rows;
  const via = (pick: (r: RolePrivileges) => string | false): string[] =>
    viaRoles.flatMap((r) => {
      const what = pick(r);
      return what ? [`${what} via role ${r.subject}`] : [];
    });
  /** Add a check that fails on the session's own problems or any reachable role's. */
  const addAll = (
    name: string,
    own: string[],
    viaProblems: string[],
    okDetail: string,
  ) => {
    const problems = [...own, ...viaProblems];
    add(
      name,
      problems.length === 0,
      problems.length === 0 ? okDetail : problems.join(", "),
    );
  };

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
  addAll(
    "no_foreign_schema_access",
    foreign.map(
      (r) =>
        `has ${[r.usage && "USAGE", r.create && "CREATE"].filter(Boolean).join("+")} on ${r.nspname}`,
    ),
    via(
      (r) =>
        r.foreign_schemas.length > 0 &&
        `USAGE/CREATE on ${r.foreign_schemas.join(", ")}`,
    ),
    "no USAGE/CREATE on other schemas",
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
  if (schema === "public") {
    // `public` is the engine schema here: the schema_create, no_schema_create
    // and ledger checks below judge it, and DML in it is the whole point.
    add("public_schema_locked", true, "not applicable: public is the engine schema");
  } else if (pub) {
    addAll(
      "public_schema_locked",
      [
        ...(pub.create ? ["CREATE on public"] : []),
        ...pub.readable.map((t) => `privileges on public.${t}`),
      ],
      via((r) => r.public_create && "CREATE on public"),
      "no CREATE or table privileges in public",
    );
  } else {
    add("public_schema_locked", true, "no public schema");
  }

  const db = (
    await client.query<{ temp: boolean; create: boolean }>(
      `SELECT pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP') AS temp,
              pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE') AS create`,
    )
  ).rows[0];
  addAll(
    "no_database_create",
    db.create ? ["has CREATE on the database"] : [],
    via((r) => r.db_create && "CREATE on the database"),
    "no CREATE on the database",
  );
  const tempViaRoles = via((r) => r.temp && "TEMP on the database");

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
    // The platform grants the owner TEMP directly; it must not come (or be
    // usable) through any other role.
    addAll(
      "database_temp",
      [],
      tempViaRoles,
      db.temp
        ? "TEMP on the database by the owner's own grant only"
        : "no TEMP on the database",
    );
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
      addAll(
        "not_schema_owner",
        schemaRow.owner === who.current_user
          ? [`schema ${schema} owner is ${schemaRow.owner}`]
          : [],
        via((r) => r.schema_owner && `owns schema ${schema}`),
        `schema ${schema} owner is ${schemaRow.owner}`,
      );
      add(
        "schema_usage",
        schemaRow.usage,
        schemaRow.usage ? `USAGE on ${schema}` : `no USAGE on ${schema}`,
      );
      addAll(
        "no_schema_create",
        schemaRow.create ? [`has CREATE on ${schema}`] : [],
        via((r) => r.schema_create && `CREATE on ${schema}`),
        `no CREATE on ${schema}`,
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
    addAll(
      "owns_no_objects_in_schema",
      owned.map((o) => `owns ${o.kind} ${o.name}`),
      via(
        (r) => r.owned.length > 0 && `owns ${r.owned.join(", ")} in ${schema}`,
      ),
      `owns nothing in ${schema}`,
    );

    addAll(
      "no_database_temp",
      db.temp ? ["has TEMP on the database"] : [],
      tempViaRoles,
      "no TEMP on the database",
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
      checks.push({
        name: "ledger_read_only",
        ok: true,
        skipped: true,
        detail: `not applicable: ${schema}.${ledgerTable} absent (no migrations applied yet)`,
      });
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

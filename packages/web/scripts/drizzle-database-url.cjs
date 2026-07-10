function toDirectEndpoint(connectionString) {
  try {
    const url = new URL(connectionString);
    url.hostname = url.hostname.replace("-pooler.", ".");
    return url.toString();
  } catch {
    return connectionString;
  }
}

function loadDatabaseUrl(env = process.env) {
  const direct = env.DATABASE_URL;
  if (direct && direct.length > 0) {
    return direct;
  }

  // Long-lived stages: migrations run as the schema-OWNING role (neondb_owner),
  // distinct from the DML-only runtime app role the deployed Lambda/Worker use
  // via the NeonDatabaseUrl SST secret. The app role cannot run DDL, so the
  // migrate / verify-schema tooling resolves this owner URL ahead of the
  // (app-role) SST resource. Required on every long-lived stage — there is no
  // NEON_DATABASE_URL fallback there. See .claude/rules/neon-credential-split.md.
  const migrations = env.NEON_MIGRATIONS_DATABASE_URL;
  if (migrations && migrations.length > 0) {
    return migrations;
  }

  // Ephemeral preview branches / CI: a single owner role per branch, seeded
  // into this env var (preview.yml + seed-sst-secrets.sh). Not set on
  // long-lived stages.
  const neon = env.NEON_DATABASE_URL;
  if (neon && neon.length > 0) {
    return neon;
  }

  const raw = env.SST_RESOURCE_NeonDatabaseUrl;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.value === "string" && parsed.value.length > 0) {
        return parsed.value;
      }
    } catch {
      // Not JSON; treat the raw env value as the connection string.
      if (raw.length > 0) {
        return raw;
      }
    }
  }

  const { PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE } = env;
  if (PGHOST && PGDATABASE) {
    const user = PGUSER || "postgres";
    const auth = PGPASSWORD
      ? `${encodeURIComponent(user)}:${encodeURIComponent(PGPASSWORD)}`
      : encodeURIComponent(user);
    const port = PGPORT || "5432";
    return `postgres://${auth}@${PGHOST}:${port}/${PGDATABASE}`;
  }

  return "";
}

function resolveDrizzleDatabaseUrl(env = process.env) {
  const connectionString = loadDatabaseUrl(env);
  return connectionString ? toDirectEndpoint(connectionString) : "";
}

module.exports = {
  loadDatabaseUrl,
  resolveDrizzleDatabaseUrl,
  toDirectEndpoint,
};

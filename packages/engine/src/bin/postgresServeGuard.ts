/** Prefix of every PostgreSQL variable the postgres adapter reads (see src/adapters/postgres/config.ts). */
export const POSTGRES_ENV_PREFIX = 'RELAYCAST_DATABASE_';

/**
 * True when `env` selects the PostgreSQL backend: any non-blank
 * `RELAYCAST_DATABASE_*` (including `_URL_FILE`). `RELAYCAST_DB_PATH` is the
 * SQLite file and does not count. A server with any of these set serves from
 * PostgreSQL or refuses; it never silently falls back to SQLite.
 */
export function postgresServeRequested(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((name) => name.startsWith(POSTGRES_ENV_PREFIX) && (env[name] ?? '').trim() !== '');
}

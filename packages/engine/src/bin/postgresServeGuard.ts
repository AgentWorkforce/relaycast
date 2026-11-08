/**
 * The PostgreSQL configuration this build defines is for the `migrate` and
 * `verify-db` subcommands only: the HTTP server still runs on SQLite. A
 * server started with any of it would silently serve from SQLite while the
 * operator believes it uses PostgreSQL, so the serve path refuses instead.
 */

/** Prefix of every PostgreSQL variable the postgres adapter reads (see src/adapters/postgres/config.ts). */
export const POSTGRES_ENV_PREFIX = 'RELAYCAST_DATABASE_';

/**
 * The refusal message when `env` sets any PostgreSQL variable (a non-blank
 * `RELAYCAST_DATABASE_*`, including `_URL_FILE`), else `undefined`. Names the
 * variables only, never their values (a URL may carry a password).
 * `RELAYCAST_DB_PATH` is the SQLite file and is not affected.
 */
export function postgresServeRefusal(env: NodeJS.ProcessEnv): string | undefined {
  const set = Object.keys(env)
    .filter((name) => name.startsWith(POSTGRES_ENV_PREFIX) && (env[name] ?? '').trim() !== '')
    .sort();
  if (set.length === 0) return undefined;
  return (
    `the PostgreSQL serving path is not available in this build (${set.join(', ')} set). ` +
    'Only the `relaycast-engine migrate` and `relaycast-engine verify-db` subcommands use PostgreSQL; ' +
    'unset these variables to serve from SQLite (--db / RELAYCAST_DB_PATH).'
  );
}

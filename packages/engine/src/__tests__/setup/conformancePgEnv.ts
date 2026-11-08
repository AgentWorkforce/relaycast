/**
 * Environment for the PostgreSQL conformance mode (test code only). All three
 * are required; there is no SQLite fallback. Values are never logged.
 *
 *   RELAYCAST_TEST_DATABASE_URL        runtime-role URL (the handle under test)
 *   RELAYCAST_TEST_DATABASE_OWNER_URL  owner-role URL (migrate once, TRUNCATE between tests)
 *   RELAYCAST_TEST_DATABASE_CA_FILE    CA bundle for verify-full TLS
 *
 * The schema is always `relaycast`.
 */
import { loadPostgresConfig, type PostgresConfig, type PostgresMode } from '../../adapters/postgres/config.js';

export const CONFORMANCE_PG_SCHEMA = 'relaycast';

const REQUIRED = ['RELAYCAST_TEST_DATABASE_URL', 'RELAYCAST_TEST_DATABASE_OWNER_URL', 'RELAYCAST_TEST_DATABASE_CA_FILE'] as const;

export function conformancePgConfig(mode: Extract<PostgresMode, 'runtime' | 'owner'>): PostgresConfig {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`PostgreSQL conformance mode requires ${missing.join(', ')} (no SQLite fallback)`);
  }
  const url = mode === 'runtime' ? process.env.RELAYCAST_TEST_DATABASE_URL : process.env.RELAYCAST_TEST_DATABASE_OWNER_URL;
  return loadPostgresConfig(
    {
      RELAYCAST_DATABASE_URL: url,
      RELAYCAST_DATABASE_CA_FILE: process.env.RELAYCAST_TEST_DATABASE_CA_FILE,
      RELAYCAST_DATABASE_SCHEMA: CONFORMANCE_PG_SCHEMA,
    },
    mode,
  );
}

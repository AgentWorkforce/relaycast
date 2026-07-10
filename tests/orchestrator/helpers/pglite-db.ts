/**
 * PGlite test helper — spins up an in-memory Postgres with the
 * session_events table for isolated testing.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as _schema from '../../../packages/web/lib/db/schema.js';

// Handle CJS/ESM interop: tsx may wrap the module as { default: { ... } }
const schema = (_schema as any).default ?? _schema;

const SESSION_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS session_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  step_name TEXT,
  sandbox_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_session_events_run ON session_events (run_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events (event_type);
`;

const WORKFLOW_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  user_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  relay_workspace_id TEXT,
  workflow TEXT NOT NULL,
  file_type TEXT NOT NULL,
  callback_token TEXT NOT NULL,
  status TEXT NOT NULL,
  relayauth_identity_id TEXT,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function createTestDb() {
  const pg = new PGlite();
  await pg.exec(SESSION_EVENTS_DDL);
  await pg.exec(WORKFLOW_RUNS_DDL);
  const db = drizzle(pg, { schema });
  return { db, pg, schema, cleanup: () => pg.close() };
}

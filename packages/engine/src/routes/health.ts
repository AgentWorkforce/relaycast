import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppEnv } from '../env.js';
import * as sqlx from '../db/sqlx.js';

export const healthRoutes = new Hono<AppEnv>();

/** How long a readiness/liveness database probe may take. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;
/**
 * How long the database may stay unreachable before liveness fails, so the
 * orchestrator restarts a process whose in-process recovery (the pool
 * re-dialing after a failover) did not work. Readiness fails at once.
 */
export const LIVENESS_DB_GRACE_MS = 90_000;

let lastProbeOkAt = Date.now();

/** Resolve true when `SELECT 1` answers within the probe timeout. */
async function probeDatabase(db: object): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ok = await Promise.race([
      sqlx.all(db, sql`SELECT 1 AS ok`).then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), HEALTH_PROBE_TIMEOUT_MS); }),
    ]);
    if (ok) lastProbeOkAt = Date.now();
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

healthRoutes.get('/', (c) => {
  return c.json({
    ok: true,
    version: c.get('engine').config.appSemver ?? c.get('engine').config.appVersion ?? '0.1.0',
    build: c.get('engine').config.appVersion ?? 'unknown',
  });
});

/** Readiness: 200 only while the database answers. */
healthRoutes.get('/ready', async (c) => {
  const ok = await probeDatabase(c.get('db'));
  return c.json({ ok, database: ok ? 'ok' : 'unreachable' }, ok ? 200 : 503);
});

/**
 * Liveness: 503 once the database has not answered a probe for
 * LIVENESS_DB_GRACE_MS. A brief outage (a failover the pool recovers from)
 * only fails readiness.
 */
healthRoutes.get('/live', async (c) => {
  const ok = await probeDatabase(c.get('db'));
  const downForMs = ok ? 0 : Date.now() - lastProbeOkAt;
  const live = downForMs < LIVENESS_DB_GRACE_MS;
  return c.json({ ok: live, database: ok ? 'ok' : 'unreachable', database_down_ms: downForMs }, live ? 200 : 503);
});

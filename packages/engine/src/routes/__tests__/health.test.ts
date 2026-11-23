import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env.js';
import { healthRoutes, HEALTH_PROBE_TIMEOUT_MS, LIVENESS_DB_GRACE_MS } from '../health.js';

/** A database stub for sqlx.all: answers, rejects, or never answers. */
let mode: 'ok' | 'fail' | 'hang' = 'ok';
vi.mock('../../db/sqlx.js', () => ({
  all: () => mode === 'ok' ? Promise.resolve([{ ok: 1 }])
    : mode === 'fail' ? Promise.reject(new Error('Connection terminated unexpectedly'))
    : new Promise(() => {}),
}));

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', {} as never);
    c.set('engine', { config: {} } as never);
    await next();
  });
  a.route('/health', healthRoutes);
  return a;
}

describe('health probes', () => {
  afterEach(() => { mode = 'ok'; vi.useRealTimers(); });

  it('readiness follows the database; liveness fails only after the grace period', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const a = app();
    expect((await a.request('/health/ready')).status).toBe(200);
    expect((await a.request('/health/live')).status).toBe(200);

    mode = 'fail';
    expect((await a.request('/health/ready')).status).toBe(503);
    expect((await a.request('/health/live')).status).toBe(200);

    // A hung probe counts as down, bounded by the probe timeout.
    mode = 'hang';
    const pending = a.request('/health/ready');
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
    expect((await pending).status).toBe(503);

    mode = 'fail';
    vi.setSystemTime(Date.now() + LIVENESS_DB_GRACE_MS);
    const dead = await a.request('/health/live');
    expect(dead.status).toBe(503);
    expect(((await dead.json()) as { database_down_ms: number }).database_down_ms).toBeGreaterThanOrEqual(LIVENESS_DB_GRACE_MS);

    // Recovery clears both at once.
    mode = 'ok';
    expect((await a.request('/health/live')).status).toBe(200);
    expect((await a.request('/health/ready')).status).toBe(200);
  });
});

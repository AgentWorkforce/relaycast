import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const touchLastSeen = vi.fn(async () => {});
const state = { lastSeen: new Date() };

vi.mock('../../engine/agent.js', () => ({ touchLastSeen }));
vi.mock('../../auth/workspaceExpiry.js', () => ({
  authenticateUnexpired: async () => ({
    ok: true,
    agent: { id: 'agent_1', lastSeen: state.lastSeen },
  }),
}));
vi.mock('../../lib/credentialNotice.js', () => ({ noteAuthenticatedCredential: () => {} }));

const { LAST_SEEN_TOUCH_INTERVAL_MS, requireAgentToken } = await import('../auth.js');

function makeApp() {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('db', {});
    c.set('engine', { auth: {} });
    await next();
  });
  app.use('*', requireAgentToken);
  app.get('/ping', (c) => c.text('ok'));
  return app;
}

describe('last_seen touch debounce', () => {
  const T0 = new Date('2026-01-01T00:00:00Z').getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    touchLastSeen.mockClear();
    state.lastSeen = new Date(T0);
  });
  afterEach(() => vi.useRealTimers());

  const call = (app: Hono<any>) =>
    app.request('/ping', { headers: { Authorization: 'Bearer tok' } });

  it('is 120 seconds', () => {
    expect(LAST_SEEN_TOUCH_INTERVAL_MS).toBe(120_000);
  });

  it('does not write within the interval, writes after it', async () => {
    const app = makeApp();

    vi.setSystemTime(T0 + LAST_SEEN_TOUCH_INTERVAL_MS - 1_000);
    expect((await call(app)).status).toBe(200);
    expect(touchLastSeen).not.toHaveBeenCalled();

    vi.setSystemTime(T0 + LAST_SEEN_TOUCH_INTERVAL_MS + 1_000);
    expect((await call(app)).status).toBe(200);
    expect(touchLastSeen).toHaveBeenCalledTimes(1);
    expect(touchLastSeen).toHaveBeenCalledWith({}, 'agent_1');
  });
});

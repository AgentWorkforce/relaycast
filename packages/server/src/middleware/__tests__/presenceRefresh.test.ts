import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { presenceRefresh } from '../presenceRefresh.js';

function createMockPresenceDO() {
  const mockStub = {
    fetch: vi.fn().mockResolvedValue(new Response('ok')),
  };
  return {
    idFromName: vi.fn().mockReturnValue('do-id-123'),
    get: vi.fn().mockReturnValue(mockStub),
    _stub: mockStub,
  };
}

function makeApp(options: { agent?: any; workspace?: any } = {}) {
  const presenceDO = createMockPresenceDO();
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    (c.env as any) = { PRESENCE_DO: presenceDO };
    if (options.workspace) c.set('workspace', options.workspace);
    if (options.agent) c.set('agent', options.agent);
    await next();
  });
  app.use('*', presenceRefresh);
  app.get('/test', (c) => c.json({ ok: true }));

  return { app, presenceDO };
}

describe('presenceRefresh middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends heartbeat to PresenceDO for agent requests', async () => {
    const agent = { id: 'agent_1', workspaceId: 'ws_1', name: 'TestBot' };
    const workspace = { id: 'ws_1' };
    const { app, presenceDO } = makeApp({ agent, workspace });

    const res = await app.request('/test');
    expect(res.status).toBe(200);

    expect(presenceDO.idFromName).toHaveBeenCalledWith('ws_1');
    expect(presenceDO.get).toHaveBeenCalledWith('do-id-123');
    expect(presenceDO._stub.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
      }),
    );

    const req = presenceDO._stub.fetch.mock.calls[0][0] as Request;
    await expect(req.clone().json()).resolves.toEqual({
      agentId: 'agent_1',
      workspaceId: 'ws_1',
      agentName: 'TestBot',
    });
  });

  it('skips presence for non-agent requests (workspace key auth)', async () => {
    const workspace = { id: 'ws_1' };
    const { app, presenceDO } = makeApp({ workspace });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(presenceDO.idFromName).not.toHaveBeenCalled();
  });

  it('calls next even if presence refresh fails', async () => {
    const agent = { id: 'agent_1', workspaceId: 'ws_1', name: 'TestBot' };
    const workspace = { id: 'ws_1' };

    const presenceDO = createMockPresenceDO();
    presenceDO.idFromName.mockImplementation(() => {
      throw new Error('DO error');
    });

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      (c.env as any) = { PRESENCE_DO: presenceDO };
      c.set('workspace', workspace as any);
      c.set('agent', agent as any);
      await next();
    });
    app.use('*', presenceRefresh);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('skips when neither agent nor workspace is set', async () => {
    const { app, presenceDO } = makeApp({});

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(presenceDO.idFromName).not.toHaveBeenCalled();
  });
});

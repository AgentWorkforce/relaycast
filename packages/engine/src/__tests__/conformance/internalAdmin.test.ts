import { afterEach, describe, expect, it } from 'vitest';
import { makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * Internal admin API (`/internal/*`) for a trusted control plane.
 *
 * Disabled (generic 404) unless `config.internalSecret` is set; authenticated
 * by `Authorization: Bearer <secret>`. The capability and key-push shapes are
 * the hosted gateway's, so a control plane's existing client works unchanged:
 * generation-fenced upsert/rotation with an optional grace window.
 */
const SECRET = 'internal-test-secret-0123456789abcdef';

describe('internal admin API', () => {
  let stack: TestStack;
  afterEach(() => stack?.close());

  function internal(path: string, init: { method?: string; body?: unknown; secret?: string | null } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.secret !== null) headers.authorization = `Bearer ${init.secret ?? SECRET}`;
    return stack.app.request(`/internal${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  }

  async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
    return ((await res.json()) as { data: T }).data;
  }

  function readWorkspace(key: string) {
    return stack.app.request('/v1/workspace', { headers: { authorization: `Bearer ${key}` } });
  }

  async function createViaAdmin(name = 'team') {
    const res = await internal('/workspaces', { method: 'POST', body: { name } });
    expect(res.status).toBe(201);
    return data<{ workspace_id: string; api_key: string; name: string; api_key_generation: number }>(res);
  }

  describe('when no internal secret is configured', () => {
    it('answers every internal route with the generic 404', async () => {
      stack = makeNodeStack();
      for (const [path, method] of [
        ['/capabilities', 'GET'],
        ['/workspaces', 'POST'],
        ['/workspaces/ws1/api-key', 'POST'],
      ] as const) {
        const res = await internal(path, { method, body: method === 'POST' ? {} : undefined });
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
      }
    });
  });

  describe('when enabled', () => {
    it('rejects a missing or wrong bearer with 401', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      expect((await internal('/capabilities', { secret: null })).status).toBe(401);
      expect((await internal('/capabilities', { secret: `${SECRET}x` })).status).toBe(401);
      expect((await internal('/capabilities', { secret: SECRET.slice(0, -1) })).status).toBe(401);
      // A workspace key is not an internal credential.
      const ws = await createViaAdmin();
      expect((await internal('/capabilities', { secret: ws.api_key })).status).toBe(401);
    });

    it('advertises the hosted key-push capabilities', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const res = await internal('/capabilities');
      expect(res.status).toBe(200);
      expect(await data(res)).toEqual({
        workspace_key_push: {
          generation_cas: true,
          generation_required_once_fenced: true,
          grace_ms: true,
          max_grace_ms: 3_600_000,
          revocation_markers: true,
          previous_key_slot: true,
        },
        workspace_admin: { create: true, server_minted_key: true },
      });
    });

    it('creates a workspace whose key registers agents and carries messages', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin('pilot');
      expect(ws).toMatchObject({ name: 'pilot', api_key_generation: 0 });
      expect(ws.api_key).toMatch(/^rk_live_[0-9a-f]{32}$/);

      const alice = await registerAgent(stack.app, ws.api_key, 'alice');
      const bob = await registerAgent(stack.app, ws.api_key, 'bob');
      const post = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'hello from alice' }),
      });
      expect(post.status).toBe(201);
      const read = await stack.app.request('/v1/channels/general/messages', {
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(read.status).toBe(200);
      expect(JSON.stringify(await read.json())).toContain('hello from alice');
    });

    it('rejects an invalid create body', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const res = await internal('/workspaces', { method: 'POST', body: { name: '' } });
      expect(res.status).toBe(400);
    });

    it('server-minted rotation kills the old key and fences the workspace', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin();
      const res = await internal(`/workspaces/${ws.workspace_id}/api-key`, { method: 'POST' });
      expect(res.status).toBe(200);
      const rotated = await data<{ workspace_id: string; api_key: string; api_key_generation: number }>(res);
      expect(rotated.workspace_id).toBe(ws.workspace_id);
      expect(rotated.api_key_generation).toBe(1);
      expect(rotated.api_key).toMatch(/^rk_live_/);
      expect(rotated.api_key).not.toBe(ws.api_key);

      expect((await readWorkspace(ws.api_key)).status).toBe(401);
      expect((await readWorkspace(rotated.api_key)).status).toBe(200);

      // Fenced now: a generationless hash change is refused.
      const legacy = await internal(`/workspaces/${ws.workspace_id}/api-key`, {
        method: 'POST', body: { api_key: 'rk_live_legacywriter' },
      });
      expect(legacy.status).toBe(409);
      expect(await legacy.json()).toMatchObject({ error: { code: 'key_generation_required' } });
    });

    it('server-minted rotation honours a grace window', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin();
      const res = await internal(`/workspaces/${ws.workspace_id}/api-key`, { method: 'POST', body: { grace_ms: 60_000 } });
      const rotated = await data<{ api_key: string }>(res);
      expect((await readWorkspace(ws.api_key)).status).toBe(200);
      expect((await readWorkspace(rotated.api_key)).status).toBe(200);
    });

    it('server-minted rotation of an unknown workspace is 404', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const res = await internal('/workspaces/nope/api-key', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('upserts a missing workspace from a pushed key (hosted shape)', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const key = `rk_${'live'}_cloudminted0000000000000001`;
      const res = await internal('/workspaces/cloud-ws-1/api-key', {
        method: 'POST', body: { api_key: key, key_generation: 1, plan: 'pro' },
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ ok: true, data: { workspace_id: 'cloud-ws-1', api_key_generation: 1 } });
      const me = await readWorkspace(key);
      expect(me.status).toBe(200);
      expect(JSON.stringify(await me.json())).toContain('cloud-ws-1');
      // The upserted workspace has its #general channel like any other.
      const alice = await registerAgent(stack.app, key, 'alice');
      const post = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(post.status).toBe(201);
    });

    it('re-pushing the live key is idempotent and can bump the generation', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const key = `rk_${'live'}_cloudminted0000000000000002`;
      const path = '/workspaces/cloud-ws-2/api-key';
      expect((await internal(path, { method: 'POST', body: { api_key: key, key_generation: 2 } })).status).toBe(201);
      const again = await internal(path, { method: 'POST', body: { api_key: key, key_generation: 2 } });
      expect(again.status).toBe(200);
      expect(await data(again)).toEqual({ workspace_id: 'cloud-ws-2', api_key_generation: 2 });
      const lower = await internal(path, { method: 'POST', body: { api_key: key, key_generation: 1 } });
      expect(await data(lower)).toEqual({ workspace_id: 'cloud-ws-2', api_key_generation: 2 });
      const bumped = await internal(path, { method: 'POST', body: { api_key: key, key_generation: 5 } });
      expect(await data(bumped)).toEqual({ workspace_id: 'cloud-ws-2', api_key_generation: 5 });
    });

    it('generation-fenced rotation: grace 0 revokes, stale pushes are refused', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const path = '/workspaces/cloud-ws-3/api-key';
      const k1 = `rk_${'live'}_cloudminted0000000000000031`;
      const k2 = `rk_${'live'}_cloudminted0000000000000032`;
      await internal(path, { method: 'POST', body: { api_key: k1, key_generation: 1 } });

      const rotate = await internal(path, { method: 'POST', body: { api_key: k2, key_generation: 2, grace_ms: 0 } });
      expect(rotate.status).toBe(200);
      expect(await data(rotate)).toEqual({ workspace_id: 'cloud-ws-3', api_key_generation: 2 });
      expect((await readWorkspace(k1)).status).toBe(401);
      expect((await readWorkspace(k2)).status).toBe(200);

      // A stale repair carrying the old key cannot resurrect it.
      const stale = await internal(path, { method: 'POST', body: { api_key: k1, key_generation: 1 } });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ ok: false, error: { code: 'stale_key_generation' } });
      expect((await readWorkspace(k1)).status).toBe(401);
    });

    it('keeps the superseded key alive for grace_ms', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const path = '/workspaces/cloud-ws-4/api-key';
      const k1 = `rk_${'live'}_cloudminted0000000000000041`;
      const k2 = `rk_${'live'}_cloudminted0000000000000042`;
      await internal(path, { method: 'POST', body: { api_key: k1, key_generation: 1 } });
      await internal(path, { method: 'POST', body: { api_key: k2, key_generation: 2, grace_ms: 60_000 } });
      expect((await readWorkspace(k1)).status).toBe(200);
      expect((await readWorkspace(k2)).status).toBe(200);
    });

    it('accepts generationless pushes only while unfenced', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const path = '/workspaces/cloud-ws-5/api-key';
      const k1 = `rk_${'live'}_cloudminted0000000000000051`;
      const k2 = `rk_${'live'}_cloudminted0000000000000052`;
      expect((await internal(path, { method: 'POST', body: { api_key: k1 } })).status).toBe(201);
      const swap = await internal(path, { method: 'POST', body: { api_key: k2 } });
      expect(await data(swap)).toEqual({ workspace_id: 'cloud-ws-5', api_key_generation: 0 });
      expect((await readWorkspace(k1)).status).toBe(401);
      expect((await readWorkspace(k2)).status).toBe(200);
    });

    it('validates the push body like the hosted gateway', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const path = '/workspaces/cloud-ws-6/api-key';
      const cases: unknown[] = [
        { api_key: 'not-a-workspace-key' },
        { api_key: 'rk_live_x', key_generation: 0 },
        { api_key: 'rk_live_x', key_generation: 1.5 },
        { api_key: 'rk_live_x', key_generation: 1, grace_ms: 3_600_001 },
        { api_key: 'rk_live_x', grace_ms: 10 },
      ];
      for (const body of cases) {
        const res = await internal(path, { method: 'POST', body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect((await internal('/workspaces/bad%20id/api-key', { method: 'POST', body: { api_key: 'rk_live_x' } })).status).toBe(400);
    });

    it('refuses binding a key that already belongs to another workspace', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin();
      const res = await internal('/workspaces/other-ws/api-key', { method: 'POST', body: { api_key: ws.api_key } });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'api_key_conflict' } });
    });
  });
});

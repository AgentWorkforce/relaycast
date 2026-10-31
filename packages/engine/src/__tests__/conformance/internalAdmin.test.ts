import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../entrypoints/node.js';
import { beginInternalWorkspaceDeletion, pushWorkspaceKey } from '../../engine/internalAdmin.js';
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
        ['/workspaces/ws1', 'DELETE'],
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
        workspace_admin: { create: true, delete: true, server_minted_key: true },
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

    it('deletes by id idempotently and revokes workspace and agent credentials', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin('delete-me');
      const alice = await registerAgent(stack.app, ws.api_key, 'alice');

      expect((await internal(`/workspaces/${ws.workspace_id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await internal(`/workspaces/${ws.workspace_id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await readWorkspace(ws.api_key)).status).toBe(401);
      expect((await stack.app.request('/v1/inbox', {
        headers: { authorization: `Bearer ${alice.token}` },
      })).status).toBe(401);
    });

    it('validates delete ids and fences a concurrent key push', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      expect((await internal('/workspaces/bad%20id', { method: 'DELETE' })).status).toBe(400);
      const ws = await createViaAdmin('delete-race');
      const nextKey = `rk_${'live'}_delete_race_000000000000000000000`;
      const deletion = internal(`/workspaces/${ws.workspace_id}`, { method: 'DELETE' });
      const push = internal(`/workspaces/${ws.workspace_id}/api-key`, {
        method: 'POST',
        body: { api_key: nextKey, key_generation: 1 },
      });
      const [deleted, pushed] = await Promise.all([deletion, push]);
      expect(deleted.status).toBe(204);
      expect([200, 410]).toContain(pushed.status);
      // If the push won the write race, deletion followed it and removed the
      // workspace. If deletion claimed first, the push was fenced with 410.
      expect((await readWorkspace(nextKey)).status).toBe(401);
      expect((await internal(`/workspaces/${ws.workspace_id}`, { method: 'DELETE' })).status).toBe(204);
    });

    it('keeps a successful deletion fenced when an overlapping delete fails', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin('delete-overlap');
      const first = beginInternalWorkspaceDeletion(stack.runtime.deps.db, ws.workspace_id);
      const retry = beginInternalWorkspaceDeletion(stack.runtime.deps.db, ws.workspace_id);
      first.commit();
      retry.release();

      const push = await internal(`/workspaces/${ws.workspace_id}/api-key`, {
        method: 'POST',
        body: { api_key: `rk_${'live'}_must_stay_fenced_0000000000000000`, key_generation: 1 },
      });
      expect(push.status).toBe(410);
      expect(await push.json()).toMatchObject({ error: { code: 'workspace_deleted' } });
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
        method: 'POST', body: { api_key: `rk_${'live'}_legacywriter00000000000000000000` },
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

    it('server-minted rotation that loses a race re-derives its generation and retries', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const ws = await createViaAdmin();
      const realDb = stack.runtime.deps.db as Parameters<typeof pushWorkspaceKey>[0];
      let raced = false;
      // Simulate a concurrent rotation that commits between this call's read
      // and its CAS write: the first UPDATE sees a changed hash at generation 1.
      const racingDb = new Proxy(realDb, {
        get(target, prop, receiver) {
          if (prop === 'update' && !raced) {
            raced = true;
            stack.runtime.handle.sqlite
              .prepare('UPDATE workspaces SET api_key_hash = ?, api_key_generation = 1 WHERE id = ?')
              .run('concurrent-winner-hash', ws.workspace_id);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const result = await pushWorkspaceKey(racingDb, ws.workspace_id, {});
      expect(raced).toBe(true);
      expect(result.apiKeyGeneration).toBe(2);
      expect(result.mintedApiKey).toMatch(/^rk_live_/);
      expect((await readWorkspace(result.mintedApiKey!)).status).toBe(200);
    });

    it('server-minted rotation refuses to derive a generation past MAX_SAFE_INTEGER', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const path = '/workspaces/cloud-ws-max/api-key';
      const key = `rk_${'live'}_cloudminted_b64url-00000000000000ff`;
      expect((await internal(path, { method: 'POST', body: { api_key: key, key_generation: Number.MAX_SAFE_INTEGER } })).status).toBe(201);
      const res = await internal(path, { method: 'POST', body: {} });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: 'key_generation_exhausted' } });
      // Nothing was written: the pushed key still authenticates.
      expect((await readWorkspace(key)).status).toBe(200);
    });

    it("server-minted rotation follows the deployment's self-routing credential format", async () => {
      stack = makeNodeStack({ internalSecret: SECRET, credentialFormat: 'self_routing' });
      const ws = await createViaAdmin();
      const res = await internal(`/workspaces/${ws.workspace_id}/api-key`, { method: 'POST', body: {} });
      expect(res.status).toBe(200);
      const rotated = await data<{ api_key: string }>(res);
      expect(rotated.api_key.startsWith(`relaycast_ws_${ws.workspace_id}_`)).toBe(true);
      expect((await readWorkspace(rotated.api_key)).status).toBe(200);
      expect((await readWorkspace(ws.api_key)).status).toBe(401);
    });

    it('server-minted rotation of an unknown workspace is 404', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const res = await internal('/workspaces/nope/api-key', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('upserts a missing workspace from a pushed key (hosted shape)', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const key = `rk_${'live'}_cloudminted_b64url-0000000000000001`;
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
      const key = `rk_${'live'}_cloudminted_b64url-0000000000000002`;
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
      const k1 = `rk_${'live'}_cloudminted_b64url-0000000000000031`;
      const k2 = `rk_${'live'}_cloudminted_b64url-0000000000000032`;
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
      const k1 = `rk_${'live'}_cloudminted_b64url-0000000000000041`;
      const k2 = `rk_${'live'}_cloudminted_b64url-0000000000000042`;
      await internal(path, { method: 'POST', body: { api_key: k1, key_generation: 1 } });
      await internal(path, { method: 'POST', body: { api_key: k2, key_generation: 2, grace_ms: 60_000 } });
      expect((await readWorkspace(k1)).status).toBe(200);
      expect((await readWorkspace(k2)).status).toBe(200);
    });

    it('accepts generationless pushes only while unfenced', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const path = '/workspaces/cloud-ws-5/api-key';
      const k1 = `rk_${'live'}_cloudminted_b64url-0000000000000051`;
      const k2 = `rk_${'live'}_cloudminted_b64url-0000000000000052`;
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
      cases.push(
        // rk_live_ + fewer than 32 characters, or characters outside [A-Za-z0-9_-].
        { api_key: `rk_live_${'a'.repeat(31)}` },
        { api_key: `rk_live_${'a'.repeat(32)}!` },
        { api_key: `rk_live_${'a'.repeat(257)}` },
        { api_key: `rk_live_${'a'.repeat(16)} ${'a'.repeat(16)}` },
        { api_key: `rk_live_${'a'.repeat(32)}`, key_generation: Number.MAX_SAFE_INTEGER + 1 },
        // Surrounding whitespace is refused, not trimmed: the stored hash must
        // match the exact bearer callers present.
        { api_key: ` rk_live_${'a'.repeat(32)}` },
        { api_key: `rk_live_${'a'.repeat(32)}\n` },
      );
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

    it("refuses binding a key that is live in another workspace's grace slot", async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const k1 = `rk_${'live'}_cloudminted_b64url-0000000000000071`;
      const k2 = `rk_${'live'}_cloudminted_b64url-0000000000000072`;
      const kb = `rk_${'live'}_cloudminted_b64url-0000000000000073`;
      const pathA = '/workspaces/cloud-ws-a/api-key';
      const pathB = '/workspaces/cloud-ws-b/api-key';
      expect((await internal(pathA, { method: 'POST', body: { api_key: k1, key_generation: 1 } })).status).toBe(201);
      expect((await internal(pathA, { method: 'POST', body: { api_key: k2, key_generation: 2, grace_ms: 60_000 } })).status).toBe(200);
      expect((await internal(pathB, { method: 'POST', body: { api_key: kb, key_generation: 1 } })).status).toBe(201);

      // Upsert of a new workspace with A's grace-period key.
      const upsert = await internal('/workspaces/cloud-ws-c/api-key', { method: 'POST', body: { api_key: k1, key_generation: 1 } });
      expect(upsert.status).toBe(409);
      expect(await upsert.json()).toMatchObject({ error: { code: 'api_key_conflict' } });
      // Fenced rotation of an existing workspace onto A's grace-period key.
      const rotate = await internal(pathB, { method: 'POST', body: { api_key: k1, key_generation: 2 } });
      expect(rotate.status).toBe(409);
      expect(await rotate.json()).toMatchObject({ error: { code: 'api_key_conflict' } });

      // A's callers on the old key still reach A; B is untouched.
      const meA = await readWorkspace(k1);
      expect(meA.status).toBe(200);
      expect(JSON.stringify(await meA.json())).toContain('cloud-ws-a');
      expect((await readWorkspace(kb)).status).toBe(200);
    });

    it("refuses a generationless swap onto another workspace's grace-period key", async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const k1 = `rk_${'live'}_cloudminted_b64url-0000000000000081`;
      const k2 = `rk_${'live'}_cloudminted_b64url-0000000000000082`;
      const kb = `rk_${'live'}_cloudminted_b64url-0000000000000083`;
      await internal('/workspaces/cloud-ws-d/api-key', { method: 'POST', body: { api_key: k1, key_generation: 1 } });
      await internal('/workspaces/cloud-ws-d/api-key', { method: 'POST', body: { api_key: k2, key_generation: 2, grace_ms: 60_000 } });
      // Unfenced workspace E (generation 0) accepts generationless pushes.
      expect((await internal('/workspaces/cloud-ws-e/api-key', { method: 'POST', body: { api_key: kb } })).status).toBe(201);
      const swap = await internal('/workspaces/cloud-ws-e/api-key', { method: 'POST', body: { api_key: k1 } });
      expect(swap.status).toBe(409);
      expect(await swap.json()).toMatchObject({ error: { code: 'api_key_conflict' } });
      expect((await readWorkspace(kb)).status).toBe(200);
    });
  });
  describe('key formats', () => {
    it('accepts engine-minted hex keys and cloud-minted base64url keys', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      // The cloud control plane mints rk_live_ + base64url(32 random bytes).
      const cloudKey = `rk_live_${Buffer.alloc(32, 0xfb).toString('base64url')}`;
      expect(cloudKey).toMatch(/[-_]/);
      const pushed = await internal('/workspaces/cloud-b64/api-key', {
        method: 'POST', body: { api_key: cloudKey, key_generation: Number.MAX_SAFE_INTEGER },
      });
      expect(pushed.status).toBe(201);
      expect((await readWorkspace(cloudKey)).status).toBe(200);
    });
  });

  describe('public workspace create', () => {
    it('is on by default and answers the generic 404 when publicWorkspaceCreate is false', async () => {
      const create = () => stack.app.request('/v1/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'public-team' }),
      });
      stack = makeNodeStack({ internalSecret: SECRET });
      expect((await create()).status).toBe(201);
      stack.close();

      stack = makeNodeStack({ internalSecret: SECRET, publicWorkspaceCreate: false });
      const res = await create();
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
      // The control plane path still provisions workspaces.
      const ws = await createViaAdmin('managed');
      expect((await readWorkspace(ws.api_key)).status).toBe(200);
    });
  });

  describe('secret handling', () => {
    it('refuses an internal secret shorter than 32 characters at engine creation', () => {
      expect(() => makeNodeStack({ internalSecret: 'x'.repeat(31) })).toThrow(/at least 32 characters/);
    });

    it('refuses an internal secret with surrounding whitespace at engine creation', () => {
      // The route trims the presented bearer, so a padded secret could never match.
      expect(() => makeNodeStack({ internalSecret: ` ${SECRET}` })).toThrow(/leading or trailing whitespace/);
      expect(() => makeNodeStack({ internalSecret: `${SECRET}\n` })).toThrow(/leading or trailing whitespace/);
    });

    it('startServer refuses a short internal secret before opening the database', () => {
      const dir = mkdtempSync(join(tmpdir(), 'relaycast-weak-secret-'));
      try {
        const dbPath = join(dir, 'relaycast.db');
        expect(() => startServer({
          dbPath, port: 0, migrate: true, config: { internalSecret: 'x'.repeat(31) },
        })).toThrow(/at least 32 characters/);
        // Nothing was opened: no SQLite file, so no handle or workers to leak.
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('never fingerprints the internal bearer in request logs', async () => {
      stack = makeNodeStack({ internalSecret: SECRET });
      const lines: unknown[][] = [];
      const capture = (...args: unknown[]) => { lines.push(args); };
      const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(capture));
      try {
        // 401 with a wrong secret is logged as a client error.
        expect((await internal('/capabilities', { secret: `${SECRET}-wrong` })).status).toBe(401);
        // A public route with a bearer still gets a fingerprint (unchanged behaviour).
        await stack.app.request('/v1/workspace', { headers: { authorization: 'Bearer rk_live_unknownkey' } });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const serialized = lines.map((args) => JSON.stringify(args));
      const internalLines = serialized.filter((line) => line.includes('/internal/capabilities'));
      expect(internalLines.length).toBeGreaterThan(0);
      for (const line of internalLines) {
        expect(line).not.toContain('actor_fingerprint');
        expect(line).not.toContain(SECRET);
      }
      expect(serialized.some((line) => line.includes('/v1/workspace') && line.includes('actor_fingerprint'))).toBe(true);
    });
  });
});

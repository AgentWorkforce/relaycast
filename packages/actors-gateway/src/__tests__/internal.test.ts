import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';
import { INTERNAL_CAPABILITIES } from '../internal.js';
import { jsonResponse, type FakeWorkspace } from './fakeControlPlane.js';
import { INTERNAL_SECRET, WORKSPACE_ID, baseEnv, foreignCredential, readJson, startHarness, type Harness } from './harness.js';

const adminWorkspace = (id: string): FakeWorkspace => ({
  create: (request, tag) => jsonResponse(201, { ok: true, data: { workspace_id: id, api_key: `key-for-${id}`, tag, body: JSON.parse(request.body ?? 'null') } }),
  handle: (request) => jsonResponse(200, {
    ok: true,
    data: { workspace_id: id, method: request.method, url: request.url, authorization: Object.fromEntries(request.headers).authorization, body: request.body },
  }),
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('internal admin API', () => {
  it('answers the generic 404 for every /internal route when no secret is configured', async () => {
    harness = await startHarness({ workspace: adminWorkspace });
    for (const [method, path] of [['GET', '/internal/capabilities'], ['POST', '/internal/workspaces'], ['DELETE', `/internal/workspaces/${WORKSPACE_ID}`]]) {
      const response = await fetch(`${harness.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
      expect(response.status).toBe(404);
      expect(await readJson(response)).toEqual({ ok: false, error: { code: 'not_found', message: 'Route not found' } });
    }
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it('refuses a short internal secret at startup with exit code 64 semantics', () => {
    expect(() => loadConfig(baseEnv('http://127.0.0.1:1', { RELAYCAST_INTERNAL_SECRET: 'too-short' }))).toThrow(ConfigError);
    try {
      loadConfig(baseEnv('http://127.0.0.1:1', { RELAYCAST_INTERNAL_SECRET: 'too-short' }));
    } catch (error) {
      expect((error as ConfigError).code).toBe('weak_internal_secret');
      expect((error as ConfigError).message).not.toContain('too-short');
    }
  });

  it('requires the bearer secret, compared exactly', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    for (const authorization of [undefined, 'Bearer nope', `Bearer ${INTERNAL_SECRET}x`]) {
      const response = await fetch(`${harness.baseUrl}/internal/capabilities`, { headers: authorization ? { authorization } : {} });
      expect(response.status).toBe(401);
      expect((await readJson(response)).error).toMatchObject({ code: 'unauthorized' });
    }
  });

  it('advertises capabilities in the engine\'s shape', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const response = await fetch(`${harness.baseUrl}/internal/capabilities`, { headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, data: INTERNAL_CAPABILITIES });
    expect(INTERNAL_CAPABILITIES.workspace_admin).toEqual({ create: true, delete: true, server_minted_key: true });
  });

  it('creates a workspace: the gateway mints the id and tag, the actor answers 201', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const response = await fetch(`${harness.baseUrl}/internal/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  acme  ', metadata: { plan: 'team' } }),
    });
    expect(response.status).toBe(201);
    const data = (await readJson(response)).data as { workspace_id: string; api_key: string; tag: string; body: unknown };
    expect(data.workspace_id).toMatch(/^[0-9]+$/);
    expect(data.api_key).toBe(`key-for-${data.workspace_id}`);
    expect(data.tag).toBe(await harness.signer.tag(data.workspace_id));
    expect(data.body).toEqual({ name: 'acme', metadata: { plan: 'team' } });
    const [invocation] = harness.controlPlane.invocations;
    expect(invocation.method).toBe('create');
    const synthesized = invocation.args[0] as { method: string; url: string; headers: [string, string][] };
    expect(synthesized.method).toBe('POST');
    expect(synthesized.url).toBe(`${harness.baseUrl}/v1/workspaces`);
    expect(Object.fromEntries(synthesized.headers)['content-type']).toBe('application/json');
  });

  it('validates the create body', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const headers = { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json' };
    const malformed = await fetch(`${harness.baseUrl}/internal/workspaces`, { method: 'POST', headers, body: '{' });
    expect(malformed.status).toBe(400);
    expect((await readJson(malformed)).error).toMatchObject({ code: 'invalid_json' });
    for (const body of [{}, { name: '' }, { name: 'x', extra: 1 }]) {
      const response = await fetch(`${harness.baseUrl}/internal/workspaces`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toMatchObject({ code: 'invalid_request' });
    }
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it('forwards delete and key push to the named workspace actor with the Authorization header', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const deleted = await fetch(`${harness.baseUrl}/internal/workspaces/${WORKSPACE_ID}`, { method: 'DELETE', headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
    expect(deleted.status).toBe(200);
    expect((await readJson(deleted)).data).toMatchObject({ workspace_id: WORKSPACE_ID, method: 'DELETE', authorization: `Bearer ${INTERNAL_SECRET}`, body: null });

    const pushed = await fetch(`${harness.baseUrl}/internal/workspaces/${WORKSPACE_ID}/api-key`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ key_generation: 2 }),
    });
    expect(pushed.status).toBe(200);
    expect((await readJson(pushed)).data).toMatchObject({ url: `${harness.baseUrl}/internal/workspaces/${WORKSPACE_ID}/api-key`, body: '{"key_generation":2}' });
    expect(harness.controlPlane.invocations.map((call) => [call.method, call.actorId])).toEqual([['handle', WORKSPACE_ID], ['handle', WORKSPACE_ID]]);
  });

  it('answers 400 for a workspace id segment whose percent-encoding is malformed', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const response = await fetch(`${harness.baseUrl}/internal/workspaces/%ZZ`, { method: 'DELETE', headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
    expect(response.status).toBe(400);
    expect((await readJson(response)).error).toMatchObject({ code: 'invalid_request' });
    expect(harness.controlPlane.invocations).toHaveLength(0);
    expect(harness.logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it("refuses a pushed ar_ws_ key whose routing tag this deployment's keyring did not sign", async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const push = (api_key: string) => fetch(`${harness!.baseUrl}/internal/workspaces/${WORKSPACE_ID}/api-key`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ api_key }),
    });
    const foreign = await push(await foreignCredential(WORKSPACE_ID, 'workspace'));
    expect(foreign.status).toBe(400);
    expect((await readJson(foreign)).error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('routing tag') });
    expect(harness.controlPlane.invocations).toHaveLength(0);
    // A key this keyring tagged goes through to the actor.
    const own = await push(await harness.credential(WORKSPACE_ID, 'workspace'));
    expect(own.status).toBe(200);
    expect(harness.controlPlane.invocations.map((call) => [call.method, call.actorId])).toEqual([['handle', WORKSPACE_ID]]);
  });

  it('refuses workspace ids that are not snowflakes without spawning an actor', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    for (const id of ['ws_abc', 'not%20ok', '99999999999999999999999']) {
      const response = await fetch(`${harness.baseUrl}/internal/workspaces/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toMatchObject({ code: 'invalid_request' });
    }
    const unknown = await fetch(`${harness.baseUrl}/internal/other`, { headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
    expect(unknown.status).toBe(404);
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });
});

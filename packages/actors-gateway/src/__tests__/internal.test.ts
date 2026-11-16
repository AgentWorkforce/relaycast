import { afterEach, describe, expect, it } from 'vitest';
import { deriveInternalWorkspaceCreateKey, deriveKeyedWorkspaceId } from '@relaycast/engine/gateway';
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

  it('refuses an invalid Idempotency-Key before deriving an id or calling an actor', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET, RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'bootstrap-secret-0123456789abcdef' } });
    for (const key of [' ', 'x'.repeat(256)]) {
      const response = await fetch(`${harness.baseUrl}/internal/workspaces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ name: 'team' }),
      });
      expect(response.status).toBe(400);
      expect((await readJson(response)).error).toMatchObject({ code: 'invalid_idempotency_key' });
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
    // Without a bootstrap secret a keyed create is 503, so create_idempotency is not advertised.
    expect(await readJson(response)).toEqual({ ok: true, data: INTERNAL_CAPABILITIES });
    expect(INTERNAL_CAPABILITIES.workspace_admin).toEqual({ create: true, delete: true, server_minted_key: true, expiry: true, create_idempotency: false });
  });

  it('advertises create_idempotency exactly when a workspace bootstrap secret is configured', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET, RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'bootstrap-secret-0123456789abcdef' } });
    const response = await fetch(`${harness.baseUrl}/internal/capabilities`, { headers: { authorization: `Bearer ${INTERNAL_SECRET}` } });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      ok: true,
      data: { ...INTERNAL_CAPABILITIES, workspace_admin: { ...INTERNAL_CAPABILITIES.workspace_admin, create_idempotency: true } },
    });
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

  it('routes a keyed internal create to the actor derived from its internal-scoped Idempotency-Key and forwards that key', async () => {
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET, RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'bootstrap-secret-0123456789abcdef' } });
    const create = () => fetch(`${harness!.baseUrl}/internal/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json', 'idempotency-key': 'cccccccccccccccccccccccccccccccc' },
      body: JSON.stringify({ name: 'team' }),
    });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    const [a, b] = harness.controlPlane.invocations;
    expect(a.actorId).toBe(b.actorId);
    // The actor records the create under the internal-scoped key (an HMAC of the caller's key under the bootstrap secret),
    // never the caller's raw key, so a public anonymous create presenting the same value reaches another actor and binding.
    const scoped = await deriveInternalWorkspaceCreateKey('bootstrap-secret-0123456789abcdef', 'cccccccccccccccccccccccccccccccc');
    expect(scoped).toMatch(/^[0-9a-f]{64}$/);
    expect(a.actorId).toBe(await deriveKeyedWorkspaceId('bootstrap-secret-0123456789abcdef', scoped));
    expect(a.actorId).not.toBe(await deriveKeyedWorkspaceId('bootstrap-secret-0123456789abcdef', 'cccccccccccccccccccccccccccccccc'));
    const forwarded = (a.args[0] as { headers: [string, string][] }).headers.filter(([name]) => name === 'idempotency-key');
    expect(forwarded).toEqual([['idempotency-key', scoped]]);
    // The public create with the same key value lands on the anonymous derivation of the raw value.
    const publicCreate = await fetch(`${harness.baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'cccccccccccccccccccccccccccccccc' },
      body: JSON.stringify({ name: 'team' }),
    });
    expect(publicCreate.status).toBe(201);
    const publicCall = harness.controlPlane.invocations[2];
    expect(publicCall.actorId).toBe(await deriveKeyedWorkspaceId('bootstrap-secret-0123456789abcdef', 'cccccccccccccccccccccccccccccccc'));
    expect(publicCall.actorId).not.toBe(a.actorId);
    // No length floor on the internal caller's key: the internal secret is the authorization.
    const short = await fetch(`${harness.baseUrl}/internal/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json', 'idempotency-key': 'job-1' },
      body: JSON.stringify({ name: 'team' }),
    });
    expect(short.status).toBe(201);
    expect(harness.controlPlane.invocations[3].actorId).toBe(
      await deriveKeyedWorkspaceId('bootstrap-secret-0123456789abcdef', await deriveInternalWorkspaceCreateKey('bootstrap-secret-0123456789abcdef', 'job-1')),
    );
    const withoutSecret = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    try {
      const refused = await fetch(`${withoutSecret.baseUrl}/internal/workspaces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json', 'idempotency-key': 'cccccccccccccccccccccccccccccccc' },
        body: JSON.stringify({ name: 'team' }),
      });
      expect(refused.status).toBe(503);
      expect((await readJson(refused)).error).toMatchObject({ code: 'workspace_create_idempotency_unavailable' });
      expect(withoutSecret.controlPlane.invocations).toHaveLength(0);
    } finally {
      await withoutSecret.close();
    }
  });

  it('proves the bootstrap secret itself for a keyed internal create when the deployment requires proof', async () => {
    const secret = 'bootstrap-secret-0123456789abcdef';
    harness = await startHarness({ workspace: adminWorkspace, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET, RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: secret, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' } });
    const create = (headers: Record<string, string>) => fetch(`${harness!.baseUrl}/internal/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ name: 'team' }),
    });
    // The internal secret is the authentication, as on the engine's own internal create: no proof is asked of the caller,
    // and the synthesized create carries the gateway's proof so the actor's engine accepts it.
    const keyed = await create({ 'idempotency-key': 'cccccccccccccccccccccccccccccccc' });
    expect(keyed.status).toBe(201);
    const [keyedCall] = harness.controlPlane.invocations;
    const scoped = await deriveInternalWorkspaceCreateKey(secret, 'cccccccccccccccccccccccccccccccc');
    expect(keyedCall.actorId).toBe(await deriveKeyedWorkspaceId(secret, scoped));
    const proofHeaders = (index: number) => (harness!.controlPlane.invocations[index].args[0] as { headers: [string, string][] }).headers
      .filter(([name]) => name === 'x-workspace-bootstrap-secret');
    // Exactly the gateway's proof, once.
    expect(proofHeaders(0)).toEqual([['x-workspace-bootstrap-secret', secret]]);
    expect((keyedCall.args[0] as { headers: [string, string][] }).headers).toContainEqual(['idempotency-key', scoped]);
    // A caller's own proof header is not what travels; the synthesized request is the gateway's.
    const presented = await create({ 'idempotency-key': 'cccccccccccccccccccccccccccccccc', 'x-workspace-bootstrap-secret': 'not-the-configured-secret' });
    expect(presented.status).toBe(201);
    expect(proofHeaders(1)).toEqual([['x-workspace-bootstrap-secret', secret]]);
    // An unkeyed internal create needs no proof and carries none.
    const unkeyed = await create({});
    expect(unkeyed.status).toBe(201);
    expect(proofHeaders(2)).toEqual([]);
    expect(JSON.stringify(harness.logs)).not.toContain(secret);
  });

  it('retries an unkeyed internal create once under a fresh id when the minted one was taken', async () => {
    let first: string | undefined;
    const colliding = (id: string): FakeWorkspace => ({
      create: () => {
        first ??= id;
        return id === first
          ? jsonResponse(409, { ok: false, error: { code: 'workspace_exists', message: 'taken' } })
          : jsonResponse(201, { ok: true, data: { workspace_id: id, api_key: `key-for-${id}` } });
      },
      handle: () => jsonResponse(404, { ok: false, error: { code: 'not_found', message: 'no' } }),
    });
    harness = await startHarness({ workspace: colliding, env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET } });
    const response = await fetch(`${harness.baseUrl}/internal/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'team' }),
    });
    expect(response.status).toBe(201);
    const actors = harness.controlPlane.invocations.map((call) => call.actorId);
    expect(actors).toHaveLength(2);
    expect(actors[0]).not.toBe(actors[1]);
    expect((await readJson(response)).data).toMatchObject({ workspace_id: actors[1] });
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

  it('forwards delete, key push and expiry to the named workspace actor with the Authorization header', async () => {
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
    const expiry = await fetch(`${harness.baseUrl}/internal/workspaces/${WORKSPACE_ID}/expiry`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expires_in_seconds: null }),
    });
    expect(expiry.status).toBe(200);
    expect((await readJson(expiry)).data).toMatchObject({ url: `${harness.baseUrl}/internal/workspaces/${WORKSPACE_ID}/expiry`, body: '{"expires_in_seconds":null}' });
    expect(harness.controlPlane.invocations.map((call) => [call.method, call.actorId])).toEqual([['handle', WORKSPACE_ID], ['handle', WORKSPACE_ID], ['handle', WORKSPACE_ID]]);
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

  it('forwards a migration import step to the actor for that id, with the tag its keyring signs', async () => {
    const seen: { body: unknown; tag: string }[] = [];
    harness = await startHarness({
      workspace: (id) => ({
        ...adminWorkspace(id),
        importData: (body, tag) => {
          seen.push({ body, tag });
          return jsonResponse(201, { ok: true, data: { run_id: 'run-0001-import', status: 'in_progress' } });
        },
      }),
      env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET },
    });
    const post = (path: string, body: unknown, secret = INTERNAL_SECRET) => fetch(`${harness!.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const begin = { op: 'begin', run_id: 'run-0001-import', tables: [{ name: 'workspaces', columns: ['id'] }] };

    expect((await post(`/internal/workspaces/${WORKSPACE_ID}/import`, begin, 'wrong-secret')).status).toBe(401);
    expect((await post('/internal/workspaces/not-a-snowflake/import', begin)).status).toBe(400);
    expect((await post(`/internal/workspaces/${WORKSPACE_ID}/import`, '{nope')).status).toBe(400);
    expect(seen).toHaveLength(0);

    const response = await post(`/internal/workspaces/${WORKSPACE_ID}/import`, begin);
    expect(response.status).toBe(201);
    expect((await readJson(response)).data).toEqual({ run_id: 'run-0001-import', status: 'in_progress' });
    expect(seen).toEqual([{ body: begin, tag: await harness.signer.tag(WORKSPACE_ID) }]);
    expect(harness.controlPlane.invocations.at(-1)).toMatchObject({ actorId: WORKSPACE_ID, method: 'importData' });
  });
});

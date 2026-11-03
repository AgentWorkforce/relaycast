import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActorHttpRequest, ActorHttpResponse } from '@relaycast/engine/gateway';
import { jsonResponse, type FakeWorkspace } from './fakeControlPlane.js';
import { WORKSPACE_ID, foreignCredential, readJson, startHarness, type Harness } from './harness.js';

const echoWorkspace = (id: string): FakeWorkspace => ({
  create: (request, tag) => jsonResponse(201, { ok: true, data: { workspace_id: id, tag, body: request.body, url: request.url } }),
  handle: (request: ActorHttpRequest) => jsonResponse(200, {
    ok: true,
    data: { workspace_id: id, method: request.method, url: request.url, body: request.body, headers: Object.fromEntries(request.headers) },
  }, [['x-custom', 'yes'], ['transfer-encoding', 'chunked']]),
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('routing', () => {
  it('serves health and readiness, with readiness following the control plane', async () => {
    harness = await startHarness();
    for (const path of ['/health', '/healthz']) {
      const response = await fetch(`${harness.baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true, service: 'relaycast-actors-gateway' });
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((await fetch(`${harness.baseUrl}/readyz`)).status).toBe(200);
    harness.controlPlane.healthy = false;
    // Cached for a few seconds: the first answer sticks.
    expect((await fetch(`${harness.baseUrl}/readyz`)).status).toBe(200);
  });

  it('reports a control plane that is down as not ready', async () => {
    harness = await startHarness();
    harness.controlPlane.healthy = false;
    const response = await fetch(`${harness.baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toMatchObject({ code: 'not_ready' });
  });

  it('refuses requests without a credential this keyring tagged, before any actor call', async () => {
    harness = await startHarness({ workspace: echoWorkspace });
    const cases: [string, Record<string, string>][] = [
      ['missing', {}],
      ['legacy', { authorization: `Bearer rk_live_${'0'.repeat(32)}` }],
      ['foreign tag', { authorization: `Bearer ${await foreignCredential()}` }],
      ['typo', { authorization: `Bearer ${(await harness.credential()).slice(0, -1)}x` }],
    ];
    for (const [, headers] of cases) {
      const response = await fetch(`${harness.baseUrl}/v1/agents`, { headers });
      expect(response.status).toBe(401);
      expect((await readJson(response)).error).toMatchObject({ code: 'unauthorized' });
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it('forwards an authenticated request to the credential\'s workspace actor and relays its response', async () => {
    harness = await startHarness({ workspace: echoWorkspace });
    const token = await harness.credential();
    const response = await fetch(`${harness.baseUrl}/v1/channels/general/messages?limit=5`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': 'req-123', connection: 'keep-alive' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-custom')).toBe('yes');
    expect(response.headers.get('x-request-id')).toBe('req-123');
    const body = await readJson(response);
    const data = body.data as { workspace_id: string; method: string; url: string; body: string; headers: Record<string, string> };
    expect(data.workspace_id).toBe(WORKSPACE_ID);
    expect(data.method).toBe('POST');
    expect(data.url).toBe(`${harness.baseUrl}/v1/channels/general/messages?limit=5`);
    expect(data.body).toBe('{"text":"hi"}');
    expect(data.headers.authorization).toBe(`Bearer ${token}`);
    expect(data.headers['x-request-id']).toBe('req-123');
    expect(data.headers.connection).toBeUndefined();

    const [invocation] = harness.controlPlane.invocations;
    expect(invocation.method).toBe('handle');
    expect(invocation.actorId).toBe(WORKSPACE_ID);
    expect(invocation.headers['x-request-id']).toBe(invocation.requestId);
    const log = harness.logs.find((entry) => entry.event === 'http.request');
    expect(log).toMatchObject({ method: 'POST', path: '/v1/channels/general/messages', status: 200, request_id: 'req-123', workspace_id: WORKSPACE_ID });
    expect(typeof log?.ms).toBe('number');
  });

  it('creates a workspace with a fresh id and a tag the keyring verifies', async () => {
    harness = await startHarness({ workspace: echoWorkspace });
    const response = await fetch(`${harness.baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    });
    expect(response.status).toBe(201);
    const data = (await readJson(response)).data as { workspace_id: string; tag: string; body: string };
    expect(data.workspace_id).toMatch(/^[0-9]+$/);
    expect(data.tag).toBe(await harness.signer.tag(data.workspace_id));
    expect(data.body).toBe('{"name":"demo"}');
    const [invocation] = harness.controlPlane.invocations;
    expect(invocation).toMatchObject({ method: 'create', actorId: data.workspace_id });
    expect(invocation.args[1]).toBe(data.tag);
  });

  it('hides the public create behind a generic 404 when RELAYCAST_PUBLIC_WORKSPACE_CREATE=false', async () => {
    harness = await startHarness({ workspace: echoWorkspace, env: { RELAYCAST_PUBLIC_WORKSPACE_CREATE: 'false' } });
    const response = await fetch(`${harness.baseUrl}/v1/workspaces`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
    expect((await readJson(response)).error).toMatchObject({ code: 'not_found' });
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it('answers CORS preflights itself', async () => {
    harness = await startHarness();
    const response = await fetch(`${harness.baseUrl}/v1/agents`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE');
  });

  it('caps request bodies at RELAYCAST_MAX_UPLOAD_BYTES', async () => {
    harness = await startHarness({ workspace: echoWorkspace, env: { RELAYCAST_MAX_UPLOAD_BYTES: '16' } });
    const token = await harness.credential();
    // Declared up front: refused before a byte is read.
    const declared = await fetch(`${harness.baseUrl}/v1/channels`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'x'.repeat(17) });
    expect(declared.status).toBe(413);
    expect(declared.headers.get('connection')).toBe('close');
    expect((await readJson(declared)).error).toMatchObject({ code: 'payload_too_large' });
    // Streamed without a length: refused at the first chunk past the cap, and the answer still arrives.
    const streamed = await fetch(`${harness.baseUrl}/v1/channels`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(40))); controller.close(); } }),
      duplex: 'half',
    } as RequestInit);
    expect(streamed.status).toBe(413);
    expect((await readJson(streamed)).error).toMatchObject({ code: 'payload_too_large' });
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it('routes a keyed create (Idempotency-Key) to one actor derived from the key, so a retry gets the same workspace', async () => {
    // Each actor keeps its own idempotency record, as the engine does.
    const created = new Map<string, ActorHttpResponse>();
    const keyedWorkspace = (id: string): FakeWorkspace => ({
      create: (request) => {
        const key = Object.fromEntries(request.headers)['idempotency-key'];
        const existing = created.get(id);
        if (existing && key) return existing;
        const response = jsonResponse(201, { ok: true, data: { workspace_id: id, api_key: `ar_ws_${id}_key`, key } });
        created.set(id, response);
        return response;
      },
      handle: () => jsonResponse(404, { ok: false, error: { code: 'not_found', message: 'no' } }),
    });
    harness = await startHarness({ workspace: keyedWorkspace, env: { RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'bootstrap-secret-0123456789abcdef' } });
    const create = (key?: string) => fetch(`${harness!.baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify({ name: 'team' }),
    });
    const key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const first = await readJson(await create(key));
    const retry = await readJson(await create(key));
    expect(first.data).toEqual(retry.data);
    expect((first.data as { workspace_id: string }).workspace_id).toMatch(/^[1-9][0-9]{0,18}$/);
    const actors = harness.controlPlane.invocations.map((call) => call.actorId);
    expect(actors).toHaveLength(2);
    expect(actors[0]).toBe(actors[1]);
    expect((harness.controlPlane.invocations[0].args[0] as ActorHttpRequest).headers).toContainEqual(['idempotency-key', key]);
    // Another key is another actor; no key is a fresh snowflake every time.
    const other = await readJson(await create('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'));
    expect((other.data as { workspace_id: string }).workspace_id).not.toBe((first.data as { workspace_id: string }).workspace_id);
    const plainA = await readJson(await create());
    const plainB = await readJson(await create());
    expect((plainA.data as { workspace_id: string }).workspace_id).not.toBe((plainB.data as { workspace_id: string }).workspace_id);
  });

  it('fails a keyed create closed when the deployment has no bootstrap secret, as the engine does', async () => {
    harness = await startHarness({ workspace: echoWorkspace });
    const response = await fetch(`${harness.baseUrl}/v1/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      body: JSON.stringify({ name: 'team' }),
    });
    expect(response.status).toBe(503);
    expect((await readJson(response)).error).toMatchObject({ code: 'workspace_create_idempotency_unavailable' });
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it('answers 400 for a Host header the URL parser refuses, on requests and upgrades alike', async () => {
    harness = await startHarness({ workspace: echoWorkspace });
    const port = Number(new URL(harness.baseUrl).port);
    const raw = (headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/channels', method: 'GET', setHost: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
    const plain = await raw({ host: 'x:bad', authorization: `Bearer ${await harness.credential()}` });
    expect(plain.status).toBe(400);
    expect(JSON.parse(plain.body)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    const upgrade = await raw({ host: 'x:bad', connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' });
    expect(upgrade.status).toBe(400);
    // The gateway is still serving.
    expect((await fetch(`${harness.baseUrl}/healthz`)).status).toBe(200);
    expect(harness.controlPlane.invocations).toHaveLength(0);
  });

  it("sends the gateway's CORS headers once, even when the actor's response carries the engine's copy", async () => {
    const corsWorkspace = (id: string): FakeWorkspace => ({
      handle: () => jsonResponse(200, { ok: true, data: { workspace_id: id } }, [
        ['access-control-allow-origin', '*'],
        ['access-control-expose-headers', 'X-Request-Id'],
        ['x-custom', 'a'],
        ['x-custom', 'b'],
      ]),
    });
    harness = await startHarness({ workspace: corsWorkspace });
    const response = await fetch(`${harness.baseUrl}/v1/channels`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-expose-headers')).toBe('X-Request-Id');
    expect(response.headers.get('x-custom')).toBe('a, b');
  });

  it('answers 502 workspace_unavailable when the actor call fails, without leaking the control plane', async () => {
    harness = await startHarness({ workspace: echoWorkspace, controlPlane: { secret: 'plane-secret' }, env: { DURABLE_ACTORS_SECRET: 'wrong-secret' } });
    const response = await fetch(`${harness.baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text).error).toEqual({ code: 'workspace_unavailable', message: 'The workspace could not be reached; retry' });
    expect(text).not.toContain('127.0.0.1');
    expect(JSON.stringify(harness.logs)).not.toContain('wrong-secret');
    expect(harness.logs.find((entry) => entry.event === 'actor.call_failed')).toMatchObject({ code: 'unauthenticated' });
  });

  it('retries a not_executed outcome once and sends the control plane credential', async () => {
    harness = await startHarness({ workspace: echoWorkspace, controlPlane: { secret: 'plane-secret' }, env: { DURABLE_ACTORS_SECRET: 'plane-secret' } });
    let attempts = 0;
    harness.controlPlane.interceptInvoke = () => (attempts++ === 0 ? { status: 200, body: { outcome: { type: 'not_executed', reason: 'host_unavailable' } } } : undefined);
    const response = await fetch(`${harness.baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(harness.controlPlane.invocations[0].headers.authorization).toBe('Bearer plane-secret');
  });

  it('treats a malformed actor result as unavailable', async () => {
    harness = await startHarness({ workspace: echoWorkspace });
    harness.controlPlane.interceptInvoke = () => ({ status: 200, body: { outcome: { type: 'completed', result: { nope: true } } } });
    const response = await fetch(`${harness.baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    expect(response.status).toBe(502);
  });
});

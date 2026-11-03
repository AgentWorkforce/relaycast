import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SOCKET_GRANT_HEADER, parseSocketGrant } from '../socketGrant.js';
import { sendableCloseCode } from '../ws.js';
import { jsonResponse, once, waitFor, type FakeWorkspace } from './fakeControlPlane.js';
import { WORKSPACE_ID, foreignCredential, startHarness, type Harness } from './harness.js';

/** An actor that grants sockets to `ar_ag_` tokens via `?token=` or the bearer, and refuses the rest. */
const grantingWorkspace = (id: string): FakeWorkspace => ({
  handle: (request) => {
    const headers = Object.fromEntries(request.headers);
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? headers.authorization?.replace(/^Bearer /, '');
    if (headers.upgrade !== 'websocket' || headers.connection !== 'Upgrade') return jsonResponse(426, { ok: false, error: { code: 'upgrade_required', message: 'ws only' } });
    if (!token?.startsWith('ar_ag_')) return jsonResponse(401, { ok: false, error: { code: 'invalid_token', message: 'Invalid token' } });
    if (headers['sec-websocket-key']) return jsonResponse(400, { ok: false, error: { code: 'bad_probe', message: 'hop-by-hop header leaked' } });
    const metadata = url.pathname === '/v1/node/ws'
      ? { v: 1, kind: 'node', workspace_id: id, node_id: `node-${headers['x-request-id']}` }
      : { v: 1, kind: 'observer', workspace_id: id, observer_token_id: `obs-${headers['x-request-id']}` };
    return jsonResponse(200, { ok: true, data: { metadata } }, [[SOCKET_GRANT_HEADER, '1']]);
  },
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function connect(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function upgradeStatus(url: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode ?? 0); });
    ws.once('open', () => { ws.close(); reject(new Error('unexpectedly opened')); });
    ws.once('error', reject);
  });
}

describe('WebSocket bridge', () => {
  it('bridges a granted socket: probe, find-websocket, frames both ways, close propagation', async () => {
    harness = await startHarness({ workspace: grantingWorkspace });
    const token = await harness.credential();
    const client = await connect(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${token}`);
    await waitFor(() => harness!.controlPlane.sessions.length === 1);
    expect(harness.gateway.socketCount).toBe(1);

    // The probe carried the upgrade headers and the grant's principal became the socket metadata.
    const [probe] = harness.controlPlane.invocations;
    const probeHeaders = Object.fromEntries((probe.args[0] as { headers: [string, string][] }).headers);
    expect(probeHeaders.upgrade).toBe('websocket');
    expect(probeHeaders.connection).toBe('Upgrade');
    expect(probeHeaders['sec-websocket-key']).toBeUndefined();
    expect(harness.controlPlane.findWebsocketCalls).toEqual([{ actorId: WORKSPACE_ID, metadata: { v: 1, kind: 'observer', workspace_id: WORKSPACE_ID, observer_token_id: expect.stringMatching(/^obs-/) }, homeRegion: undefined }]);

    const echoed = once<[Buffer]>(client, 'message');
    client.send(JSON.stringify({ type: 'subscribe' }));
    expect(JSON.parse((await echoed)[0].toString())).toEqual({ echo: '{"type":"subscribe"}' });

    const fromActor = once<[Buffer]>(client, 'message');
    harness.controlPlane.sessions[0].send('{"type":"event"}');
    expect((await fromActor)[0].toString()).toBe('{"type":"event"}');

    // The actor closes with its own code; the client sees it.
    const closed = once<[number, Buffer]>(client, 'close');
    harness.controlPlane.sessions[0].close(4001, 'workspace deleted');
    const [code, reason] = await closed;
    expect(code).toBe(4001);
    expect(reason.toString()).toBe('workspace deleted');
    await waitFor(() => harness!.gateway.socketCount === 0);
    expect(harness.logs.find((entry) => entry.event === 'socket.open')).toMatchObject({ path: '/v1/ws', workspace_id: WORKSPACE_ID });
    expect(harness.logs.find((entry) => entry.event === 'socket.close')).toMatchObject({ code: 4001, closed_by: 'upstream' });
    expect(JSON.stringify(harness.logs)).not.toContain('key=');
  });

  it('propagates a client close to the actor and accepts the node token from a bearer header', async () => {
    harness = await startHarness({ workspace: grantingWorkspace });
    const token = await harness.credential(WORKSPACE_ID, 'agent');
    const client = await connect(`${harness.baseUrl.replace('http', 'ws')}/v1/node/ws`, { authorization: `Bearer ${token}` });
    await waitFor(() => harness!.controlPlane.sessions.length === 1);
    expect(harness.controlPlane.findWebsocketCalls[0].metadata).toMatchObject({ kind: 'node' });
    const upstreamClosed = once<[number, Buffer]>(harness.controlPlane.sessions[0], 'close');
    client.close(1000, 'bye');
    const [code, reason] = await upstreamClosed;
    expect(code).toBe(1000);
    expect(reason.toString()).toBe('bye');
  });

  it('closes a client that sends a binary frame with 1003', async () => {
    harness = await startHarness({ workspace: grantingWorkspace });
    const client = await connect(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${await harness.credential()}`);
    const closed = once<[number, Buffer]>(client, 'close');
    client.send(Buffer.from([1, 2, 3]));
    expect((await closed)[0]).toBe(1003);
  });

  it('rejects the upgrade with a raw HTTP status when the credential or the actor refuses', async () => {
    harness = await startHarness({ workspace: grantingWorkspace });
    const base = harness.baseUrl.replace('http', 'ws');
    expect(await upgradeStatus(`${base}/v1/ws`)).toBe(401);
    expect(await upgradeStatus(`${base}/v1/ws?token=${await foreignCredential()}`)).toBe(401);
    expect(harness.controlPlane.invocations).toHaveLength(0);
    // Well-tagged, but the actor says no (a workspace key cannot open the stream).
    expect(await upgradeStatus(`${base}/v1/ws?token=${await harness.credential(WORKSPACE_ID, 'workspace')}`)).toBe(401);
    expect(harness.controlPlane.invocations).toHaveLength(1);
    expect(harness.controlPlane.findWebsocketCalls).toHaveLength(0);
    expect(await upgradeStatus(`${base}/v1/other?token=${await harness.credential()}`)).toBe(426);
  });

  it('only treats a response as a grant when it carries the header and an engine-shaped principal', () => {
    const principal = { v: 1, kind: 'node', workspace_id: WORKSPACE_ID, node_id: 'n1' };
    expect(parseSocketGrant(jsonResponse(200, { ok: true, data: { metadata: principal } }, [[SOCKET_GRANT_HEADER, '1']]))).toEqual(principal);
    expect(parseSocketGrant(jsonResponse(200, { ok: true, data: { metadata: principal } }))).toBeUndefined();
    expect(parseSocketGrant(jsonResponse(200, { ok: true, data: { metadata: { a: 1 } } }, [[SOCKET_GRANT_HEADER, '1']]))).toBeUndefined();
    expect(parseSocketGrant(jsonResponse(200, { ok: true, data: { metadata: { ...principal, extra: true } } }, [[SOCKET_GRANT_HEADER, '1']]))).toBeUndefined();
    expect(parseSocketGrant(jsonResponse(401, { ok: true, data: { metadata: principal } }, [[SOCKET_GRANT_HEADER, '1']]))).toBeUndefined();
    expect(parseSocketGrant({ status: 200, headers: [[SOCKET_GRANT_HEADER, '1']], body: 'not json' })).toBeUndefined();
  });

  it('does not accept a 200 that is not a grant', async () => {
    harness = await startHarness({ workspace: () => ({ handle: () => jsonResponse(200, { ok: true, data: { agents: [] } }) }) });
    expect(await upgradeStatus(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${await harness.credential()}`)).toBe(502);
    expect(harness.controlPlane.findWebsocketCalls).toHaveLength(0);
  });

  it('closes the client with 1011 when the upstream socket cannot be opened', async () => {
    harness = await startHarness({ workspace: grantingWorkspace, gateway: { socket: { connectTimeoutMs: 1000 } } });
    harness.controlPlane.acceptSockets = false;
    const client = await connect(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${await harness.credential()}`);
    const [code] = await once<[number, Buffer]>(client, 'close');
    expect(code).toBe(1011);
    expect(harness.gateway.socketCount).toBe(0);
  });

  it('rejects with 502 when find-websocket fails', async () => {
    harness = await startHarness({ workspace: grantingWorkspace });
    harness.controlPlane.failFindWebsocket = 503;
    expect(await upgradeStatus(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${await harness.credential()}`)).toBe(502);
  });

  it('terminates a client that stops answering pings', async () => {
    harness = await startHarness({ workspace: grantingWorkspace, gateway: { socket: { pingIntervalMs: 100 } } });
    const client = await connect(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${await harness.credential()}`);
    // A client that never pongs: the ws library answers pings on our behalf, so suppress that.
    (client as unknown as { _receiver: { on: (event: string, fn: () => void) => void; removeAllListeners: (event: string) => void } })._receiver.removeAllListeners('ping');
    const [code] = await once<[number, Buffer]>(client, 'close');
    expect(code).toBe(1006);
    await waitFor(() => harness!.gateway.socketCount === 0);
  });

  it('relays a status-less close as 1000, a dropped peer as 1001, and codes the library refuses to send as 1011', () => {
    expect(sendableCloseCode(1000)).toBe(1000);
    expect(sendableCloseCode(1012)).toBe(1012);
    expect(sendableCloseCode(4000)).toBe(4000);
    expect(sendableCloseCode(1005)).toBe(1000);
    expect(sendableCloseCode(1006)).toBe(1001);
    for (const code of [1004, 1015, 2000, 5000]) expect(sendableCloseCode(code)).toBe(1011);
  });

  it('drops a client that sends more than a few KiB before its upgrade is answered', async () => {
    const slowGrant = (id: string): FakeWorkspace => ({
      handle: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return grantingWorkspace(id).handle(request);
      },
    });
    harness = await startHarness({ workspace: slowGrant });
    const port = Number(new URL(harness.baseUrl).port);
    const token = await harness.credential();
    const closed = new Promise<void>((resolve) => {
      const raw = createConnection({ host: '127.0.0.1', port }, () => {
        raw.write(`GET /v1/ws?token=${token} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        // Bytes a real client would never send before its 101.
        setTimeout(() => raw.write(Buffer.alloc(20 * 1024, 0x41)), 100);
      });
      raw.on('error', () => {});
      raw.once('close', () => resolve());
    });
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(harness.controlPlane.findWebsocketCalls).toHaveLength(0);
    expect(harness.controlPlane.sessions).toHaveLength(0);
    expect(harness.logs.find((entry) => entry.event === 'socket.early_bytes')).toMatchObject({ path: '/v1/ws' });
  });

  it('opens no upstream for a client that left while its actor was being asked', async () => {
    const slowGrant = (id: string): FakeWorkspace => ({
      handle: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return grantingWorkspace(id).handle(request);
      },
    });
    harness = await startHarness({ workspace: slowGrant });
    const ws = new WebSocket(`${harness.baseUrl.replace('http', 'ws')}/v1/ws?token=${await harness.credential()}`);
    ws.on('error', () => {});
    await waitFor(() => harness!.controlPlane.invocations.length === 1);
    ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(harness.controlPlane.findWebsocketCalls).toHaveLength(0);
    expect(harness.controlPlane.sessions).toHaveLength(0);
    expect(harness.gateway.socketCount).toBe(0);
    expect(harness.logs.find((entry) => entry.event === 'socket.client_gone')).toMatchObject({ path: '/v1/ws', workspace_id: WORKSPACE_ID });
  });
});

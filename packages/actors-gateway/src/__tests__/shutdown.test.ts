import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SOCKET_GRANT_HEADER } from '../socketGrant.js';
import { jsonResponse, once, waitFor, type FakeWorkspace } from './fakeControlPlane.js';
import { WORKSPACE_ID, startHarness, type Harness } from './harness.js';

const workspace = (): FakeWorkspace => ({
  handle: async (request) => {
    const headers = Object.fromEntries(request.headers);
    if (headers.upgrade === 'websocket') return jsonResponse(200, { ok: true, data: { metadata: { v: 1, kind: 'observer', workspace_id: WORKSPACE_ID, observer_token_id: 'obs-1' } } }, [[SOCKET_GRANT_HEADER, '1']]);
    if (new URL(request.url).pathname === '/v1/slow') await new Promise((resolve) => setTimeout(resolve, 300));
    return jsonResponse(200, { ok: true, data: [] });
  },
});

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close().catch(() => {});
  harness = undefined;
});

describe('graceful shutdown', () => {
  it('closes bridged sockets with 1012, finishes in-flight requests and stops listening', async () => {
    harness = await startHarness({ workspace, env: { RELAYCAST_SHUTDOWN_GRACE_MS: '2000' } });
    const token = await harness.credential();
    const client = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${harness!.baseUrl.replace('http', 'ws')}/v1/ws?token=${token}`);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
    await waitFor(() => harness!.gateway.socketCount === 1);
    const clientClosed = once<[number, Buffer]>(client, 'close');

    const slow = fetch(`${harness.baseUrl}/v1/slow`, { headers: { authorization: `Bearer ${token}` } });
    await waitFor(() => harness!.controlPlane.invocations.some((call) => (call.args[0] as { url: string }).url.endsWith('/v1/slow')));

    const started = Date.now();
    const closing = harness.gateway.close();
    const [code, reason] = await clientClosed;
    expect(code).toBe(1012);
    expect(reason.toString()).toBe('gateway restarting');

    const response = await slow;
    expect(response.status).toBe(200);
    await closing;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(harness.gateway.socketCount).toBe(0);
    await expect(fetch(`${harness.baseUrl}/healthz`)).rejects.toThrow();
  });

  it('drops requests still in flight once the grace period ends', async () => {
    harness = await startHarness({ workspace: () => ({ handle: () => new Promise(() => {}) }), env: { RELAYCAST_SHUTDOWN_GRACE_MS: '200' } });
    const stuck = fetch(`${harness.baseUrl}/v1/never`, { headers: { authorization: `Bearer ${await harness.credential()}` } });
    await waitFor(() => harness!.controlPlane.invocations.length === 1);
    const started = Date.now();
    await harness.gateway.close();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    await expect(stuck).rejects.toThrow();
    expect(harness.logs.find((entry) => entry.event === 'gateway.drain_timeout')).toMatchObject({ in_flight: 1 });
  });
});

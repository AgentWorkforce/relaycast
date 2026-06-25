import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../entrypoints/node.js';

/**
 * Regression guard for the self-host WebSocket upgrade handler in
 * `entrypoints/node.ts` — the *real* node-control read-side (the Hono
 * `/v1/node/ws` route only answers the 426, the upgrade is owned by the Node
 * HTTP server). Asserts:
 *   - the node token is accepted from `Authorization: Bearer` (the relay Rust
 *     broker's transport) AND from the `?token=` query param (SDK/Pear)
 *
 * This is the exact cross-repo handshake (broker #1107 send-side ↔ engine #192
 * read-side) that shipped mismatched; it must never regress.
 */
describe('node control WS upgrade auth (self-host)', () => {
  let running: RunningServer;
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    running = startServer({
      dbPath: ':memory:',
      port: 0,
      migrate: true,
      config: { environment: 'test' },
    });
    const addr = running.server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
    wsBase = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(() => running.stop());

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) } as {
      status: number;
      body: any;
    };
  }

  /** Resolve to the HTTP status code of the upgrade response (101 on success). */
  function tryUpgrade(headers: Record<string, string>, query = '', path = '/v1/node/ws'): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${wsBase}${path}${query}`, { headers });
      ws.on('open', () => { ws.close(); resolve(101); });
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); });
      ws.on('error', () => { /* handled by unexpected-response */ });
    });
  }

  async function enrollNode(workspaceKey: string, name: string): Promise<string> {
    const { status, body } = await api('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ node_id: name, name, capabilities: ['echo'] }),
    });
    expect(status).toBe(201);
    return body.data.token as string;
  }

  it('accepts the node token via Authorization: Bearer AND ?token=', async () => {
    const ws = await api('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ws-node-auth' }),
    });
    const workspaceKey = ws.body.data.api_key as string;

    const token = await enrollNode(workspaceKey, 'header-node');

    // Broker transport: Authorization: Bearer header, no query param.
    expect(await tryUpgrade({ authorization: `Bearer ${token}` })).toBe(101);
    // Empty query params must not shadow a valid Authorization header.
    expect(await tryUpgrade({ authorization: `Bearer ${token}` }, '?token=')).toBe(101);
    // SDK/Pear transport: ?token= query param, no header.
    expect(await tryUpgrade({}, `?token=${token}`)).toBe(101);
  });

  it('accepts agent realtime upgrades without a workspace stream mode', async () => {
    const ws = await api('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'agent-ws-on' }),
    });
    const workspaceKey = ws.body.data.api_key as string;

    const agent = await api('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ name: 'stream-agent' }),
    });
    expect(agent.status).toBe(201);
    const token = agent.body.data.token as string;

    expect(await tryUpgrade({}, `?token=${token}`, '/v1/ws')).toBe(101);
  });

  it('accepts workspace observer realtime upgrades with workspace keys', async () => {
    const ws = await api('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'workspace-ws-on' }),
    });
    const workspaceKey = ws.body.data.api_key as string;

    expect(await tryUpgrade({}, `?token=${workspaceKey}`, '/v1/ws')).toBe(101);
  });

  it('rejects a missing or malformed token (401)', async () => {
    expect(await tryUpgrade({})).toBe(401);
    expect(await tryUpgrade({ authorization: 'Bearer not_a_node_token' })).toBe(401);
  });
});

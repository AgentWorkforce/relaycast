import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SocketGrantSchema } from '@relaycast/engine/adapters/actor';
import { createCredentialTagSigner } from '@relaycast/engine/gateway';
import { WorkspaceHost } from '../host.js';
import { WorkspaceRouter } from '../router.js';
import { FileLogStore } from '../store.js';

const WORKSPACE_ID = '241764880589606912';
const TAGS = createCredentialTagSigner({ current: 'a', keys: { a: 'sqlite-host-test-tag-secret-0123456789' } });
const cleanups: (() => Promise<unknown> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function cluster() {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-router-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new FileLogStore(join(root, 'bucket'));
  const routerPort = await freePort();
  const routerUrl = `http://127.0.0.1:${routerPort}`;
  const hosts = await Promise.all(['host-0', 'host-1'].map(async (name) => {
    const port = await freePort();
    const host = new WorkspaceHost({
      name, socketOrigin: routerUrl, grantSecret: 'grant-secret-of-at-least-32-characters', store, prefix: 'workspaces',
      dataDir: join(root, name), baseEvery: 1000, durability: 'sync', log: () => undefined,
      config: {
        publicUrl: 'https://armadillo.test',
        fileSigningSecret: 'file-secret-of-at-least-32-characters',
        engine: { environment: 'test', maxUploadBytes: 1024 * 1024, retention: { messageTtlDays: null } },
      },
    });
    await host.listen(port);
    cleanups.push(() => host.close());
    return { name, url: `http://127.0.0.1:${port}`, host };
  }));
  const router = new WorkspaceRouter({ hosts: hosts.map(({ name, url }) => ({ name, url })), checkMs: 50, log: () => undefined });
  await router.listen(routerPort);
  cleanups.push(() => router.close());
  return { routerUrl, router, hosts };
}

async function invoke(routerUrl: string, method: string, args: unknown[]) {
  const response = await fetch(`${routerUrl}/v1/projects/bench/actors/Workspace/${WORKSPACE_ID}/invoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'r', method, args }),
  });
  const { outcome } = await response.json() as { outcome: { type: string; result: { status: number; headers: [string, string][]; body: string } } };
  expect(outcome.type).toBe('completed');
  return outcome.result;
}

function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: [string, string][] = [['content-type', 'application/json']];
  if (token) headers.push(['authorization', `Bearer ${token}`]);
  return { method, url: `https://armadillo.test${path}`, headers, body: body === undefined ? null : JSON.stringify(body) };
}

describe('router and hosts over the control-plane protocol', () => {
  it('routes a workspace to one host and bridges its node socket through the router', async () => {
    const { routerUrl } = await cluster();
    const created = await invoke(routerUrl, 'create', [req('POST', '/v1/workspaces', { name: 'armadillo' }), await TAGS.tag(WORKSPACE_ID)]);
    expect(created.status).toBe(201);
    const key = (JSON.parse(created.body) as { data: { api_key: string } }).data.api_key;
    const alice = JSON.parse((await invoke(routerUrl, 'handle', [req('POST', '/v1/agents', { name: 'alice' }, key)])).body).data.token as string;
    const minted = JSON.parse((await invoke(routerUrl, 'handle', [req('POST', '/v1/agent/node-token', {}, alice)])).body).data as { node_id: string; node_name: string; token: string };
    const upgrade = await invoke(routerUrl, 'handle', [{
      method: 'GET', url: `https://armadillo.test/v1/node/ws?token=${encodeURIComponent(minted.token)}`,
      headers: [['upgrade', 'websocket'], ['connection', 'Upgrade']], body: null,
    }]);
    const grant = SocketGrantSchema.parse(JSON.parse(upgrade.body));
    const found = await (await fetch(`${routerUrl}/v1/projects/bench/actors/Workspace/${WORKSPACE_ID}/find-websocket`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metadata: grant.data.metadata }),
    })).json() as { websocketUrl: string };
    expect(found.websocketUrl.startsWith(routerUrl.replace('http', 'ws'))).toBe(true);

    const socket = new WebSocket(found.websocketUrl);
    const frames: Record<string, unknown>[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    cleanups.push(() => socket.close());
    socket.send(JSON.stringify({
      v: 1, id: 'r1', type: 'node.register', node_id: minted.node_id, name: minted.node_name,
      capabilities: [], max_agents: 1, tags: ['implicit', 'direct'], version: 'sqlite-host-test/1',
    }));
    await expect.poll(() => frames.find((frame) => frame.id === 'r1'), { timeout: 5000 }).toMatchObject({ type: 'reply', ok: true });

    const bob = JSON.parse((await invoke(routerUrl, 'handle', [req('POST', '/v1/agents', { name: 'bob' }, key)])).body).data.token as string;
    expect((await invoke(routerUrl, 'handle', [req('POST', '/v1/dm', { to: 'alice', text: 'over sqlite' }, bob)])).status).toBe(201);
    await expect.poll(() => frames.find((frame) => frame.type === 'deliver'), { timeout: 5000 }).toMatchObject({ agent: 'alice' });
  });

  it('moves a workspace to the surviving host when its owner goes down, with every write', async () => {
    const { routerUrl, router, hosts } = await cluster();
    const created = await invoke(routerUrl, 'create', [req('POST', '/v1/workspaces', { name: 'armadillo' }), await TAGS.tag(WORKSPACE_ID)]);
    const key = (JSON.parse(created.body) as { data: { api_key: string } }).data.api_key;
    const alice = JSON.parse((await invoke(routerUrl, 'handle', [req('POST', '/v1/agents', { name: 'alice' }, key)])).body).data.token as string;
    await invoke(routerUrl, 'handle', [req('POST', '/v1/channels/general/messages', { text: 'before' }, alice)]);

    const owner = hosts.find((host) => host.name === router.owner(WORKSPACE_ID)!.name)!;
    await owner.host.close();
    await expect.poll(() => router.owner(WORKSPACE_ID)?.name, { timeout: 5000 }).not.toBe(owner.name);

    expect((await invoke(routerUrl, 'handle', [req('POST', '/v1/channels/general/messages', { text: 'after' }, alice)])).status).toBe(201);
    const listed = JSON.parse((await invoke(routerUrl, 'handle', [req('GET', '/v1/channels/general/messages', undefined, alice)])).body).data as { text: string }[];
    expect(listed.map((message) => message.text).sort()).toEqual(['after', 'before']);
  });
});

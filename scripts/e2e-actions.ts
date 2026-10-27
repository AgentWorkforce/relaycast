#!/usr/bin/env npx tsx
/**
 * Relaycast ACTIONS end-to-end test.
 *
 * Exercises the NEW action contract (which supersedes the old `/v1/commands`
 * API). Actions are an async agent-to-agent RPC, not a synchronous command:
 *
 *   handler agent  ──register──▶  POST /v1/actions  (ownership enforced)
 *   caller agent   ──invoke────▶  POST /v1/actions/:name/invoke  → { invocation_id, status: 'invoked' }
 *                                  (`action.invoked` arrives on the workspace observer stream)
 *   handler agent  ──complete──▶  POST /v1/actions/:name/invocations/:id/complete { output }
 *                                  (`action.completed` arrives on the workspace observer stream)
 *
 * The handler's direct node stays connected so invoke can dispatch. That socket
 * is not the event wait; action events are read from `/v1/ws`.
 *   caller agent   ──poll──────▶  GET  /v1/actions/:name/invocations/:id  → status: 'completed'
 *
 * Usage:
 *   npm run e2e:actions                       # http://localhost:8787
 *   npm run e2e:actions -- http://localhost:8787
 */

import WebSocket from 'ws';
import { actionWaitObserverCreateBody, actionWaitWsUrl } from './action-wait-ws.js';

const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:8787').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}
function bad(name: string, err: unknown): void {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err instanceof Error ? err.message : String(err)}`);
}
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err);
  }
}

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

/**
 * Keep a handler invocable. Direct-node registration is the live connection
 * invoke checks; it does not replace the workspace observer wait.
 */
function connectDirectNode(node: { node_id: string; node_name: string; token: string }): Promise<{ close: () => void }> {
  const wsBase = BASE.replace(/^http/, 'ws');
  const ws = new WebSocket(`${wsBase}/v1/node/ws?token=${encodeURIComponent(node.token)}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout waiting for direct node.register reply'));
    }, 5000);
    const fail = (err: unknown) => {
      clearTimeout(timer);
      ws.close();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    ws.on('error', fail);
    ws.on('message', (d) => {
      let frame: { type?: string; ok?: boolean };
      try {
        frame = JSON.parse(d.toString());
      } catch (err) {
        fail(err);
        return;
      }
      if (frame.type !== 'reply') return;
      clearTimeout(timer);
      if (frame.ok !== true) {
        ws.close();
        reject(new Error(`direct node.register failed: ${d.toString()}`));
        return;
      }
      resolve({ close: () => ws.close() });
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({
        v: 1,
        id: `e2e-direct-${Date.now()}`,
        type: 'node.register',
        node_id: node.node_id,
        name: node.node_name,
        capabilities: [],
        max_agents: 1,
        tags: ['implicit', 'direct'],
        version: 'e2e-actions',
      }));
    });
  });
}

/** Open the workspace observer stream and wait for action events on it. */
function openObserverWs(observerToken: string): {
  ready: Promise<void>;
  waitFor: (type: string, timeoutMs?: number) => Promise<any>;
  close: () => void;
} {
  const ws = new WebSocket(actionWaitWsUrl(BASE, observerToken));
  const events: any[] = [];
  const waiters: Array<{ type: string; resolve: (e: any) => void }> = [];
  ws.on('message', (d) => {
    const e = JSON.parse(d.toString());
    events.push(e);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === e.type) {
        waiters[i].resolve(e);
        waiters.splice(i, 1);
      }
    }
  });
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  return {
    ready,
    waitFor: (type, timeoutMs = 4000) =>
      new Promise((resolve, reject) => {
        const existing = events.find((e) => e.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`timeout waiting for "${type}" event`)), timeoutMs);
        waiters.push({ type, resolve: (e) => { clearTimeout(timer); resolve(e); } });
      }),
    close: () => ws.close(),
  };
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mRelaycast actions E2E\x1b[0m → ${BASE}\n`);

  // ── Bootstrap: workspace + handler agent + caller agent ──
  const wsName = `actions-e2e-${Date.now()}`;
  const wsRes = await req('POST', '/v1/workspaces', {
    body: {
      name: wsName,
      expires_in_seconds: 24 * 60 * 60,
      provenance: {
        source: 'ci',
        origin_id: process.env.GITHUB_RUN_ID
          ? `github:AgentWorkforce/relaycast/actions/runs/${process.env.GITHUB_RUN_ID}`
          : 'relaycast:e2e-actions:local',
        classification: 'internal',
      },
    },
  });
  if (wsRes.status >= 300) throw new Error(`create workspace failed: ${wsRes.status}`);
  const workspaceKey: string = wsRes.json.data.api_key;

  const mkAgent = async (name: string) => {
    const r = await req('POST', '/v1/agents', { token: workspaceKey, body: { name } });
    if (r.status >= 300) throw new Error(`register ${name} failed: ${r.status}`);
    return { name, id: r.json.data.id as string, token: r.json.data.token as string };
  };
  const handler = await mkAgent('deployer');
  const caller = await mkAgent('requester');
  console.log(`  workspace=${wsName} handler=${handler.name} caller=${caller.name}\n`);

  const observerRes = await req('POST', '/v1/observer-tokens', {
    token: workspaceKey,
    body: actionWaitObserverCreateBody('actions-e2e'),
  });
  if (observerRes.status !== 201 || typeof observerRes.json?.data?.token !== 'string') {
    throw new Error(`create observer token failed: ${observerRes.status}`);
  }
  const observerWs = openObserverWs(observerRes.json.data.token);
  await observerWs.ready;

  const nodeRes = await req('POST', '/v1/agent/node-token', { token: handler.token });
  if (nodeRes.status !== 200 || typeof nodeRes.json?.data?.token !== 'string') {
    throw new Error(`mint handler node token failed: ${nodeRes.status}`);
  }
  const handlerNode = await connectDirectNode(nodeRes.json.data);

  let invocationId = '';

  // ── 1. Handler registers an action it owns ──
  await test('Handler registers an action', async () => {
    const r = await req('POST', '/v1/actions', {
      token: handler.token,
      body: {
        name: 'deploy',
        description: 'Deploy a service to an environment',
        handler_agent: handler.name,
        input_schema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
        output_schema: { type: 'object', properties: { url: { type: 'string' } } },
      },
    });
    if (r.status !== 201) throw new Error(`expected 201, got ${r.status}: ${JSON.stringify(r.json)}`);
    if (r.json.data.name !== 'deploy') throw new Error('action name mismatch');
  });

  // ── 2. Ownership enforcement: caller cannot register an action it won't handle ──
  await test('Ownership enforced: non-handler cannot register', async () => {
    const r = await req('POST', '/v1/actions', {
      token: caller.token,
      body: { name: 'sneaky', description: 'x', handler_agent: handler.name },
    });
    if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
  });

  // ── 3. List + get the action ──
  await test('List actions includes deploy', async () => {
    const r = await req('GET', '/v1/actions', { token: caller.token });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    const names = (r.json.data ?? []).map((a: any) => a.name);
    if (!names.includes('deploy')) throw new Error(`deploy not listed: ${JSON.stringify(names)}`);
  });
  await test('Get action by name', async () => {
    const r = await req('GET', '/v1/actions/deploy', { token: caller.token });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (r.json.data?.name !== 'deploy') throw new Error(`expected action name "deploy", got ${JSON.stringify(r.json.data?.name)}`);
    if (r.json.data.handler_agent !== handler.name) throw new Error(`handler mismatch: ${JSON.stringify(r.json.data)}`);
  });

  // ── 4. Caller invokes → gets invocation_id with status 'invoked' ──
  await test('Caller invokes action → invocation_id, status invoked', async () => {
    const r = await req('POST', '/v1/actions/deploy/invoke', {
      token: caller.token,
      body: { input: { env: 'staging' } },
    });
    if (r.status !== 201) throw new Error(`expected 201, got ${r.status}: ${JSON.stringify(r.json)}`);
    invocationId = r.json.data.invocation_id;
    if (!invocationId) throw new Error('no invocation_id returned');
  });

  // ── 5. Handler receives action.invoked over WS ──
  await test('Handler receives action.invoked over WebSocket', async () => {
    const e = await observerWs.waitFor('action.invoked');
    const data = e.data ?? e;
    if (data.action_name !== 'deploy') throw new Error('wrong action in event');
  });

  // ── 6. Handler completes the invocation ──
  await test('Handler completes the invocation', async () => {
    const r = await req('POST', `/v1/actions/deploy/invocations/${invocationId}/complete`, {
      token: handler.token,
      body: { output: { url: 'https://staging.example.com' }, duration_ms: 1200 },
    });
    if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.json)}`);
    if (r.json.data.status !== 'completed') throw new Error(`status ${r.json.data.status}`);
  });

  // ── 7. Caller receives action.completed over WS ──
  await test('Caller receives action.completed over WebSocket', async () => {
    const e = await observerWs.waitFor('action.completed');
    const data = e.data ?? e;
    if (data.action_name !== 'deploy') throw new Error('wrong action in completion event');
  });

  // ── 8. Get invocation reflects completion + output ──
  await test('Get invocation shows completed status + output', async () => {
    const r = await req('GET', `/v1/actions/deploy/invocations/${invocationId}`, { token: caller.token });
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    if (r.json.data.status !== 'completed') throw new Error(`status ${r.json.data.status}`);
    if (r.json.data.output?.url !== 'https://staging.example.com') throw new Error('output not recorded');
  });

  // ── 9. Delete the action ──
  await test('Delete action', async () => {
    const r = await req('DELETE', '/v1/actions/deploy', { token: handler.token });
    if (r.status >= 300 && r.status !== 204) throw new Error(`status ${r.status}`);
    const after = await req('GET', '/v1/actions/deploy', { token: caller.token });
    if (after.status !== 404) throw new Error(`expected 404 after delete, got ${after.status}`);
  });

  observerWs.close();
  handlerNode.close();

  console.log(`\n  \x1b[1m${passed}\x1b[0m passed, ${failed > 0 ? `\x1b[31m\x1b[1m${failed}\x1b[0m` : failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nactions E2E crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

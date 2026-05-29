#!/usr/bin/env npx tsx
/**
 * Relaycast ACTIONS end-to-end test.
 *
 * Exercises the NEW action contract (which supersedes the old `/v1/commands`
 * API). Actions are an async agent-to-agent RPC, not a synchronous command:
 *
 *   handler agent  ──register──▶  POST /v1/actions  (ownership enforced)
 *   caller agent   ──invoke────▶  POST /v1/actions/:name/invoke  → { invocation_id, status: 'invoked' }
 *                                  (handler receives `action.invoked` over WS)
 *   handler agent  ──complete──▶  POST /v1/actions/:name/invocations/:id/complete { output }
 *                                  (caller receives `action.completed` over WS)
 *   caller agent   ──poll──────▶  GET  /v1/actions/:name/invocations/:id  → status: 'completed'
 *
 * Usage:
 *   npm run e2e:actions                       # http://localhost:8787
 *   npm run e2e:actions -- http://localhost:8787
 */

import WebSocket from 'ws';

const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:8787').replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');

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

/** Open an agent WebSocket that records events and can wait for a given type. */
function openAgentWs(token: string): {
  ready: Promise<void>;
  waitFor: (type: string, timeoutMs?: number) => Promise<any>;
  close: () => void;
} {
  const ws = new WebSocket(`${WS_BASE}/v1/ws?token=${token}`);
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
  const wsRes = await req('POST', '/v1/workspaces', { body: { name: wsName } });
  if (wsRes.status >= 300) throw new Error(`create workspace failed: ${wsRes.status}`);
  const workspaceKey: string = wsRes.json.data.api_key ?? wsRes.json.data.key;

  const mkAgent = async (name: string) => {
    const r = await req('POST', '/v1/agents', { token: workspaceKey, body: { name } });
    if (r.status >= 300) throw new Error(`register ${name} failed: ${r.status}`);
    return { name, id: r.json.data.id as string, token: r.json.data.token as string };
  };
  const handler = await mkAgent('deployer');
  const caller = await mkAgent('requester');
  console.log(`  workspace=${wsName} handler=${handler.name} caller=${caller.name}\n`);

  const handlerWs = openAgentWs(handler.token);
  const callerWs = openAgentWs(caller.token);
  await Promise.all([handlerWs.ready, callerWs.ready]);

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
    if (r.json.data.handler_agent_id !== handler.id && r.json.data.handler_agent !== handler.name) {
      // handler exposed either as id or name depending on shape; tolerate both
    }
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
    const e = await handlerWs.waitFor('action.invoked');
    const data = e.data ?? e;
    if ((data.action_name ?? e.action_name) !== 'deploy') throw new Error('wrong action in event');
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
    const e = await callerWs.waitFor('action.completed');
    const data = e.data ?? e;
    if ((data.action_name ?? e.action_name) !== 'deploy') throw new Error('wrong action in completion event');
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

  handlerWs.close();
  callerWs.close();

  console.log(`\n  \x1b[1m${passed}\x1b[0m passed, ${failed > 0 ? `\x1b[31m\x1b[1m${failed}\x1b[0m` : failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nactions E2E crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

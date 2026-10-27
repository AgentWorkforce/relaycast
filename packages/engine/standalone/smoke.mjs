#!/usr/bin/env node
/**
 * Smoke-test a `relaycast-engine` executable end to end.
 *
 *   node standalone/smoke.mjs <binary> [--expect-version <v>]
 *
 * Uses only Node built-ins (Node >= 22 for the global WebSocket), so it runs on
 * a bare CI runner. Checks `--version`, then starts the server on a fresh
 * SQLite file and a free port and drives the HTTP and WebSocket API: health,
 * workspace create, two agent registrations, a DM observed on the observer
 * workspace stream (WebSocket upgrade path), and the recipient's inbox. Finally it restarts the server on the same
 * file (migrations must be idempotent) and confirms the data is still there.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const binary = args[0] && resolve(args[0]);
if (!binary) {
  console.error('usage: smoke.mjs <binary> [--expect-version <v>]');
  process.exit(2);
}
const versionFlag = args.indexOf('--expect-version');
const expectVersion = versionFlag === -1 ? undefined : args[versionFlag + 1];

function assert(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`);
}

function step(name) {
  console.log(`- ${name}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function start(db, port, cwd) {
  const child = spawn(binary, ['--db', db, '--port', String(port)], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })));
  return { child, exited, output: () => output };
}

async function waitHealthy(base, server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`server exited early:\n${server.output()}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return res.json();
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not become healthy:\n${server.output()}`);
}

async function stop(server) {
  if (process.platform === 'win32') {
    // No POSIX signals on Windows; a hard kill is the only option.
    server.child.kill();
    await server.exited;
    return;
  }
  server.child.kill('SIGTERM');
  const result = await Promise.race([
    server.exited,
    new Promise((r) => setTimeout(() => r(null), 10_000)),
  ]);
  if (result === null) {
    server.child.kill('SIGKILL');
    throw new Error(`server did not stop on SIGTERM:\n${server.output()}`);
  }
  assert(result.code === 0, `server exited with ${JSON.stringify(result)} on SIGTERM:\n${server.output()}`);
}

async function api(base, method, path, token, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  assert(res.ok && json.ok, `${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.data;
}

function openStream(base, token) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(token)}`);
  const events = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    let parsed;
    try { parsed = JSON.parse(String(event.data)); } catch { return; }
    events.push(parsed);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const opened = new Promise((resolveOpen, reject) => {
    ws.addEventListener('open', () => resolveOpen(), { once: true });
    ws.addEventListener('error', () => reject(new Error('observer WebSocket failed to open')), { once: true });
  });
  async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for stream event; saw ${JSON.stringify(events.map((e) => e.type))}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, remaining);
      });
    }
  }
  return { opened, waitFor, close: () => ws.close() };
}

const dir = mkdtempSync(join(tmpdir(), 'relaycast-engine-smoke-'));
const db = join(dir, 'relaycast.db');
let server;
try {
  step('--version');
  const printed = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  assert(/^\d+\.\d+\.\d+/.test(printed), `--version printed ${JSON.stringify(printed)}`);
  if (expectVersion) assert(printed === expectVersion, `--version printed ${printed}, expected ${expectVersion}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = start(db, port, dir);

  step('GET /health');
  const health = await waitHealthy(base, server);
  assert(health.ok === true, `health ${JSON.stringify(health)}`);

  step('create workspace');
  const workspace = await api(base, 'POST', '/v1/workspaces', undefined, { name: 'smoke' });
  assert(workspace.api_key, 'workspace api_key missing');

  step('register two agents');
  const alice = await api(base, 'POST', '/v1/agents', workspace.api_key, { name: 'alice', type: 'agent' });
  const bob = await api(base, 'POST', '/v1/agents', workspace.api_key, { name: 'bob', type: 'agent' });
  assert(alice.token && bob.token, 'agent token missing');

  step('open the observer workspace stream');
  const observer = await api(base, 'POST', '/v1/observer-tokens', workspace.api_key, {
    name: 'smoke-observer',
    scopes: ['stream:read', 'dms:read', 'messages:read'],
    filters: { include_dms: true },
  });
  const stream = openStream(base, observer.token);
  await stream.opened;

  step('send a DM');
  const text = `hello from the standalone smoke test ${Date.now()}`;
  await api(base, 'POST', '/v1/dm', alice.token, { to: 'bob', text, mode: 'wait' });

  step('observe the DM on the stream');
  await stream.waitFor((event) => JSON.stringify(event).includes(text));
  stream.close();

  step("read the recipient's inbox");
  const inbox = await api(base, 'GET', '/v1/inbox', bob.token);
  const unread = inbox.unread_dms ?? [];
  assert(
    unread.some((dm) => dm.from === 'alice' && (dm.unread_count ?? 0) >= 1),
    `inbox has no unread DM from alice: ${JSON.stringify(inbox)}`,
  );

  step('stop (SIGTERM) and restart on the same database');
  await stop(server);
  server = start(db, port, dir);
  await waitHealthy(base, server);
  const agents = await api(base, 'GET', '/v1/agents', workspace.api_key);
  const names = agents.map((agent) => agent.name).sort();
  assert(names.includes('alice') && names.includes('bob'), `agents after restart: ${JSON.stringify(names)}`);
  await stop(server);
  server = undefined;

  console.log(`ok: ${binary} (${printed})`);
} catch (err) {
  if (server) console.error(server.output());
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  if (server && server.child.exitCode === null) server.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

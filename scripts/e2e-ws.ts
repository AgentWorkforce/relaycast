#!/usr/bin/env npx tsx
/**
 * E2E WebSocket test script.
 *
 * Validates the full message flow:
 *   HTTP POST message → engine → Redis pub/sub → WS broadcast → transform → client receives ServerEvent
 *
 * Prerequisites:
 *   1. docker compose up -d            (Postgres on 5433, Redis on 6379)
 *   2. npm run dev -w packages/server   (or let this script start it)
 *
 * Usage:
 *   npx tsx scripts/e2e-ws.ts                           # auto-start server
 *   SERVER_URL=http://localhost:8080 npx tsx scripts/e2e-ws.ts  # use running server
 */

import { createServer, type Server as HttpServer } from 'node:http';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const EXTERNAL_SERVER = process.env.SERVER_URL; // if set, skip in-process server
const TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function fail(msg: string): never {
  throw new Error(msg);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms): ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function api(
  base: string,
  method: string,
  path: string,
  body?: object,
  token?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data: json };
}

// ---------------------------------------------------------------------------
// WS helpers
// ---------------------------------------------------------------------------
function connectWs(base: string, token: string): Promise<{ ws: WebSocket; clientId: string }> {
  const wsUrl = base.replace(/^http/, 'ws') + `/v1/stream?token=${token}`;
  const ws = new WebSocket(wsUrl);

  return new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connected') {
        resolve({ ws, clientId: msg.client_id });
      }
    });
    ws.on('error', reject);
  });
}

function sendAndReceive(ws: WebSocket, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    ws.send(JSON.stringify(msg));
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

// ---------------------------------------------------------------------------
// In-process server setup (when no external server)
// ---------------------------------------------------------------------------
let httpServer: HttpServer | undefined;

async function startInProcessServer(): Promise<string> {
  // Set env for local DB/Redis before importing server modules
  process.env.DATABASE_URL ??= 'postgresql://relay:relay@localhost:5433/relay';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.TIGRIS_ENDPOINT ??= 'http://localhost:9000';
  process.env.TIGRIS_ACCESS_KEY ??= 'minioadmin';
  process.env.TIGRIS_SECRET_KEY ??= 'minioadmin';
  process.env.TIGRIS_BUCKET ??= 'relay-files';
  process.env.STRIPE_SECRET_KEY ??= 'sk_test_xxx';
  process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_xxx';
  process.env.NODE_ENV ??= 'development';

  const { app } = await import('../packages/server/src/app.js');
  const { runMigrations } = await import('../packages/server/src/db/migrate.js');
  const { getDb } = await import('../packages/server/src/db/index.js');
  const { startWsServer } = await import('../packages/server/src/ws/server.js');
  const { setupPubSubListener } = await import('../packages/server/src/ws/pubsub.js');
  const { connectRedisSub } = await import('../packages/server/src/redis/index.js');

  console.log('  Initializing DB...');
  getDb();
  await runMigrations();

  httpServer = createServer(app);
  startWsServer(httpServer);
  await connectRedisSub();
  setupPubSubListener();

  const port = await new Promise<number>((resolve) => {
    httpServer!.listen(0, () => {
      const addr = httpServer!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return `http://localhost:${port}`;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name}... `);
  try {
    await withTimeout(fn(), TIMEOUT_MS, name);
    console.log('PASS');
    results.push({ name, passed: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL: ${msg}`);
    results.push({ name, passed: false, error: msg });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== Relaycast E2E WebSocket Tests ===\n');

  // Determine server URL
  let baseUrl: string;
  if (EXTERNAL_SERVER) {
    baseUrl = EXTERNAL_SERVER;
    console.log(`Using external server: ${baseUrl}\n`);
  } else {
    console.log('Starting in-process server...');
    try {
      baseUrl = await withTimeout(startInProcessServer(), 30_000, 'server start');
    } catch (err) {
      console.error('\nFailed to start server. Make sure docker compose is running:');
      console.error('  docker compose up -d\n');
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    console.log(`  Server running at ${baseUrl}\n`);
  }

  // Shared state across tests
  let workspaceKey = '';
  let agentToken = '';
  let agentName = '';
  const channelName = `e2e-ws-${Date.now()}`;

  // ---- Test 1: Create workspace ----
  await test('Create workspace', async () => {
    const workspaceName = `e2e-ws-${Date.now()}`;
    const res = await api(baseUrl, 'POST', '/v1/workspaces', { name: workspaceName });
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    assert(res.data.ok === true, 'Response not ok');
    const data = res.data.data as Record<string, unknown>;
    workspaceKey = data.api_key as string;
    assert(workspaceKey.startsWith('rk_live_'), `Invalid key format: ${workspaceKey}`);
  });

  // ---- Test 2: Register agent ----
  await test('Register agent', async () => {
    agentName = `e2e-bot-${Date.now()}`;
    const res = await api(baseUrl, 'POST', '/v1/agents', { name: agentName, type: 'agent' }, workspaceKey);
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    const data = res.data.data as Record<string, unknown>;
    agentToken = data.token as string;
    assert(agentToken.startsWith('at_live_'), `Invalid token format: ${agentToken}`);
  });

  // ---- Test 3: Create channel ----
  await test('Create channel', async () => {
    const res = await api(baseUrl, 'POST', '/v1/channels', { name: channelName, topic: 'E2E test' }, agentToken);
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    const data = res.data.data as Record<string, unknown>;
    assert(data.name === channelName, `Channel name mismatch: ${data.name}`);
  });

  // ---- Test 4: WS connect + handshake ----
  let ws: WebSocket | undefined;
  let clientId = '';
  await test('WebSocket connect + handshake', async () => {
    const result = await connectWs(baseUrl, agentToken);
    ws = result.ws;
    clientId = result.clientId;
    assert(typeof clientId === 'string' && clientId.length > 0, 'No client_id in handshake');
  });

  // ---- Test 5: Subscribe to channel ----
  await test('Subscribe to channel', async () => {
    assert(ws !== undefined, 'WS not connected');
    const res = await sendAndReceive(ws!, { type: 'subscribe', channels: [channelName] });
    assert(res.type === 'subscribed', `Expected subscribed, got ${res.type}: ${JSON.stringify(res)}`);
    const channels = res.channels as string[];
    assert(channels.includes(channelName), `Channel ${channelName} not in subscribed list`);
  });

  // ---- Test 6: Post message via HTTP and receive via WS ----
  await test('HTTP POST message → WS event delivery (message.created)', async () => {
    assert(ws !== undefined, 'WS not connected');

    // Set up listener BEFORE posting
    const eventPromise = nextMessage(ws!, 10_000);

    // Post message via HTTP API
    const msgText = `E2E test message ${Date.now()}`;
    const postRes = await api(
      baseUrl,
      'POST',
      `/v1/channels/${channelName}/messages`,
      { text: msgText },
      agentToken,
    );
    assert(postRes.status === 201, `POST message failed: ${postRes.status} ${JSON.stringify(postRes.data)}`);

    // Wait for WS event
    const event = await eventPromise;

    // Verify ServerEvent shape (NOT raw WsEvent)
    assert(event.type === 'message.created', `Expected message.created, got ${event.type}`);
    assert(event.channel === channelName, `Expected channel ${channelName}, got ${event.channel}`);

    const message = event.message as Record<string, unknown>;
    assert(typeof message === 'object' && message !== null, 'Missing message object');
    assert(message.text === msgText, `Text mismatch: expected "${msgText}", got "${message.text}"`);
    assert(message.agent_name === agentName, `Agent name mismatch: expected "${agentName}", got "${message.agent_name}"`);
    assert(typeof message.id === 'string', 'Missing message.id');

    // Internal fields must NOT be present
    assert(!('workspace_id' in event), 'workspace_id should be stripped');
    assert(!('channel_id' in event), 'channel_id should be stripped');
    assert(!('data' in event), 'raw data field should be stripped');
    assert(!('timestamp' in event), 'timestamp should be stripped');
  });

  // ---- Test 7: DM delivery via WS ----
  let agent2Token = '';
  await test('DM delivery via WS (dm.received)', async () => {
    // Register a second agent to send the DM
    const agent2Name = `e2e-sender-${Date.now()}`;
    const regRes = await api(baseUrl, 'POST', '/v1/agents', { name: agent2Name, type: 'agent' }, workspaceKey);
    assert(regRes.status === 201, `Agent2 registration failed: ${regRes.status}`);
    agent2Token = ((regRes.data.data as Record<string, unknown>).token) as string;

    // Connect WS for agent1 is already done — listen for DM
    const dmPromise = nextMessage(ws!, 10_000);

    // Send DM from agent2 to agent1
    const dmRes = await api(baseUrl, 'POST', '/v1/dm', { to: agentName, text: 'hello via DM' }, agent2Token);
    assert(dmRes.status === 201, `DM send failed: ${dmRes.status} ${JSON.stringify(dmRes.data)}`);

    // Wait for WS event
    const event = await dmPromise;
    assert(event.type === 'dm.received', `Expected dm.received, got ${event.type}`);
    assert(typeof event.conversation_id === 'string', 'Missing conversation_id');

    const message = event.message as Record<string, unknown>;
    assert(message.text === 'hello via DM', `DM text mismatch: ${message.text}`);
    assert(!('workspace_id' in event), 'workspace_id should be stripped');
    assert(!('data' in event), 'raw data field should be stripped');
  });

  // ---- Test 8: Unsubscribe stops events ----
  await test('Unsubscribe stops channel events', async () => {
    assert(ws !== undefined, 'WS not connected');

    // Unsubscribe
    const unsub = await sendAndReceive(ws!, { type: 'unsubscribe', channels: [channelName] });
    assert(unsub.type === 'unsubscribed', `Expected unsubscribed, got ${unsub.type}`);
    const remaining = unsub.channels as string[];
    assert(!remaining.includes(channelName), `Channel ${channelName} still subscribed`);

    // Post another message — should NOT arrive
    let received = false;
    ws!.once('message', () => { received = true; });

    await api(
      baseUrl,
      'POST',
      `/v1/channels/${channelName}/messages`,
      { text: 'should not be received' },
      agentToken,
    );

    // Wait briefly
    await new Promise((r) => setTimeout(r, 500));
    assert(!received, 'Received a message after unsubscribe');
  });

  // ---- Cleanup ----
  if (ws) ws.close();

  // Cleanup workspace
  try {
    await api(baseUrl, 'DELETE', '/v1/workspace', undefined, workspaceKey);
  } catch {
    // ignore cleanup errors
  }

  // ---- Summary ----
  console.log('\n--- Results ---');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests\n`);

  // Shutdown
  if (httpServer) {
    httpServer.close();
    // Close DB and Redis connections
    try {
      const { closeDb } = await import('../packages/server/src/db/index.js');
      const { closeRedis } = await import('../packages/server/src/redis/index.js');
      closeDb();
      await closeRedis();
    } catch {
      // ignore
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  if (httpServer) httpServer.close();
  process.exit(1);
});

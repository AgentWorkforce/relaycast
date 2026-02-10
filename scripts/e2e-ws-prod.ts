#!/usr/bin/env npx tsx
/**
 * E2E WebSocket test against production Relaycast at relaycast.dev.
 *
 * Tests the full WebSocket lifecycle:
 *   1. Register a test agent via HTTP
 *   2. Connect WebSocket with agent token
 *   3. Verify "connected" handshake
 *   4. Subscribe to a channel
 *   5. Post message via HTTP → receive via WS
 *   6. Send DM → receive via WS
 *   7. Ping/pong keepalive
 *   8. Unsubscribe stops events
 *   9. Graceful disconnect
 *
 * Usage:
 *   RELAY_API_KEY=rk_live_xxx npx tsx scripts/e2e-ws-prod.ts
 *
 * Or use .mcp.json key:
 *   npx tsx scripts/e2e-ws-prod.ts
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL = process.env.RELAY_BASE_URL ?? 'https://api.relaycast.dev';
const TIMEOUT_MS = 15_000;
const RUN_ID = Date.now().toString(36);
const __dirname = dirname(fileURLToPath(import.meta.url));

let resolvedApiKey = process.env.RELAY_API_KEY;
if (!resolvedApiKey) {
  // Try to load from .mcp.json
  try {
    const mcpConfig = JSON.parse(
      readFileSync(resolve(__dirname, '..', '.mcp.json'), 'utf8'),
    );
    resolvedApiKey = mcpConfig?.mcpServers?.relaycast?.env?.RELAY_API_KEY;
    if (!resolvedApiKey) {
      console.error('Error: RELAY_API_KEY not set and not found in .mcp.json');
      process.exit(1);
    }
  } catch {
    console.error('Error: RELAY_API_KEY env var required. Set it or ensure .mcp.json exists.');
    process.exit(1);
  }
}

const apiKey = resolvedApiKey!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
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

async function api(
  method: string,
  path: string,
  body?: object,
  token?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, data: json };
}

function connectWs(token: string): Promise<{ ws: WebSocket; clientId: string }> {
  const wsUrl = BASE_URL.replace(/^http/, 'ws') + `/v1/stream?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS handshake timeout')), 10_000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connected') {
        clearTimeout(timer);
        resolve({ ws, clientId: msg.client_id });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendAndReceive(ws: WebSocket, msg: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sendAndReceive timeout')), 10_000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
    ws.send(JSON.stringify(msg));
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${name}... `);
  const start = Date.now();
  try {
    await withTimeout(fn(), TIMEOUT_MS, name);
    const dur = Date.now() - start;
    console.log(`PASS (${dur}ms)`);
    results.push({ name, passed: true, durationMs: dur });
  } catch (err) {
    const dur = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL: ${msg} (${dur}ms)`);
    results.push({ name, passed: false, error: msg, durationMs: dur });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n=== Relaycast Production E2E WebSocket Tests ===');
  console.log(`  Server: ${BASE_URL}`);
  console.log(`  Run ID: ${RUN_ID}\n`);

  // Shared state
  let agentToken = '';
  let agentName = '';
  let agent2Token = '';
  let agent2Name = '';
  const channelName = `e2e-ws-${RUN_ID}`;
  let ws: WebSocket | undefined;

  // ---- Test 1: Register test agent ----
  await test('Register test agent', async () => {
    agentName = `ws-test-${RUN_ID}`;
    const res = await api('POST', '/v1/agents', { name: agentName, type: 'agent', persona: 'WS E2E test agent' }, apiKey);
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
    const data = res.data.data as Record<string, unknown>;
    agentToken = data.token as string;
    assert(agentToken.startsWith('at_live_'), `Invalid token format: ${agentToken}`);
  });

  // ---- Test 2: WebSocket connect + handshake ----
  await test('WebSocket connect + "connected" handshake', async () => {
    const result = await connectWs(agentToken);
    ws = result.ws;
    assert(typeof result.clientId === 'string' && result.clientId.length > 0, 'No client_id in handshake');
    console.log(); // newline before sub-detail
    process.stdout.write(`    client_id: ${result.clientId}\n`);
    process.stdout.write(`    `); // indent for next test line
  });

  // ---- Test 3: Create test channel ----
  await test('Create test channel', async () => {
    const res = await api('POST', '/v1/channels', { name: channelName, topic: 'WS E2E test' }, agentToken);
    assert(res.status === 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.data)}`);
  });

  // ---- Test 4: Subscribe to channel via WS ----
  await test('Subscribe to channel via WS', async () => {
    assert(ws !== undefined, 'WS not connected');
    const res = await sendAndReceive(ws!, { type: 'subscribe', channels: [channelName] });
    assert(res.type === 'subscribed', `Expected subscribed, got ${res.type}: ${JSON.stringify(res)}`);
    const channels = res.channels as string[];
    assert(channels.includes(channelName), `Channel ${channelName} not in subscribed list`);
  });

  // ---- Test 5: HTTP POST message → WS event delivery ----
  await test('HTTP POST message → WS event (message.created)', async () => {
    assert(ws !== undefined, 'WS not connected');

    const eventPromise = nextMessage(ws!);
    const msgText = `E2E prod test ${RUN_ID}`;

    const postRes = await api('POST', `/v1/channels/${channelName}/messages`, { text: msgText }, agentToken);
    assert(postRes.status === 201, `POST failed: ${postRes.status} ${JSON.stringify(postRes.data)}`);

    const event = await eventPromise;
    assert(event.type === 'message.created', `Expected message.created, got ${event.type}`);
    assert(event.channel === channelName, `Expected channel ${channelName}, got ${event.channel}`);

    const message = event.message as Record<string, unknown>;
    assert(message.text === msgText, `Text mismatch: "${message.text}"`);
    assert(message.agent_name === agentName, `Agent name mismatch: "${message.agent_name}"`);
    assert(typeof message.id === 'string', 'Missing message.id');

    // Internal fields must be stripped
    assert(!('workspace_id' in event), 'workspace_id should be stripped');
    assert(!('data' in event), 'raw data field should be stripped');
  });

  // ---- Test 6: DM delivery via WS ----
  await test('DM delivery via WS (dm.received)', async () => {
    assert(ws !== undefined, 'WS not connected');

    // Register a second agent to send the DM
    agent2Name = `ws-sender-${RUN_ID}`;
    const regRes = await api('POST', '/v1/agents', { name: agent2Name, type: 'agent', persona: 'DM sender' }, apiKey);
    assert(regRes.status === 201, `Agent2 registration failed: ${regRes.status}`);
    agent2Token = ((regRes.data.data as Record<string, unknown>).token) as string;

    const dmPromise = nextMessage(ws!);

    const dmRes = await api('POST', '/v1/dm', { to: agentName, text: `DM test ${RUN_ID}` }, agent2Token);
    assert(dmRes.status === 201, `DM send failed: ${dmRes.status} ${JSON.stringify(dmRes.data)}`);

    const event = await dmPromise;
    assert(event.type === 'dm.received', `Expected dm.received, got ${event.type}`);
    assert(typeof event.conversation_id === 'string', 'Missing conversation_id');

    const message = event.message as Record<string, unknown>;
    assert(message.text === `DM test ${RUN_ID}`, `DM text mismatch: ${message.text}`);
    assert(!('workspace_id' in event), 'workspace_id should be stripped');
  });

  // ---- Test 7: Native WS ping/pong keepalive ----
  await test('Native WebSocket ping/pong keepalive', async () => {
    assert(ws !== undefined, 'WS not connected');
    const pongReceived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pong timeout')), 5_000);
      ws!.once('pong', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    ws!.ping();
    await pongReceived;
  });

  // ---- Test 8: Unsubscribe stops events ----
  await test('Unsubscribe stops channel events', async () => {
    assert(ws !== undefined, 'WS not connected');

    const unsub = await sendAndReceive(ws!, { type: 'unsubscribe', channels: [channelName] });
    assert(unsub.type === 'unsubscribed', `Expected unsubscribed, got ${unsub.type}`);

    // Post another message — should NOT arrive via WS
    let received = false;
    ws!.once('message', () => { received = true; });

    await api('POST', `/v1/channels/${channelName}/messages`, { text: 'should not arrive' }, agentToken);

    // Wait briefly
    await new Promise((r) => setTimeout(r, 1500));
    assert(!received, 'Received a channel message after unsubscribe');
  });

  // ---- Test 9: Graceful disconnect ----
  await test('Graceful WebSocket disconnect', async () => {
    assert(ws !== undefined, 'WS not connected');
    const closePromise = new Promise<void>((resolve) => {
      ws!.on('close', () => resolve());
    });
    ws!.close();
    await withTimeout(closePromise, 5_000, 'ws close');
    ws = undefined;
  });

  // ---- Cleanup ----
  console.log('\n  Cleaning up...');
  try {
    await api('DELETE', `/v1/channels/${channelName}`, undefined, apiKey);
  } catch { /* ignore */ }

  // ---- Summary ----
  console.log('\n--- Results ---');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((acc, r) => acc + r.durationMs, 0);
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name} (${r.durationMs}ms)${r.error ? ` — ${r.error}` : ''}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed out of ${results.length} tests (${totalMs}ms total)\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});

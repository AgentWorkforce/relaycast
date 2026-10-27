import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createEngine } from '../dist/engine.js';
import { createNodeRuntime } from '../dist/adapters/node/index.js';

// Consume actual Queue payloads exported by relayfile-cloud's Workerd proof.
// Build the engine and set RELAYFILE_PROOF_EVENTS to that JSON artifact first.
assert.ok(process.env.RELAYFILE_PROOF_EVENTS, 'RELAYFILE_PROOF_EVENTS is required');
const events = JSON.parse(await readFile(process.env.RELAYFILE_PROOF_EVENTS, 'utf8'));
assert.equal(events.length, 5);
const runtime = createNodeRuntime({ dbPath: ':memory:', baseUrl: 'http://localhost:0', migrate: true,
  config: { environment: 'test', relayfileInboundSecret: 'fixture-master' },
  presence: { sweepIntervalMs: 0 }, eventQueue: { pollIntervalMs: 0 } });
runtime.webhookQueue.stop();
const app = createEngine(runtime.deps);
/**
 * Call the in-memory engine with an optional bearer token and JSON body.
 * Fail the proof on HTTP errors and return the successful response data.
 */
async function request(path, token, body) {
  const response = await app.request(path, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `request failed: ${response.status}`);
  return (await response.json()).data;
}
try {
  const ws = await request('/v1/workspaces', null, { name: 'cloud-inbound-proof' });
  const key = ws.api_key ?? ws.key;
  const agent = await request('/v1/agents', key, { name: 'subscriber' });
  await request('/v1/channels/general/join', agent.token, {});
  const target = await request('/v1/integrations/relayfile/inbound-target', key, {
    channel: 'general', provider: 'github', path_glob: '/github/repos/AgentWorkforce/relay/pulls/1815/**',
  });
  const delivered = [];
  for (const event of events) {
    const body = JSON.stringify(event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.request(target.url, { method: 'POST', body, headers: {
      'content-type': 'application/json', 'X-Relay-Event-Id': event.eventId,
      'X-Relay-Timestamp': timestamp,
      'X-Relay-Signature': createHmac('sha256', target.secret).update(`${timestamp}.${body}`).digest('hex'),
    } });
    assert.equal(response.status, 201, `cloud event skipped: ${event.eventId}`);
    delivered.push((await response.json()).data.message_id);
  }
  const inbox = await request('/v1/deliveries', agent.token);
  assert.equal(inbox.filter(item => delivered.includes(item.message_id)).length, 5);
  console.log('PASS: 5 real cloud Queue events reached the signed receiver and subscriber inbox');
} finally { runtime.close(); }

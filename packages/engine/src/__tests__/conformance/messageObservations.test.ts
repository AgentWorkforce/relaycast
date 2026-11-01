import { afterEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents } from '../../db/schema.js';
import { sendDm } from '../../engine/dm.js';
import type { EngineObservation } from '../../ports/telemetry.js';
import { createWorkspace, makeNodeStack, registerAgent } from './harness.js';

afterEach(() => vi.restoreAllMocks());

it.each(['agent', 'human'])('observes persisted %s DM recipients, bounds harnesses and never counts replay twice', async type => {
  const events: EngineObservation[] = [];
  const stack = makeNodeStack({ telemetry: { capture: event => { events.push(event); }, captureException() {} } });
  const { workspaceKey, workspaceId } = await createWorkspace(stack.app, 'message-observations');
  const sender = await registerAgent(stack.app, workspaceKey, 'sender');
  const recipient = await registerAgent(stack.app, workspaceKey, 'recipient');
  await stack.runtime.deps.db.update(agents).set({ metadata: { cli: 'codex', owner_user_id: 'spoof' } }).where(eq(agents.id, sender.agentId));
  await stack.runtime.deps.db.update(agents).set({ type, metadata: { cli: 'claude', owner_user_id: 'spoof' } }).where(eq(agents.id, recipient.agentId));
  const send = () => stack.app.request('/v1/dm', { method: 'POST', headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'application/json', 'Idempotency-Key': 'one-message' }, body: JSON.stringify({ to: 'recipient', text: 'private message' }) });
  const response = await send();
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(JSON.stringify(body)).not.toMatch(/recipient_harness|recipient_type|harness|spoof/);
  expect((await send()).status).toBe(201);
  const observations = events.filter(event => event.kind === 'dm.sent');
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ workspaceId, facts: { sender_harness: 'codex', recipient_type: type, recipient_harness: 'claude-code' } });
  expect(JSON.stringify(observations)).not.toMatch(/spoof|private message/);

  const callback = vi.fn(() => { throw Error('observer'); });
  const result = await sendDm(stack.runtime.deps.db, workspaceId, sender.agentId, { to: 'recipient', text: 'committed' }, { onRecipientResolved: callback });
  expect(result.id).toBeTruthy();
  expect(callback).toHaveBeenCalledOnce();
});

it('installs HTTP completion sampling on the real engine before auth and not-found handling', async () => {
  const capture = vi.fn();
  const stack = makeNodeStack({ telemetryRequestSampleRate: 1, telemetry: { capture, captureException() {} } });
  expect((await stack.app.request('/v1/agents/private@example.com?private=query')).status).toBe(401);
  expect((await stack.app.request('/missing/private@example.com?private=query')).status).toBe(404);
  const completions = capture.mock.calls.map(([event]) => event).filter(event => event.kind === 'request.completed');
  expect(completions.map(event => [event.facts.route_template, event.facts.status_code])).toEqual([['/v1/agents/:name', 401], ['unmatched', 404]]);
  expect(JSON.stringify(completions)).not.toMatch(/example.com|query/);
  vi.restoreAllMocks();
});


it('marks channel messages and channel threads as channels without mistaking DM threads for channels', async () => {
  const events: EngineObservation[] = [];
  const stack = makeNodeStack({ telemetry: { capture: event => { events.push(event); }, captureException() {} } });
  const { workspaceKey } = await createWorkspace(stack.app, 'channel-observations');
  const sender = await registerAgent(stack.app, workspaceKey, 'sender');
  await registerAgent(stack.app, workspaceKey, 'recipient');
  const post = (path: string, body: object) => stack.app.request(path, { method: 'POST', headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const message = await post('/v1/channels/general/messages', { text: 'channel' });
  expect(message.status).toBe(201);
  const { data: channelData } = await message.json() as { data: { id: string } };
  expect((await post(`/v1/messages/${channelData.id}/replies`, { text: 'reply' })).status).toBe(201);
  const dm = await post('/v1/dm', { to: 'recipient', text: 'direct' });
  expect(dm.status).toBe(201);
  const { data: dmData } = await dm.json() as { data: { id: string } };
  expect((await post(`/v1/messages/${dmData.id}/replies`, { text: 'reply' })).status).toBe(201);
  expect(events.filter(event => event.kind === 'message.created' || event.kind === 'thread.reply.created').map(event => event.facts.recipient_type)).toEqual(['channel', 'channel', 'unknown']);
});

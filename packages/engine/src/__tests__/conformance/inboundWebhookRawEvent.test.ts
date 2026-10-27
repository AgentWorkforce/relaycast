import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, type TestStack } from './harness.js';
import { createTrigger } from '../../engine/trigger.js';
import { RAW_WEBHOOK_EVENT_TEXT_LIMIT } from '../../engine/inboundWebhook.js';
import { messageSessions, messages } from '../../db/schema.js';

// A third party (e.g. Roma) may post its own event envelope as-is. The body is
// rendered into the message text only: its fields must never be read as
// message metadata, session_ref or trigger control flags.
describe('POST /v1/hooks/:webhookId raw JSON bodies', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function setupHook(name: string) {
    const ws = await createWorkspace(stack.app, name);
    const create = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'roma', channel: 'general' }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { webhook_id: string; token: string } };
    return { ws, webhookId: created.data.webhook_id, token: created.data.token };
  }

  async function post(hook: { webhookId: string; token: string }, body: unknown) {
    return stack.app.request(`/v1/hooks/${hook.webhookId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.token}` },
      body: JSON.stringify(body),
    });
  }

  type Triggered = { data: { message_id: string; text: string; metadata: Record<string, unknown> } };

  it('delivers a raw body carrying session_ref: null as text without indexing it', async () => {
    const hook = await setupHook('raw-session-ref');
    const rawEvent = { event: 'task.updated', session_ref: null, task: { id: 'roma-42' } };

    const res = await post(hook, rawEvent);
    expect(res.status).toBe(201);
    const body = await res.json() as Triggered;
    expect(body.data.text).toBe(`Webhook roma: ${JSON.stringify(rawEvent)}`);
    expect(body.data.metadata).toEqual({});

    const [row] = await stack.runtime.handle.db
      .select({ sessionRef: messages.sessionRef, metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, body.data.message_id));
    expect(row!.sessionRef).toBeNull();
    expect(row!.metadata).not.toHaveProperty('session_ref');
    expect(row!.metadata).not.toHaveProperty('task');
  });

  it('does not index a raw body string session_ref as replay evidence', async () => {
    const hook = await setupHook('raw-session-ref-string');
    const res = await post(hook, { event: 'task.updated', session_ref: 'roma-session' });
    expect(res.status).toBe(201);

    const ledger = await stack.runtime.handle.db
      .select({ sessionRef: messageSessions.sessionRef })
      .from(messageSessions)
      .where(eq(messageSessions.workspaceId, hook.ws.workspaceId));
    expect(ledger).toEqual([]);
  });

  it('does not let a raw body action_generated: true suppress message triggers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hook = await setupHook('raw-action-generated');
      await createTrigger(stack.runtime.handle.db, hook.ws.workspaceId, {
        channel: 'general',
        action_name: 'no-such-action',
      });

      const res = await post(hook, { event: 'task.updated', action_generated: true, trigger_id: 'x' });
      expect(res.status).toBe(201);
      const body = await res.json() as Triggered;
      expect(body.data.metadata).toEqual({});
      await stack.settle();

      // The trigger ran: dispatch was attempted (and failed, because the
      // action does not exist) rather than being skipped as action output.
      expect(warn).toHaveBeenCalledWith('[trigger] action dispatch failed', expect.objectContaining({
        actionName: 'no-such-action',
        code: 'action_not_found',
        workspaceId: hook.ws.workspaceId,
      }));
    } finally {
      warn.mockRestore();
    }
  });

  it('renders an empty object as JSON text, not a generic event line', async () => {
    const hook = await setupHook('raw-empty');
    const res = await post(hook, {});
    expect(res.status).toBe(201);
    const body = await res.json() as Triggered;
    expect(body.data.text).toBe('Webhook roma: {}');
  });

  it('caps the rendered text of a very large raw body', async () => {
    const hook = await setupHook('raw-large');
    const res = await post(hook, { event: 'bulk', blob: 'x'.repeat(RAW_WEBHOOK_EVENT_TEXT_LIMIT * 2) });
    expect(res.status).toBe(201);
    const body = await res.json() as Triggered;
    expect(body.data.text.startsWith('Webhook roma: {"event":"bulk","blob":"xxx')).toBe(true);
    expect(body.data.text.endsWith('… [truncated]')).toBe(true);
    expect(body.data.text.length).toBe('Webhook roma: '.length + RAW_WEBHOOK_EVENT_TEXT_LIMIT);
  });

  it('keeps envelope behavior: text, message/author and payload metadata', async () => {
    const hook = await setupHook('raw-envelope');

    const textRes = await post(hook, { text: 'deploy started', source: 'ci' });
    expect(textRes.status).toBe(201);
    expect((await textRes.json() as Triggered).data.text).toBe('deploy started');

    const sdkRes = await post(hook, { message: 'deploy done', author: 'CI' });
    expect(sdkRes.status).toBe(201);
    expect((await sdkRes.json() as Triggered).data).toMatchObject({ text: 'deploy done', author: 'CI' });

    const relayfile = { provider: 'slack', path: '/slack/channels/C1' };
    const payloadRes = await post(hook, { payload: { relayfile } });
    expect(payloadRes.status).toBe(201);
    const payloadBody = await payloadRes.json() as Triggered;
    expect(payloadBody.data.text).toBe(`Webhook roma: ${JSON.stringify({ relayfile })}`);
    expect(payloadBody.data.metadata).toEqual({ relayfile });

    // An explicit envelope payload is still metadata, so an invalid
    // session_ref there is still rejected.
    const invalidRes = await post(hook, { text: 'bad ref', payload: { session_ref: null } });
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json() as { error: { code: string } }).error.code).toBe('invalid_session_ref');
  });
});

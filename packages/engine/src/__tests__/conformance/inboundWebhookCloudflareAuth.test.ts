import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeNodeStack, createWorkspace, type TestStack } from './harness.js';
import { messages } from '../../db/tables.js';

// Cloudflare Notifications webhook destinations send their configured secret
// only in the `cf-webhook-auth` header. The hook token is accepted from there
// when no Authorization header is sent, and verified exactly as a bearer token.
describe('POST /v1/hooks/:webhookId cf-webhook-auth', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  async function setupHook(name: string) {
    const ws = await createWorkspace(stack.app, name);
    const create = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'cloudflare', channel: 'general' }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { data: { webhook_id: string; token: string } };
    return { ws, webhookId: created.data.webhook_id, token: created.data.token };
  }

  async function post(webhookId: string, headers: Record<string, string>, body: unknown) {
    return stack.app.request(`/v1/hooks/${webhookId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  type Triggered = { data: { message_id: string; text: string } };
  type Failed = { ok: false; error: { code: string } };

  // Body Cloudflare sends when a destination is saved and tested.
  const cloudflareTestBody = {
    text: 'Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly.',
  };

  it('accepts the hook token from cf-webhook-auth (destination test POST gets 2xx)', async () => {
    const hook = await setupHook('cf-auth-ok');
    const res = await post(hook.webhookId, { 'cf-webhook-auth': hook.token }, cloudflareTestBody);
    expect(res.status).toBe(201);
    const body = await res.json() as Triggered;
    expect(body.data.text).toBe(cloudflareTestBody.text);
  });

  it('rejects a wrong cf-webhook-auth token with 401', async () => {
    const hook = await setupHook('cf-auth-wrong');
    const res = await post(hook.webhookId, { 'cf-webhook-auth': `${hook.token}x` }, cloudflareTestBody);
    expect(res.status).toBe(401);
    expect((await res.json() as Failed).error.code).toBe('webhook_token_invalid');
  });

  it('still requires a token when neither header is sent', async () => {
    const hook = await setupHook('cf-auth-missing');
    const res = await post(hook.webhookId, {}, cloudflareTestBody);
    expect(res.status).toBe(401);
    expect((await res.json() as Failed).error.code).toBe('webhook_token_required');
  });

  it('treats an empty cf-webhook-auth header as no token', async () => {
    const hook = await setupHook('cf-auth-empty');
    const res = await post(hook.webhookId, { 'cf-webhook-auth': '' }, cloudflareTestBody);
    expect(res.status).toBe(401);
    expect((await res.json() as Failed).error.code).toBe('webhook_token_required');
  });

  it('accepts a bearer token and a matching cf-webhook-auth together', async () => {
    const hook = await setupHook('cf-auth-both-match');
    const res = await post(hook.webhookId, {
      authorization: `Bearer ${hook.token}`,
      'cf-webhook-auth': hook.token,
    }, cloudflareTestBody);
    expect(res.status).toBe(201);
  });

  it('refuses a bearer token and cf-webhook-auth that disagree, whichever is right', async () => {
    const hook = await setupHook('cf-auth-both-mismatch');
    for (const headers of [
      { authorization: `Bearer ${hook.token}`, 'cf-webhook-auth': 'wh_live_wrong' },
      { authorization: 'Bearer wh_live_wrong', 'cf-webhook-auth': hook.token },
    ]) {
      const res = await post(hook.webhookId, headers, cloudflareTestBody);
      expect(res.status).toBe(401);
      expect((await res.json() as Failed).error.code).toBe('webhook_token_invalid');
    }
    const rows = await stack.runtime.handle.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.workspaceId, hook.ws.workspaceId));
    expect(rows).toEqual([]);
  });

  it('does not read cf-webhook-auth when a non-bearer Authorization header is sent', async () => {
    const hook = await setupHook('cf-auth-other-scheme');
    const res = await post(hook.webhookId, {
      authorization: `Basic ${hook.token}`,
      'cf-webhook-auth': hook.token,
    }, cloudflareTestBody);
    expect(res.status).toBe(401);
    expect((await res.json() as Failed).error.code).toBe('webhook_token_required');
  });

  it('posts a Cloudflare alert payload with its text as the message text', async () => {
    const hook = await setupHook('cf-auth-alert');
    const alert = {
      name: 'Origin health check',
      text: 'Pool example-pool is unhealthy',
      data: { pool_id: 'pool-1', origin_name: 'origin-a', new_health: 'Unhealthy' },
      ts: 1136214245,
      account_id: 'acct-placeholder',
      policy_id: '00000000-0000-0000-0000-000000000000',
      policy_name: 'origin health',
      alert_type: 'load_balancing_health_alert',
      alert_correlation_id: 'corr-1',
      alert_event: 'ALERT_STATE_EVENT_START',
    };
    const res = await post(hook.webhookId, { 'cf-webhook-auth': hook.token }, alert);
    expect(res.status).toBe(201);
    const body = await res.json() as Triggered;
    expect(body.data.text).toBe(alert.text);

    const [row] = await stack.runtime.handle.db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.id, body.data.message_id));
    expect(row!.body).toBe(alert.text);
  });
});

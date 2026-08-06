import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { startServer, type RunningServer } from '../entrypoints/node.js';

/**
 * End-to-end negative-auth receipts, taken against the real HTTP surface.
 *
 * The unit tests drive the auth provider directly. These drive the server,
 * because the thing that actually has to be true is that a request carrying a
 * revoked credential is refused — on **every** path that accepts that
 * credential, not just the one the provider owns.
 *
 * The A2A webhook is the reason this file exists. It compares
 * `agents.token_hash` itself rather than calling the auth provider, so the
 * provider-level revocation check does not cover it. Before that was fixed,
 * revoking an A2A proxy seat produced a clean `revoked_at`, a passing unit
 * suite, and a credential that still worked here — a false receipt, which is
 * strictly worse than no revocation at all.
 */
describe('agent credential revocation — negative-auth receipts over HTTP', () => {
  let running: RunningServer;
  let base: string;

  beforeAll(async () => {
    running = startServer({
      dbPath: ':memory:',
      port: 0,
      migrate: true,
      config: { environment: 'test' },
    });
    base = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
  });

  afterAll(() => running.stop());

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  async function newWorkspace(name: string): Promise<string> {
    const ws = await api('/v1/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    return ws.body.data.api_key as string;
  }

  function revoke(workspaceKey: string, name: string) {
    return api(`/v1/agents/${name}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
  }

  /** Resolve a token to an identity — read-only, so it probes auth and nothing else. */
  function whoami(token: string) {
    return api('/v1/agent', { headers: { authorization: `Bearer ${token}` } });
  }

  it('refuses a revoked credential on the ordinary agent path', async () => {
    const workspaceKey = await newWorkspace('receipt-plain');
    const created = await api('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ name: 'seat' }),
    });
    const token = created.body.data.token as string;

    expect((await whoami(token)).status).toBe(200);

    const receipt = await revoke(workspaceKey, 'seat');
    expect(receipt.status).toBe(200);
    expect(receipt.body.data).toMatchObject({ revoked: true, already_revoked: false });

    const refused = await whoami(token);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('agent_token_revoked');
  });

  it('refuses a revoked credential on the A2A webhook, which bypasses the auth provider', async () => {
    const workspaceKey = await newWorkspace('receipt-a2a');

    const registered = await api('/v1/a2a/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({
        agent_card: {
          name: 'external-proxy',
          url: 'https://example.invalid/a2a',
          version: '1.0.0',
          skills: [{ name: 'echo' }],
        },
      }),
    });
    expect(registered.status).toBe(201);

    const relayName = registered.body.data.relay_name as string;
    const relayToken = registered.body.data.relay_token as string;
    const webhookPath = new URL(registered.body.data.webhook_url as string).pathname;

    const callWebhook = () =>
      api(webhookPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${relayToken}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'message/send', params: {} }),
      });

    // Before revocation the credential is accepted here. Whatever the handler
    // then does with the payload, it is not an auth refusal.
    const before = await callWebhook();
    expect(before.body?.error?.code).not.toBe('agent_token_revoked');

    expect((await revoke(workspaceKey, relayName)).status).toBe(200);

    const after = await callWebhook();
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('agent_token_revoked');
  });

  it('reports a repeat revoke as already revoked without moving the timestamp', async () => {
    const workspaceKey = await newWorkspace('receipt-idempotent');
    await api('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ name: 'seat' }),
    });

    const first = await revoke(workspaceKey, 'seat');
    const second = await revoke(workspaceKey, 'seat');

    expect(first.body.data.already_revoked).toBe(false);
    expect(second.body.data.already_revoked).toBe(true);
    expect(second.body.data.revoked_at).toBe(first.body.data.revoked_at);
  });

  it('404s on an unknown agent instead of issuing a receipt', async () => {
    const workspaceKey = await newWorkspace('receipt-unknown');

    expect((await revoke(workspaceKey, 'no-such-seat')).status).toBe(404);
  });

  it('refuses to let an agent revoke itself or a peer', async () => {
    const workspaceKey = await newWorkspace('receipt-authz');
    const created = await api('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${workspaceKey}` },
      body: JSON.stringify({ name: 'seat' }),
    });
    const token = created.body.data.token as string;

    const attempt = await api('/v1/agents/seat/revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(attempt.status).toBe(401);
    expect((await whoami(token)).status).toBe(200);
  });
});

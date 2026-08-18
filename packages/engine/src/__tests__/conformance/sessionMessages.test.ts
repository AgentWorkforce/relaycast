import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import { getMessagesBySessionRef } from '../../engine/sessionMessages.js';
import { triggerIntegrationMessage } from '../../engine/inboundWebhook.js';
import type { EngineDb } from '../../ports/database.js';

const SESSION_REF = '1c4cb581-7ce7-4fbe-9fd4-39f61f8a6b6d';

describe('session_ref message lookup and effective retention', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => {
    stack.close();
  });

  async function seedSessionMessage(retention: number | null | undefined, text = 'retained message') {
    const { workspaceId, workspaceKey } = await createWorkspace(stack.app, 'session-lookup');
    const agent = await registerAgent(stack.app, workspaceKey, 'session-writer');
    if (retention !== undefined) {
      stack.runtime.handle.sqlite.prepare(
        'UPDATE workspaces SET retention = ? WHERE id = ?',
      ).run(JSON.stringify({ message_ttl_days: retention }), workspaceId);
    }

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text, data: { session_ref: SESSION_REF } }),
    });
    expect(post.status).toBe(201);
    const posted = await post.json() as { data: { id: string } };

    return { workspaceId, workspaceKey, agent, messageId: posted.data.id };
  }

  async function query(workspaceKey: string) {
    const response = await stack.app.request(
      `/v1/sessions/${encodeURIComponent(SESSION_REF)}/messages?limit=10`,
      { headers: { authorization: `Bearer ${workspaceKey}` } },
    );
    return {
      response,
      body: await response.json() as {
        data: {
          availability: string;
          reason?: string;
          retention: { policy: string; retained_since: string | null };
          messages: Array<{ text: string; metadata: Record<string, unknown> }>;
        };
      },
    };
  }

  it('must-not-fire: resolves a retained session inside the workspace window', async () => {
    const { workspaceKey } = await seedSessionMessage(30);

    const { response, body } = await query(workspaceKey);

    expect(response.status).toBe(200);
    expect(body.data.availability).toBe('retained');
    expect(body.data.retention.policy).toBe('window');
    expect(body.data.retention.retained_since).toEqual(expect.any(String));
    expect(body.data.messages).toEqual([
      expect.objectContaining({
        text: 'retained message',
        metadata: { session_ref: SESSION_REF },
      }),
    ]);

    const workspaceResponse = await stack.app.request('/v1/workspace', {
      headers: { authorization: `Bearer ${workspaceKey}` },
    });
    const workspaceBody = await workspaceResponse.json() as {
      data: { effective_retention: { messages: { policy: string; retained_since: string } } };
    };
    expect(workspaceBody.data.effective_retention.messages).toMatchObject({
      policy: 'window',
      retained_since: expect.any(String),
    });
  });

  it('must-fire: reports an aged-out session without rendering it replayable', async () => {
    const { workspaceId, workspaceKey } = await seedSessionMessage(30, 'expired message');
    const oldSeconds = Math.floor(Date.now() / 1_000) - 45 * 24 * 60 * 60;
    stack.runtime.handle.sqlite.prepare(
      'UPDATE messages SET created_at = ? WHERE workspace_id = ? AND session_ref = ?',
    ).run(oldSeconds, workspaceId, SESSION_REF);
    stack.runtime.handle.sqlite.prepare(
      'UPDATE message_sessions SET first_message_at = ?, last_message_at = ? WHERE workspace_id = ? AND session_ref = ?',
    ).run(oldSeconds, oldSeconds, workspaceId, SESSION_REF);

    const { body } = await query(workspaceKey);

    expect(body.data.availability).toBe('aged_out');
    expect(body.data.availability).not.toBe('retained');
    expect(body.data.messages).toEqual([]);
  });

  it('keeps a never-prune workspace retained regardless of session age', async () => {
    const { workspaceId, workspaceKey } = await seedSessionMessage(null, 'cold-storage message');
    const oldSeconds = Math.floor(Date.now() / 1_000) - 400 * 24 * 60 * 60;
    stack.runtime.handle.sqlite.prepare(
      'UPDATE messages SET created_at = ? WHERE workspace_id = ? AND session_ref = ?',
    ).run(oldSeconds, workspaceId, SESSION_REF);
    stack.runtime.handle.sqlite.prepare(
      'UPDATE message_sessions SET first_message_at = ?, last_message_at = ? WHERE workspace_id = ? AND session_ref = ?',
    ).run(oldSeconds, oldSeconds, workspaceId, SESSION_REF);

    const { body } = await query(workspaceKey);

    expect(body.data.availability).toBe('retained');
    expect(body.data.retention).toMatchObject({
      policy: 'never_prune',
      retained_since: null,
    });
    expect(body.data.messages).toEqual([
      expect.objectContaining({ text: 'cold-storage message' }),
    ]);
  });

  it('reports partial coverage when a session crosses the live boundary', async () => {
    const { workspaceId, workspaceKey } = await seedSessionMessage(30, 'retained tail');
    const oldSeconds = Math.floor(Date.now() / 1_000) - 45 * 24 * 60 * 60;
    stack.runtime.handle.sqlite.prepare(
      'UPDATE message_sessions SET first_message_at = ? WHERE workspace_id = ? AND session_ref = ?',
    ).run(oldSeconds, workspaceId, SESSION_REF);

    const { body } = await query(workspaceKey);

    expect(body.data.availability).toBe('partial');
    expect(body.data.availability).not.toBe('retained');
    expect(body.data.messages).toEqual([
      expect.objectContaining({ text: 'retained tail' }),
    ]);
  });

  it('reports an unavailable boundary as unknown, never retained', async () => {
    const { workspaceKey } = await seedSessionMessage(undefined);
    stack.runtime.deps.config!.retention = {};

    const { body } = await query(workspaceKey);

    expect(body.data.availability).toBe('unknown');
    expect(body.data.availability).not.toBe('retained');
    expect(body.data.reason).toBe('boundary_unavailable');
    expect(body.data.retention.policy).toBe('unknown');
    expect(body.data.messages).toEqual([]);
  });

  it('must-fire: reports a query failure as unknown, never retained', async () => {
    const failingDb = new Proxy(stack.runtime.handle.db as unknown as EngineDb, {
      get(target, property) {
        if (property === 'select') {
          return () => {
            throw new Error('injected query failure');
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await getMessagesBySessionRef(
      failingDb,
      'unknown-workspace',
      SESSION_REF,
      { deploymentMessageTtlDays: 30 },
    );

    expect(result.availability).toBe('unknown');
    expect(result.availability).not.toBe('retained');
    expect(result.reason).toBe('query_failed');
    expect(result.messages).toEqual([]);
  });

  it('preserves and indexes session metadata for channel, thread, direct-DM, group-DM, and inbound integration messages', async () => {
    const { workspaceId, workspaceKey, agent, messageId } = await seedSessionMessage(30, 'channel');
    const recipient = await registerAgent(stack.app, workspaceKey, 'session-recipient');

    const reply = await stack.app.request(`/v1/messages/${messageId}/replies`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'thread', data: { session_ref: SESSION_REF } }),
    });
    expect(reply.status).toBe(201);

    const dm = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: recipient.name,
        text: 'direct dm',
        data: { session_ref: SESSION_REF },
      }),
    });
    expect(dm.status).toBe(201);

    const createGroup = await stack.app.request('/v1/dm/group', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ participants: [recipient.name], name: 'replay group' }),
    });
    expect(createGroup.status).toBe(201);
    const group = await createGroup.json() as { data: { id: string } };
    const groupMessage = await stack.app.request(`/v1/dm/${group.data.id}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: 'group dm', data: { session_ref: SESSION_REF } }),
    });
    expect(groupMessage.status).toBe(201);

    const channel = stack.runtime.handle.sqlite.prepare(
      'SELECT id FROM channels WHERE workspace_id = ? AND name = ?',
    ).get(workspaceId, 'general') as { id: string };
    await triggerIntegrationMessage(
      stack.runtime.handle.db,
      workspaceId,
      channel.id,
      {
        text: 'inbound integration',
        source: 'test-source',
        author: 'test-author',
        payload: { session_ref: SESSION_REF },
      },
    );

    const { body } = await query(workspaceKey);
    expect(body.data.availability).toBe('retained');
    expect(body.data.messages.map((message) => message.text)).toEqual([
      'channel',
      'thread',
      'direct dm',
      'group dm',
      'inbound integration',
    ]);
    expect(body.data.messages.every(
      (message) => message.metadata.session_ref === SESSION_REF,
    )).toBe(true);
  });

  it('uses the composite session index and does not fall back to JSON history scans', async () => {
    const { workspaceId } = await seedSessionMessage(30);
    const indexedPlan = stack.runtime.handle.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE workspace_id = ? AND session_ref = ? ORDER BY id LIMIT 10',
    ).all(workspaceId, SESSION_REF) as Array<{ detail: string }>;
    const negativeControl = stack.runtime.handle.sqlite.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE workspace_id = ? AND json_extract(metadata, '$.session_ref') = ? ORDER BY id LIMIT 10",
    ).all(workspaceId, SESSION_REF) as Array<{ detail: string }>;

    expect(indexedPlan.map((row) => row.detail).join('\n')).toContain(
      'idx_messages_workspace_session',
    );
    expect(negativeControl.map((row) => row.detail).join('\n')).not.toContain(
      'idx_messages_workspace_session',
    );
  });

  it('rejects page sizes above the bounded maximum', async () => {
    const { workspaceKey } = await seedSessionMessage(30);

    const response = await stack.app.request(
      `/v1/sessions/${encodeURIComponent(SESSION_REF)}/messages?limit=501`,
      { headers: { authorization: `Bearer ${workspaceKey}` } },
    );

    expect(response.status).toBe(400);
  });
});

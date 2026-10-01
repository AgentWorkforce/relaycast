import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeNodeStack, createWorkspace, registerAgent, type TestStack } from './harness.js';
import {
  getMessagesBySessionRef,
  SessionRefSchema,
  sessionRefFromMetadata,
} from '../../engine/sessionMessages.js';
import { triggerIntegrationMessage } from '../../engine/inboundWebhook.js';
import { snowflakeIdLowerBound } from '../../engine/snowflake.js';
import { getWorkspace } from '../../engine/workspace.js';
import { sha256Hex } from '../../lib/crypto.js';
import { runIdempotent } from '../../middleware/idempotency.js';
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

  it('does not require a valid clock for a never-prune workspace', async () => {
    const { workspaceId } = await seedSessionMessage(null, 'clock-independent cold storage');

    const result = await getMessagesBySessionRef(
      stack.runtime.handle.db,
      workspaceId,
      SESSION_REF,
      { now: new Date(Number.NaN) },
    );

    expect(result.availability).toBe('retained');
    expect(result.retention.policy).toBe('never_prune');
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

  it('reports migrated session history as partial when the true start is unknowable', async () => {
    const { workspaceId, workspaceKey } = await seedSessionMessage(30, 'surviving history');
    stack.runtime.handle.sqlite.prepare(
      'UPDATE message_sessions SET start_is_known = 0 WHERE workspace_id = ? AND session_ref = ?',
    ).run(workspaceId, SESSION_REF);

    const { body } = await query(workspaceKey);

    expect(body.data.availability).toBe('partial');
    expect(body.data.availability).not.toBe('retained');
    expect(body.data.reason).toBe('pre_migration_history_unknown');
    expect((body.data as { session_started_at?: string | null }).session_started_at).toBeNull();
    expect(body.data.messages).toEqual([
      expect.objectContaining({ text: 'surviving history' }),
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'reports a non-finite deployment boundary (%s) as unknown',
    async (messageTtlDays) => {
      const { workspaceKey } = await seedSessionMessage(undefined);
      stack.runtime.deps.config!.retention = { messageTtlDays };

      const { body } = await query(workspaceKey);

      expect(body.data.availability).toBe('unknown');
      expect(body.data.availability).not.toBe('retained');
      expect(body.data.reason).toBe('boundary_unavailable');
    },
  );

  it('keeps a workspace readable when its boundary query fails', async () => {
    const { workspaceId } = await createWorkspace(stack.app, 'workspace-retention-failure');
    let selects = 0;
    const failingRetentionDb = new Proxy(stack.runtime.handle.db as unknown as EngineDb, {
      get(target, property) {
        if (property === 'select') {
          return (...args: unknown[]) => {
            selects += 1;
            if (selects === 2) throw new Error('injected retention failure');
            return Reflect.apply(target.select, target, args);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const workspace = await getWorkspace(failingRetentionDb, workspaceId, 30);

    expect(workspace).not.toBeNull();
    expect(workspace!.effective_retention.messages).toEqual({
      policy: 'unknown',
      message_ttl_days: null,
      retained_since: null,
      source: 'unknown',
      reason: 'boundary_unavailable',
    });
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
    const groupMessageUrl = `/v1/dm/${group.data.id}/messages`;
    const groupMessage = await stack.app.request(groupMessageUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'session-group-metadata',
      },
      body: JSON.stringify({
        text: 'group dm',
        data: { session_ref: SESSION_REF, nested: { z: 2, a: 1 } },
      }),
    });
    expect(groupMessage.status).toBe(201);
    const replayedGroupMessage = await stack.app.request(groupMessageUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'session-group-metadata',
      },
      body: JSON.stringify({
        text: 'group dm',
        data: { nested: { a: 1, z: 2 }, session_ref: SESSION_REF },
      }),
    });
    expect(replayedGroupMessage.status).toBe(201);
    expect(replayedGroupMessage.headers.get('idempotency-replayed')).toBe('true');

    const noMetadata = await stack.app.request(groupMessageUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'session-group-null-metadata',
      },
      body: JSON.stringify({ text: 'no replay marker' }),
    });
    expect(noMetadata.status).toBe(201);
    const nullMetadataReplay = await stack.app.request(groupMessageUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'session-group-null-metadata',
      },
      body: JSON.stringify({ text: 'no replay marker', data: null }),
    });
    expect(nullMetadataReplay.status).toBe(201);
    expect(nullMetadataReplay.headers.get('idempotency-replayed')).toBe('true');

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
      'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE workspace_id = ? AND session_ref = ? ORDER BY length(id), id LIMIT 10',
    ).all(workspaceId, SESSION_REF) as Array<{ detail: string }>;
    const indexedRangePlan = stack.runtime.handle.sqlite.prepare(
      'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE workspace_id = ? AND session_ref = ? AND (length(id), id) >= (?, ?) ORDER BY length(id), id LIMIT 10',
    ).all(workspaceId, SESSION_REF, 1, '0') as Array<{ detail: string }>;
    const negativeControl = stack.runtime.handle.sqlite.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE workspace_id = ? AND json_extract(metadata, '$.session_ref') = ? ORDER BY id LIMIT 10",
    ).all(workspaceId, SESSION_REF) as Array<{ detail: string }>;

    expect(indexedPlan.map((row) => row.detail).join('\n')).toContain(
      'idx_messages_workspace_session',
    );
    expect(indexedRangePlan.map((row) => row.detail).join('\n')).toContain(
      'idx_messages_workspace_session',
    );
    expect(indexedRangePlan.map((row) => row.detail).join('\n')).not.toContain(
      'USE TEMP B-TREE',
    );
    expect(negativeControl.map((row) => row.detail).join('\n')).not.toContain(
      'idx_messages_workspace_session',
    );
  });

  it('replays a group-DM record written with the pre-canonical fingerprint', async () => {
    const { workspaceId, workspaceKey } = await createWorkspace(stack.app, 'legacy-group-idempotency');
    const sender = await registerAgent(stack.app, workspaceKey, 'legacy-group-sender');
    const recipient = await registerAgent(stack.app, workspaceKey, 'legacy-group-recipient');
    const createGroup = await stack.app.request('/v1/dm/group', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sender.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ participants: [recipient.name] }),
    });
    const group = await createGroup.json() as { data: { id: string } };
    const data = { session_ref: SESSION_REF, nested: { z: 2, a: 1 } };
    const text = 'legacy fingerprint replay';
    const legacyFingerprint = JSON.stringify({
      conversationId: group.data.id,
      text,
      data_sha256: await sha256Hex(JSON.stringify(data)),
    });
    await runIdempotent({
      workspaceId,
      actorId: sender.agentId,
      scope: `dm-group-message:${group.data.id}`,
      key: 'legacy-group-fingerprint',
      status: 201,
      fingerprint: legacyFingerprint,
      kv: stack.runtime.deps.kv,
      operation: async () => ({ id: 'legacy-result' }),
    });

    const response = await stack.app.request(`/v1/dm/${group.data.id}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sender.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'legacy-group-fingerprint',
      },
      body: JSON.stringify({ text, data }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('idempotency-replayed')).toBe('true');
  });

  it('does not silently drop retained messages with missing relational display rows', async () => {
    const { workspaceId, agent } = await seedSessionMessage(30, 'orphaned display rows');
    stack.runtime.handle.sqlite.exec('PRAGMA foreign_keys = OFF');
    stack.runtime.handle.sqlite.prepare('DELETE FROM agents WHERE id = ?').run(agent.agentId);
    stack.runtime.handle.sqlite.prepare(
      'DELETE FROM channels WHERE workspace_id = ? AND name = ?',
    ).run(workspaceId, 'general');

    const result = await getMessagesBySessionRef(
      stack.runtime.handle.db,
      workspaceId,
      SESSION_REF,
      { deploymentMessageTtlDays: null },
    );

    expect(result.availability).toBe('retained');
    expect(result.messages).toEqual([
      expect.objectContaining({
        text: 'orphaned display rows',
        agent_name: 'unknown',
        channel_name: 'unknown',
      }),
    ]);
  });

  it('rejects page sizes above the bounded maximum', async () => {
    const { workspaceKey } = await seedSessionMessage(30);

    const response = await stack.app.request(
      `/v1/sessions/${encodeURIComponent(SESSION_REF)}/messages?limit=501`,
      { headers: { authorization: `Bearer ${workspaceKey}` } },
    );

    expect(response.status).toBe(400);
  });

  it('normalizes a non-finite direct-call limit to a bounded default', async () => {
    const { workspaceId } = await seedSessionMessage(30);

    const result = await getMessagesBySessionRef(
      stack.runtime.handle.db,
      workspaceId,
      SESSION_REF,
      { deploymentMessageTtlDays: 30, limit: Number.NaN },
    );

    expect(result.availability).toBe('retained');
    expect(result.messages).toHaveLength(1);
  });

  it('rejects an invalid session_ref on trusted message writers', async () => {
    const { workspaceKey } = await createWorkspace(stack.app, 'invalid-session-ref');
    const sender = await registerAgent(stack.app, workspaceKey, 'invalid-ref-sender');
    const recipient = await registerAgent(stack.app, workspaceKey, 'invalid-ref-recipient');
    const invalidRef = '😀'.repeat(256);
    const headers = {
      authorization: `Bearer ${sender.token}`,
      'content-type': 'application/json',
    };

    const channel = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'invalid channel ref', data: { session_ref: invalidRef } }),
    });
    const dm = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: recipient.name,
        text: 'invalid dm ref',
        data: { session_ref: invalidRef },
      }),
    });

    expect(channel.status).toBe(400);
    expect(await channel.json()).toMatchObject({ error: { code: 'invalid_session_ref' } });
    expect(dm.status).toBe(400);
    expect(await dm.json()).toMatchObject({ error: { code: 'invalid_session_ref' } });
  });

  it('orders, filters, and paginates snowflakes numerically across a digit transition', async () => {
    const { workspaceId, workspaceKey } = await createWorkspace(stack.app, 'numeric-session-order');
    const agent = await registerAgent(stack.app, workspaceKey, 'numeric-writer');
    stack.runtime.handle.sqlite.prepare(
      'UPDATE workspaces SET retention = ? WHERE id = ?',
    ).run(JSON.stringify({ message_ttl_days: 30 }), workspaceId);
    const channel = stack.runtime.handle.sqlite.prepare(
      'SELECT id FROM channels WHERE workspace_id = ? AND name = ?',
    ).get(workspaceId, 'general') as { id: string };

    const firstEighteenDigitId = 100_000_000_000_000_000n;
    const snowflakeTick = 1n << 22n;
    const boundaryDeltaMs = (firstEighteenDigitId + snowflakeTick - 1n) / snowflakeTick;
    const boundaryMs = Date.UTC(2025, 0, 1) + Number(boundaryDeltaMs);
    const oldId = (firstEighteenDigitId - 1n).toString();
    const newId = snowflakeIdLowerBound(boundaryMs);
    expect(oldId).toHaveLength(17);
    expect(newId).toHaveLength(18);

    const oldSeconds = Math.floor(boundaryMs / 1_000) - 1;
    const newSeconds = Math.ceil(boundaryMs / 1_000);
    const insertMessage = stack.runtime.handle.sqlite.prepare(`
      INSERT INTO messages (
        id, workspace_id, channel_id, agent_id, body, metadata, session_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertMessage.run(
      oldId,
      workspaceId,
      channel.id,
      agent.agentId,
      'before transition',
      JSON.stringify({ session_ref: SESSION_REF }),
      SESSION_REF,
      oldSeconds,
    );
    insertMessage.run(
      newId,
      workspaceId,
      channel.id,
      agent.agentId,
      'after transition',
      JSON.stringify({ session_ref: SESSION_REF }),
      SESSION_REF,
      newSeconds,
    );
    stack.runtime.handle.sqlite.prepare(`
      INSERT INTO message_sessions (
        workspace_id, session_ref, first_message_at, last_message_at, start_is_known
      ) VALUES (?, ?, ?, ?, 1)
    `).run(workspaceId, SESSION_REF, oldSeconds, newSeconds);

    const windowed = await getMessagesBySessionRef(
      stack.runtime.handle.db,
      workspaceId,
      SESSION_REF,
      { now: new Date(boundaryMs + 30 * 24 * 60 * 60 * 1_000) },
    );
    expect(windowed.availability).toBe('partial');
    expect(windowed.messages.map((message) => message.id)).toEqual([newId]);

    stack.runtime.handle.sqlite.prepare(
      'UPDATE workspaces SET retention = ? WHERE id = ?',
    ).run(JSON.stringify({ message_ttl_days: null }), workspaceId);
    const firstPage = await getMessagesBySessionRef(
      stack.runtime.handle.db,
      workspaceId,
      SESSION_REF,
      { limit: 1 },
    );
    expect(firstPage.messages.map((message) => message.id)).toEqual([oldId]);
    expect(firstPage.page).toEqual({ next_cursor: oldId, has_more: true });

    const secondPage = await getMessagesBySessionRef(
      stack.runtime.handle.db,
      workspaceId,
      SESSION_REF,
      { limit: 1, after: oldId },
    );
    expect(secondPage.messages.map((message) => message.id)).toEqual([newId]);
    expect(secondPage.page.has_more).toBe(false);
  });

  it('counts Unicode code points consistently at the session_ref length boundary', () => {
    const accepted = '😀'.repeat(255);
    expect(sessionRefFromMetadata({ session_ref: accepted })).toBe(accepted);
    expect(sessionRefFromMetadata({ session_ref: `${accepted}😀` })).toBeNull();
    const empty = SessionRefSchema.safeParse('');
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe(
        'session_ref must contain at least 1 character',
      );
    }
  });
});

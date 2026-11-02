import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  D1_MAX_BOUND_PARAMETERS,
  enforceD1ParameterLimit,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

const CONVERSATION_COUNT = 151;

function seedDmConversations(
  stack: TestStack,
  workspaceId: string,
  agentId: string,
  count: number,
): void {
  const sqlite = stack.runtime.handle.sqlite;
  const insertAgent = sqlite.prepare(`
    INSERT INTO agents (id, workspace_id, name, token_hash)
    VALUES (?, ?, ?, ?)
  `);
  const insertChannel = sqlite.prepare(`
    INSERT INTO channels (id, workspace_id, name, channel_type, created_by)
    VALUES (?, ?, ?, 1, ?)
  `);
  const insertConversation = sqlite.prepare(`
    INSERT INTO dm_conversations (id, workspace_id, channel_id, dm_type, created_at)
    VALUES (?, ?, ?, '1:1', ?)
  `);
  const insertParticipant = sqlite.prepare(`
    INSERT INTO dm_participants (conversation_id, agent_id)
    VALUES (?, ?)
  `);
  const insertMember = sqlite.prepare(`
    INSERT INTO channel_members (channel_id, agent_id)
    VALUES (?, ?)
  `);
  const insertMessage = sqlite.prepare(`
    INSERT INTO messages (id, workspace_id, channel_id, agent_id, body)
    VALUES (?, ?, ?, ?, ?)
  `);

  sqlite.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const reverseSuffix = String(count - index).padStart(3, '0');
      const peerId = `agent_peer_${suffix}`;
      const channelId = `channel_dm_${suffix}`;
      const conversationId = `dm_conversation_${reverseSuffix}`;

      insertAgent.run(peerId, workspaceId, `peer-${suffix}`, `token-hash-${suffix}`);
      insertChannel.run(channelId, workspaceId, `dm-${suffix}`, agentId);
      insertConversation.run(conversationId, workspaceId, channelId, 1_700_000_000);
      insertParticipant.run(conversationId, agentId);
      insertParticipant.run(conversationId, peerId);
      insertMember.run(channelId, agentId);
      insertMember.run(channelId, peerId);
      insertMessage.run(`message_${suffix}`, workspaceId, channelId, peerId, `message ${suffix}`);
    }
  })();
}

describe('DM inbox scaling', () => {
  let stack: TestStack;
  let agentToken: string;

  beforeEach(async () => {
    stack = makeNodeStack();
    const workspace = await createWorkspace(stack.app, 'dm-scale');
    const agent = await registerAgent(stack.app, workspace.workspaceKey, 'coordinator');
    agentToken = agent.token;
    seedDmConversations(stack, workspace.workspaceId, agent.agentId, CONVERSATION_COUNT);
  });

  afterEach(() => stack.close());

  it('lists more than 150 DM conversations without exceeding D1 parameter limits', async () => {
    const guard = enforceD1ParameterLimit(stack);
    try {
      const response = await stack.app.request('/v1/dm/conversations', {
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { data: Array<{ id: string }> };
      expect(body.data).toHaveLength(CONVERSATION_COUNT);

      const limitedResponse = await stack.app.request('/v1/dm/conversations?limit=25', {
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect(limitedResponse.status).toBe(200);
      const limitedBody = await limitedResponse.json() as { data: Array<{ id: string }> };
      expect(limitedBody.data).toHaveLength(25);
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      guard.restore();
    }
  });

  it('rejects a DM conversation limit above 100', async () => {
    const response = await stack.app.request('/v1/dm/conversations?limit=101', {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(response.status).toBe(400);
  });

  it('keeps expected participant errors out of global error logs', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await stack.app.request('/v1/dm/unknown-conversation/messages', {
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { code: 'forbidden', message: 'Not a participant in this conversation' },
      });
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('lets history read failures reach the global handler for logging and telemetry', async () => {
    const captureException = vi.spyOn(stack.runtime.deps.telemetry, 'captureException');
    const sqlite = stack.runtime.handle.sqlite;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    const path = '/v1/dm/dm_conversation_151/messages';
    sqlite.prepare = ((source: string) => {
      if (source.includes('from "dm_participants"')) {
        throw new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.');
      }
      return originalPrepare(source);
    }) as typeof sqlite.prepare;

    try {
      const response = await stack.app.request(path, {
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: { code: 'internal_error', message: 'Internal server error', request_id: expect.any(String) },
      });
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'D1_ERROR: D1 DB is overloaded. Requests queued for too long.' }),
        expect.objectContaining({ path, method: 'GET', status_code: 500, error_code: 'internal_error' }),
      );
    } finally {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare;
    }
  });

  it('lists same-second conversations in newest-first insertion order', async () => {
    const response = await stack.app.request('/v1/dm/conversations?limit=25', {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((conversation) => conversation.id)).toEqual(
      Array.from(
        { length: 25 },
        (_, index) => `dm_conversation_${String(index + 1).padStart(3, '0')}`,
      ),
    );
  });

  it('checks an inbox with more than 150 unread DMs without exceeding D1 parameter limits', async () => {
    const guard = enforceD1ParameterLimit(stack);
    try {
      const response = await stack.app.request('/v1/inbox', {
        headers: { authorization: `Bearer ${agentToken}` },
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { data: { unread_dms: Array<{ conversation_id: string }> } };
      expect(body.data.unread_dms).toHaveLength(CONVERSATION_COUNT);
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      guard.restore();
    }
  });
});

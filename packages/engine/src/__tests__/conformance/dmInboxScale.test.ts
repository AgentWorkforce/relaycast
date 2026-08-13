import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

const CONVERSATION_COUNT = 151;
const D1_MAX_BOUND_PARAMETERS = 100;

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

/**
 * better-sqlite3 accepts far more parameters than hosted D1. Guard prepare()
 * at D1's real 100-parameter ceiling so a regression cannot pass locally while
 * still failing in production.
 */
function enforceD1ParameterLimit(stack: TestStack): {
  maxObserved: () => number;
  restore: () => void;
} {
  const sqlite = stack.runtime.handle.sqlite;
  const originalPrepare = sqlite.prepare.bind(sqlite);
  let maxObserved = 0;

  sqlite.prepare = ((source: string) => {
    const parameterCount = source.match(/\?/g)?.length ?? 0;
    maxObserved = Math.max(maxObserved, parameterCount);
    if (parameterCount > D1_MAX_BOUND_PARAMETERS) {
      throw new Error(
        `D1_ERROR: too many bound parameters (${parameterCount}; maximum ${D1_MAX_BOUND_PARAMETERS})`,
      );
    }
    return originalPrepare(source);
  }) as typeof sqlite.prepare;

  return {
    maxObserved: () => maxObserved,
    restore: () => {
      sqlite.prepare = originalPrepare as typeof sqlite.prepare;
    },
  };
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getAgentStats,
  getConsoleOverview,
  getCostStats,
  listMessageLogs,
  logMessage,
} from '../console.js';

describe('console engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs messages with all supported fields', async () => {
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const db = { insert } as any;

    await logMessage(db, {
      workspaceId: 'ws_123',
      messageId: 'msg_123',
      channelId: 'chan_123',
      agentId: 'agent_123',
      conversationId: 'conv_123',
      deliveryKind: 'dm',
      body: 'Certification completed',
      contentType: 'text/markdown',
      metadata: {
        model: 'gpt-5.4',
        _cost: {
          total_usd: 0.042,
          prompt_tokens: 1200,
          completion_tokens: 200,
          total_tokens: 1400,
        },
      },
      attachmentCount: 2,
      mentionCount: 3,
      latencyMs: 850,
    });

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws_123',
      messageId: 'msg_123',
      channelId: 'chan_123',
      agentId: 'agent_123',
      conversationId: 'conv_123',
      deliveryKind: 'dm',
      body: 'Certification completed',
      contentType: 'text/markdown',
      metadata: {
        model: 'gpt-5.4',
        _cost: {
          total_usd: 0.042,
          prompt_tokens: 1200,
          completion_tokens: 200,
          total_tokens: 1400,
        },
      },
      attachmentCount: 2,
      mentionCount: 3,
      latencyMs: 850,
    }));
    expect(values.mock.calls[0]?.[0].id).toEqual(expect.any(String));
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it('maps listed message logs to the public snake_case response shape', async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        id: 'log_2',
        messageId: 'msg_2',
        channelId: 'chan_9',
        channelName: 'ops',
        agentId: 'agent_2',
        agentName: 'ConsoleBot',
        conversationId: 'conv_2',
        deliveryKind: 'dm',
        body: 'usage report',
        contentType: 'text/plain',
        metadata: { model: 'gpt-5.4-mini' },
        attachmentCount: 1,
        mentionCount: 0,
        latencyMs: 320,
        createdAt: new Date('2026-03-20T10:00:00.000Z'),
      },
    ]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const leftJoinSecond = vi.fn().mockReturnValue({ where });
    const leftJoinFirst = vi.fn().mockReturnValue({ leftJoin: leftJoinSecond });
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoinFirst });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as any;

    const result = await listMessageLogs(db, 'ws_123', {
      limit: 200,
      before: 'log_9',
      agentId: 'agent_2',
      channelId: 'chan_9',
      conversationId: 'conv_2',
      deliveryKind: 'dm',
    });

    expect(result).toEqual([
      {
        id: 'log_2',
        message_id: 'msg_2',
        channel_id: 'chan_9',
        channel_name: 'ops',
        agent_id: 'agent_2',
        agent_name: 'ConsoleBot',
        conversation_id: 'conv_2',
        delivery_kind: 'dm',
        text: 'usage report',
        content_type: 'text/plain',
        metadata: { model: 'gpt-5.4-mini' },
        attachment_count: 1,
        mention_count: 0,
        latency_ms: 320,
        created_at: '2026-03-20T10:00:00.000Z',
      },
    ]);
    expect(limit).toHaveBeenCalledWith(100);
  });

  it('aggregates console overview metrics', async () => {
    const where = vi.fn().mockResolvedValue([{
      totalMessages: 4,
      channelMessages: 3,
      dmMessages: 1,
      uniqueAgents: 2,
      avgLatencyMs: 188,
      maxLatencyMs: 400,
      attachments: 5,
      mentions: 2,
    }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as any;

    const result = await getConsoleOverview(db, 'ws_123', 14);

    expect(result).toMatchObject({
      window_days: 14,
      total_messages: 4,
      channel_messages: 3,
      dm_messages: 1,
      unique_agents: 2,
      avg_latency_ms: 188,
      max_latency_ms: 400,
      attachment_count: 5,
      mention_count: 2,
    });
    expect(new Date(result.since).toString()).not.toBe('Invalid Date');
  });

  it('aggregates per-agent stats and cost totals', async () => {
    const all = vi.fn()
      .mockResolvedValueOnce([
        {
          agent_id: 'agent_1',
          agent_name: 'LeadAgent',
          message_count: 3,
          channel_count: 2,
          dm_count: 1,
          avg_latency_ms: 210,
          last_message_at: 1_763_028_000,
        },
        {
          agent_id: 'agent_2',
          agent_name: 'InfraAgent',
          message_count: 1,
          channel_count: 0,
          dm_count: 1,
          avg_latency_ms: 95,
          last_message_at: 1_763_024_400,
        },
      ])
      .mockResolvedValueOnce([
        {
          agent_id: 'agent_1',
          agent_name: 'LeadAgent',
          message_count: 2,
          total_cost_usd: 0.05,
          prompt_tokens: 1000,
          completion_tokens: 250,
          total_tokens: 1250,
        },
        {
          agent_id: 'agent_2',
          agent_name: 'InfraAgent',
          message_count: 1,
          total_cost_usd: 0.015,
          prompt_tokens: 300,
          completion_tokens: 100,
          total_tokens: 400,
        },
      ]);
    const db = { all } as any;

    const agentStats = await getAgentStats(db, 'ws_123', 7, 10);
    const costStats = await getCostStats(db, 'ws_123', 7);

    expect(agentStats).toEqual([
      {
        agent_id: 'agent_1',
        agent_name: 'LeadAgent',
        message_count: 3,
        channel_count: 2,
        dm_count: 1,
        avg_latency_ms: 210,
        last_message_at: '2025-11-13T10:00:00.000Z',
      },
      {
        agent_id: 'agent_2',
        agent_name: 'InfraAgent',
        message_count: 1,
        channel_count: 0,
        dm_count: 1,
        avg_latency_ms: 95,
        last_message_at: '2025-11-13T09:00:00.000Z',
      },
    ]);
    expect(costStats).toEqual({
      window_days: 7,
      totals: {
        total_cost_usd: 0.065,
        prompt_tokens: 1300,
        completion_tokens: 350,
        total_tokens: 1650,
      },
      agents: [
        {
          agent_id: 'agent_1',
          agent_name: 'LeadAgent',
          message_count: 2,
          total_cost_usd: 0.05,
          prompt_tokens: 1000,
          completion_tokens: 250,
          total_tokens: 1250,
        },
        {
          agent_id: 'agent_2',
          agent_name: 'InfraAgent',
          message_count: 1,
          total_cost_usd: 0.015,
          prompt_tokens: 300,
          completion_tokens: 100,
          total_tokens: 400,
        },
      ],
    });
    expect(all).toHaveBeenCalledTimes(2);
  });
});

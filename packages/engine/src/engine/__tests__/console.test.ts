import { describe, expect, it } from 'vitest';
import {
  summarizeAgentStats,
  summarizeConsoleOverview,
  summarizeCostStats,
  type ConsoleMessageLog,
} from '../console.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a synthetic ConsoleMessageLog. Only the fields consumed by the pure
 * summarizers matter; everything else gets deterministic defaults.
 */
function log(overrides: Partial<ConsoleMessageLog> = {}): ConsoleMessageLog {
  return {
    id: 'log-1',
    message_id: 'msg-1',
    channel_id: 'chan-1',
    channel_name: 'general',
    channel_type: 0,
    agent_id: 'agent-1',
    agent_name: 'Agent One',
    conversation_id: null,
    delivery_kind: 'channel',
    text: 'hello',
    content_type: null,
    metadata: {},
    attachment_count: 0,
    mention_count: 0,
    latency_ms: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function costLog(
  agentId: string,
  agentName: string | null,
  cost: Record<string, unknown>,
): ConsoleMessageLog {
  return log({ agent_id: agentId, agent_name: agentName, metadata: { _cost: cost } });
}

describe('summarizeConsoleOverview', () => {
  it('returns all-zero aggregates for empty input', () => {
    const result = summarizeConsoleOverview([]);
    expect(result.total_messages).toBe(0);
    expect(result.channel_messages).toBe(0);
    expect(result.dm_messages).toBe(0);
    expect(result.unique_agents).toBe(0);
    expect(result.avg_latency_ms).toBe(0);
    expect(result.max_latency_ms).toBe(0);
    expect(result.attachment_count).toBe(0);
    expect(result.mention_count).toBe(0);
    expect(result.window_days).toBe(7);
  });

  it('aggregates counts, unique agents, latency, attachments and mentions', () => {
    const logs = [
      log({ agent_id: 'a', delivery_kind: 'channel', latency_ms: 10, attachment_count: 2, mention_count: 1 }),
      log({ agent_id: 'a', delivery_kind: 'dm', latency_ms: 15, attachment_count: 0, mention_count: 3 }),
      log({ agent_id: 'b', delivery_kind: 'channel', latency_ms: 40, attachment_count: 5, mention_count: 0 }),
    ];
    const result = summarizeConsoleOverview(logs);
    expect(result.total_messages).toBe(3);
    expect(result.channel_messages).toBe(2);
    expect(result.dm_messages).toBe(1);
    expect(result.unique_agents).toBe(2); // 'a' counted once
    // total latency = 65, 65/3 = 21.666... -> Math.round -> 22
    expect(result.avg_latency_ms).toBe(22);
    expect(result.max_latency_ms).toBe(40);
    expect(result.attachment_count).toBe(7);
    expect(result.mention_count).toBe(4);
  });

  it('rounds (not truncates) the average latency at the .5 boundary', () => {
    const logs = [log({ latency_ms: 10 }), log({ latency_ms: 15 })];
    // 25 / 2 = 12.5 -> Math.round -> 13 (would be 12 if truncated)
    expect(summarizeConsoleOverview(logs).avg_latency_ms).toBe(13);
  });

  it('passes windowDays through and derives `since` from it', () => {
    const before = Date.now();
    const result = summarizeConsoleOverview([], 3);
    expect(result.window_days).toBe(3);
    const since = Date.parse(result.since);
    const delta = before - since; // should be ~3 days
    expect(delta).toBeGreaterThanOrEqual(3 * DAY_MS - 5_000);
    expect(delta).toBeLessThanOrEqual(3 * DAY_MS + 5_000);
  });
});

describe('summarizeAgentStats', () => {
  it('groups per agent with per-kind counts, rounded avg latency and last message', () => {
    const logs = [
      log({ agent_id: 'a', agent_name: 'A', delivery_kind: 'channel', latency_ms: 10, created_at: '2026-07-01T00:00:00.000Z' }),
      log({ agent_id: 'a', agent_name: 'A', delivery_kind: 'channel', latency_ms: 20, created_at: '2026-07-03T00:00:00.000Z' }),
      log({ agent_id: 'a', agent_name: 'A', delivery_kind: 'dm', latency_ms: 30, created_at: '2026-07-02T00:00:00.000Z' }),
    ];
    const [row] = summarizeAgentStats(logs);
    expect(row.agent_id).toBe('a');
    expect(row.agent_name).toBe('A');
    expect(row.message_count).toBe(3);
    expect(row.channel_count).toBe(2);
    expect(row.dm_count).toBe(1);
    expect(row.avg_latency_ms).toBe(20); // (10+20+30)/3
    expect(row.last_message_at).toBe('2026-07-03T00:00:00.000Z'); // max created_at
  });

  it('orders agents by message_count descending', () => {
    const logs = [
      log({ agent_id: 'few', agent_name: 'Few' }),
      log({ agent_id: 'many', agent_name: 'Many' }),
      log({ agent_id: 'many', agent_name: 'Many' }),
      log({ agent_id: 'many', agent_name: 'Many' }),
    ];
    const rows = summarizeAgentStats(logs);
    expect(rows.map((r) => r.agent_id)).toEqual(['many', 'few']);
    expect(rows[0].message_count).toBe(3);
    expect(rows[1].message_count).toBe(1);
  });

  it('breaks message_count ties by most recent last_message first', () => {
    // Names are chosen so alphabetical order CONTRADICTS recency order:
    // the newer agent sorts later by name, so only the recency key produces
    // the expected order (isolates the tie-breaker from the name fallback).
    const logs = [
      log({ agent_id: 'older', agent_name: 'Alpha', created_at: '2026-07-04T00:00:00.000Z' }),
      log({ agent_id: 'older', agent_name: 'Alpha', created_at: '2026-07-04T00:00:00.000Z' }),
      log({ agent_id: 'newer', agent_name: 'Zeta', created_at: '2026-07-05T00:00:00.000Z' }),
      log({ agent_id: 'newer', agent_name: 'Zeta', created_at: '2026-07-05T00:00:00.000Z' }),
    ];
    // both have message_count 2 -> newer last_message wins despite later name
    expect(summarizeAgentStats(logs).map((r) => r.agent_id)).toEqual(['newer', 'older']);
  });

  it('breaks message_count + recency ties by agent_name ascending (null name sorts first)', () => {
    const logs = [
      log({ agent_id: 'z', agent_name: 'Zeta', created_at: '2026-07-05T00:00:00.000Z' }),
      log({ agent_id: 'a', agent_name: 'Alpha', created_at: '2026-07-05T00:00:00.000Z' }),
      log({ agent_id: 'n', agent_name: null, created_at: '2026-07-05T00:00:00.000Z' }),
    ];
    // identical count (1) and identical last_message_ms -> localeCompare on name;
    // null coalesces to '' which sorts ahead of every non-empty name.
    expect(summarizeAgentStats(logs).map((r) => r.agent_name)).toEqual([null, 'Alpha', 'Zeta']);
  });

  it('rounds (not truncates) the per-agent avg latency at the .5 boundary', () => {
    const logs = [
      log({ agent_id: 'a', agent_name: 'A', latency_ms: 10 }),
      log({ agent_id: 'a', agent_name: 'A', latency_ms: 15 }),
    ];
    // 25 / 2 = 12.5 -> Math.round -> 13 (would be 12 if truncated)
    expect(summarizeAgentStats(logs)[0].avg_latency_ms).toBe(13);
  });

  it('applies the top-N limit after sorting', () => {
    const logs = [
      log({ agent_id: 'a', agent_name: 'A' }),
      log({ agent_id: 'a', agent_name: 'A' }),
      log({ agent_id: 'a', agent_name: 'A' }),
      log({ agent_id: 'b', agent_name: 'B' }),
      log({ agent_id: 'b', agent_name: 'B' }),
      log({ agent_id: 'c', agent_name: 'C' }),
    ];
    const rows = summarizeAgentStats(logs, 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.agent_id)).toEqual(['a', 'b']); // top 2 by count
  });

  it('clamps a limit of 0 up to 1 (clampLimit floor)', () => {
    const logs = [
      log({ agent_id: 'a', agent_name: 'A' }),
      log({ agent_id: 'a', agent_name: 'A' }),
      log({ agent_id: 'b', agent_name: 'B' }),
    ];
    const rows = summarizeAgentStats(logs, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe('a');
  });

  it('yields null last_message_at when created_at is unparseable', () => {
    const rows = summarizeAgentStats([log({ agent_id: 'a', agent_name: 'A', created_at: 'not-a-date' })]);
    expect(rows[0].last_message_at).toBeNull();
  });

  it('returns an empty array for empty input', () => {
    expect(summarizeAgentStats([])).toEqual([]);
  });
});

describe('summarizeCostStats', () => {
  it('returns zero totals and no agents for empty input', () => {
    const result = summarizeCostStats([]);
    expect(result.window_days).toBe(7);
    expect(result.agents).toEqual([]);
    expect(result.totals).toEqual({
      total_cost_usd: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it('sums per-agent cost/tokens including numeric-string values', () => {
    const logs = [
      costLog('a', 'A', { total_usd: 0.5, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
      // string values must be coerced by costNumber
      costLog('a', 'A', { total_usd: '0.25', prompt_tokens: '10', completion_tokens: '5', total_tokens: '15' }),
    ];
    const { agents } = summarizeCostStats(logs);
    expect(agents).toHaveLength(1);
    const [a] = agents;
    expect(a.message_count).toBe(2);
    expect(a.total_cost_usd).toBeCloseTo(0.75, 10);
    expect(a.prompt_tokens).toBe(110);
    expect(a.completion_tokens).toBe(55);
    expect(a.total_tokens).toBe(165);
  });

  it('excludes agents with no cost/token signal and reflects that in totals', () => {
    const logs = [
      costLog('paid', 'Paid', { total_usd: 2, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
      // all-zero / non-finite -> costNumber returns 0 -> filtered out
      costLog('free', 'Free', { total_usd: 'abc', prompt_tokens: Infinity, completion_tokens: NaN, total_tokens: 0 }),
      log({ agent_id: 'nometa', agent_name: 'NoMeta' }), // metadata {} -> no _cost
    ];
    const result = summarizeCostStats(logs);
    expect(result.agents.map((r) => r.agent_id)).toEqual(['paid']);
    // totals derived only from included agents
    expect(result.totals.total_cost_usd).toBe(2);
    expect(result.totals.total_tokens).toBe(2);
  });

  it('includes an agent that has tokens but zero cost', () => {
    const logs = [
      costLog('tokensonly', 'TokensOnly', { total_usd: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 100 }),
    ];
    const result = summarizeCostStats(logs);
    expect(result.agents.map((r) => r.agent_id)).toEqual(['tokensonly']);
    expect(result.agents[0].total_cost_usd).toBe(0);
    expect(result.agents[0].total_tokens).toBe(100);
  });

  it('includes agents whose only signal is prompt_tokens or completion_tokens', () => {
    // Exercises the prompt_tokens>0 and completion_tokens>0 OR-terms of the
    // inclusion filter in isolation (cost and total_tokens both zero).
    const promptOnly = summarizeCostStats([
      costLog('p', 'P', { total_usd: 0, prompt_tokens: 7, completion_tokens: 0, total_tokens: 0 }),
    ]);
    expect(promptOnly.agents.map((r) => r.agent_id)).toEqual(['p']);
    expect(promptOnly.agents[0].prompt_tokens).toBe(7);

    const completionOnly = summarizeCostStats([
      costLog('c', 'C', { total_usd: 0, prompt_tokens: 0, completion_tokens: 9, total_tokens: 0 }),
    ]);
    expect(completionOnly.agents.map((r) => r.agent_id)).toEqual(['c']);
    expect(completionOnly.agents[0].completion_tokens).toBe(9);
  });

  it('orders agents by total_cost_usd descending', () => {
    const logs = [
      costLog('cheap', 'Cheap', { total_usd: 0.75 }),
      costLog('pricey', 'Pricey', { total_usd: 2.0 }),
    ];
    expect(summarizeCostStats(logs).agents.map((r) => r.agent_id)).toEqual(['pricey', 'cheap']);
  });

  it('breaks equal-cost ties by total_tokens descending', () => {
    // Names contradict the token order (higher tokens sorts later by name), so
    // only the total_tokens key yields the expected order.
    const logs = [
      costLog('lowtok', 'Alpha', { total_usd: 1, total_tokens: 200 }),
      costLog('hitok', 'Zeta', { total_usd: 1, total_tokens: 300 }),
    ];
    expect(summarizeCostStats(logs).agents.map((r) => r.agent_id)).toEqual(['hitok', 'lowtok']);
  });

  it('breaks equal-cost + equal-token ties by agent_name ascending', () => {
    const logs = [
      costLog('z', 'Zeta', { total_usd: 1, total_tokens: 100 }),
      costLog('a', 'Alpha', { total_usd: 1, total_tokens: 100 }),
    ];
    expect(summarizeCostStats(logs).agents.map((r) => r.agent_name)).toEqual(['Alpha', 'Zeta']);
  });

  it('accumulates totals across all included agents and passes windowDays through', () => {
    const logs = [
      costLog('a', 'A', { total_usd: 1.5, prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }),
      costLog('b', 'B', { total_usd: 2.5, prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }),
    ];
    const result = summarizeCostStats(logs, 30);
    expect(result.window_days).toBe(30);
    expect(result.totals.total_cost_usd).toBeCloseTo(4.0, 10);
    expect(result.totals.prompt_tokens).toBe(15);
    expect(result.totals.completion_tokens).toBe(25);
    expect(result.totals.total_tokens).toBe(40);
  });
});

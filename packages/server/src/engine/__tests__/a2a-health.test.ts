import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runA2aHealthChecks } from '../a2a-health.js';

interface MockRow {
  id: string;
  workspace_id: string;
  relay_agent_id: string;
  external_url: string;
  health_failures: number;
}

function createMockDb(rows: MockRow[]) {
  const updates: Array<[string, number, string]> = [];

  const db = {
    $client: {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT id, workspace_id, relay_agent_id, external_url, health_failures')) {
          return {
            all: vi.fn().mockResolvedValue({ results: rows }),
          };
        }

        if (sql.includes('UPDATE a2a_agents')) {
          return {
            bind: vi.fn((status: string, healthFailures: number, agentId: string) => {
              updates.push([status, healthFailures, agentId]);
              return {
                run: vi.fn().mockResolvedValue({ success: true }),
              };
            }),
          };
        }

        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    },
  };

  return { db, updates };
}

describe('runA2aHealthChecks', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resets failures and updates last health after a successful ping', async () => {
    const { db, updates } = createMockDb([
      {
        id: 'a2a_1',
        workspace_id: 'ws_1',
        relay_agent_id: 'agent_1',
        external_url: 'https://example.com/agent',
        health_failures: 2,
      },
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const result = await runA2aHealthChecks(db as never);

    expect(fetch).toHaveBeenCalledWith('https://example.com/.well-known/agent-card.json', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(updates).toEqual([['active', 0, 'a2a_1']]);
    expect(result).toEqual({
      checked: 1,
      healthy: 1,
      failed: 0,
      suspended: 0,
    });
  });

  it('increments failures and keeps the agent active before the suspension threshold', async () => {
    const { db, updates } = createMockDb([
      {
        id: 'a2a_2',
        workspace_id: 'ws_1',
        relay_agent_id: 'agent_2',
        external_url: 'https://example.com',
        health_failures: 1,
      },
    ]);
    vi.mocked(fetch).mockResolvedValue(new Response('nope', { status: 503 }));

    const result = await runA2aHealthChecks(db as never);

    expect(updates).toEqual([['active', 2, 'a2a_2']]);
    expect(result).toEqual({
      checked: 1,
      healthy: 0,
      failed: 1,
      suspended: 0,
    });
  });

  it('suspends the agent after the third consecutive failure', async () => {
    const { db, updates } = createMockDb([
      {
        id: 'a2a_3',
        workspace_id: 'ws_1',
        relay_agent_id: 'agent_3',
        external_url: 'https://example.com',
        health_failures: 2,
      },
    ]);
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await runA2aHealthChecks(db as never);

    expect(updates).toEqual([['suspended', 3, 'a2a_3']]);
    expect(result).toEqual({
      checked: 1,
      healthy: 0,
      failed: 1,
      suspended: 1,
    });
  });
});

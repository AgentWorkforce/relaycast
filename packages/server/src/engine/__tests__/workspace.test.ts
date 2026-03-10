import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../snowflake.js', () => ({
  generateId: vi.fn()
    .mockReturnValueOnce('ws_new')
    .mockReturnValueOnce('ch_general'),
}));

import { createWorkspace } from '../workspace.js';

describe('workspace engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates duplicate workspace names without preflight lookup', async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        id: 'ws_new',
        name: 'my-project',
        apiKeyHash: 'hash',
        systemPrompt: null,
        plan: 'free',
        createdAt: new Date('2026-03-10T00:00:00.000Z'),
        metadata: {},
      },
    ]);
    const workspaceInsertValues = vi.fn().mockReturnValue({ returning });
    const channelInsertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn()
      .mockReturnValueOnce({ values: workspaceInsertValues })
      .mockReturnValueOnce({ values: channelInsertValues });
    const select = vi.fn();

    const result = await createWorkspace({ insert, select } as any, 'my-project');

    expect(select).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(2);
    expect(result.workspace_id).toBe('ws_new');
    expect(result.api_key).toMatch(/^rk_live_/);
    expect(result.created_at).toBe('2026-03-10T00:00:00.000Z');
  });
});

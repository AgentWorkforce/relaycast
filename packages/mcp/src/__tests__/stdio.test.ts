import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startStdio: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../transports.js', () => ({
  startStdio: mocks.startStdio,
}));

describe('stdio entrypoint', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    mocks.startStdio.mockClear();
    process.env = { ...originalEnv };
    delete process.env.RELAY_WORKSPACES_JSON;
    delete process.env.RELAY_DEFAULT_WORKSPACE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes RELAY_WORKSPACES_JSON and RELAY_DEFAULT_WORKSPACE to startStdio()', async () => {
    process.env.RELAY_WORKSPACES_JSON = JSON.stringify([
      {
        workspace_id: 'ws_alpha',
        workspace_alias: 'alpha',
        api_key: 'rk_live_alpha',
        agent_token: 'at_live_alpha',
        agent_name: 'Alpha',
      },
      {
        workspace_id: 'ws_beta',
        workspace_alias: 'beta',
        api_key: 'rk_live_beta',
        agent_token: 'at_live_beta',
        agent_name: 'Beta',
      },
    ]);
    process.env.RELAY_DEFAULT_WORKSPACE = 'beta';

    await import('../stdio.js');

    expect(mocks.startStdio).toHaveBeenCalledWith(expect.objectContaining({
      defaultWorkspace: 'beta',
      workspaces: [
        {
          workspaceId: 'ws_alpha',
          workspaceAlias: 'alpha',
          workspaceKey: 'rk_live_alpha',
          agentToken: 'at_live_alpha',
          agentName: 'Alpha',
        },
        {
          workspaceId: 'ws_beta',
          workspaceAlias: 'beta',
          workspaceKey: 'rk_live_beta',
          agentToken: 'at_live_beta',
          agentName: 'Beta',
        },
      ],
    }));
  });
});

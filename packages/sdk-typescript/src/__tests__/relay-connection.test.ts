import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockWorkspaceResponse() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        ok: true,
        data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
      }),
  });
}

describe('RelayCast connection options', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it('constructor supports connection.baseUrl', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({
      apiKey: 'rk_live_test123',
      connection: { baseUrl: 'http://localhost:3200' },
    });

    mockFetch.mockImplementation(() => mockWorkspaceResponse());
    await relay.workspace.info();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3200/v1/workspace');
  });

  it('createWorkspace local mode uses local base URL', async () => {
    const { RelayCast } = await import('../relay.js');
    mockFetch.mockImplementation(() => mockWorkspaceResponse());

    await RelayCast.createWorkspace('Local Workspace', {
      baseUrl: 'http://127.0.0.1:7528',
      local: { autoStart: false },
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:7528/v1/workspaces');
  });

  it('constructor local mode uses default local base URL', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({
      apiKey: 'rk_live_test123',
      connection: { local: true },
    });

    mockFetch.mockImplementation(() => mockWorkspaceResponse());
    await relay.workspace.info();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:7528/v1/workspace');
  });
});

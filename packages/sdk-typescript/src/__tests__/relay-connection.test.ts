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

describe('RelayCast baseUrl options', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it('constructor supports baseUrl', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({
      apiKey: 'rk_live_test123',
      baseUrl: 'http://localhost:3200',
    });

    mockFetch.mockImplementation(() => mockWorkspaceResponse());
    await relay.workspace.info();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://localhost:3200/v1/workspace');
  });

  it('createWorkspace with baseUrl string', async () => {
    const { RelayCast } = await import('../relay.js');
    mockFetch.mockImplementation(() => mockWorkspaceResponse());

    await RelayCast.createWorkspace('Test Workspace', 'http://127.0.0.1:7528');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:7528/v1/workspaces');
  });

  it('createWorkspace defaults to hosted API', async () => {
    const { RelayCast } = await import('../relay.js');
    mockFetch.mockImplementation(() => mockWorkspaceResponse());

    await RelayCast.createWorkspace('Test Workspace');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/workspaces');
  });

  it('createWorkspace supports options object with auth', async () => {
    const { RelayCast } = await import('../relay.js');
    mockFetch.mockImplementation(() => mockWorkspaceResponse());

    await RelayCast.createWorkspace('Test Workspace', {
      apiKey: 'rk_live_existing',
      baseUrl: 'http://127.0.0.1:7528',
    });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:7528/v1/workspaces');
    expect(init.headers.Authorization).toBe('Bearer rk_live_existing');
  });
});

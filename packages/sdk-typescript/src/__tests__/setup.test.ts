import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Promise<Response> {
  const text = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as Response);
}

function textResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
    json: () => Promise.reject(new SyntaxError('Unexpected token')),
  } as Response);
}

describe('RelaycastSetup', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  it.each([200, 201])('createWorkspace() accepts %i success responses', async (status) => {
    const { RelaycastSetup, WorkspaceHandle } = await import('../setup.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          workspace_id: 'ws_1',
          api_key: 'rk_live_workspace',
          created_at: '2026-04-30T12:00:00.000Z',
        },
      }, status),
    );

    const setup = new RelaycastSetup();
    const workspace = await setup.createWorkspace({ name: 'Acme Ops' });

    expect(workspace).toBeInstanceOf(WorkspaceHandle);
    expect(workspace.info).toEqual({
      workspaceId: 'ws_1',
      apiKey: 'rk_live_workspace',
      baseUrl: 'https://api.relaycast.dev',
      createdAt: '2026-04-30T12:00:00.000Z',
      name: 'Acme Ops',
    });
    expect(workspace.workspaceId).toBe('ws_1');
    expect(workspace.apiKey).toBe('rk_live_workspace');

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/workspaces');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-SDK-Version']).toBeDefined();
    expect(init.headers['X-Relaycast-Origin-Surface']).toBe('sdk');
    expect(init.headers['X-Relaycast-Origin-Client']).toBe('@relaycast/sdk');
    expect(init.headers['X-Relaycast-Origin-Version']).toBeDefined();
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ name: 'Acme Ops' });
  });

  it('createWorkspace() uses a custom baseUrl and resolves apiKey functions per request', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    const apiKey = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(' rk_live_setup_1 ')
      .mockResolvedValueOnce('rk_live_setup_2');

    mockFetch
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            workspace_id: 'ws_2',
            api_key: 'rk_live_workspace',
            created_at: '2026-04-30T12:01:00.000Z',
          },
        }, 201),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            id: 'ws_2',
            name: 'Acme Ops',
            created_at: '2026-04-30T12:01:00.000Z',
          },
        }),
      );

    const setup = new RelaycastSetup({
      apiKey,
      baseUrl: 'https://relay.example.test',
    });

    await setup.createWorkspace({ name: 'Acme Ops' });
    await setup.lookupWorkspace('Acme Ops');

    expect(apiKey).toHaveBeenCalledTimes(2);

    const [createUrl, createInit] = mockFetch.mock.calls[0]!;
    expect(createUrl).toBe('https://relay.example.test/v1/workspaces');
    expect(createInit.headers.Authorization).toBe('Bearer rk_live_setup_1');

    const [lookupUrl, lookupInit] = mockFetch.mock.calls[1]!;
    expect(lookupUrl).toBe('https://relay.example.test/v1/workspaces/by-name/Acme%20Ops');
    expect(lookupInit.method).toBe('GET');
    expect(lookupInit.headers.Authorization).toBe('Bearer rk_live_setup_2');
  });

  it('createWorkspace() surfaces API errors with status and body', async () => {
    const { RelaycastSetup } = await import('../setup.js');
    const { RelaycastApiError } = await import('../setup-errors.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: false,
        error: {
          code: 'internal_error',
          message: 'workspace creation failed',
        },
      }, 500),
    );

    const setup = new RelaycastSetup();

    await expect(setup.createWorkspace({ name: 'Broken' })).rejects.toMatchObject({
      constructor: RelaycastApiError,
      code: 'api_error',
      httpStatus: 500,
      message: 'workspace creation failed',
      httpBody: {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'workspace creation failed',
        },
      },
    });
  });

  it('createWorkspace() rejects malformed success envelopes missing workspace_id', async () => {
    const { RelaycastSetup } = await import('../setup.js');
    const { MalformedApiResponseError } = await import('../setup-errors.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          api_key: 'rk_live_workspace',
          created_at: '2026-04-30T12:02:00.000Z',
        },
      }),
    );

    const setup = new RelaycastSetup();

    await expect(setup.createWorkspace({ name: 'Malformed' })).rejects.toMatchObject({
      constructor: MalformedApiResponseError,
      code: 'malformed_api_response',
      field: 'workspace_id',
    });
  });

  it('createWorkspace() rejects non-JSON success responses as malformed', async () => {
    const { RelaycastSetup } = await import('../setup.js');
    const { MalformedApiResponseError } = await import('../setup-errors.js');

    mockFetch.mockImplementation(() => textResponse('not json at all', 200));

    const setup = new RelaycastSetup();

    await expect(setup.createWorkspace({ name: 'Malformed JSON' })).rejects.toMatchObject({
      constructor: MalformedApiResponseError,
      code: 'malformed_api_response',
      field: 'response',
      response: 'not json at all',
    });
  });

  it('createWorkspace() retries retriable responses and eventually succeeds', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    mockFetch
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: false,
          error: {
            code: 'temporarily_unavailable',
            message: 'try again',
          },
        }, 503),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            workspace_id: 'ws_retry',
            api_key: 'rk_live_retry',
            created_at: '2026-04-30T12:03:00.000Z',
          },
        }, 201),
      );

    const setup = new RelaycastSetup({
      retry: {
        maxRetries: 1,
        baseDelayMs: 10,
      },
    });

    const promise = setup.createWorkspace({ name: 'Retry Me' });

    await vi.advanceTimersByTimeAsync(10);
    await expect(promise).resolves.toMatchObject({
      workspaceId: 'ws_retry',
      apiKey: 'rk_live_retry',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    randomSpy.mockRestore();
  });

  it('createWorkspace() honors Retry-After on 429 responses', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    vi.useFakeTimers();

    mockFetch
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: false,
          error: {
            code: 'rate_limited',
            message: 'slow down',
          },
        }, 429, { 'Retry-After': '1' }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            workspace_id: 'ws_rate_limit',
            api_key: 'rk_live_rate_limit',
            created_at: '2026-04-30T12:04:00.000Z',
          },
        }, 201),
      );

    const setup = new RelaycastSetup({
      retry: {
        maxRetries: 1,
        baseDelayMs: 5,
      },
    });

    const promise = setup.createWorkspace({ name: 'Wait Please' });

    await vi.advanceTimersByTimeAsync(999);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({
      workspaceId: 'ws_rate_limit',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('createWorkspace() applies requestTimeoutMs via AbortSignal.timeout()', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    vi.useFakeTimers();

    mockFetch.mockImplementation((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
        });
      }),
    );

    const setup = new RelaycastSetup({
      requestTimeoutMs: 25,
      retry: {
        maxRetries: 0,
        baseDelayMs: 1,
      },
    });

    const promise = setup.createWorkspace({ name: 'Slow Request' });

    await vi.advanceTimersByTimeAsync(25);
    await expect(promise).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  it('joinWorkspace() creates a handle without calling the API', async () => {
    const { RelaycastSetup, WorkspaceHandle } = await import('../setup.js');

    const setup = new RelaycastSetup();
    const workspace = await setup.joinWorkspace('ws_join', ' rk_live_join ');

    expect(workspace).toBeInstanceOf(WorkspaceHandle);
    expect(workspace.info).toEqual({
      workspaceId: 'ws_join',
      apiKey: 'rk_live_join',
      baseUrl: 'https://api.relaycast.dev',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('lookupWorkspace() returns camelCase workspace data when found', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          id: 'ws_lookup',
          name: 'Lookup Workspace',
          created_at: '2026-04-30T12:05:00.000Z',
        },
      }),
    );

    const setup = new RelaycastSetup();
    const result = await setup.lookupWorkspace('Lookup Workspace');

    expect(result).toEqual({
      id: 'ws_lookup',
      name: 'Lookup Workspace',
      createdAt: '2026-04-30T12:05:00.000Z',
    });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/workspaces/by-name/Lookup%20Workspace');
    expect(init.method).toBe('GET');
  });

  it('lookupWorkspace() returns null on 404 per the accepted contract', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: false,
        error: {
          code: 'workspace_not_found',
          message: 'missing',
        },
      }, 404),
    );

    const setup = new RelaycastSetup();

    await expect(setup.lookupWorkspace('Missing Workspace')).resolves.toBeNull();
  });

  it('local mode uses the local daemon baseUrl, and explicit baseUrl still wins', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    const localOnly = await new RelaycastSetup({ local: true }).joinWorkspace('ws_local', 'rk_local');
    const explicit = await new RelaycastSetup({
      local: true,
      baseUrl: 'http://localhost:9999',
    }).joinWorkspace('ws_override', 'rk_override');

    expect(localOnly.info.baseUrl).toBe('http://127.0.0.1:7528');
    expect(explicit.info.baseUrl).toBe('http://localhost:9999');
  });
});

describe('WorkspaceHandle', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  it('registerAgent() sends snake_case JSON and stores camelCase agent records', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          id: 'ag_alice',
          name: 'Alice',
          token: 'at_live_alice',
          status: 'away',
          created_at: '2026-04-30T12:06:00.000Z',
        },
      }),
    );

    const workspace = await new RelaycastSetup().joinWorkspace('ws_agents', 'rk_live_workspace');
    const agent = await workspace.registerAgent({
      name: 'Alice',
      type: 'human',
      persona: 'planner',
      metadata: { favoriteColor: 'blue' },
    });

    expect(agent).toEqual({
      id: 'ag_alice',
      name: 'Alice',
      token: 'at_live_alice',
      type: 'human',
      status: 'away',
      createdAt: '2026-04-30T12:06:00.000Z',
    });
    expect(workspace.getAgentToken('Alice')).toBe('at_live_alice');

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/agents');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rk_live_workspace');
    expect(JSON.parse(init.body)).toEqual({
      name: 'Alice',
      type: 'human',
      persona: 'planner',
      metadata: {
        favorite_color: 'blue',
      },
    });
  });

  it('registerAgent() surfaces duplicate handling conflicts from the API', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: false,
        error: {
          code: 'agent_already_exists',
          message: 'Agent already exists',
        },
      }, 409),
    );

    const workspace = await new RelaycastSetup().joinWorkspace('ws_agents', 'rk_live_workspace');

    await expect(workspace.registerAgent({ name: 'Alice' })).rejects.toMatchObject({
      name: 'RelayError',
      code: 'name_conflict',
      statusCode: 409,
    });
  });

  it('listRegisteredAgents() preserves registration order and replaces duplicate records in place', async () => {
    const { RelaycastSetup } = await import('../setup.js');

    mockFetch
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            id: 'ag_alice_1',
            name: 'Alice',
            token: 'at_live_alice_1',
            status: 'offline',
            created_at: '2026-04-30T12:07:00.000Z',
          },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            id: 'ag_bob',
            name: 'Bob',
            token: 'at_live_bob',
            status: 'online',
            created_at: '2026-04-30T12:07:30.000Z',
          },
        }),
      )
      .mockImplementationOnce(() =>
        jsonResponse({
          ok: true,
          data: {
            id: 'ag_alice_2',
            name: 'Alice',
            token: 'at_live_alice_2',
            status: 'online',
            created_at: '2026-04-30T12:08:00.000Z',
          },
        }),
      );

    const workspace = await new RelaycastSetup().joinWorkspace('ws_agents', 'rk_live_workspace');

    await workspace.registerAgent({ name: 'Alice' });
    await workspace.registerAgent({ name: 'Bob' });
    await workspace.registerAgent({ name: 'Alice' });

    expect(workspace.getAgentToken('Alice')).toBe('at_live_alice_2');
    expect(workspace.getAgentToken('Unknown')).toBeUndefined();
    expect(workspace.listRegisteredAgents()).toEqual([
      {
        id: 'ag_alice_2',
        name: 'Alice',
        token: 'at_live_alice_2',
        type: 'agent',
        status: 'online',
        createdAt: '2026-04-30T12:08:00.000Z',
      },
      {
        id: 'ag_bob',
        name: 'Bob',
        token: 'at_live_bob',
        type: 'agent',
        status: 'online',
        createdAt: '2026-04-30T12:07:30.000Z',
      },
    ]);
  });

  it('relay() returns a cached Relay for registered agents and throws for unknown agents', async () => {
    const { RelaycastSetup } = await import('../setup.js');
    const { AgentNotRegisteredError } = await import('../setup-errors.js');
    const { Relay } = await import('../communicate/relay.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          id: 'ag_alice',
          name: 'Alice',
          token: 'at_live_alice',
          status: 'online',
          created_at: '2026-04-30T12:09:00.000Z',
        },
      }),
    );

    const workspace = await new RelaycastSetup().joinWorkspace('ws_agents', 'rk_live_workspace');
    await workspace.registerAgent({ name: 'Alice' });

    const relayOne = workspace.relay('Alice');
    const relayTwo = workspace.relay('Alice');

    expect(relayOne).toBeInstanceOf(Relay);
    expect(relayOne).toBe(relayTwo);

    expect(() => workspace.relay('Unknown')).toThrowError(AgentNotRegisteredError);
    expect(() => workspace.relay('Unknown')).toThrowError(/Unknown/);
  });

  it('as() returns an AgentClient that sends requests with the provided token', async () => {
    const { RelaycastSetup } = await import('../setup.js');
    const { AgentClient } = await import('../agent.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          id: 'msg_1',
          channel: 'general',
          text: 'hello',
          created_at: '2026-04-30T12:10:00.000Z',
        },
      }),
    );

    const workspace = await new RelaycastSetup({
      baseUrl: 'https://relay.example.test',
    }).joinWorkspace('ws_agents', 'rk_live_workspace');

    const alice = workspace.as('at_live_alice');
    expect(alice).toBeInstanceOf(AgentClient);

    await alice.send('#general', 'hello');

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://relay.example.test/v1/channels/general/messages');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer at_live_alice');
    expect(JSON.parse(init.body)).toEqual({
      text: 'hello',
      mode: 'wait',
    });
  });

  it('relayCast() returns a cached RelayCast configured with workspace credentials', async () => {
    const { RelaycastSetup } = await import('../setup.js');
    const { RelayCast } = await import('../relay.js');

    mockFetch.mockImplementation(() =>
      jsonResponse({
        ok: true,
        data: {
          id: 'ws_agents',
        },
      }),
    );

    const workspace = await new RelaycastSetup({
      baseUrl: 'https://relay.example.test',
    }).joinWorkspace('ws_agents', 'rk_live_workspace');

    const relayCastOne = workspace.relayCast();
    const relayCastTwo = workspace.relayCast();

    expect(relayCastOne).toBeInstanceOf(RelayCast);
    expect(relayCastOne).toBe(relayCastTwo);

    await relayCastOne.workspace.info();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://relay.example.test/v1/workspace');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer rk_live_workspace');
  });
});

describe('@relaycast/sdk exports', () => {
  it('re-exports setup classes, errors, and communicate Relay from index.ts', async () => {
    const sdk = await import('../index.js');
    const setup = await import('../setup.js');
    const errors = await import('../setup-errors.js');
    const communicate = await import('../communicate/relay.js');

    expect(sdk.RelaycastSetup).toBe(setup.RelaycastSetup);
    expect(sdk.WorkspaceHandle).toBe(setup.WorkspaceHandle);
    expect(sdk.AgentNotRegisteredError).toBe(errors.AgentNotRegisteredError);
    expect(sdk.MalformedApiResponseError).toBe(errors.MalformedApiResponseError);
    expect(sdk.MissingApiKeyError).toBe(errors.MissingApiKeyError);
    expect(sdk.RelaycastApiError).toBe(errors.RelaycastApiError);
    expect(sdk.WorkspaceNotFoundError).toBe(errors.WorkspaceNotFoundError);
    expect(sdk.Relay).toBe(communicate.Relay);
    expect(sdk.Relay).not.toBe(sdk.RelayCast);
  });
});

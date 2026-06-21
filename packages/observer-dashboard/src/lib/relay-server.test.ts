import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  orderByRemembered,
  pickRememberedEngine,
  resolveRelayServerCandidatesFromHost,
  selectEngineForKey,
} from './relay-server';

const originalRelayServerUrl = process.env.RELAY_SERVER_URL;

function mockFetch(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      fetchMock.mockRejectedValueOnce(response);
    } else {
      fetchMock.mockResolvedValueOnce(response);
    }
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('relay server resolution', () => {
  beforeEach(() => {
    delete process.env.RELAY_SERVER_URL;
  });

  afterEach(() => {
    if (originalRelayServerUrl === undefined) {
      delete process.env.RELAY_SERVER_URL;
    } else {
      process.env.RELAY_SERVER_URL = originalRelayServerUrl;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves the hosted engine for the production observer', () => {
    expect(resolveRelayServerCandidatesFromHost('observer.relaycast.dev')).toEqual([
      'https://cast.agentrelay.com',
    ]);
  });

  it('resolves the per-environment gateway/api candidates for preview observers', () => {
    expect(resolveRelayServerCandidatesFromHost('pr23-observer.relaycast.dev')).toEqual([
      'https://pr23-gateway.relaycast.dev',
      'https://pr23-api.relaycast.dev',
    ]);
  });

  it('pins explicit server override to a single candidate', () => {
    process.env.RELAY_SERVER_URL = 'https://self-hosted.example.com/';

    expect(resolveRelayServerCandidatesFromHost('observer.relaycast.dev')).toEqual([
      'https://self-hosted.example.com/',
    ]);
  });

  it('only accepts remembered engines from the current host candidates', () => {
    const candidates = [
      'https://pr23-gateway.relaycast.dev',
      'https://pr23-api.relaycast.dev',
    ];

    expect(pickRememberedEngine('https://pr23-api.relaycast.dev', candidates)).toBe(
      'https://pr23-api.relaycast.dev'
    );
    expect(
      pickRememberedEngine('https://attacker.example.com', candidates)
    ).toBeNull();
  });

  it('orders remembered engine first without duplicating candidates', () => {
    expect(
      orderByRemembered(
        ['https://pr23-gateway.relaycast.dev', 'https://pr23-api.relaycast.dev'],
        'https://pr23-api.relaycast.dev'
      )
    ).toEqual(['https://pr23-api.relaycast.dev', 'https://pr23-gateway.relaycast.dev']);
  });
});

describe('selectEngineForKey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the -api engine when the gateway rejects the key', async () => {
    const fetchMock = mockFetch(
      new Response(null, { status: 401 }),
      new Response(null, { status: 200 })
    );

    await expect(
      selectEngineForKey(
        ['https://pr23-gateway.relaycast.dev', 'https://pr23-api.relaycast.dev'],
        'rk_live_test'
      )
    ).resolves.toEqual({
      baseUrl: 'https://pr23-api.relaycast.dev',
      reachedAny: true,
      rejectedAny: true,
      inconclusiveAny: false,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://pr23-gateway.relaycast.dev/v1/workspace',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://pr23-api.relaycast.dev/v1/workspace',
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('marks all-auth-rejection failures as conclusive invalid credentials', async () => {
    mockFetch(
      new Response(null, { status: 401 }),
      new Response(null, { status: 403 })
    );

    await expect(
      selectEngineForKey(
        ['https://pr23-gateway.relaycast.dev', 'https://pr23-api.relaycast.dev'],
        'rk_live_test'
      )
    ).resolves.toEqual({
      baseUrl: null,
      reachedAny: true,
      rejectedAny: true,
      inconclusiveAny: false,
    });
  });

  it('keeps transient failures inconclusive even when fallback rejects the key', async () => {
    mockFetch(
      new Response(null, { status: 503 }),
      new Response(null, { status: 401 })
    );

    await expect(
      selectEngineForKey(
        ['https://pr23-gateway.relaycast.dev', 'https://pr23-api.relaycast.dev'],
        'rk_live_test'
      )
    ).resolves.toEqual({
      baseUrl: null,
      reachedAny: true,
      rejectedAny: true,
      inconclusiveAny: true,
    });
  });

  it('keeps network failures inconclusive when no engine accepts the key', async () => {
    mockFetch(new Error('dns failed'), new Response(null, { status: 401 }));

    await expect(
      selectEngineForKey(
        ['https://pr23-gateway.relaycast.dev', 'https://pr23-api.relaycast.dev'],
        'rk_live_test'
      )
    ).resolves.toEqual({
      baseUrl: null,
      reachedAny: true,
      rejectedAny: true,
      inconclusiveAny: true,
    });
  });

  it('constructs probe URLs correctly for trailing-slash base URLs', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 200 }));

    await selectEngineForKey(['https://self-hosted.example.com/'], 'rk_live_test');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://self-hosted.example.com/v1/workspace',
      expect.any(Object)
    );
  });
});

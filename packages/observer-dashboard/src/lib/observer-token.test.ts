import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintObserverStreamToken } from './observer-token';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

describe('mintObserverStreamToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates a scoped observer token and returns its material', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ ok: true, data: { id: 'ot_1', token: 'ot_live_new' } }, 201)
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBe('ot_live_new');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cast.agentrelay.com/v1/observer-tokens');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rk_live_admin');
    const body = JSON.parse(init.body);
    expect(body.name).toBe('observer-dashboard');
    expect(body.scopes).toContain('stream:read');
    expect(body.scopes).toContain('dms:read');
    expect(body.filters).toEqual({ include_dms: true });
    expect(typeof body.expires_at).toBe('string');
  });

  it('reuses the existing token by rotating it on a name conflict', async () => {
    const fetchMock = mockFetch(
      jsonResponse(
        { ok: false, error: { code: 'observer_token_name_conflict' } },
        409
      ),
      jsonResponse({
        ok: true,
        data: [
          { id: 'ot_old', name: 'observer-dashboard', status: 'active' },
          { id: 'ot_dead', name: 'observer-dashboard', status: 'revoked' },
        ],
      }),
      jsonResponse({ ok: true, data: { id: 'ot_old' } }),
      jsonResponse({ ok: true, data: { id: 'ot_old', token: 'ot_live_rotated' } })
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBe('ot_live_rotated');

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cast.agentrelay.com/v1/observer-tokens',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://cast.agentrelay.com/v1/observer-tokens/ot_old',
      expect.objectContaining({ method: 'PATCH' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://cast.agentrelay.com/v1/observer-tokens/ot_old/rotate',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns null when creation fails for a non-conflict reason', async () => {
    mockFetch(jsonResponse({ ok: false }, 401));

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });

  it('returns null when no active token exists to rotate on conflict', async () => {
    mockFetch(
      jsonResponse({ ok: false }, 409),
      jsonResponse({
        ok: true,
        data: [{ id: 'ot_dead', name: 'observer-dashboard', status: 'revoked' }],
      })
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });

  it('returns null when rotation fails', async () => {
    mockFetch(
      jsonResponse({ ok: false }, 409),
      jsonResponse({
        ok: true,
        data: [{ id: 'ot_old', name: 'observer-dashboard', status: 'active' }],
      }),
      jsonResponse({ ok: true, data: { id: 'ot_old' } }),
      jsonResponse({ ok: false }, 500)
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });

  it('rejects token material that is not an observer token', async () => {
    mockFetch(
      jsonResponse({ ok: true, data: { id: 'ot_1', token: 'rk_live_leaked' } }, 201)
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });
});

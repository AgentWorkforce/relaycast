import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mintObserverStreamToken,
  revokeObserverStreamToken,
} from './observer-token';

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

  it('creates a fresh, uniquely-named scoped token and returns token + id', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ ok: true, data: { id: 'ot_1', token: 'ot_live_new' } }, 201)
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toEqual({ token: 'ot_live_new', id: 'ot_1' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cast.agentrelay.com/v1/observer-tokens');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rk_live_admin');
    const body = JSON.parse(init.body);
    expect(body.name).toMatch(/^observer-dashboard-/);
    expect(body.scopes).toContain('stream:read');
    expect(body.scopes).toContain('dms:read');
    expect(body.filters).toEqual({ include_dms: true });
    expect(typeof body.expires_at).toBe('string');
  });

  it('mints a distinct token name on each call', async () => {
    const fetchMock = mockFetch(
      jsonResponse({ ok: true, data: { id: 'ot_1', token: 'ot_live_a' } }, 201),
      jsonResponse({ ok: true, data: { id: 'ot_2', token: 'ot_live_b' } }, 201)
    );

    await mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin');
    await mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin');

    const nameA = JSON.parse(fetchMock.mock.calls[0][1].body).name;
    const nameB = JSON.parse(fetchMock.mock.calls[1][1].body).name;
    expect(nameA).not.toBe(nameB);
  });

  it('returns null when creation fails', async () => {
    mockFetch(jsonResponse({ ok: false }, 401));

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });

  it('fails soft to null when the network request rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(new Error('dns failed'));

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });

  it('rejects a non-observer-token in the response', async () => {
    mockFetch(
      jsonResponse({ ok: true, data: { id: 'ot_1', token: 'rk_live_leaked' } }, 201)
    );

    await expect(
      mintObserverStreamToken('https://cast.agentrelay.com', 'rk_live_admin')
    ).resolves.toBeNull();
  });
});

describe('revokeObserverStreamToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends DELETE for the token id with the admin key', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));

    await revokeObserverStreamToken(
      'https://cast.agentrelay.com',
      'rk_live_admin',
      'ot_1'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://cast.agentrelay.com/v1/observer-tokens/ot_1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer rk_live_admin' },
      })
    );
  });

  it('swallows network errors so logout can still clear cookies', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(new Error('unreachable'));

    await expect(
      revokeObserverStreamToken(
        'https://cast.agentrelay.com',
        'rk_live_admin',
        'ot_1'
      )
    ).resolves.toBeUndefined();
  });
});

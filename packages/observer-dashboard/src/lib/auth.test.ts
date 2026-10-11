import { afterEach, describe, expect, it, vi } from 'vitest';
import { login } from './auth';

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('login', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports a rejected capability as revoked', async () => {
    vi.stubGlobal('fetch', respond(401, { success: false, error: 'Invalid API key' }));
    expect(await login('ot_live_x', { connectObserverId: 'ot_1' })).toEqual({ ok: false, failure: 'revoked' });
  });

  it('reports an engine that could not validate the capability (rate limit, outage) as temporary', async () => {
    vi.stubGlobal('fetch', respond(503, { success: false, error: 'Unable to validate API key' }));
    expect(await login('ot_live_x', { connectObserverId: 'ot_1' })).toEqual({ ok: false, failure: 'temporary' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await login('ot_live_x')).toEqual({ ok: false, failure: 'temporary' });
  });

  it('succeeds only on success: true', async () => {
    vi.stubGlobal('fetch', respond(200, { success: true }));
    expect(await login('ot_live_x')).toEqual({ ok: true });
  });
});

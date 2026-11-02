import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env.js';
import type { EngineObservation } from '../../ports/telemetry.js';
import { requestObservationMiddleware } from '../requestObservation.js';

function fixture(rate?: number) {
  const events: EngineObservation[] = [];
  const app = new Hono<AppEnv>();
  app.onError((_error, c) => c.text('failed', 500));
  app.use('*', async (c, next) => {
    c.set('engine', { config: { telemetryRequestSampleRate: rate }, telemetry: { capture: (event: EngineObservation) => { events.push(event); } } } as never);
    await next();
  });
  app.use('*', requestObservationMiddleware);
  app.get('/agents/:name', c => {
    c.set('workspace', { id: 'ws_1' } as never);
    c.set('agent', { id: 'a_1', workspaceId: 'ws_1', name: 'sender', type: 'human' } as never);
    c.set('agentCredentialHash', 'trusted');
    return c.text('ok');
  });
  app.use('/private/*', c => c.text('unauthorized', 401));
  app.get('/private/:name', c => c.text('unreachable'));
  app.post('/v1/agents/heartbeat', c => c.text('heartbeat', 401));
  app.get('/broken', () => { throw Error('private exception'); });
  return { app, events };
}

afterEach(() => vi.restoreAllMocks());

describe('uniform HTTP completion observations', () => {
  it('uses registered templates and credential context without private paths or claims', async () => {
    const { app, events } = fixture(1);
    await app.request('/agents/private-email@example.com?secret=raw', { headers: { 'X-Agent-Relay-User-Id': 'spoof' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'request.completed', workspaceId: 'ws_1', authenticatedActor: { agentId: 'a_1', credentialHash: 'trusted' }, facts: { route_template: '/agents/:name', method: 'GET', status_code: 200, sample_rate: 1, duration_ms: expect.any(Number) } });
    expect(events[0]!.facts.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toMatch(/private-email|secret|spoof/);
  });

  it.each([['/private/secret', '/private/:name', 401], ['/missing/secret', 'unmatched', 404], ['/broken', '/broken', 500]] as const)('includes %s after the final response, without a fabricated identity', async (path, template, status) => {
    const { app, events } = fixture(1);
    expect((await app.request(path)).status).toBe(status);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ facts: { route_template: template, status_code: status, sample_rate: 1 } });
    expect(events[0]!.workspaceId).toBeUndefined();
    expect(events[0]).not.toHaveProperty('authenticatedActor');
    expect(JSON.stringify(events)).not.toMatch(/secret|private exception/);
  });

  it('makes the default 1% decision before the outcome with an honest inclusion rate', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.009).mockReturnValueOnce(0.01).mockReturnValueOnce(0.009);
    const { app, events } = fixture();
    await app.request('/agents/a');
    await app.request('/broken');
    await app.request('/private/a');
    expect(events.map(event => event.facts.status_code)).toEqual([200, 401]);
    expect(events.every(event => event.facts.sample_rate === 0.01)).toBe(true);
  });

  it.each([0, -1])('disables at rate %s', async rate => {
    const random = vi.spyOn(Math, 'random');
    const { app, events } = fixture(rate);
    await app.request('/broken');
    expect(events).toHaveLength(0);
    expect(random).not.toHaveBeenCalled();
  });

  it.each([[2, 1], [Number.NaN, 0.01], [Number.POSITIVE_INFINITY, 0.01]])('bounds invalid sampling configuration %s', async (rate, expected) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { app, events } = fixture(rate);
    await app.request('/broken');
    expect(events[0]!.facts.sample_rate).toBe(expected);
  });

  it('excludes registered heartbeat requests before sampling including failures', async () => {
    const random = vi.spyOn(Math, 'random');
    const { app, events } = fixture(1);
    expect((await app.request('/v1/agents/heartbeat', { method: 'POST' })).status).toBe(401);
    expect(events).toHaveLength(0);
    expect(random).not.toHaveBeenCalled();
    await app.request('/v1/agents/heartbeat/private?token=secret', { method: 'POST' });
    expect(events[0]!.facts.route_template).toBe('unmatched');
  });

  it('uses OTHER for methods outside the receiver vocabulary', async () => {
    const { app, events } = fixture(1);
    // Hono accepts TRACE directly even though native Fetch Request rejects it.
    await app.fetch({ method: 'TRACE', url: 'http://localhost/missing', headers: new Headers() } as Request);
    expect(events[0]!.facts.method).toBe('OTHER');
  });

  it('isolates observer failures from responses', async () => {
    const { app } = fixture(1);
    app.use('*', async (c, next) => { c.get('engine').telemetry.capture = () => { throw Error('observer'); }; await next(); });
    expect((await app.request('/missing')).status).toBe(404);
  });
});

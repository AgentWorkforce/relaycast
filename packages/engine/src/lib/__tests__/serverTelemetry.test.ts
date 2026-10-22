import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env.js';
import type { EngineObservation, TelemetrySink } from '../../ports/telemetry.js';
import { safeTelemetrySink } from '../../ports/telemetry.js';
import { emitServerEvent } from '../serverTelemetry.js';

async function emit(capture: TelemetrySink['capture'], workspaceId = 'ws_1') {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set('engine', { telemetry: { capture } } as never);
    c.set('agent', { id: 'agent_1', workspaceId, name: 'alice', type: 'human', metadata: { cloud_user_id: 'spoof' } } as never);
    c.set('agentCredentialHash', 'a'.repeat(64));
    await next();
  });
  app.post('/', (c) => {
    emitServerEvent(c, 'ws_1', 'message.created', { channel_id: 'ch_1', message_id: 'msg_1', workspace_id: 'spoof' });
    return c.text('committed', 201);
  });
  return app.request('/', { method: 'POST', headers: { 'X-Agent-Relay-Distinct-Id': 'spoof', 'X-Agent-Relay-User-Id': 'spoof', 'X-Agent-Relay-Org-Id': 'spoof' } });
}

describe('domain observations', () => {
  it('emits domain facts and authenticated provenance, without analytics policy or caller identity', async () => {
    const events: EngineObservation[] = [];
    expect((await emit(event => { events.push(event); })).status).toBe(201);
    expect(events[0]).toMatchObject({ kind: 'message.created', workspaceId: 'ws_1', authenticatedActor: { agentId: 'agent_1', credentialHash: 'a'.repeat(64), type: 'human' }, sender: { id: 'agent_1', name: 'alice', type: 'human' }, facts: { channel_id: 'ch_1', message_id: 'msg_1' } });
    expect(new Date(events[0]!.occurredAt).toISOString()).toBe(events[0]!.occurredAt);
    expect(events[0]!.facts).not.toHaveProperty('workspace_id');
    for (const key of ['distinctId', 'groups', 'setOnce', 'processPersonProfile', 'hints']) expect(events[0]).not.toHaveProperty(key);
    expect(JSON.stringify(events)).not.toContain('spoof');
  });
  it('does not inherit credentials or sender across workspaces', async () => {
    const capture = vi.fn();
    await emit(capture, 'ws_other');
    expect(capture.mock.calls[0]![0]).not.toHaveProperty('authenticatedActor');
    expect(capture.mock.calls[0]![0]).not.toHaveProperty('sender');
  });
  it.each(['throw', 'reject'])('isolates observer %s from successful operations', async mode => {
    const capture = () => { if (mode === 'throw') throw Error('private'); return Promise.reject(Error('private')); };
    expect((await emit(capture)).status).toBe(201);
    await Promise.resolve();
  });
  it.each(['throw', 'reject'])('isolates exception observers that %s', async mode => {
    const callback = () => { if (mode === 'throw') throw Error('private'); return Promise.reject(Error('private')); };
    expect(() => safeTelemetrySink({ capture: callback, captureException: callback }).captureException(Error('domain'))).not.toThrow();
    await Promise.resolve();
  });
});

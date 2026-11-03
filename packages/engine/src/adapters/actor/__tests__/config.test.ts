import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_ACTOR_MAX_UPLOAD_BYTES, actorConfigFromEnv } from '../index.js';
import { FakeWorkspaceActor, jsonRequest } from './fakeActor.js';

const WORKSPACE_ID = '241764880589606912';
const INTERNAL_SECRET = 'an-internal-secret-of-thirty-two-chars!!';

describe('actorConfigFromEnv', () => {
  it('defaults to production, a 64 MiB upload cap and messages kept forever', () => {
    expect(actorConfigFromEnv({})).toEqual({
      environment: 'production',
      maxUploadBytes: DEFAULT_ACTOR_MAX_UPLOAD_BYTES,
      retention: { messageTtlDays: null },
    });
    // Blank variables are unset; 0 or negative TTL days is an explicit keep-forever.
    expect(actorConfigFromEnv({ RELAYCAST_MESSAGE_TTL_DAYS: '', RELAYCAST_MAILBOX_TTL_MS: ' ' })).toEqual(actorConfigFromEnv({}));
    expect(actorConfigFromEnv({ RELAYCAST_MESSAGE_TTL_DAYS: '0' }).retention).toEqual({ messageTtlDays: null });
    expect(actorConfigFromEnv({ RELAYCAST_MESSAGE_TTL_DAYS: '-3' }).retention).toEqual({ messageTtlDays: null });
  });

  it('reads every self-host variable', () => {
    expect(actorConfigFromEnv({
      RELAYCAST_ENV: 'staging',
      RELAYCAST_MAX_UPLOAD_BYTES: '1048576',
      RELAYCAST_MESSAGE_TTL_DAYS: '30',
      RELAYCAST_MAILBOX_TTL_MS: '600000',
      RELAYCAST_MAILBOX_DEPTH_CAP: '50',
      RELAYCAST_RATE_LIMIT_PER_MINUTE: '120',
      RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET,
    })).toEqual({
      environment: 'staging',
      maxUploadBytes: 1_048_576,
      retention: { messageTtlDays: 30 },
      mailbox: { deliveryTtlMs: 600_000, depthCap: 50 },
      rateLimitPerMinute: 120,
      internalSecret: INTERNAL_SECRET,
    });
  });

  it('refuses bad values by name', () => {
    expect(() => actorConfigFromEnv({ RELAYCAST_MAX_UPLOAD_BYTES: 'lots' })).toThrow(ConfigError);
    expect(() => actorConfigFromEnv({ RELAYCAST_MAX_UPLOAD_BYTES: '0' })).toThrow(/RELAYCAST_MAX_UPLOAD_BYTES/);
    expect(() => actorConfigFromEnv({ RELAYCAST_MAILBOX_DEPTH_CAP: '1.5' })).toThrow(/RELAYCAST_MAILBOX_DEPTH_CAP/);
    expect(() => actorConfigFromEnv({ RELAYCAST_INTERNAL_SECRET: 'short' })).toThrow(/RELAYCAST_INTERNAL_SECRET: must be at least 32/);
    expect(() => actorConfigFromEnv({ RELAYCAST_INTERNAL_SECRET: ` ${INTERNAL_SECRET} ` })).toThrow(/whitespace/);
    expect(() => actorConfigFromEnv({ RELAYCAST_MAX_UPLOAD_BYTES: 'x', RELAYCAST_RATE_LIMIT_PER_MINUTE: '-1' }))
      .toThrow(/RELAYCAST_MAX_UPLOAD_BYTES.*RELAYCAST_RATE_LIMIT_PER_MINUTE/);
  });
});

describe('internal admin routes inside a workspace actor', () => {
  const internal = (method: string, path: string, body?: unknown) => ({
    ...jsonRequest(method, path, body),
    headers: [['content-type', 'application/json'], ['authorization', `Bearer ${INTERNAL_SECRET}`]] as [string, string][],
  });

  it('serves only this actor\'s workspace', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, { config: { internalSecret: INTERNAL_SECRET } });
    const created = await actor.handle(jsonRequest('POST', '/v1/workspaces', { name: 'admin' }));
    expect(created.status).toBe(201);

    const capabilities = await actor.handle(internal('GET', '/internal/capabilities'));
    expect(capabilities.status).toBe(200);

    // The gateway picks the actor for a new workspace; the actor does not create others.
    const create = await actor.handle(internal('POST', '/internal/workspaces', { name: 'another' }));
    expect(create.status).toBe(404);

    const other = '241764880589606913';
    expect((await actor.handle(internal('POST', `/internal/workspaces/${other}/api-key`, {}))).status).toBe(404);
    expect((await actor.handle(internal('DELETE', `/internal/workspaces/${other}`))).status).toBe(404);

    const rotated = await actor.handle(internal('POST', `/internal/workspaces/${WORKSPACE_ID}/api-key`, {}));
    expect(rotated.status).toBe(200);
    expect(JSON.parse(rotated.body).data).toMatchObject({ workspace_id: WORKSPACE_ID, api_key: expect.stringMatching(/^ar_ws_/) });

    expect((await actor.handle(internal('DELETE', `/internal/workspaces/${WORKSPACE_ID}`))).status).toBe(204);
    expect(actor.sql.exec('SELECT COUNT(*) AS n FROM workspaces')).toEqual([{ n: 0 }]);

    // Without the secret the surface does not exist; with a wrong one it is 401.
    expect((await actor.handle(jsonRequest('GET', '/internal/capabilities'))).status).toBe(401);
    expect((await new FakeWorkspaceActor(WORKSPACE_ID).handle(internal('GET', '/internal/capabilities'))).status).toBe(404);
  });

  it('refuses a weak internal secret at construction', () => {
    expect(() => new FakeWorkspaceActor(WORKSPACE_ID, { config: { internalSecret: 'short' } })).toThrow(/at least 32 characters/);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeArCredential } from '@relaycast/types';
import { createCredentialTagSigner } from '../../../auth/credentialTags.js';
import { ConfigError, DEFAULT_ACTOR_MAX_UPLOAD_BYTES, actorConfigFromEnv } from '../index.js';
import { FakeWorkspaceActor, jsonRequest } from './fakeActor.js';

const WORKSPACE_ID = '241764880589606912';
const INTERNAL_SECRET = 'an-internal-secret-of-thirty-two-chars!!';

describe('actorConfigFromEnv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-actor-config-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
      RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'bootstrap-secret-0123456789abcdef',
      RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true',
    })).toEqual({
      environment: 'staging',
      maxUploadBytes: 1_048_576,
      retention: { messageTtlDays: 30 },
      mailbox: { deliveryTtlMs: 600_000, depthCap: 50 },
      rateLimitPerMinute: 120,
      internalSecret: INTERNAL_SECRET,
      workspaceBootstrapSecret: 'bootstrap-secret-0123456789abcdef',
      workspaceBootstrapProofRequired: true,
    });
  });

  it('reads the bootstrap secret as exact bytes and the proof flag as exactly "true" or "false", blank unset', () => {
    // The secret's bytes feed a derivation: a direct value is verbatim, only an empty one is unset.
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: ' exact bytes ' }).workspaceBootstrapSecret).toBe(' exact bytes ');
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: '  ' }).workspaceBootstrapSecret).toBe('  ');
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: '' }).workspaceBootstrapSecret).toBeUndefined();
    // `_FILE`: one trailing newline dropped, a direct value wins, an unreadable file is a refusal naming the variable.
    const file = join(dir, 'bootstrap');
    writeFileSync(file, ' from file \r\n');
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: file }).workspaceBootstrapSecret).toBe(' from file ');
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'direct', RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: file }).workspaceBootstrapSecret).toBe('direct');
    expect(() => actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: join(dir, 'missing') })).toThrow(ConfigError);
    expect(() => actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE: join(dir, 'missing') })).toThrow(/RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET_FILE/);
    // The proof flag is the raw value, exactly "true" or "false" (not trimmed); blank is unset (false), anything else is refused by name.
    expect(actorConfigFromEnv({}).workspaceBootstrapProofRequired).toBeUndefined();
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'false' }).workspaceBootstrapProofRequired).toBeUndefined();
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: '' }).workspaceBootstrapProofRequired).toBeUndefined();
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: '  ' }).workspaceBootstrapProofRequired).toBeUndefined();
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' }).workspaceBootstrapProofRequired).toBe(true);
    // Like the server, the flag without a secret is accepted: keyed creates then fail closed (503) before any proof is checked.
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' })).toEqual({ ...actorConfigFromEnv({}), workspaceBootstrapProofRequired: true });
    expect(() => actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'yes' })).toThrow(/RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED/);
    expect(() => actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'TRUE' })).toThrow(ConfigError);
    expect(() => actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true ' })).toThrow(/RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED/);
  });

  it('refuses, with proof required, a bootstrap secret an HTTP header cannot carry; without it the secret is only a derivation input', () => {
    for (const value of [' leading-space', 'trailing-tab\t', 'embedded\nnewline', 'nul\u0000byte']) {
      expect(() => actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: value, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' }), JSON.stringify(value))
        .toThrow(/RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: must be carried in an HTTP header/);
      // Not trimmed, not refused: exact bytes.
      expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: value }).workspaceBootstrapSecret).toBe(value);
      expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: value, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'false' }).workspaceBootstrapSecret).toBe(value);
    }
    expect(actorConfigFromEnv({ RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: 'inner spaces are fine', RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: 'true' }).workspaceBootstrapSecret).toBe('inner spaces are fine');
  });

  it('refuses bad values by name', () => {
    expect(() => actorConfigFromEnv({ RELAYCAST_MAX_UPLOAD_BYTES: 'lots' })).toThrow(ConfigError);
    expect(() => actorConfigFromEnv({ RELAYCAST_MAX_UPLOAD_BYTES: '0' })).toThrow(/RELAYCAST_MAX_UPLOAD_BYTES/);
    expect(() => actorConfigFromEnv({ RELAYCAST_MAILBOX_DEPTH_CAP: '1.5' })).toThrow(/RELAYCAST_MAILBOX_DEPTH_CAP/);
    expect(() => actorConfigFromEnv({ RELAYCAST_INTERNAL_SECRET: 'short' })).toThrow(/RELAYCAST_INTERNAL_SECRET: must be at least 32/);
    // Read as the self-host server reads it: trimmed, and blank is unset.
    expect(actorConfigFromEnv({ RELAYCAST_INTERNAL_SECRET: ` ${INTERNAL_SECRET} ` }).internalSecret).toBe(INTERNAL_SECRET);
    expect(actorConfigFromEnv({ RELAYCAST_INTERNAL_SECRET: '   ' }).internalSecret).toBeUndefined();
    expect(() => actorConfigFromEnv({ RELAYCAST_MAX_UPLOAD_BYTES: 'x', RELAYCAST_RATE_LIMIT_PER_MINUTE: '-1' }))
      .toThrow(/RELAYCAST_MAX_UPLOAD_BYTES.*RELAYCAST_RATE_LIMIT_PER_MINUTE/);
  });
});

describe('internal admin routes inside a workspace actor', () => {
  const internal = (method: string, path: string, body?: unknown) => ({
    ...jsonRequest(method, path, body),
    headers: [['content-type', 'application/json'], ['authorization', `Bearer ${INTERNAL_SECRET}`]] as [string, string][],
  });

  it('keeps the routing tag of an ar_ws_ key whose push created the workspace, so it can mint credentials', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, { config: { internalSecret: INTERNAL_SECRET } });
    const signer = createCredentialTagSigner({ current: 'a', keys: { a: 'test-credential-tag-secret-0123456789' } });
    const apiKey = encodeArCredential({ kind: 'workspace', workspaceId: WORKSPACE_ID, tag: await signer.tag(WORKSPACE_ID), secret: new Uint8Array(32).fill(5) });
    const pushed = await actor.handle(internal('POST', `/internal/workspaces/${WORKSPACE_ID}/api-key`, { api_key: apiKey }));
    expect(pushed.status).toBe(201);
    // The pushed key authenticates, and the workspace can mint an agent token under the same tag.
    const agent = await actor.handle(jsonRequest('POST', '/v1/agents', { name: 'alice' }, apiKey));
    expect(agent.status).toBe(201);
    expect(JSON.parse(agent.body).data.token).toMatch(new RegExp(`^ar_ag_[0-9A-Za-z]+_${await signer.tag(WORKSPACE_ID)}_`));
    // A rotation afterwards keeps the tag.
    const rotated = await actor.handle(internal('POST', `/internal/workspaces/${WORKSPACE_ID}/api-key`, {}));
    expect(rotated.status).toBe(200);
    expect(JSON.parse(rotated.body).data.api_key).toContain(`_${await signer.tag(WORKSPACE_ID)}_`);
  });

  it('serves only this actor\'s workspace', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID, { config: { internalSecret: INTERNAL_SECRET } });
    const created = await actor.handle(jsonRequest('POST', '/v1/workspaces', { name: 'admin' }));
    expect(created.status).toBe(201);

    const capabilities = await actor.handle(internal('GET', '/internal/capabilities'));
    expect(capabilities.status).toBe(200);
    // The actor creates no workspaces (its gateway does), so it does not advertise `create`.
    expect(JSON.parse(capabilities.body).data.workspace_admin).toMatchObject({ create: false, delete: true, server_minted_key: true });

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

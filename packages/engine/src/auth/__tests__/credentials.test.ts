import { describe, expect, it } from 'vitest';
import {
  configureCredentials,
  credentialFormat,
  credentialFromHex,
  credentialShape,
  derivationFamilies,
  issueCredential,
  mintCredential,
  parseArCredential,
  parseCredential,
} from '../credentials.js';
import { createCredentialTagSigner } from '../credentialTags.js';
import { getAuthTokenKind, requiredTokenMessage } from '../tokenKind.js';

const WS = '241764880589606912';
const tagger = createCredentialTagSigner({ current: 'a', keys: { a: 'credential-tag-secret-a' } });
const arDb = () => {
  const db = {};
  configureCredentials(db, { format: 'ar', tagger });
  return db;
};

describe('credential families', () => {
  it('mints legacy credentials with the established prefixes and lengths', async () => {
    const db = {};
    expect(await mintCredential(db, 'legacy', 'workspace', WS)).toMatch(/^rk_live_[0-9a-f]{32}$/);
    expect(await mintCredential(db, 'legacy', 'agent', WS)).toMatch(/^at_live_[0-9a-f]{32}$/);
    expect(await mintCredential(db, 'legacy', 'node', WS)).toMatch(/^nt_live_[0-9a-f]{48}$/);
    expect(await mintCredential(db, 'legacy', 'observer', WS)).toMatch(/^ot_live_[0-9a-f]{48}$/);
    expect(await mintCredential(db, 'legacy', 'webhook', WS)).toMatch(/^wh_live_[0-9a-f]{48}$/);
  });

  it('mints ar_ credentials that name their kind, workspace and tag', async () => {
    const db = arDb();
    const tag = await tagger.tag(WS);
    const cases = [['workspace', 'ws'], ['agent', 'ag'], ['node', 'nd'], ['observer', 'ob'], ['webhook', 'wh']] as const;
    for (const [kind, code] of cases) {
      const token = await mintCredential(db, 'ar', kind, WS);
      expect(token).toMatch(new RegExp(`^ar_${code}_[0-9A-Za-z]{11}_${tag}_[0-9A-Za-z]{49}$`));
      expect(parseArCredential(token)).toEqual({ kind, workspaceId: WS, tag, keyVersion: 'a' });
      expect(await tagger.verify(token)).toBe(true);
    }
    await expect(mintCredential(db, 'ar', 'agent', 'ws_1')).rejects.toThrow(/must be snowflakes/);
  });

  it('classifies both families', async () => {
    const legacy = await mintCredential({}, 'legacy', 'agent', WS);
    const ar = await mintCredential(arDb(), 'ar', 'agent', WS);
    expect(parseCredential(legacy)).toEqual({ family: 'legacy', kind: 'agent' });
    expect(getAuthTokenKind(legacy)).toBe('agent');
    expect(getAuthTokenKind(ar)).toBe('agent');
    expect(getAuthTokenKind('not_a_token')).toBeUndefined();
    // Webhook tokens never authenticate API calls.
    expect(getAuthTokenKind(await mintCredential(arDb(), 'ar', 'webhook', WS))).toBeUndefined();
    expect(getAuthTokenKind(await mintCredential({}, 'legacy', 'webhook', WS))).toBeUndefined();
  });

  it('derives credentials from digests deterministically in each family', async () => {
    const digest = 'ab'.repeat(32);
    expect(await credentialFromHex({}, 'legacy', 'node', WS, digest)).toBe(`nt_live_${digest.slice(0, 48)}`);
    const db = arDb();
    const first = await credentialFromHex(db, 'ar', 'node', WS, digest);
    expect(await credentialFromHex(db, 'ar', 'node', WS, digest)).toBe(first);
    expect(await credentialFromHex(db, 'ar', 'node', WS, digest, 'bAAAAAAAAAA')).toMatch(/_bAAAAAAAAAA_/);
    await expect(credentialFromHex({}, 'ar', 'node', WS, digest)).rejects.toThrow(/credentialTagger/);
  });

  it('names the family in required-credential messages', () => {
    expect(requiredTokenMessage('agent', 'legacy')).toBe('Agent token required (at_live_...)');
    expect(requiredTokenMessage('agent', 'ar')).toBe('Agent token required (ar_ag_...)');
    expect(credentialShape('workspace', 'ar')).toBe('ar_ws_...');
  });

  it('binds one configuration to a database handle, defaulting to legacy', async () => {
    const db = {};
    expect(credentialFormat(db)).toBe('legacy');
    expect(await issueCredential(db, 'workspace', WS)).toMatch(/^rk_live_/);
    configureCredentials(db, { format: 'ar', tagger });
    expect(await issueCredential(db, 'workspace', WS)).toMatch(/^ar_ws_/);
    // Repeating the same configuration is idempotent; switching is refused.
    configureCredentials(db, { format: 'ar', tagger });
    expect(() => configureCredentials(db, { format: 'legacy' })).toThrow(/one credential configuration/);
    expect(() => configureCredentials({}, { format: 'ar' })).toThrow(/credentialTagger/);
  });
});

describe('derivationFamilies', () => {
  const rotated = createCredentialTagSigner({ current: 'b', keys: { a: 'credential-tag-secret-a', b: 'credential-tag-secret-b' } });

  it('lists the current family first and every family a replay may have committed in', async () => {
    const [current, previous] = await rotated.tags(WS);
    expect(current).toMatch(/^b/);
    expect(previous).toMatch(/^a/);
    const ar = {};
    configureCredentials(ar, { format: 'ar', tagger: rotated });
    expect(await derivationFamilies(ar, WS)).toEqual([{ format: 'ar', tag: current }, { format: 'ar', tag: previous }, { format: 'legacy' }]);

    const legacy = {};
    configureCredentials(legacy, { format: 'legacy', tagger: rotated });
    expect(await derivationFamilies(legacy, WS)).toEqual([{ format: 'legacy' }, { format: 'ar', tag: current }, { format: 'ar', tag: previous }]);
  });

  it('lists only legacy for a workspace id that cannot carry an ar_ credential', async () => {
    const legacy = {};
    configureCredentials(legacy, { format: 'legacy', tagger: rotated });
    expect(await derivationFamilies(legacy, 'custom-workspace')).toEqual([{ format: 'legacy' }]);
  });
});

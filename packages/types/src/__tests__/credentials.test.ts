import { describe, expect, it } from 'vitest';
import {
  AR_KIND_CODES,
  base62Decode,
  base62Encode,
  crc32,
  credentialFamily,
  credentialKind,
  credentialWorkspaceId,
  encodeArCredential,
  encodeArWorkspaceId,
  isObserverToken,
  isWorkspaceKey,
  maskCredential,
  parseCredential,
  redactCredentials,
  type CredentialKind,
} from '../credentials.js';

const WS = '241764880589606912';
const TAG = 'aX7pQ2mN4bc';
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
const ar = (kind: CredentialKind, workspaceId = WS) => encodeArCredential({ kind, workspaceId, tag: TAG, secret: SECRET });

describe('ar_ credentials', () => {
  it('round-trip every kind with a fixed-width layout', () => {
    for (const kind of Object.keys(AR_KIND_CODES) as CredentialKind[]) {
      const token = ar(kind);
      expect(token).toMatch(new RegExp(`^ar_${AR_KIND_CODES[kind]}_[0-9A-Za-z]{11}_${TAG}_[0-9A-Za-z]{49}$`));
      expect(token).toHaveLength(79);
      expect(parseCredential(token)).toEqual({ family: 'ar', kind, workspaceId: WS, tag: TAG, keyVersion: 'a' });
    }
    // The smallest and largest snowflakes keep the width.
    expect(parseCredential(ar('agent', '0'))).toMatchObject({ workspaceId: '0' });
    expect(parseCredential(ar('agent', '18446744073709551615'))).toMatchObject({ workspaceId: '18446744073709551615' });
    expect(() => ar('agent', '18446744073709551616')).toThrow(/64-bit snowflake/);
    expect(() => ar('agent', '0123')).toThrow(/64-bit snowflake/);
  });

  it('reject a one-character typo through the checksum', () => {
    const token = ar('workspace');
    for (const index of [3, 7, 20, 40, token.length - 1]) {
      const typo = token.slice(0, index) + (token[index] === 'x' ? 'y' : 'x') + token.slice(index + 1);
      expect(parseCredential(typo)).toBeUndefined();
    }
    expect(parseCredential(token.slice(0, -1))).toBeUndefined();
  });

  it('encode base62 and CRC-32 as specified', () => {
    expect(base62Encode(61n, 2)).toBe('0z');
    expect(base62Decode('0z')).toBe(61n);
    expect(encodeArWorkspaceId('62')).toBe('00000000010');
    expect(crc32('123456789')).toBe(0xcbf43926);
  });
});

describe('credential families', () => {
  it('classifies legacy credentials by kind', () => {
    expect(parseCredential('rk_live_abc')).toEqual({ family: 'legacy', kind: 'workspace' });
    expect(credentialKind('at_live_abc')).toBe('agent');
    expect(credentialKind('nt_live_abc')).toBe('node');
    expect(credentialKind('ot_live_abc')).toBe('observer');
    expect(credentialKind('wh_live_abc')).toBe('webhook');
    expect(credentialFamily(ar('node'))).toBe('ar');
    expect(credentialFamily('nt_live_abc')).toBe('legacy');
  });

  it('never classifies other services or retired shapes as relaycast credentials', () => {
    for (const token of ['relay_ws_abc', 'relay_ag_abc', 'relay_pa_abc', 'relay_id_abc', `ar_au_ws_${ar('workspace').slice(6)}`,
      `relaycast_ws_${WS}_${'0'.repeat(64)}`, 'rk_test_abc', '']) {
      expect(parseCredential(token)).toBeUndefined();
    }
  });

  it('answers the common checks', () => {
    expect(credentialWorkspaceId(ar('agent'))).toBe(WS);
    expect(credentialWorkspaceId('at_live_abc')).toBeUndefined();
    expect(isWorkspaceKey('rk_live_abc')).toBe(true);
    expect(isWorkspaceKey(ar('workspace'))).toBe(true);
    expect(isWorkspaceKey(ar('observer'))).toBe(false);
    expect(isObserverToken(ar('observer'))).toBe(true);
  });

  it('masks by structure', () => {
    expect(maskCredential('rk_live_mask_fixture_key_wxyz')).toBe('rk_live_mask...wxyz');
    const token = ar('workspace');
    const secret = token.slice(-49, -6);
    expect(maskCredential(token)).toBe(`ar_ws_${encodeArWorkspaceId(WS)}_${TAG}_${secret.slice(0, 4)}...${secret.slice(-4)}`);
  });

  it('redacts credentials glued to surrounding text', () => {
    const routed = ar('agent');
    expect(redactCredentials(`key:${routed}xyz and ${routed}.`, '[x]')).toBe('key:[x]xyz and [x].');
    expect(redactCredentials(`token${routed}`, '[x]')).toBe('token[x]');
    expect(redactCredentials(`(rk_live_abc)and prefixot_live_def`, '[x]')).toBe('([x])and prefix[x]');
    // The replacement is literal: `$&` must not re-insert the credential.
    expect(redactCredentials(`a rk_live_abc b`, '$&')).toBe('a $& b');
  });
});

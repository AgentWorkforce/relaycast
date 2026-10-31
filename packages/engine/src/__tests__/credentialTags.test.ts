import { describe, expect, it } from 'vitest';
import { encodeArCredential } from '@relaycast/types';
import { createCredentialTagSigner, generateWorkspaceId, parseArCredential, parseCredentialKeyring } from '../gateway.js';

const SECRET = { a: 'first-secret-0123456789', b: 'second-secret-0123456789', c: 'third-secret-0123456789' };
const ring = (current: string, keys: Record<string, string>) => createCredentialTagSigner({ current, keys });
const WS = generateWorkspaceId();
const credential = (tag: string, workspaceId = WS) =>
  encodeArCredential({ kind: 'agent', workspaceId, tag, secret: new Uint8Array(32).fill(7) });

describe('credential tags', () => {
  it('tag a workspace so the same keyring verifies its credentials', async () => {
    expect(WS).toMatch(/^[0-9]+$/);
    const signer = ring('a', { a: SECRET.a });
    const tag = await signer.tag(WS);
    expect(tag).toMatch(/^a[0-9A-Za-z]{10}$/);
    expect(await signer.tag(WS)).toBe(tag);
    const token = credential(tag);
    expect(parseArCredential(token)).toEqual({ kind: 'agent', workspaceId: WS, tag, keyVersion: 'a' });
    expect(await signer.verify(token)).toBe(true);
  });

  it('refuse forged tags, another workspace\'s tag, and another keyring', async () => {
    const signer = ring('a', { a: SECRET.a });
    const tag = await signer.tag(WS);
    const forged = `a${tag.slice(1, -1)}${tag.endsWith('0') ? '1' : '0'}`;
    expect(await signer.verify(credential(forged))).toBe(false);
    expect(await signer.verify(credential(tag, '241764880589606912'))).toBe(false);
    expect(await ring('a', { a: 'another-secret-0123456' }).verify(credential(tag))).toBe(false);
    expect(await signer.verify(`at_live_${'0'.repeat(32)}`)).toBe(false);
  });

  it('keep verifying credentials of every version across rotations a→b→c', async () => {
    const underA = credential(await ring('a', { a: SECRET.a }).tag(WS));
    const underB = credential(await ring('b', { a: SECRET.a, b: SECRET.b }).tag(WS));
    const rotated = ring('c', SECRET);
    expect(await rotated.verify(underA)).toBe(true);
    expect(await rotated.verify(underB)).toBe(true);
    expect(await rotated.tag(WS)).toMatch(/^c/);
    // Every version's tag, the current one first, for deterministic-key recovery.
    expect((await rotated.tags(WS)).map((tag) => tag[0])).toEqual(['c', 'a', 'b']);
  });

  it('reject a credential whose version is not in the keyring (retiring a version locks out its credentials)', async () => {
    const underA = credential(await ring('a', { a: SECRET.a }).tag(WS));
    expect(await ring('c', { b: SECRET.b, c: SECRET.c }).verify(underA)).toBe(false);
  });

  it('parse keyrings strictly', () => {
    expect(parseCredentialKeyring(JSON.stringify({ current: 'b', keys: { a: SECRET.a, b: SECRET.b } }))).toEqual({ current: 'b', keys: { a: SECRET.a, b: SECRET.b } });
    expect(() => parseCredentialKeyring('not json')).toThrow();
    expect(() => parseCredentialKeyring(JSON.stringify({ current: 'c', keys: { a: SECRET.a } }))).toThrow(/not in the keyring/);
    expect(() => parseCredentialKeyring(JSON.stringify({ current: 'A', keys: { A: SECRET.a } }))).toThrow(/one letter/);
    expect(() => parseCredentialKeyring(JSON.stringify({ current: 'a', keys: { a: 'short' } }))).toThrow(/16 characters/);
  });
});

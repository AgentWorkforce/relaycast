import { describe, expect, it } from 'vitest';
import { createWorkspaceIdSigner, parseSelfRoutingCredential, parseWorkspaceIdKeyring } from '../gateway.js';

const SECRET = { a: 'first-secret-0123456789', b: 'second-secret-0123456789', c: 'third-secret-0123456789' };
const ring = (current: string, keys: Record<string, string>) => createWorkspaceIdSigner({ current, keys });

describe('signed workspace ids', () => {
  it('mints ids the same keyring verifies, usable in self-routing credentials', async () => {
    const signer = ring('a', { a: SECRET.a });
    const id = await signer.mint();
    expect(id).toMatch(/^[0-9]+a[0-9a-f]{32}$/);
    expect(await signer.verify(id)).toBe(true);
    expect(parseSelfRoutingCredential(`relaycast_ag_${id}_${'c'.repeat(64)}`)).toEqual({ kind: 'agent', workspaceId: id });
  });

  it('refuses forged and tampered ids, and ids from another keyring', async () => {
    const signer = ring('a', { a: SECRET.a });
    const id = await signer.mint();
    expect(await signer.verify(`${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`)).toBe(false);
    expect(await signer.verify(`1${id}`)).toBe(false);
    expect(await signer.verify('241764880589606912')).toBe(false);
    expect(await ring('a', { a: 'another-secret-0123456' }).verify(id)).toBe(false);
  });

  it('keeps verifying ids of every version in the keyring across rotations', async () => {
    const underA = await ring('a', { a: SECRET.a }).mint();
    const underB = await ring('b', { a: SECRET.a, b: SECRET.b }).mint();
    const rotated = ring('c', SECRET);
    expect(await rotated.verify(underA)).toBe(true);
    expect(await rotated.verify(underB)).toBe(true);
    expect(await rotated.mint()).toMatch(/^[0-9]+c[0-9a-f]{32}$/);
  });

  it('rejects an id whose version is not in the keyring (retiring a version locks out its workspaces)', async () => {
    const underA = await ring('a', { a: SECRET.a }).mint();
    expect(await ring('c', { b: SECRET.b, c: SECRET.c }).verify(underA)).toBe(false);
  });

  it('parses keyrings strictly', () => {
    expect(parseWorkspaceIdKeyring(JSON.stringify({ current: 'b', keys: { a: SECRET.a, b: SECRET.b } }))).toEqual({ current: 'b', keys: { a: SECRET.a, b: SECRET.b } });
    expect(() => parseWorkspaceIdKeyring('not json')).toThrow();
    expect(() => parseWorkspaceIdKeyring(JSON.stringify({ current: 'c', keys: { a: SECRET.a } }))).toThrow(/not in the keyring/);
    expect(() => parseWorkspaceIdKeyring(JSON.stringify({ current: 'A', keys: { A: SECRET.a } }))).toThrow(/one letter/);
    expect(() => parseWorkspaceIdKeyring(JSON.stringify({ current: 'a', keys: { a: 'short' } }))).toThrow(/16 characters/);
  });
});

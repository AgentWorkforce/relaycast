import { describe, expect, it } from 'vitest';
import { createWorkspaceIdSigner, parseWorkspaceIdKey, parseSelfRoutingCredential } from '../gateway.js';

const keyA = parseWorkspaceIdKey('a:first-secret-0123456789');
const keyB = parseWorkspaceIdKey('b:second-secret-0123456789');

describe('signed workspace ids', () => {
  it('mints ids the same signer verifies, usable in self-routing credentials', async () => {
    const signer = createWorkspaceIdSigner(keyA);
    const id = await signer.mint();
    expect(id).toMatch(/^[0-9]+a[0-9a-f]{32}$/);
    expect(await signer.verify(id)).toBe(true);
    expect(parseSelfRoutingCredential(`relaycast_ag_${id}_${'c'.repeat(64)}`)).toEqual({ kind: 'agent', workspaceId: id });
  });

  it('refuses forged, tampered and unknown-version ids', async () => {
    const signer = createWorkspaceIdSigner(keyA);
    const id = await signer.mint();
    const flipped = `${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`;
    expect(await signer.verify(flipped)).toBe(false);
    expect(await signer.verify(`1${id}`)).toBe(false);
    expect(await signer.verify('241764880589606912')).toBe(false);
    expect(await signer.verify(`${id.slice(0, id.indexOf('a'))}z${id.slice(id.indexOf('a') + 1)}`)).toBe(false);
    expect(await createWorkspaceIdSigner(parseWorkspaceIdKey('a:another-secret-012345')).verify(id)).toBe(false);
  });

  it('accepts the previous key during a rotation and mints with the current one', async () => {
    const before = await createWorkspaceIdSigner(keyA).mint();
    const rotated = createWorkspaceIdSigner(keyB, keyA);
    expect(await rotated.verify(before)).toBe(true);
    const after = await rotated.mint();
    expect(after).toMatch(/^[0-9]+b[0-9a-f]{32}$/);
    expect(await createWorkspaceIdSigner(keyB).verify(before)).toBe(false);
  });

  it('parses keys strictly', () => {
    expect(() => parseWorkspaceIdKey('first-secret-0123456789')).toThrow();
    expect(() => parseWorkspaceIdKey('A:first-secret-0123456789')).toThrow();
    expect(() => parseWorkspaceIdKey('a:short')).toThrow();
    expect(() => createWorkspaceIdSigner(keyA, keyA)).toThrow(/own version/);
  });
});

import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, randomHex, randomUuid, sha256Hex } from '../crypto.js';

describe('crypto helpers', () => {
  it('returns SHA-256 hex digests', async () => {
    await expect(sha256Hex('test-token')).resolves.toBe(
      '4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e',
    );
  });

  it('returns HMAC-SHA-256 hex signatures', async () => {
    await expect(hmacSha256Hex('payload', 'secret')).resolves.toBe(
      'b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4',
    );
  });

  it('generates random hex and UUID values', () => {
    expect(randomHex(16)).toMatch(/^[a-f0-9]{32}$/);
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

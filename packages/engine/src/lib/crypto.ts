const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, textEncoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

/**
 * Constant-time equality for caller-presented secrets (e.g. a bootstrap
 * secret proof header). Both inputs are hashed to a fixed-length digest
 * first so the comparison cost never varies with the length of an
 * attacker-controlled input, then compared byte-by-byte without
 * short-circuiting so it also never varies with how many leading bytes
 * matched.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < digestA.length; i += 1) {
    diff |= digestA.charCodeAt(i) ^ digestB.charCodeAt(i);
  }
  return diff === 0;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}

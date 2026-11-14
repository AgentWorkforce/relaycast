/**
 * Export blocks are sealed at rest: rows carry credential hashes and, for
 * outbound webhook subscriptions, their signing secrets and custom headers in
 * the clear (the actor needs them to sign deliveries). Each NDJSON line is
 * AES-256-GCM ciphertext under a key derived (HKDF-SHA256) from the
 * deployment's internal secret and the run id, with the line's place
 * (`<workspace>/<table>/<seq>`) as associated data, so a line cannot be read
 * without the secret nor moved to another table or position unnoticed.
 *
 *   v1.<iv base64url>.<ciphertext+tag base64url>
 *
 * The exporter and `relaycast-migrate` (files, import) both hold the internal
 * secret; nothing else in the export (manifest: tables, columns, counts,
 * digests) is secret. Used by the Node CLIs only (Buffer for base64url).
 */
export const SEALING = 'aes-256-gcm+hkdf-sha256/v1';
const INFO = new TextEncoder().encode('relaycast-migration-export v1');
const PREFIX = 'v1.';

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = Buffer.from(text, 'base64url');
  const out = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  out.set(bytes);
  return out;
};

/** The run's block key, from the deployment's internal secret. */
export async function exportKey(internalSecret: string, runId: string): Promise<CryptoKey> {
  const ikm = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(internalSecret), 'HKDF', false, ['deriveKey']);
  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(runId), info: INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Where a block sits; bound into its ciphertext. */
export function blockPlace(workspaceId: string, table: string, seq: number): string {
  return `${workspaceId}/${table}/${seq}`;
}

export async function sealBlock(key: CryptoKey, place: string, plaintext: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(place) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${PREFIX}${b64url(iv)}.${b64url(new Uint8Array(ciphertext))}`;
}

/** The plaintext of a sealed line; throws when the key, the place or the bytes are wrong. */
export async function openBlock(key: CryptoKey, place: string, line: string): Promise<string> {
  const parts = line.startsWith(PREFIX) ? line.slice(PREFIX.length).split('.') : [];
  if (parts.length !== 2) throw new Error(`${place}: not a sealed export block`);
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(parts[0]!), additionalData: new TextEncoder().encode(place) },
      key,
      fromB64url(parts[1]!),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(`${place}: the export block does not open with this deployment's internal secret (wrong secret, run or position, or a damaged file)`);
  }
}

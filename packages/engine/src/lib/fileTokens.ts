/**
 * Short-lived signed tokens for file upload/download URLs, built on WebCrypto
 * so the signer (an engine host) and the verifier (a gateway that holds the
 * blob store) can run on different runtimes and share only the secret.
 *
 * Token: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payload))>`.
 */
/**
 * Whether `key` has the engine's storage-key shape: three non-empty segments
 * (`<workspace_id>/<file_id>/<name>`), none of them `.` or `..`, no
 * backslashes. Such a key stays inside its workspace and file directory
 * wherever a store resolves keys as paths.
 */
export function isContainedStorageKey(key: string): boolean {
  if (key.includes('\\')) return false;
  const segments = key.split('/');
  return segments.length === 3 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export interface FileTokenPayload {
  /** Engine storage key (`<workspaceId>/<fileId>/<name>`). */
  key: string;
  /** `stat` reads the stored size (`HEAD`), for upload completion. */
  op: 'put' | 'get' | 'delete' | 'stat';
  /** Expiry, epoch seconds. */
  exp: number;
  /** `put` only: the exact byte length the upload must have. */
  size?: number;
  /** `put` only: the content type the upload must declare. */
  type?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('invalid base64url');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signFileToken(secret: string, payload: FileTokenPayload): Promise<string> {
  if (!isContainedStorageKey(payload.key)) throw new Error(`Refusing to sign storage key outside its workspace/file prefix: ${payload.key}`);
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The payload of a valid, unexpired token; `null` for anything else. */
export async function verifyFileToken(
  secret: string,
  token: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<FileTokenPayload | null> {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret, 'verify'),
      fromBase64Url(token.slice(dot + 1)),
      encoder.encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(body))) as Partial<FileTokenPayload>;
    if (
      typeof payload.key !== 'string' ||
      (payload.op !== 'put' && payload.op !== 'get' && payload.op !== 'delete' && payload.op !== 'stat') ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    if (payload.op === 'put' && (!Number.isSafeInteger(payload.size) || payload.size! < 1 || typeof payload.type !== 'string')) return null;
    if (!isContainedStorageKey(payload.key)) return null;
    if (payload.exp * 1000 < nowMs) return null;
    return payload.op === 'put'
      ? { key: payload.key, op: payload.op, exp: payload.exp, size: payload.size, type: payload.type }
      : { key: payload.key, op: payload.op, exp: payload.exp };
  } catch {
    return null;
  }
}

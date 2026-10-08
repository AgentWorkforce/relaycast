const encoder = new TextEncoder();

const STANDARD_WEBHOOK_SECRET_PREFIX = 'whsec_';
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('Standard Webhooks secret is not valid base64');
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let decoded: string;
  try {
    decoded = globalThis.atob(padded);
  } catch {
    throw new Error('Standard Webhooks secret is not valid base64');
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encodeBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function decodeStandardWebhookSecret(secretWhsec: string): Uint8Array {
  if (!secretWhsec.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)) {
    throw new Error('Standard Webhooks secret must start with whsec_');
  }
  const secret = decodeBase64(secretWhsec.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length));
  if (secret.length < MIN_SECRET_BYTES || secret.length > MAX_SECRET_BYTES) {
    throw new Error('Standard Webhooks secret must decode to 24-64 bytes');
  }
  return secret;
}

export function isValidStandardWebhookSecret(secretWhsec: string): boolean {
  try {
    decodeStandardWebhookSecret(secretWhsec);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign the exact request body using the Standard Webhooks symmetric scheme.
 * `tsSeconds` is the attempt timestamp, not the event creation timestamp.
 */
export async function signStandardWebhook(
  secretWhsec: string,
  msgId: string,
  tsSeconds: string,
  rawBody: string,
): Promise<string> {
  if (!msgId || !/^\d+$/.test(tsSeconds)) {
    throw new Error('Standard Webhooks signing requires a message id and Unix-seconds timestamp');
  }
  const secret = decodeStandardWebhookSecret(secretWhsec);
  const secretBytes = secret.buffer.slice(
    secret.byteOffset,
    secret.byteOffset + secret.byteLength,
  ) as ArrayBuffer;
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = `${msgId}.${tsSeconds}.${rawBody}`;
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(signed));
  return `v1,${encodeBase64(signature)}`;
}

export interface VerifyStandardWebhookOptions {
  /** Unix time used for freshness checks; defaults to the current time. */
  nowSeconds?: number;
  /** Maximum allowed clock skew in seconds; defaults to five minutes. */
  toleranceSeconds?: number;
}

/** Accept a fresh matching v1 signature from the rotation-friendly space-delimited header. */
export async function verifyStandardWebhook(
  secretWhsec: string,
  msgId: string,
  tsSeconds: string,
  rawBody: string,
  signatureHeader: string,
  options: VerifyStandardWebhookOptions = {},
): Promise<boolean> {
  if (!/^\d+$/.test(tsSeconds)) return false;
  const timestamp = Number(tsSeconds);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  if (!Number.isSafeInteger(timestamp)
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(tolerance)
    || tolerance < 0
    || Math.abs(now - timestamp) > tolerance) {
    return false;
  }
  const expected = await signStandardWebhook(secretWhsec, msgId, tsSeconds, rawBody);
  for (const candidate of signatureHeader.trim().split(/\s+/)) {
    if (!candidate.startsWith('v1,') || candidate.length !== expected.length) continue;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
    }
    if (difference === 0) return true;
  }
  return false;
}

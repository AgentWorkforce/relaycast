/**
 * Credential encryption — AES-256-GCM encrypt/decrypt for CLI credentials at rest.
 *
 * Uses a caller-supplied server-side encryption key to encrypt credentials
 * before writing to S3 and decrypt after reading.
 *
 * Each encrypted payload includes a random IV and auth tag, so identical
 * plaintext produces different ciphertext every time.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Envelope format stored in S3:
 * { iv: hex, tag: hex, ciphertext: base64, v: 1 }
 */
export interface EncryptedEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface CredentialCryptoRuntimeInfo {
  selectedDecryptBranch: "webcrypto" | "node";
  hasGlobalCrypto: boolean;
  hasSubtleCrypto: boolean;
  runtime: "browser_or_worker" | "node" | "unknown";
  envelopeVersion?: unknown;
  ivLength?: number;
  tagLength?: number;
  ciphertextLength?: number;
}

function getEncryptionKey(raw: string): Buffer {
  if (!raw) {
    throw new Error(
      "Credential encryption key is required. Provide a 64-char hex string (32 bytes)."
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(
      `Credential encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes.`
    );
  }

  return key;
}

function getEncryptionKeyBytes(raw: string): Uint8Array<ArrayBuffer> {
  if (!raw) {
    throw new Error(
      "Credential encryption key is required. Provide a 64-char hex string (32 bytes)."
    );
  }

  const key = hexToBytes(raw);
  if (key.length !== 32) {
    throw new Error(
      `Credential encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes.`
    );
  }

  return key;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (value.length % 2 !== 0) {
    throw new Error("Hex value must have an even number of characters");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error("Hex value contains non-hex characters");
    }
    bytes[i] = byte;
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getSubtleCrypto(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

function runtimeKind(): CredentialCryptoRuntimeInfo["runtime"] {
  if (typeof navigator !== "undefined" && typeof navigator.userAgent === "string") {
    return "browser_or_worker";
  }
  if (
    typeof process !== "undefined" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string"
  ) {
    return "node";
  }
  return "unknown";
}

export function credentialCryptoRuntimeInfo(
  envelope?: Partial<EncryptedEnvelope> | null,
): CredentialCryptoRuntimeInfo {
  const subtle = getSubtleCrypto();
  return {
    selectedDecryptBranch: subtle ? "webcrypto" : "node",
    hasGlobalCrypto: Boolean(globalThis.crypto),
    hasSubtleCrypto: Boolean(subtle),
    runtime: runtimeKind(),
    ...(envelope
      ? {
          envelopeVersion: envelope.v,
          ivLength: typeof envelope.iv === "string" ? envelope.iv.length : undefined,
          tagLength: typeof envelope.tag === "string" ? envelope.tag.length : undefined,
          ciphertextLength: typeof envelope.ciphertext === "string" ? envelope.ciphertext.length : undefined,
        }
      : {}),
  };
}

async function importAesGcmKey(encryptionKey: string): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    throw new Error("Web Crypto AES-GCM is not available in this runtime");
  }
  return subtle.importKey(
    "raw",
    getEncryptionKeyBytes(encryptionKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a plaintext string and return a JSON-serializable envelope.
 */
export function encryptCredential(
  plaintext: string,
  encryptionKey: string
): EncryptedEnvelope {
  const key = getEncryptionKey(encryptionKey);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    v: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: encrypted.toString("base64"),
  };
}

/**
 * Decrypt an encrypted envelope back to plaintext.
 */
export function decryptCredential(
  envelope: EncryptedEnvelope,
  encryptionKey: string
): string {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }

  const key = getEncryptionKey(encryptionKey);
  const iv = Buffer.from(envelope.iv, "hex");
  const tag = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/**
 * Async AES-GCM encryption for runtimes that do not implement Node's
 * createCipheriv/createDecipheriv APIs, notably Cloudflare Workers.
 *
 * The envelope is byte-compatible with encryptCredential/decryptCredential:
 * Web Crypto returns ciphertext and auth tag concatenated, so we split the
 * final 16 bytes into the existing `tag` field.
 */
export async function encryptCredentialAsync(
  plaintext: string,
  encryptionKey: string,
): Promise<EncryptedEnvelope> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    return encryptCredential(plaintext, encryptionKey);
  }

  const key = await importAesGcmKey(encryptionKey);
  const iv = new Uint8Array(IV_LENGTH);
  globalThis.crypto.getRandomValues(iv);
  const encrypted = new Uint8Array(
    await subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH * 8 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const ciphertext = encrypted.slice(0, encrypted.length - AUTH_TAG_LENGTH);
  const tag = encrypted.slice(encrypted.length - AUTH_TAG_LENGTH);

  return {
    v: 1,
    iv: bytesToHex(iv),
    tag: bytesToHex(tag),
    ciphertext: bytesToBase64(ciphertext),
  };
}

/**
 * Async AES-GCM decryption for runtimes that do not implement Node's
 * createCipheriv/createDecipheriv APIs, notably Cloudflare Workers.
 */
export async function decryptCredentialAsync(
  envelope: EncryptedEnvelope,
  encryptionKey: string,
): Promise<string> {
  if (envelope.v !== 1) {
    throw new Error(`Unsupported envelope version: ${envelope.v}`);
  }

  const subtle = getSubtleCrypto();
  if (!subtle) {
    return decryptCredential(envelope, encryptionKey);
  }

  const key = await importAesGcmKey(encryptionKey);
  const iv = hexToBytes(envelope.iv);
  const tag = hexToBytes(envelope.tag);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext, 0);
  combined.set(tag, ciphertext.length);
  const decrypted = await subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH * 8 },
    key,
    combined,
  );

  return new TextDecoder().decode(decrypted);
}

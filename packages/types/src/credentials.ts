/**
 * Relaycast credentials come in two families, and every deployment accepts both:
 *
 * - `legacy`: `rk_live_…` (workspace key), `at_live_…` (agent), `nt_live_…`
 *   (node), `ot_live_…` (observer), `wh_live_…` (inbound webhook);
 * - `ar`: `ar_<kind>_<wsid>_<tag>_<secret><crc>`:
 *   - `kind`: `ws` | `ag` | `nd` | `ob` | `wh` ({@link AR_KIND_CODES});
 *   - `wsid`: the workspace snowflake (64-bit) in base62, 11 characters;
 *   - `tag`: a key-version letter plus 10 base62 characters of
 *     HMAC-SHA256(keyring[version], wsid), which lets a gateway refuse a
 *     forged workspace with no lookup;
 *   - `secret`: 32 random bytes in base62, 43 characters;
 *   - `crc`: CRC-32 of every preceding character in base62, 6 characters, so
 *     a typo or truncation is rejected offline and secret scanners match
 *     precisely.
 *
 * This module is the one classifier of credential shape for the engine and
 * every client. Shape (including the checksum) says nothing about validity;
 * the server decides that.
 */
export type CredentialKind = 'workspace' | 'agent' | 'node' | 'observer' | 'webhook';
export type CredentialFamily = 'legacy' | 'ar';

export type ParsedCredential =
  | { family: 'legacy'; kind: CredentialKind }
  | {
      family: 'ar';
      kind: CredentialKind;
      /** The workspace snowflake, in decimal. */
      workspaceId: string;
      /** The routing tag: key version letter plus 10 base62 characters. */
      tag: string;
      /** The keyring version that signed the tag. */
      keyVersion: string;
    };

/** The `legacy` prefix for each kind. */
export const LEGACY_CREDENTIAL_PREFIXES: Readonly<Record<CredentialKind, string>> = {
  workspace: 'rk_live_',
  agent: 'at_live_',
  node: 'nt_live_',
  observer: 'ot_live_',
  webhook: 'wh_live_',
};

/**
 * Reserved `ar_` kind codes for relaycast credentials (`ar_<code>_…`).
 *
 * The `ar_` prefix is shared across agent relay services. RelayAuth will take
 * a service segment (`ar_au_<kind>_…`), so `au` is never a relaycast kind
 * code. RelayAuth's current `relay_ws_` / `relay_ag_` / `relay_pa_` /
 * `relay_id_` tokens belong to that service and are never relaycast
 * credentials.
 */
export const AR_KIND_CODES: Readonly<Record<CredentialKind, string>> = {
  workspace: 'ws',
  agent: 'ag',
  node: 'nd',
  observer: 'ob',
  webhook: 'wh',
};

/** `ar_` service segments reserved for other agent relay services. */
export const AR_RESERVED_SERVICE_CODES: readonly string[] = ['au'];

export const AR_CREDENTIAL_PREFIX = 'ar_';
export const AR_WORKSPACE_ID_LENGTH = 11;
export const AR_TAG_LENGTH = 11;
export const AR_SECRET_LENGTH = 43;
export const AR_CHECKSUM_LENGTH = 6;
/** Secret bytes an `ar_` credential carries. */
export const AR_SECRET_BYTES = 32;

const KIND_BY_CODE = Object.fromEntries(
  Object.entries(AR_KIND_CODES).map(([kind, code]) => [code, kind]),
) as Record<string, CredentialKind>;

const KINDS = Object.keys(LEGACY_CREDENTIAL_PREFIXES) as CredentialKind[];
const AR = /^ar_(ws|ag|nd|ob|wh)_([0-9A-Za-z]{11})_([a-z][0-9A-Za-z]{10})_([0-9A-Za-z]{43})([0-9A-Za-z]{6})$/;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

/** `value` in base62, left-padded with `0` to `width` characters. */
export function base62Encode(value: bigint, width: number): string {
  if (value < 0n) throw new Error('base62 encodes non-negative integers');
  let out = '';
  for (let rest = value; rest > 0n; rest /= 62n) out = BASE62[Number(rest % 62n)] + out;
  if (out.length > width) throw new Error(`Value does not fit ${width} base62 characters`);
  return out.padStart(width, '0');
}

export function base62Decode(text: string): bigint {
  let value = 0n;
  for (const char of text) {
    const digit = BASE62.indexOf(char);
    if (digit < 0) throw new Error('Not base62');
    value = value * 62n + BigInt(digit);
  }
  return value;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** The 11-character base62 form of a workspace snowflake (decimal, 64-bit). */
export function encodeArWorkspaceId(workspaceId: string): string {
  const value = /^(0|[1-9][0-9]{0,19})$/.test(workspaceId) ? BigInt(workspaceId) : -1n;
  if (value < 0n || value > MAX_SNOWFLAKE) {
    throw new Error(`Workspace id ${JSON.stringify(workspaceId)} is not a 64-bit snowflake`);
  }
  return base62Encode(value, AR_WORKSPACE_ID_LENGTH);
}

/** Whether `workspaceId` is a 64-bit snowflake an `ar_` credential can carry. */
export function isArWorkspaceId(workspaceId: string): boolean {
  try {
    encodeArWorkspaceId(workspaceId);
    return true;
  } catch {
    return false;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of an ASCII string. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i += 1) crc = CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function arChecksum(body: string): string {
  return base62Encode(BigInt(crc32(body)), AR_CHECKSUM_LENGTH);
}

/**
 * Assemble an `ar_` credential. `tag` comes from the deployment's keyring
 * (`createCredentialTagSigner` in `@relaycast/engine`); `secret` is exactly
 * {@link AR_SECRET_BYTES} bytes.
 */
export function encodeArCredential(args: {
  kind: CredentialKind;
  workspaceId: string;
  tag: string;
  secret: Uint8Array;
}): string {
  if (!/^[a-z][0-9A-Za-z]{10}$/.test(args.tag)) throw new Error('A credential tag is a key version letter plus 10 base62 characters');
  if (args.secret.length !== AR_SECRET_BYTES) throw new Error(`A credential secret is ${AR_SECRET_BYTES} bytes`);
  const body = `${AR_CREDENTIAL_PREFIX}${AR_KIND_CODES[args.kind]}_${encodeArWorkspaceId(args.workspaceId)}_${args.tag}_`
    + base62Encode(bytesToBigInt(args.secret), AR_SECRET_LENGTH);
  return body + arChecksum(body);
}

/** Family, kind and (for `ar`) workspace and tag of a credential, from its shape and checksum. */
export function parseCredential(token: string): ParsedCredential | undefined {
  const ar = AR.exec(token);
  if (ar) {
    if (arChecksum(token.slice(0, -AR_CHECKSUM_LENGTH)) !== ar[5]) return undefined;
    const workspace = base62Decode(ar[2]);
    if (workspace > MAX_SNOWFLAKE) return undefined;
    return { family: 'ar', kind: KIND_BY_CODE[ar[1]], workspaceId: workspace.toString(), tag: ar[3], keyVersion: ar[3][0] };
  }
  const kind = KINDS.find((candidate) => token.startsWith(LEGACY_CREDENTIAL_PREFIXES[candidate]));
  return kind ? { family: 'legacy', kind } : undefined;
}

export function credentialKind(token: string): CredentialKind | undefined {
  return parseCredential(token)?.kind;
}

export function credentialFamily(token: string): CredentialFamily | undefined {
  return parseCredential(token)?.family;
}

/** The workspace an `ar_` credential names; `undefined` for the `legacy` family. */
export function credentialWorkspaceId(token: string): string | undefined {
  const parsed = parseCredential(token);
  return parsed?.family === 'ar' ? parsed.workspaceId : undefined;
}

export function isWorkspaceKey(token: string): boolean {
  return credentialKind(token) === 'workspace';
}

export function isObserverToken(token: string): boolean {
  return credentialKind(token) === 'observer';
}

/**
 * A credential with its secret hidden, safe to display: the prefix, kind,
 * workspace and tag of an `ar_` credential stay, and the secret shows only its
 * first and last four characters.
 */
export function maskCredential(token: string): string {
  if (parseCredential(token)?.family === 'ar') {
    const end = token.length - AR_CHECKSUM_LENGTH;
    const start = end - AR_SECRET_LENGTH;
    return `${token.slice(0, start)}${token.slice(start, start + 4)}...${token.slice(end - 4, end)}`;
  }
  if (token.length <= 16) return token;
  return `${token.slice(0, 12)}...${token.slice(-4)}`;
}

/**
 * Credentials of either family anywhere in `text`, matched by structure (no
 * word boundaries), so one glued to surrounding text is still found.
 */
const CREDENTIAL_IN_TEXT = /ar_(?:ws|ag|nd|ob|wh)_[0-9A-Za-z]{11}_[a-z][0-9A-Za-z]{10}_[0-9A-Za-z]{49}|(?:rk|at|nt|ot|wh)_live_[A-Za-z0-9_-]+/g;

export function redactCredentials(text: string, replacement: string): string {
  return text.replace(CREDENTIAL_IN_TEXT, () => replacement);
}

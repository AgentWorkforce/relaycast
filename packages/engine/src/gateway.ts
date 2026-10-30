/**
 * The pieces a stateless gateway in front of workspace actors needs, without
 * the engine itself: route by self-routing credential, mint and verify signed
 * workspace ids, serve signed file URLs, and forward requests as actor calls.
 */
import { generateId } from './engine/snowflake.js';

export { parseSelfRoutingCredential } from './auth/credentials.js';
export type { CredentialKind } from './auth/credentials.js';
export { signFileToken, verifyFileToken } from './lib/fileTokens.js';
export type { FileTokenPayload } from './lib/fileTokens.js';
export type { ActorHttpRequest, ActorHttpResponse } from './adapters/actor/http.js';
export { ACTOR_FILE_ROUTE, OBJECT_SIZE_HEADER } from './adapters/actor/files.js';

/**
 * The keys workspace ids are signed with: one secret per version letter
 * (`a`-`z`) and the version that signs new ids. Workspace ids are permanent,
 * so rotation adds a version and makes it current; it never drops one.
 * Removing a version is an explicit act that locks out every workspace minted
 * under it.
 */
export interface WorkspaceIdKeyring {
  current: string;
  keys: Readonly<Record<string, string>>;
}

/** Parse a keyring from configuration: `{"current":"b","keys":{"a":"<secret>","b":"<secret>"}}`. */
export function parseWorkspaceIdKeyring(json: string): WorkspaceIdKeyring {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('The workspace id keyring is not valid JSON');
  }
  const { current, keys } = (value ?? {}) as { current?: unknown; keys?: unknown };
  if (typeof current !== 'string' || !keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('The workspace id keyring is {"current": "<version>", "keys": {"<version>": "<secret>"}}');
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  for (const [version, secret] of entries) {
    if (!/^[a-z]$/.test(version)) throw new Error(`Workspace id key version ${JSON.stringify(version)} is not one letter a-z`);
    if (typeof secret !== 'string' || secret.length < 16) throw new Error(`Workspace id key ${version} needs a secret of at least 16 characters`);
  }
  if (!Object.hasOwn(keys, current)) throw new Error(`The current workspace id key version ${JSON.stringify(current)} is not in the keyring`);
  return { current, keys: Object.fromEntries(entries) as Record<string, string> };
}

export interface WorkspaceIdSigner {
  /** A new workspace id, signed with the current key version. */
  mint(): Promise<string>;
  /** Whether `id` carries a valid tag from the key version it names. */
  verify(id: string): Promise<boolean>;
}

const TAG_HEX = 32;
const SIGNED_WORKSPACE_ID = /^([0-9]{1,20})([a-z])([0-9a-f]{32})$/;
const encoder = new TextEncoder();

/**
 * Workspace ids that prove the gateway minted them:
 * `<snowflake><key version><HMAC-SHA256(secret, version + snowflake), 16 bytes hex>`.
 * A gateway verifies the tag before it calls an actor, so a credential naming
 * a made-up workspace never creates one. The id stays alphanumeric, so the
 * engine and the credential format treat it as any other workspace id. An id
 * verifies with the key of the version it names, for as long as the keyring
 * holds that version. HMAC keys are imported once per signer.
 */
export function createWorkspaceIdSigner(keyring: WorkspaceIdKeyring): WorkspaceIdSigner {
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const [version, secret] of Object.entries(keyring.keys)) {
    if (!/^[a-z]$/.test(version)) throw new Error('A workspace id key version is one letter a-z');
    keys.set(version, crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  if (!keys.has(keyring.current)) throw new Error('The current workspace id key version is not in the keyring');
  const tag = async (version: string, body: string): Promise<string | undefined> => {
    const key = keys.get(version);
    if (!key) return undefined;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(version + body)));
    return Array.from(mac.subarray(0, TAG_HEX / 2), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  return {
    async mint() {
      const body = generateId();
      return `${body}${keyring.current}${await tag(keyring.current, body)}`;
    },
    async verify(id) {
      const match = SIGNED_WORKSPACE_ID.exec(id);
      if (!match) return false;
      const expected = await tag(match[2], match[1]);
      if (!expected) return false;
      let diff = 0;
      for (let i = 0; i < TAG_HEX; i += 1) diff |= expected.charCodeAt(i) ^ match[3].charCodeAt(i);
      return diff === 0;
    },
  };
}

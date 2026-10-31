import { base62Encode, encodeArWorkspaceId, parseCredential } from '@relaycast/types';

/** Shortest key secret a keyring accepts. */
const MIN_SECRET_LENGTH = 16;

/**
 * The keys `ar_` credential tags are signed with: one secret per version letter
 * (`a`-`z`) and the version that signs new tags. Credentials outlive key
 * changes, so rotation adds a version and makes it current; it never drops
 * one. Removing a version is an explicit act that locks out every credential
 * tagged under it.
 */
export interface CredentialKeyring {
  current: string;
  keys: Readonly<Record<string, string>>;
}

/** Parse a keyring from configuration: `{"current":"b","keys":{"a":"<secret>","b":"<secret>"}}`. */
export function parseCredentialKeyring(json: string): CredentialKeyring {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('The credential keyring is not valid JSON');
  }
  const { current, keys } = (value ?? {}) as { current?: unknown; keys?: unknown };
  if (typeof current !== 'string' || !keys || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error('The credential keyring is {"current": "<version>", "keys": {"<version>": "<secret>"}}');
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  for (const [version, secret] of entries) {
    if (!/^[a-z]$/.test(version)) throw new Error(`Credential key version ${JSON.stringify(version)} is not one letter a-z`);
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`Credential key ${version} needs a secret of at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  if (!Object.hasOwn(keys, current)) throw new Error(`The current credential key version ${JSON.stringify(current)} is not in the keyring`);
  return { current, keys: Object.fromEntries(entries) as Record<string, string> };
}

/**
 * Where an engine gets the routing tag for its workspaces' `ar_` credentials
 * (`EngineConfig.credentialTagger`). A host holding the keyring uses
 * {@link createCredentialTagSigner}; a workspace actor uses the tag its
 * gateway handed it at create.
 */
export interface CredentialTagger {
  /** The tag new credentials for `workspaceId` carry. */
  tag(workspaceId: string): Promise<string>;
  /**
   * Every tag a credential for `workspaceId` may carry, the current one first.
   * Deterministic-key recovery (workspace create replay) tries each.
   */
  tags(workspaceId: string): Promise<readonly string[]>;
}

export interface CredentialTagSigner extends CredentialTagger {
  /** Whether an `ar_` credential's tag was signed for its workspace by a version in the keyring. */
  verify(token: string): Promise<boolean>;
}

const TAG_BODY_LENGTH = 10;
const TAG_MODULUS = 62n ** BigInt(TAG_BODY_LENGTH);
const encoder = new TextEncoder();

/**
 * Tags from a keyring: `<version><10 base62 of HMAC-SHA256(key, wsid)>`, where
 * `wsid` is the credential's 11-character workspace segment. A gateway
 * verifies a credential's tag with the version it names, so a credential for a
 * workspace this deployment never tagged is refused without a lookup. HMAC
 * keys are imported once per signer.
 */
export function createCredentialTagSigner(keyring: CredentialKeyring): CredentialTagSigner {
  const keys = new Map<string, Promise<CryptoKey>>();
  if (!keyring || typeof keyring.keys !== 'object' || keyring.keys === null || Array.isArray(keyring.keys)) {
    throw new Error('The credential keyring is {"current": "<version>", "keys": {"<version>": "<secret>"}}');
  }
  for (const [version, secret] of Object.entries(keyring.keys)) {
    if (!/^[a-z]$/.test(version)) throw new Error('A credential key version is one letter a-z');
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`Credential key ${version} needs a secret of at least ${MIN_SECRET_LENGTH} characters`);
    }
    keys.set(version, crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  if (!keys.has(keyring.current)) throw new Error('The current credential key version is not in the keyring');
  const versions = [keyring.current, ...[...keys.keys()].filter((version) => version !== keyring.current)];

  const tagFor = async (version: string, wsid: string): Promise<string | undefined> => {
    const key = keys.get(version);
    if (!key) return undefined;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(wsid)));
    let value = 0n;
    for (const byte of mac.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
    return version + base62Encode(value % TAG_MODULUS, TAG_BODY_LENGTH);
  };

  return {
    async tag(workspaceId) {
      return (await tagFor(keyring.current, encodeArWorkspaceId(workspaceId)))!;
    },
    async tags(workspaceId) {
      const wsid = encodeArWorkspaceId(workspaceId);
      return Promise.all(versions.map(async (version) => (await tagFor(version, wsid))!));
    },
    async verify(token) {
      const parsed = parseCredential(token);
      if (parsed?.family !== 'ar') return false;
      const expected = await tagFor(parsed.keyVersion, encodeArWorkspaceId(parsed.workspaceId));
      if (!expected) return false;
      let diff = 0;
      for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ parsed.tag.charCodeAt(i);
      return diff === 0;
    },
  };
}

/** A tagger for one workspace whose tag was handed over at create (the workspace actor). */
export function fixedCredentialTagger(workspaceId: string, tag: () => string | undefined): CredentialTagger {
  const current = (forWorkspace: string): string => {
    if (forWorkspace !== workspaceId) throw new Error(`No credential tag for workspace ${forWorkspace}`);
    const value = tag();
    if (!value) throw new Error('This workspace has no credential tag yet; its gateway supplies one at create');
    return value;
  };
  return {
    async tag(forWorkspace) {
      return current(forWorkspace);
    },
    async tags(forWorkspace) {
      return [current(forWorkspace)];
    },
  };
}

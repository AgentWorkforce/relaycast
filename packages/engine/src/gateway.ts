/**
 * The pieces a stateless gateway in front of workspace actors needs, without
 * the engine itself: route by self-routing credential, mint and verify signed
 * workspace ids, serve signed file URLs, and drive the actor call/replay
 * protocol.
 */
import { parseActorReplay, type ActorWriteGroupFailure } from './adapters/actor/call-scope.js';
import type { ActorHttpRequest, ActorHttpResponse } from './adapters/actor/http.js';
import { generateId } from './engine/snowflake.js';

export { parseSelfRoutingCredential } from './auth/credentials.js';
export type { CredentialKind } from './auth/credentials.js';
export { signFileToken, verifyFileToken } from './lib/fileTokens.js';
export type { FileTokenPayload } from './lib/fileTokens.js';
export type { ActorWriteGroupFailure, ActorSerializedError } from './adapters/actor/call-scope.js';
export type { ActorHttpRequest, ActorHttpResponse } from './adapters/actor/http.js';
export { ACTOR_FILE_ROUTE } from './adapters/actor/files.js';

/** One actor call: `handle` or `create` on the workspace actor, with the failures to replay. */
export type ActorHttpCall = (
  request: ActorHttpRequest,
  replay: ActorWriteGroupFailure[],
) => Promise<ActorHttpResponse>;

/** Upper bound on passes; each pass that rolls back records at least one new failure. */
const MAX_PASSES = 8;

/**
 * Call a workspace actor until a pass commits. A pass whose write group
 * failed after writing rolls back and reports the failure; the next pass
 * replays it (see `adapters/actor/call-scope.ts`).
 */
export async function callWorkspaceActor(call: ActorHttpCall, request: ActorHttpRequest): Promise<ActorHttpResponse> {
  let replay: ActorWriteGroupFailure[] = [];
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    try {
      return await call(request, replay);
    } catch (error) {
      const failures = error instanceof Error ? parseActorReplay(error.message) : undefined;
      if (!failures) throw error;
      if (failures.length <= replay.length) throw new Error('Workspace actor replay made no progress', { cause: error });
      replay = failures;
    }
  }
  throw new Error(`Workspace actor call did not commit within ${MAX_PASSES} passes`);
}

/** One workspace-id signing key: a version letter (`a`–`z`) and its secret. */
export interface WorkspaceIdKey {
  version: string;
  secret: string;
}

/** Parse `<version>:<secret>`, the form gateways read keys from configuration in. */
export function parseWorkspaceIdKey(value: string): WorkspaceIdKey {
  const match = /^([a-z]):(.{16,})$/s.exec(value);
  if (!match) throw new Error('A workspace id key is "<version a-z>:<secret of at least 16 characters>"');
  return { version: match[1], secret: match[2] };
}

export interface WorkspaceIdSigner {
  /** A new workspace id, signed with the current key. */
  mint(): Promise<string>;
  /** Whether `id` carries a valid tag from the current or previous key. */
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
 * engine and the credential format treat it as any other workspace id.
 * Verification accepts the current key and, during a rotation, the previous one.
 */
export function createWorkspaceIdSigner(current: WorkspaceIdKey, previous?: WorkspaceIdKey): WorkspaceIdSigner {
  if (previous && previous.version === current.version) {
    throw new Error('The previous workspace id key needs its own version letter');
  }
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const key of [current, previous]) {
    if (!key) continue;
    if (!/^[a-z]$/.test(key.version)) throw new Error('A workspace id key version is one letter a-z');
    keys.set(key.version, crypto.subtle.importKey('raw', encoder.encode(key.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  }
  const tag = async (version: string, body: string): Promise<string | undefined> => {
    const key = keys.get(version);
    if (!key) return undefined;
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key, encoder.encode(version + body)));
    return Array.from(mac.subarray(0, TAG_HEX / 2), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  return {
    async mint() {
      const body = generateId();
      return `${body}${current.version}${await tag(current.version, body)}`;
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

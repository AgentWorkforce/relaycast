/**
 * The pieces a stateless gateway in front of workspace actors needs, without
 * the engine itself: parse an `ar_` credential and verify its tag with the
 * keyring (no lookup), mint workspace ids (plain snowflakes) and their tags,
 * serve signed file URLs, and forward requests as actor calls.
 */
import { generateId } from './engine/snowflake.js';

export { parseArCredential } from './auth/credentials.js';
export type { CredentialKind } from './auth/credentials.js';
export { createCredentialTagSigner, parseCredentialKeyring } from './auth/credentialTags.js';
export type { CredentialKeyring, CredentialTagSigner, CredentialTagger } from './auth/credentialTags.js';
export { INTERNAL_CAPABILITIES } from './engine/internalAdmin.js';
export { signFileToken, verifyFileToken } from './lib/fileTokens.js';
export type { FileTokenPayload } from './lib/fileTokens.js';
export type { ActorHttpRequest, ActorHttpResponse } from './adapters/actor/http.js';
export { ACTOR_FILE_ROUTE, OBJECT_SIZE_HEADER } from './adapters/actor/files.js';
export {
  SOCKET_GRANT_HEADER,
  SOCKET_GRANT_MAX_AGE_MS,
  SocketGrantSchema,
  SocketPrincipalSchema,
  canonicalSocketPrincipal,
  isSocketGrant,
  signSocketPrincipal,
  verifySocketPrincipal,
  type SignedSocketPrincipal,
  type SocketGrant,
  type SocketPrincipal,
  type SocketPrincipalVerdict,
} from './adapters/actor/socket-grant.js';

/** A new workspace id: a snowflake, as every relaycast deployment uses. */
export function generateWorkspaceId(): string {
  return generateId();
}

const MAX_KEYED_WORKSPACE_ID = (1n << 63n) - 1n;

/**
 * The workspace id a keyed create (`Idempotency-Key`) lands on: derived from
 * the deployment's bootstrap secret and the key, so a retry reaches the same
 * actor and its own idempotency record answers it. A positive 63-bit value,
 * which is a valid snowflake for `ar_` credentials (`isArWorkspaceId`).
 */
export async function deriveKeyedWorkspaceId(bootstrapSecret: string, idempotencyKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(bootstrapSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`relaycast:workspace-id:v1:${idempotencyKey}`)));
  let value = 0n;
  for (const byte of mac.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  value &= MAX_KEYED_WORKSPACE_ID;
  return (value === 0n ? 1n : value).toString();
}

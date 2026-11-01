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
export { signFileToken, verifyFileToken } from './lib/fileTokens.js';
export type { FileTokenPayload } from './lib/fileTokens.js';
export type { ActorHttpRequest, ActorHttpResponse } from './adapters/actor/http.js';
export { ACTOR_FILE_ROUTE, OBJECT_SIZE_HEADER } from './adapters/actor/files.js';

/** A new workspace id: a snowflake, as every relaycast deployment uses. */
export function generateWorkspaceId(): string {
  return generateId();
}

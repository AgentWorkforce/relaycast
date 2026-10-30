/**
 * The pieces a stateless gateway in front of workspace actors needs, without
 * the engine itself: route by self-routing credential, allocate workspace ids,
 * serve signed file URLs, and drive the actor call/replay protocol.
 */
import { parseActorReplay, type ActorWriteGroupFailure } from './adapters/actor/call-scope.js';
import type { ActorHttpRequest, ActorHttpResponse } from './adapters/actor/http.js';

export { parseSelfRoutingCredential } from './auth/credentials.js';
export type { CredentialKind } from './auth/credentials.js';
export { verifyFileToken } from './lib/fileTokens.js';
export type { FileTokenPayload } from './lib/fileTokens.js';
export { generateId as generateWorkspaceId } from './engine/snowflake.js';
export { parseActorReplay } from './adapters/actor/call-scope.js';
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

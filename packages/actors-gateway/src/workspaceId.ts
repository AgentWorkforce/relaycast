/**
 * The id a new workspace (and its actor) gets, and the admission of a keyed
 * create. A plain create takes a fresh snowflake. A create carrying an
 * `Idempotency-Key` takes an id derived from the deployment's bootstrap
 * secret and the key, so a retry reaches the same actor and the engine's own
 * idempotency record (owner-scoped or anonymous, with its request digest)
 * answers it; without the secret such a create fails closed with the
 * engine's own error. An owner-scoped keyed create (an `ar_ws_` bearer)
 * derives per owner, as the engine scopes its record. A deployment that
 * requires proof of the secret (`RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED`)
 * refuses a keyed create without it here unless its bearer is an `ar_ws_`
 * credential, in the engine's order (after the secret check, before any id
 * is derived or actor called) and with the engine's answer, so no actor is
 * activated for a create the engine would refuse.
 */
import type { IncomingMessage } from 'node:http';
import { deriveKeyedWorkspaceId, generateWorkspaceId, parseArCredential } from '@relaycast/engine/gateway';
import { bearerToken, constantTimeEqual } from './http.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** The engine's proof header for an anonymous keyed create. */
export const BOOTSTRAP_PROOF_HEADER = 'x-workspace-bootstrap-secret';

export interface KeyedCreatePolicy {
  /** Derives keyed ids; the actors hold the same value. Unset: a keyed create fails closed (503). */
  bootstrapSecret: string | undefined;
  /** The engine's self-host option: an anonymous keyed create must prove `bootstrapSecret`. */
  proofRequired?: boolean;
}

export type WorkspaceIdChoice =
  | { workspaceId: string; keyed: boolean }
  | { error: { status: number; code: string; message: string } };

/**
 * Whether an unkeyed create's answer means its fresh id was already taken:
 * every replica mints snowflakes with a worker id of its own (10 bits of a
 * random UUID), so two can meet in one millisecond. Such a create is retried
 * once under another id; a keyed one is answered as is (that id is the key's).
 */
export function isWorkspaceIdTaken(response: { status: number; body: string }): boolean {
  if (response.status !== 409) return false;
  try {
    return (JSON.parse(response.body) as { error?: { code?: unknown } }).error?.code === 'workspace_exists';
  } catch {
    return false;
  }
}

/** The presented proof as the actor's engine will see it: the parsed header value, repeats joined with ", ". */
function presentedProof(req: IncomingMessage): string | undefined {
  const value = req.headers[BOOTSTRAP_PROOF_HEADER];
  return Array.isArray(value) ? value.join(', ') : value;
}

export async function chooseWorkspaceId(req: IncomingMessage, policy: KeyedCreatePolicy): Promise<WorkspaceIdChoice> {
  const presented = req.headers[IDEMPOTENCY_KEY_HEADER];
  const key = (Array.isArray(presented) ? presented[0] : presented)?.trim();
  // Absent or blank: the actor answers a blank key with the engine's 400 and creates nothing.
  if (!key) return { workspaceId: generateWorkspaceId(), keyed: false };
  if (!policy.bootstrapSecret) {
    return { error: { status: 503, code: 'workspace_create_idempotency_unavailable', message: 'Anonymous workspace create idempotency is not configured on this deployment' } };
  }
  // Only an `ar_ws_` bearer makes the create an owner's (the router then
  // verifies it through the owner's actor before any child is activated).
  // Every other keyed create is gated here when proof is required: with no
  // Authorization, a blank one, or any other bearer (which the engine would
  // answer 401 itself, but only after the key's actor had been activated).
  // The proof is compared in constant time against the secret's exact bytes.
  const bearer = bearerToken(req);
  const owner = bearer ? parseArCredential(bearer) : undefined;
  const ownerWorkspaceId = owner?.kind === 'workspace' ? owner.workspaceId : undefined;
  if (policy.proofRequired && ownerWorkspaceId === undefined) {
    const proof = presentedProof(req);
    if (!proof || !constantTimeEqual(proof, policy.bootstrapSecret)) {
      return { error: { status: 401, code: 'workspace_create_bootstrap_secret_invalid', message: 'A valid workspace bootstrap secret is required for anonymous idempotent workspace creation' } };
    }
  }
  return { workspaceId: await deriveKeyedWorkspaceId(policy.bootstrapSecret, key, ownerWorkspaceId), keyed: true };
}

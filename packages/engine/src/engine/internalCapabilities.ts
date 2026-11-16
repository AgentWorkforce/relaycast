/**
 * What the internal admin API advertises, in a module with no database or
 * engine dependencies so a stateless gateway can import it from
 * `@relaycast/engine/gateway` without loading the admin implementation.
 */
import { hmacSha256Hex } from '../lib/crypto.js';

/** Longest grace a pushed workspace key may keep its predecessor valid for. */
export const WORKSPACE_KEY_MAX_GRACE_MS = 3_600_000;

/**
 * `GET /internal/capabilities`. A self-host engine has no auth cache, so
 * `revocation_markers` is satisfied by the previous-key slot itself: a
 * superseded key stops authenticating the moment its slot expires, with no
 * KV marker to arm or repair. `workspace_admin` is a self-host extension
 * (absent on the hosted gateway): `create` advertises POST /internal/workspaces
 * and `server_minted_key` that POST /internal/workspaces/:id/api-key may omit
 * `api_key` to have the engine mint the replacement. `expiry` advertises
 * POST /internal/workspaces/:id/expiry (move or clear a live workspace's
 * deadline), which the hosted gateway serves too.
 *
 * `create_idempotency` advertises that POST /internal/workspaces honours an
 * `Idempotency-Key` (replay returns the same workspace and key; a different
 * body is 409 `workspace_create_idempotency_conflict`; a deleted binding is
 * 409 `workspace_create_idempotency_terminalized`). It is `false` here, the
 * default: a host serves it `true` (see `internalCapabilities`) only when a
 * workspace bootstrap secret is configured and it serves the create route,
 * since the secret is what keyed creates derive their ids and keys from.
 */
export const INTERNAL_CAPABILITIES = {
  workspace_key_push: {
    generation_cas: true,
    generation_required_once_fenced: true,
    grace_ms: true,
    max_grace_ms: WORKSPACE_KEY_MAX_GRACE_MS,
    revocation_markers: true,
    previous_key_slot: true,
  },
  workspace_admin: {
    create: true,
    delete: true,
    server_minted_key: true,
    expiry: true,
    create_idempotency: false,
  },
} as const;

/**
 * The capability document a host serves: `INTERNAL_CAPABILITIES` with
 * `create` cleared on a host that does not serve POST /internal/workspaces (a
 * single-workspace actor) and `create_idempotency` set only when keyed creates
 * work there (a bootstrap secret is configured and `create` is served).
 */
export function internalCapabilities(options: { create: boolean; createIdempotency: boolean }) {
  return {
    ...INTERNAL_CAPABILITIES,
    workspace_admin: {
      ...INTERNAL_CAPABILITIES.workspace_admin,
      create: options.create,
      create_idempotency: options.create && options.createIdempotency,
    },
  };
}

/**
 * The Idempotency-Key a keyed POST /internal/workspaces is recorded and
 * derived under: HMAC-SHA256 of the caller's key, keyed by the deployment's
 * workspace bootstrap secret, under a label of its own, as 64 hex chars.
 *
 * The internal create is then an anonymous bootstrap create of this derived
 * key (the same binding table, replay, conflict and terminalization rules and
 * key derivation as the public route), but in a keyspace disjoint from the
 * public one. A public anonymous caller presenting the same Idempotency-Key
 * value is recorded under that raw value, never under its HMAC, so it can
 * neither recover nor conflict with a binding the control plane created here,
 * and the reverse. Reaching the internal binding through the public route
 * would mean presenting the HMAC itself, which needs the bootstrap secret; a
 * prefix such as `internal:` would not do, since `parseIdempotencyKey` lets a
 * public caller send any visible ASCII. The derived value is 64 characters,
 * so the public route's 32-character floor for anonymous keys holds without
 * imposing one on the internal caller, whose authorization is the internal
 * secret. Rotating the bootstrap secret makes a retry a new create, as it
 * does for public keyed creates.
 */
export function deriveInternalWorkspaceCreateKey(bootstrapSecret: string, idempotencyKey: string): Promise<string> {
  return hmacSha256Hex(`relaycast:internal-workspace-create:v1:${idempotencyKey}`, bootstrapSecret);
}

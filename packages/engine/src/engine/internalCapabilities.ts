/**
 * What the internal admin API advertises, in a module with no database or
 * engine dependencies so a stateless gateway can import it from
 * `@relaycast/engine/gateway` without loading the admin implementation.
 */

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
  },
} as const;

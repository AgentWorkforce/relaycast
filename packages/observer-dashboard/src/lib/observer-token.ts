/**
 * Observer-token minting for workspace-key logins.
 *
 * The engine rejects the root workspace key (`rk_live_`) on the realtime
 * endpoint (`GET /v1/ws`) — only a scoped observer token (`ot_live_`) with
 * `stream:read` may open the workspace stream. So when an operator logs into
 * the dashboard with a workspace admin key, we mint a read-only observer token
 * on their behalf and hand *that* to the stream, so the socket never carries a
 * workspace admin key.
 *
 * Each login mints a fresh, uniquely-named token (revoked on logout, expiring
 * after 30 days). This deliberately avoids reusing a single fixed-name token:
 * a shared token would have to be rotated to hand out usable material (token
 * secrets are never retrievable after creation), which invalidates other live
 * dashboard sessions, and a revoked fixed name would permanently block
 * re-minting under the engine's unique (workspace_id, name) constraint.
 */

/** Name prefix for tokens this dashboard mints; each mint appends a unique id. */
const DASHBOARD_OBSERVER_TOKEN_PREFIX = 'observer-dashboard';

/**
 * Token lifetime, matched to the dashboard auth cookie (30 days) so the minted
 * token never expires out from under an otherwise-valid session.
 */
const DASHBOARD_OBSERVER_TOKEN_TTL_MS = 60 * 60 * 24 * 30 * 1000;

/**
 * Full read scope set, mirroring the engine's `OBSERVER_SCOPES`
 * (`packages/engine/src/engine/observerToken.ts`). The dashboard is a firehose
 * observer, so it needs every read scope plus `stream:read` for the stream to
 * deliver all event types the operator could already see with the workspace
 * key. Kept as a local constant to avoid coupling this edge route to the
 * `@relaycast/types` build.
 */
const DASHBOARD_OBSERVER_SCOPES = [
  'stream:read',
  'messages:read',
  'threads:read',
  'dms:read',
  'channels:read',
  'search:read',
  'agents:read',
  'nodes:read',
  'deliveries:read',
  'activity:read',
  'files:read',
  'reactions:read',
] as const;

export interface MintedObserverToken {
  /** Raw `ot_live_` token material for the workspace stream. */
  token: string;
  /** Observer-token id (`ot_...`), used to revoke the token on logout. */
  id: string;
}

/**
 * Mint a fresh, uniquely-named scoped observer token using a workspace admin
 * key, for the workspace stream.
 *
 * Returns `{ token, id }`, or `null` if minting failed (network error or a
 * non-2xx response). Callers should let REST-only login proceed on `null`
 * rather than block the operator — and must NOT fall back to the workspace
 * admin key for the stream credential.
 */
export async function mintObserverStreamToken(
  baseUrl: string,
  adminKey: string
): Promise<MintedObserverToken | null> {
  // Fail soft: any network rejection (DNS, timeout, unreachable engine) returns
  // null so the caller can fall back to a REST-only login instead of surfacing
  // a hard 500.
  try {
    const payload = {
      name: `${DASHBOARD_OBSERVER_TOKEN_PREFIX}-${crypto.randomUUID()}`,
      description: 'Auto-minted for the Relaycast observer dashboard live stream',
      scopes: DASHBOARD_OBSERVER_SCOPES,
      // The operator holds the workspace key, so DM visibility is not an
      // escalation — keep the dashboard's existing firehose view intact.
      filters: { include_dms: true },
      expires_at: new Date(
        Date.now() + DASHBOARD_OBSERVER_TOKEN_TTL_MS
      ).toISOString(),
    };

    const res = await fetch(new URL('/v1/observer-tokens', baseUrl).toString(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;

    const body = await res.json();
    const token = body?.data?.token;
    const id = body?.data?.id;
    if (
      typeof token === 'string' &&
      token.startsWith('ot_live_') &&
      typeof id === 'string' &&
      id.length > 0
    ) {
      return { token, id };
    }
    return null;
  } catch (error) {
    console.error(
      '[mintObserverStreamToken] Failed to mint observer token:',
      error
    );
    return null;
  }
}

/**
 * Best-effort revocation of a minted observer token on logout, so a leaked ws
 * cookie value stops working immediately instead of lingering until expiry.
 * Requires the workspace admin key (only it may revoke observer tokens). Any
 * failure is swallowed — logout must clear cookies regardless.
 */
export async function revokeObserverStreamToken(
  baseUrl: string,
  adminKey: string,
  tokenId: string
): Promise<void> {
  try {
    await fetch(
      new URL(`/v1/observer-tokens/${tokenId}`, baseUrl).toString(),
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminKey}` },
        cache: 'no-store',
      }
    );
  } catch (error) {
    console.error(
      '[revokeObserverStreamToken] Failed to revoke observer token:',
      error
    );
  }
}

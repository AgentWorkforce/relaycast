/**
 * Observer-token minting for workspace-key logins.
 *
 * The engine rejects the root workspace key (`rk_live_`) on the realtime
 * endpoint (`GET /v1/ws`) — only a scoped observer token (`ot_live_`) with
 * `stream:read` may open the workspace stream. So when an operator logs into
 * the dashboard with a workspace admin key, we mint (or reuse) a read-only
 * observer token on their behalf and hand *that* to the stream, instead of
 * pushing the root key onto a long-lived browser socket.
 */

/** Fixed cookie/name for the dashboard's per-workspace observer token. */
const DASHBOARD_OBSERVER_TOKEN_NAME = 'observer-dashboard';

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

interface DashboardObserverTokenPayload {
  name: string;
  description: string;
  scopes: readonly string[];
  filters: { include_dms: boolean };
  expires_at: string;
}

function dashboardTokenPayload(): DashboardObserverTokenPayload {
  return {
    name: DASHBOARD_OBSERVER_TOKEN_NAME,
    description: 'Auto-minted for the Relaycast observer dashboard live stream',
    scopes: DASHBOARD_OBSERVER_SCOPES,
    // The operator holds the workspace key, so DM visibility is not an
    // escalation — keep the dashboard's existing firehose view intact.
    filters: { include_dms: true },
    expires_at: new Date(
      Date.now() + DASHBOARD_OBSERVER_TOKEN_TTL_MS
    ).toISOString(),
  };
}

async function readTokenMaterial(res: Response): Promise<string | null> {
  try {
    const body = await res.json();
    const token = body?.data?.token;
    return typeof token === 'string' && token.startsWith('ot_live_')
      ? token
      : null;
  } catch {
    return null;
  }
}

async function findExistingTokenId(
  collectionUrl: string,
  adminKey: string
): Promise<string | null> {
  const res = await fetch(collectionUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${adminKey}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  try {
    const body = await res.json();
    const tokens: Array<{ id?: string; name?: string; status?: string }> =
      Array.isArray(body?.data) ? body.data : [];
    const match = tokens.find(
      (t) => t?.name === DASHBOARD_OBSERVER_TOKEN_NAME && t?.status === 'active'
    );
    return typeof match?.id === 'string' ? match.id : null;
  } catch {
    return null;
  }
}

/**
 * Mint (or reuse) the dashboard's scoped observer token using a workspace admin
 * key, and return the raw `ot_live_` token for the workspace stream.
 *
 * A single durable `observer-dashboard` token is kept per workspace: it is
 * created on first login and rotated on subsequent logins. Rotation is required
 * because token material is never retrievable after creation — so reuse means
 * refreshing the existing token's scopes/expiry and rotating it to obtain a new
 * usable secret. (Trade-off: a login invalidates any other browser still using
 * the previous secret; that session re-syncs on its next `/api/auth/session`
 * poll or re-login. Acceptable for an operator dashboard.)
 *
 * Returns `null` if minting failed; callers should let REST-only login proceed
 * rather than block the operator on a stream-token failure.
 */
export async function mintObserverStreamToken(
  baseUrl: string,
  adminKey: string
): Promise<string | null> {
  const jsonAuthHeaders = {
    Authorization: `Bearer ${adminKey}`,
    'Content-Type': 'application/json',
  };
  const payload = dashboardTokenPayload();
  const collectionUrl = new URL('/v1/observer-tokens', baseUrl).toString();

  const created = await fetch(collectionUrl, {
    method: 'POST',
    headers: jsonAuthHeaders,
    cache: 'no-store',
    body: JSON.stringify(payload),
  });
  if (created.ok) return readTokenMaterial(created);
  // Only a name conflict (token already exists) is recoverable via reuse.
  if (created.status !== 409) return null;

  const existingId = await findExistingTokenId(collectionUrl, adminKey);
  if (!existingId) return null;

  const tokenUrl = new URL(
    `/v1/observer-tokens/${existingId}`,
    baseUrl
  ).toString();
  // Refresh scopes/filters/expiry so the rotated token reflects the current
  // dashboard preset and never rotates into an already-expired window.
  await fetch(tokenUrl, {
    method: 'PATCH',
    headers: jsonAuthHeaders,
    cache: 'no-store',
    body: JSON.stringify({
      scopes: payload.scopes,
      filters: payload.filters,
      expires_at: payload.expires_at,
    }),
  });

  const rotated = await fetch(`${tokenUrl}/rotate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminKey}` },
    cache: 'no-store',
  });
  if (!rotated.ok) return null;
  return readTokenMaterial(rotated);
}

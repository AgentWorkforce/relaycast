/**
 * The socket grant a workspace actor answers `GET /v1/ws` and
 * `GET /v1/node/ws` with. An actor cannot return a 101: its host (the
 * gateway) owns the WebSocket, so after the engine has authenticated the
 * upgrade the actor hands back the principal the gateway must attach as the
 * actor socket's metadata. The actor re-checks it in `onConnect`.
 *
 * Response: status 200, header {@link SOCKET_GRANT_HEADER}`: 1`, body
 * `{ ok: true, data: { metadata: <SocketPrincipal> } }`.
 *
 * The principal is signed by the actor that granted it (HMAC-SHA256 with
 * its file-signing secret over the canonical JSON of its fields, `iat` and
 * `nonce`), so metadata alone cannot attach a socket: `onConnect` verifies
 * the signature and that the grant is recent. The gateway passes the
 * principal through unchanged.
 */
import { z } from 'zod';

export const SOCKET_GRANT_HEADER = 'x-relaycast-socket-grant';
/** How long a grant may be used after it was issued (the control plane's own socket ticket is shorter). */
export const SOCKET_GRANT_MAX_AGE_MS = 120_000;
/** Tolerated clock difference between the actor that signed and the one that verifies (normally the same actor). */
const SOCKET_GRANT_CLOCK_SKEW_MS = 30_000;

/** The signature fields the granting actor adds; optional in the schema so a host can parse an unsigned principal, required to attach. */
const signature = {
  /** Unix milliseconds the grant was issued. */
  iat: z.number().int().nonnegative().optional(),
  nonce: z.string().min(1).max(64).optional(),
  /** base64url HMAC-SHA256 over {@link canonicalSocketPrincipal}. */
  sig: z.string().min(1).max(128).optional(),
};

export const SocketPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('node'),
    workspace_id: z.string().min(1),
    node_id: z.string().min(1),
    ...signature,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('observer'),
    workspace_id: z.string().min(1),
    /** Only the id: the token row is re-read at connect so a revoked token cannot attach. */
    observer_token_id: z.string().min(1),
    ...signature,
  }).strict(),
]);
export type SocketPrincipal = z.infer<typeof SocketPrincipalSchema>;
/** A principal as the actor grants it. */
export type SignedSocketPrincipal = SocketPrincipal & { iat: number; nonce: string; sig: string };

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** The bytes the signature covers: the principal's identity fields, `iat` and `nonce`, as JSON with sorted keys. */
export function canonicalSocketPrincipal(principal: SocketPrincipal, iat: number, nonce: string): string {
  const fields: Record<string, unknown> = { v: principal.v, kind: principal.kind, workspace_id: principal.workspace_id, iat, nonce };
  if (principal.kind === 'node') fields.node_id = principal.node_id;
  else fields.observer_token_id = principal.observer_token_id;
  return JSON.stringify(Object.fromEntries(Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Sign `principal` as the granting actor: `iat` now, a random nonce, and the HMAC. */
export async function signSocketPrincipal(secret: string, principal: SocketPrincipal, now = Date.now()): Promise<SignedSocketPrincipal> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const { iat: _iat, nonce: _nonce, sig: _sig, ...identity } = principal;
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(canonicalSocketPrincipal(identity as SocketPrincipal, now, nonce)));
  return { ...(identity as SocketPrincipal), iat: now, nonce, sig: toBase64Url(new Uint8Array(mac)) };
}

export type SocketPrincipalVerdict = 'ok' | 'unsigned' | 'bad_signature' | 'expired' | 'not_yet_valid';

/** Whether `principal` carries a valid, recent signature by `secret`. */
export async function verifySocketPrincipal(secret: string, principal: SocketPrincipal, now = Date.now()): Promise<SocketPrincipalVerdict> {
  if (principal.iat === undefined || principal.nonce === undefined || principal.sig === undefined) return 'unsigned';
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(canonicalSocketPrincipal(principal, principal.iat, principal.nonce)));
  if (!timingSafeEqualText(toBase64Url(new Uint8Array(expected)), principal.sig)) return 'bad_signature';
  if (principal.iat > now + SOCKET_GRANT_CLOCK_SKEW_MS) return 'not_yet_valid';
  if (now - principal.iat > SOCKET_GRANT_MAX_AGE_MS) return 'expired';
  return 'ok';
}

function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SocketGrantSchema = z.object({
  ok: z.literal(true),
  data: z.object({ metadata: SocketPrincipalSchema }).strict(),
}).strict();
export type SocketGrant = z.infer<typeof SocketGrantSchema>;

/** The `Response` an actor-side connection registry answers an authenticated upgrade with. */
export function socketGrantResponse(metadata: SocketPrincipal): Response {
  const grant: SocketGrant = { ok: true, data: { metadata } };
  return new Response(JSON.stringify(grant), {
    status: 200,
    headers: { 'content-type': 'application/json', [SOCKET_GRANT_HEADER]: '1' },
  });
}

/** Whether an engine response is a socket grant (status 200 with the grant header). */
export function isSocketGrant(response: { status: number; headers: Iterable<[string, string]> }): boolean {
  if (response.status !== 200) return false;
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === SOCKET_GRANT_HEADER && value === '1') return true;
  }
  return false;
}

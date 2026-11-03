/**
 * The socket grant a workspace actor answers `GET /v1/ws` and
 * `GET /v1/node/ws` with. An actor cannot return a 101: its host (the
 * gateway) owns the WebSocket, so after the engine has authenticated the
 * upgrade the actor hands back the principal the gateway must attach as the
 * actor socket's metadata. The actor re-checks it in `onConnect`.
 *
 * Response: status 200, header {@link SOCKET_GRANT_HEADER}`: 1`, body
 * `{ ok: true, data: { metadata: <SocketPrincipal> } }`.
 */
import { z } from 'zod';

export const SOCKET_GRANT_HEADER = 'x-relaycast-socket-grant';

export const SocketPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('node'),
    workspace_id: z.string().min(1),
    node_id: z.string().min(1),
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('observer'),
    workspace_id: z.string().min(1),
    /** Only the id: the token row is re-read at connect so a revoked token cannot attach. */
    observer_token_id: z.string().min(1),
  }).strict(),
]);
export type SocketPrincipal = z.infer<typeof SocketPrincipalSchema>;

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

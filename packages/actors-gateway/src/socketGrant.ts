/**
 * The socket-grant contract between the gateway and a workspace actor.
 *
 * The gateway forwards a WebSocket upgrade request to `handle` as a probe
 * (`upgrade: websocket`, `connection: Upgrade`). The actor authenticates the
 * token and answers either an ordinary error response or `200` with the
 * engine's {@link SOCKET_GRANT_HEADER} and a body carrying the principal the
 * socket runs as, which the gateway hands to the control plane as socket
 * metadata. A response is a grant only when the gateway itself sent the
 * probe; the header and body shapes come from `@relaycast/engine/gateway`.
 */
import { SOCKET_GRANT_HEADER, SocketGrantSchema, isSocketGrant, type ActorHttpResponse, type SocketPrincipal } from '@relaycast/engine/gateway';

export { SOCKET_GRANT_HEADER };
export type { SocketPrincipal };

/** The grant's principal when `response` is a socket grant; `undefined` for any other response. */
export function parseSocketGrant(response: ActorHttpResponse): SocketPrincipal | undefined {
  if (!isSocketGrant(response)) return undefined;
  try {
    const parsed = SocketGrantSchema.safeParse(JSON.parse(response.body));
    return parsed.success ? parsed.data.data.metadata : undefined;
  } catch {
    return undefined;
  }
}

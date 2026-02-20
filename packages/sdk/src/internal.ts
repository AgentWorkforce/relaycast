import { RelayCast, type RelayCastOptions } from './relay.js';
import { withInternalOrigin } from './client.js';
import { WsClient, withInternalWsOrigin, type WsClientOptions } from './ws.js';
import type { InternalOrigin } from './origin.js';

export function createInternalRelayCast(
  options: RelayCastOptions,
  origin: InternalOrigin,
): RelayCast {
  return new RelayCast(withInternalOrigin(options, origin));
}

export function createInternalWsClient(
  options: WsClientOptions,
  origin: InternalOrigin,
): WsClient {
  return new WsClient(withInternalWsOrigin(options, origin));
}

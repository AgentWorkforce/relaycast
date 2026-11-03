import type { CredentialTagSigner } from '@relaycast/engine/gateway';
import type { ActorClient } from './actors.js';
import type { GatewayConfig } from './config.js';
import type { FileStore } from './files/store.js';
import type { Logger } from './log.js';

/** What every route needs; built once by `createGateway`. */
export interface GatewayContext {
  config: GatewayConfig;
  actors: ActorClient;
  files: FileStore;
  /** Signs new workspaces' tags and verifies every presented credential's tag. */
  credentialTags: CredentialTagSigner;
  logger: Logger;
  /** The authority to build a request URL with when a client sends no `Host`. */
  fallbackHost: () => string;
}

/**
 * The gateway as a Node HTTP server: `createGateway(config)` wires the
 * control-plane client, keyring, file store, routes and WebSocket bridge, and
 * `close()` drains it for a restart.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCredentialTagSigner } from '@relaycast/engine/gateway';
import { createActorClient, type ActorClient } from './actors.js';
import type { GatewayConfig } from './config.js';
import type { GatewayContext } from './context.js';
import { createFileStore } from './files/index.js';
import type { FileStore } from './files/store.js';
import { createLogger, errorText, type Logger } from './log.js';
import { createRequestHandler } from './router.js';
import { createSocketBridge, type SocketBridgeOptions } from './ws.js';

export type { GatewayConfig } from './config.js';
export { CONFIG_EXIT_CODE, ConfigError, loadConfig } from './config.js';
export type { ActorClient, SocketGrant } from './actors.js';
export { ActorCallError, createActorClient } from './actors.js';
export type { FileObject, FilePutOptions, FileStore } from './files/store.js';
export { createFileStore, LocalFileStore } from './files/index.js';
export type { Logger } from './log.js';
export { createLogger } from './log.js';
export { SOCKET_GRANT_HEADER } from './socketGrant.js';

export interface GatewayOptions {
  logger?: Logger;
  /** Substitute control plane (tests). */
  actors?: ActorClient;
  /** Substitute file store (tests). */
  fileStore?: FileStore;
  socket?: SocketBridgeOptions;
}

export interface Gateway {
  server: Server;
  /** Bind and listen; resolves with the bound address. */
  listen(port?: number, host?: string): Promise<AddressInfo>;
  /**
   * Stop accepting, refuse pending upgrades, close bridged sockets with 1012
   * `gateway restarting`, wait up to `shutdownGraceMs` for in-flight requests
   * and close handshakes, then drop whatever is left.
   */
  close(): Promise<void>;
  /** Bridged WebSocket clients currently open. */
  readonly socketCount: number;
}

const DRAIN_POLL_MS = 25;

export function createGateway(config: GatewayConfig, options: GatewayOptions = {}): Gateway {
  const logger = options.logger ?? createLogger({ format: config.logFormat });
  const actors = options.actors ?? createActorClient({
    controlPlaneUrl: config.controlPlaneUrl,
    projectId: config.projectId,
    secret: config.controlPlaneSecret,
    homeRegion: config.homeRegion,
    invokeTimeoutMs: config.actorInvokeTimeoutMs,
    createTimeoutMs: config.actorCreateTimeoutMs,
  });
  const files = options.fileStore ?? createFileStore({ kind: config.fileStore, fileDir: config.fileDir, env: config.fileStoreEnv });
  const server = createServer();
  const ctx: GatewayContext = {
    config,
    actors,
    files,
    credentialTags: createCredentialTagSigner(config.credentialKeyring),
    logger,
    fallbackHost: () => {
      const address = server.address();
      return address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '127.0.0.1';
    },
  };

  let closing = false;
  const inflight = new Set<ServerResponse>();
  const handler = createRequestHandler(ctx, {
    closing: () => closing,
    onStart: (res) => { inflight.add(res); },
    onEnd: (res) => { inflight.delete(res); },
  });
  const bridge = createSocketBridge(ctx, options.socket);
  server.on('request', handler);
  server.on('upgrade', (req, socket, head) => {
    if (closing) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // A synchronous throw here would leave the listener and take the process down.
    try {
      bridge.handleUpgrade(req, socket, head);
    } catch (error) {
      logger.error('socket.upgrade_failed', { error: errorText(error) });
      socket.destroy();
    }
  });
  // A client that resets mid-request must not take the process down.
  server.on('clientError', (error, socket) => {
    if ((error as { code?: string }).code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    server,
    listen(port = config.port, host?: string) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      bridge.closeAll(1012, 'gateway restarting');
      const deadline = Date.now() + config.shutdownGraceMs;
      while ((inflight.size > 0 || bridge.size > 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
      }
      if (inflight.size > 0) logger.warn('gateway.drain_timeout', { in_flight: inflight.size });
      // Upgraded sockets are not `closeAllConnections`' to close: a peer that
      // never answered its close frame is dropped here.
      if (bridge.size > 0) logger.warn('gateway.socket_drain_timeout', { sockets: bridge.size });
      bridge.terminateAll();
      server.closeAllConnections();
      await closed;
    },
    get socketCount() {
      return bridge.size;
    },
  };
}

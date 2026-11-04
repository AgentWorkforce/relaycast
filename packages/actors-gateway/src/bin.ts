#!/usr/bin/env node
/**
 * `relaycast-actors-gateway`: run the gateway from the environment. A
 * configuration refusal prints one line and exits 64; SIGTERM/SIGINT drain
 * the server and exit 0.
 */
import { CONFIG_EXIT_CODE, ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { createLogger } from './log.js';
import { createGateway } from './server.js';

function refuse(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(CONFIG_EXIT_CODE);
}

let config: GatewayConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) refuse(error.message);
  throw error;
}

const logger = createLogger({ format: config.logFormat });
let gateway: ReturnType<typeof createGateway>;
try {
  gateway = createGateway(config, { logger });
} catch (error) {
  // A file-store refusal (ConfigError, already prefixed) or a keyring the signer refuses.
  const message = error instanceof Error ? error.message : String(error);
  refuse(error instanceof ConfigError ? message : `relaycast actors gateway refused to start: ${message}`);
}

const address = await gateway.listen(config.port);
logger.info('gateway.listening', {
  port: address.port,
  env: config.environment,
  control_plane_host: new URL(config.controlPlaneUrl).host,
  project_id: config.projectId,
  file_store: config.fileStore,
  file_dir: config.fileStore === 'local' ? config.fileDir : undefined,
  public_workspace_create: config.publicWorkspaceCreate,
  keyed_workspace_create: config.workspaceBootstrapSecret !== undefined,
  bootstrap_proof_required: config.workspaceBootstrapProofRequired,
  internal_api: config.internalSecret !== undefined,
});

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logger.info('gateway.stopping', { signal, sockets: gateway.socketCount });
  gateway.close().then(
    () => {
      logger.info('gateway.stopped');
      process.exit(0);
    },
    (error: unknown) => {
      logger.error('gateway.stop_failed', { error: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    },
  );
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

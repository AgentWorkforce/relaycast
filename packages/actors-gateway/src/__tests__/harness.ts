/** A gateway on an ephemeral port in front of a fake control plane, with credentials its keyring signs. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialTagSigner, type CredentialTagSigner } from '@relaycast/engine/gateway';
import { encodeArCredential, type CredentialKind } from '@relaycast/types';
import { loadConfig, type Env, type GatewayConfig } from '../config.js';
import { createLogger } from '../log.js';
import { createGateway, type Gateway, type GatewayOptions } from '../server.js';
import { startFakeControlPlane, type FakeControlPlane, type FakeControlPlaneOptions } from './fakeControlPlane.js';

export const KEYRING = { current: 'a', keys: { a: 'test-credential-tag-secret-0123456789' } };
export const FILE_SECRET = 'test-file-signing-secret-0123456789';
export const INTERNAL_SECRET = 'internal-secret-with-at-least-32-characters';
export const WORKSPACE_ID = '241764880589606912';
export const OTHER_WORKSPACE_ID = '241764880589606913';

export function baseEnv(controlPlaneUrl: string, overrides: Env = {}): Env {
  return {
    DURABLE_ACTORS_CONTROL_PLANE_URL: controlPlaneUrl,
    DURABLE_ACTORS_PROJECT_ID: 'local',
    RELAYCAST_FILE_SIGNING_SECRET: FILE_SECRET,
    RELAYCAST_CREDENTIAL_KEYRING: JSON.stringify(KEYRING),
    RELAYCAST_LOG_FORMAT: 'json',
    ...overrides,
  };
}

export interface Harness {
  gateway: Gateway;
  baseUrl: string;
  config: GatewayConfig;
  controlPlane: FakeControlPlane;
  signer: CredentialTagSigner;
  logs: Record<string, unknown>[];
  fileDir: string;
  credential(workspaceId?: string, kind?: CredentialKind): Promise<string>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: Env;
  controlPlane?: Partial<Omit<FakeControlPlaneOptions, 'workspace'>>;
  workspace?: FakeControlPlaneOptions['workspace'];
  gateway?: GatewayOptions;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const controlPlane = await startFakeControlPlane({
    ...options.controlPlane,
    workspace: options.workspace ?? (() => undefined),
  });
  const fileDir = await mkdtemp(join(tmpdir(), 'relaycast-gateway-files-'));
  const env = baseEnv(controlPlane.url, { RELAYCAST_FILE_DIR: fileDir, RELAYCAST_SHUTDOWN_GRACE_MS: '500', ...options.env });
  const config = loadConfig(env);
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({ format: 'json', write: (line) => { logs.push(JSON.parse(line) as Record<string, unknown>); } });
  const gateway = createGateway(config, { logger, ...options.gateway });
  const address = await gateway.listen(0, '127.0.0.1');
  const signer = createCredentialTagSigner(KEYRING);
  return {
    gateway,
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    controlPlane,
    signer,
    logs,
    fileDir,
    async credential(workspaceId = WORKSPACE_ID, kind: CredentialKind = 'agent') {
      return encodeArCredential({ kind, workspaceId, tag: await signer.tag(workspaceId), secret: new Uint8Array(32).fill(7) });
    },
    async close() {
      await gateway.close();
      await controlPlane.close();
      await rm(fileDir, { recursive: true, force: true });
    },
  };
}

/** A credential whose tag another keyring signed: well-formed, but not this deployment's. */
export async function foreignCredential(workspaceId = WORKSPACE_ID, kind: CredentialKind = 'agent'): Promise<string> {
  const other = createCredentialTagSigner({ current: 'a', keys: { a: 'another-keyring-secret-0123456789' } });
  return encodeArCredential({ kind, workspaceId, tag: await other.tag(workspaceId), secret: new Uint8Array(32).fill(9) });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

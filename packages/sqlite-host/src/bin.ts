#!/usr/bin/env node
/**
 * `relaycast-sqlite-host host` or `relaycast-sqlite-host router`, configured from the environment.
 *
 * Host:
 *   SQLITE_HOST_NAME            this host's name (the StatefulSet pod name)
 *   SQLITE_HOST_SOCKET_ORIGIN   origin socket grants point at (the router's Service)
 *   SQLITE_HOST_STORE           s3://<bucket>[/<prefix>] or file://<dir>
 *   SQLITE_HOST_DATA_DIR        local directory for workspace files (default /data)
 *   SQLITE_HOST_BASE_EVERY      commits between base snapshots (default 500)
 *   SQLITE_HOST_DURABILITY      sync (default) or async
 *   SQLITE_HOST_GRANT_SECRET    signs socket grants (32+ characters)
 *   DURABLE_ACTORS_SECRET       optional bearer the gateway sends
 *   AWS_REGION                  for an s3:// store
 *   RELAYCAST_PUBLIC_URL, RELAYCAST_FILE_SIGNING_SECRET and the engine's
 *   RELAYCAST_* variables, as the Workspace actor reads them.
 * Router:
 *   SQLITE_ROUTER_HOSTS         name=http://origin,name=http://origin,…
 * Both: PORT (default 8080).
 */
import { actorConfigFromEnv } from '@relaycast/engine/adapters/actor';
import { WorkspaceHost } from './host.js';
import { WorkspaceRouter } from './router.js';
import { FileLogStore, S3LogStore, type LogStore } from './store.js';

const env = process.env;
const port = Number(env.PORT ?? 8080);
const log = (event: Record<string, unknown>): void => console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));

function required(name: string, minLength = 1): string {
  const value = env[name]?.trim();
  if (!value || value.length < minLength) throw new Error(`${name} must be set${minLength > 1 ? ` (at least ${minLength} characters)` : ''}`);
  return value;
}

function store(spec: string): { store: LogStore; prefix: string } {
  const url = new URL(spec);
  const prefix = url.pathname.replace(/^\/|\/$/g, '') || 'workspaces';
  if (url.protocol === 's3:') return { store: S3LogStore.fromEnvironment(url.hostname, required('AWS_REGION')), prefix };
  if (url.protocol === 'file:') return { store: new FileLogStore(url.pathname), prefix: 'workspaces' };
  throw new Error('SQLITE_HOST_STORE must be s3://bucket[/prefix] or file:///dir');
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? env.SQLITE_HOST_MODE ?? 'host';
  if (mode === 'router') {
    const hosts = required('SQLITE_ROUTER_HOSTS').split(',').map((entry) => {
      const [name, url] = entry.split('=');
      return { name: name.trim(), url: url.trim().replace(/\/$/, '') };
    });
    await new WorkspaceRouter({ hosts, log }).listen(port);
    log({ event: 'sqlite_router_listening', port, hosts: hosts.map((host) => host.name) });
    return;
  }
  const durability = env.SQLITE_HOST_DURABILITY === 'async' ? 'async' : 'sync';
  const host = new WorkspaceHost({
    name: required('SQLITE_HOST_NAME'),
    socketOrigin: required('SQLITE_HOST_SOCKET_ORIGIN'),
    secret: env.DURABLE_ACTORS_SECRET?.trim() || undefined,
    grantSecret: required('SQLITE_HOST_GRANT_SECRET', 32),
    ...store(required('SQLITE_HOST_STORE')),
    dataDir: env.SQLITE_HOST_DATA_DIR ?? '/data',
    config: {
      publicUrl: new URL(required('RELAYCAST_PUBLIC_URL')).origin,
      fileSigningSecret: required('RELAYCAST_FILE_SIGNING_SECRET', 32),
      engine: actorConfigFromEnv(env),
    },
    baseEvery: Number(env.SQLITE_HOST_BASE_EVERY ?? 500),
    durability,
    log,
  });
  await host.listen(port);
  log({ event: 'sqlite_host_listening', port, durability });
  const stop = (): void => void host.close().finally(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
import { startServer } from '../entrypoints/node.js';
import { credentialConfigFromEnv } from '../config/credentialEnv.js';
import { ConfigError, secretFromEnv } from './secretEnv.js';
import { engineVersion } from './version.js';
import { MIN_INTERNAL_SECRET_LENGTH } from '../engine/internalAdmin.js';

const HELP = `relaycast-engine — run a self-hosted Relaycast server (Node + SQLite)

Usage:
  relaycast-engine [--db <path>] [--port <n>] [--base-url <url>] [--env <name>]

Options:
  --db <path>        SQLite database file (default: $RELAYCAST_DB_PATH or ./relaycast.db)
  --port <n>         HTTP port (default: $PORT or 8787)
  --base-url <url>   Public origin for signed file URLs (default: http://localhost:<port>)
  --env <name>       Environment label (default: production)
  -v, --version      Print the engine version
  -h, --help         Show this help

Environment:
  RELAYCAST_INTERNAL_SECRET(_FILE)  Enable the /internal admin API for a trusted
                                    control plane (Authorization: Bearer <secret>;
                                    at least 32 characters)
  RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET(_FILE)
                                    Stable secret for anonymous keyed workspace retries
  RELAYCAST_PUBLIC_WORKSPACE_CREATE Set false to 404 the public POST /v1/workspaces
                                    (workspaces then come from /internal/workspaces)
  RELAYCAST_CREDENTIAL_KEYRING(_FILE)
                                    {"current":"a","keys":{"a":"<secret>"}}: signs ar_ credential
                                    tags, enabling POST /v1/credentials/upgrade
  RELAYCAST_CREDENTIAL_FORMAT       legacy (default) or ar (needs RELAYCAST_CREDENTIAL_KEYRING)
  RELAYCAST_LEGACY_CREDENTIAL_GRACE_SECONDS
                                    How long an upgraded legacy credential keeps working (default 30 days)
  RELAYCAST_LEGACY_CREDENTIAL_SUNSET
                                    ISO-8601 date sent as Sunset on legacy-authenticated responses
  A directly set variable wins over its _FILE variant.

After start, create a workspace:
  curl -XPOST http://localhost:<port>/v1/workspaces -H 'content-type: application/json' -d '{"name":"my-team"}'
`;

interface ServeArgs {
  db: string;
  port: number;
  baseUrl?: string;
  environment: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ServeArgs {
  const out: ServeArgs = {
    db: env.RELAYCAST_DB_PATH ?? './relaycast.db',
    port: env.PORT ? Number(env.PORT) : 8787,
    baseUrl: undefined,
    environment: env.RELAYCAST_ENV ?? 'production',
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--db') out.db = argv[++i] ?? out.db;
    else if (arg === '--port') out.port = Number(argv[++i] ?? out.port);
    else if (arg === '--base-url') out.baseUrl = argv[++i];
    else if (arg === '--env') out.environment = argv[++i] ?? out.environment;
  }
  return out;
}

/** Exit code for a configuration the server refuses to run with (EX_USAGE). */
const CONFIG_EXIT_CODE = 64;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${engineVersion()}\n`);
    return;
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) {
    process.stderr.write('Invalid --port\n');
    process.exitCode = 1;
    return;
  }

  const baseUrl = opts.baseUrl ?? `http://localhost:${opts.port}`;
  // Optional self-host tuning via env: bounded mailbox TTL / depth cap. Lets
  // operators configure a short TTL / small depth cap without code changes.
  const num = (v: string | undefined): number | undefined => {
    if (v == null || v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const mailbox = {
    ...(num(process.env.RELAYCAST_MAILBOX_TTL_MS) !== undefined ? { deliveryTtlMs: num(process.env.RELAYCAST_MAILBOX_TTL_MS) } : {}),
    ...(num(process.env.RELAYCAST_MAILBOX_DEPTH_CAP) !== undefined ? { depthCap: num(process.env.RELAYCAST_MAILBOX_DEPTH_CAP) } : {}),
  };

  // Optional deployment-wide message retention TTL. Unset keeps message
  // history forever (the engine default — pruning is opt-in). A positive value
  // prunes messages after that many days; `0` or negative is an explicit
  // keep-forever (maps to `null`).
  const messageTtlDays = num(process.env.RELAYCAST_MESSAGE_TTL_DAYS);
  const eventQueue =
    messageTtlDays !== undefined
      ? { retention: { defaults: { messageTtlDays: messageTtlDays > 0 ? messageTtlDays : null } } }
      : undefined;

  const internalSecret = secretFromEnv(process.env, 'RELAYCAST_INTERNAL_SECRET');
  if (internalSecret !== undefined && internalSecret.length < MIN_INTERNAL_SECRET_LENGTH) {
    throw new ConfigError(
      `RELAYCAST_INTERNAL_SECRET must be at least ${MIN_INTERNAL_SECRET_LENGTH} characters`,
    );
  }
  // Verbatim: the bootstrap secret's exact bytes derive keyed-create replay
  // keys, so trimming would break retries of workspaces created before.
  const workspaceBootstrapSecret = secretFromEnv(process.env, 'RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET', {
    exact: true,
  });
  const publicWorkspaceCreate = process.env.RELAYCAST_PUBLIC_WORKSPACE_CREATE?.trim();
  if (publicWorkspaceCreate && publicWorkspaceCreate !== 'true' && publicWorkspaceCreate !== 'false') {
    throw new ConfigError('RELAYCAST_PUBLIC_WORKSPACE_CREATE must be "true" or "false"');
  }

  const credentials = credentialConfigFromEnv(process.env);

  const running = startServer({
    dbPath: opts.db,
    port: opts.port,
    baseUrl,
    config: {
      environment: opts.environment,
      ...credentials,
      ...(workspaceBootstrapSecret ? { workspaceBootstrapSecret } : {}),
      ...(process.env.RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED === 'true'
        ? { workspaceBootstrapProofRequired: true }
        : {}),
      ...(internalSecret ? { internalSecret } : {}),
      ...(publicWorkspaceCreate === 'false' ? { publicWorkspaceCreate: false } : {}),
      ...(Object.keys(mailbox).length > 0 ? { mailbox } : {}),
    },
    ...(eventQueue ? { eventQueue } : {}),
  });

  process.stdout.write(`Relaycast self-host listening on ${baseUrl} (db: ${opts.db})\n`);
  process.stdout.write(
    `Create a workspace:\n  curl -XPOST ${baseUrl}/v1/workspaces -H 'content-type: application/json' -d '{"name":"my-team"}'\n`,
  );

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.stdout.write('\nShutting down…\n');
      void running.stop().then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

main().catch((err) => {
  process.stderr.write(`relaycast-engine failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(err instanceof ConfigError ? CONFIG_EXIT_CODE : 1);
});

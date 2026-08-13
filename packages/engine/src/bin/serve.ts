#!/usr/bin/env node
import { startServer } from '../entrypoints/node.js';

const HELP = `relaycast-engine — run a self-hosted Relaycast server (Node + SQLite)

Usage:
  relaycast-engine [--db <path>] [--port <n>] [--base-url <url>] [--env <name>]

Options:
  --db <path>        SQLite database file (default: $RELAYCAST_DB_PATH or ./relaycast.db)
  --port <n>         HTTP port (default: $PORT or 8787)
  --base-url <url>   Public origin for signed file URLs (default: http://localhost:<port>)
  --env <name>       Environment label (default: production)
  -h, --help         Show this help

After start, create a workspace:
  curl -XPOST http://localhost:<port>/v1/workspaces -H 'content-type: application/json' -d '{"name":"my-team"}'
`;

interface ServeArgs {
  db: string;
  port: number;
  baseUrl?: string;
  environment: string;
  help: boolean;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ServeArgs {
  const out: ServeArgs = {
    db: env.RELAYCAST_DB_PATH ?? './relaycast.db',
    port: env.PORT ? Number(env.PORT) : 8787,
    baseUrl: undefined,
    environment: env.RELAYCAST_ENV ?? 'production',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--db') out.db = argv[++i] ?? out.db;
    else if (arg === '--port') out.port = Number(argv[++i] ?? out.port);
    else if (arg === '--base-url') out.baseUrl = argv[++i];
    else if (arg === '--env') out.environment = argv[++i] ?? out.environment;
  }
  return out;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if (opts.help) {
    process.stdout.write(HELP);
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

  const authorityPublicKey = process.env.RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_PUBLIC_KEY_PEM?.trim();
  const authorityIssuer = process.env.RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_ISSUER?.trim();
  const authorityAudience = process.env.RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_AUDIENCE?.trim();
  if ((authorityPublicKey && !authorityIssuer) || (!authorityPublicKey && authorityIssuer)) {
    process.stderr.write(
      'RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_PUBLIC_KEY_PEM and RELAYCAST_AGENT_CREDENTIAL_AUTHORITY_ISSUER must be set together\n',
    );
    process.exitCode = 1;
    return;
  }
  const agentCredentialAuthority = authorityPublicKey && authorityIssuer
    ? {
        publicKeyPem: authorityPublicKey,
        issuer: authorityIssuer,
        ...(authorityAudience ? { audience: authorityAudience } : {}),
      }
    : undefined;

  const running = startServer({
    dbPath: opts.db,
    port: opts.port,
    baseUrl,
    config: {
      environment: opts.environment,
      ...(Object.keys(mailbox).length > 0 ? { mailbox } : {}),
      ...(agentCredentialAuthority ? { agentCredentialAuthority } : {}),
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
  process.exit(1);
});

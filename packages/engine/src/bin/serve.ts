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
  const running = startServer({
    dbPath: opts.db,
    port: opts.port,
    baseUrl,
    config: { environment: opts.environment },
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

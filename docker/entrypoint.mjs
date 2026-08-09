#!/usr/bin/env node

import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const CONFIG_EXIT_CODE = 64;

const HELP = `relaycast container — run a self-hosted Relaycast server

Usage:
  docker run <image> --base-url <https-origin> [--db <path>] [--port <n>] [--env <name>]

Options:
  --base-url <url>   Required public HTTPS origin
  --db <path>        SQLite database file (default: $RELAYCAST_DB_PATH or ./relaycast.db)
  --port <n>         HTTP port inside the container (default: $PORT or 8787)
  --env <name>       Environment label (default: production)
  -h, --help         Show this help
`;

export class BaseUrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BaseUrlError';
    this.code = code;
  }
}

function refusal(code, message) {
  throw new BaseUrlError(
    code,
    `relaycast container refused to start: ${message}`,
  );
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function expandedIpv6(hostname) {
  const halves = hostname.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (
    parts.length !== 8 ||
    parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))
  ) {
    return null;
  }
  return parts.map((part) => Number.parseInt(part, 16));
}

function isLoopbackHostname(hostname) {
  const host = unbracket(hostname).replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return Number(host.split('.')[0]) === 127;
  if (ipVersion !== 6) return false;

  const parts = expandedIpv6(host);
  if (!parts) return false;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) {
    return true;
  }

  // IPv4-mapped IPv6: ::ffff:127.0.0.0/104. WHATWG URL parsing
  // canonicalizes the dotted suffix to the final two hexadecimal groups.
  const isMapped =
    parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  return isMapped && parts[6] >> 8 === 127;
}

export function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    refusal(
      'invalid_base_url',
      '--base-url must be a valid absolute URL (example: https://relay.example.com).',
    );
  }

  if (url.protocol !== 'https:') {
    refusal(
      'non_https_base_url',
      '--base-url must use https; plaintext deployment authorities are forbidden.',
    );
  }

  const hostname = unbracket(url.hostname).replace(/\.$/, '');
  if (isLoopbackHostname(hostname)) {
    refusal(
      'loopback_base_url',
      '--base-url must not use localhost or a loopback IP address.',
    );
  }

  if (isIP(hostname) === 0 && !hostname.includes('.')) {
    refusal(
      'single_label_base_url',
      '--base-url hostname must contain at least two DNS labels (for example, relay.example.com).',
    );
  }

  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    refusal(
      'non_origin_base_url',
      '--base-url must be an origin only, without credentials, a path, query, or fragment.',
    );
  }

  return url.origin;
}

export function validatedEngineArgs(argv) {
  const args = [];
  let baseUrlIndex = -1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') {
      if (baseUrlIndex !== -1) {
        refusal(
          'duplicate_base_url',
          '--base-url must be provided exactly once.',
        );
      }
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        refusal(
          'missing_base_url',
          '--base-url is required (example: --base-url https://relay.example.com).',
        );
      }
      args.push('--base-url', value);
      baseUrlIndex = args.length - 1;
      index += 1;
      continue;
    }

    if (arg.startsWith('--base-url=')) {
      if (baseUrlIndex !== -1) {
        refusal(
          'duplicate_base_url',
          '--base-url must be provided exactly once.',
        );
      }
      args.push('--base-url', arg.slice('--base-url='.length));
      baseUrlIndex = args.length - 1;
      continue;
    }

    args.push(arg);
  }

  if (baseUrlIndex === -1) {
    refusal(
      'missing_base_url',
      '--base-url is required because the engine default would mint deployment identifiers under localhost.',
    );
  }

  args[baseUrlIndex] = validateBaseUrl(args[baseUrlIndex]);
  return args;
}

function parseEngineOptions(argv, env) {
  const options = {
    db: env.RELAYCAST_DB_PATH ?? './relaycast.db',
    port: env.PORT ? Number(env.PORT) : 8787,
    baseUrl: undefined,
    environment: env.RELAYCAST_ENV ?? 'production',
  };

  const valueAfter = (index, option) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      refusal('missing_option_value', `${option} requires a value.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') {
      options.db = valueAfter(index, '--db');
      index += 1;
    } else if (arg === '--port') {
      options.port = Number(valueAfter(index, '--port'));
      index += 1;
    } else if (arg === '--base-url') {
      options.baseUrl = valueAfter(index, '--base-url');
      index += 1;
    } else if (arg === '--env') {
      options.environment = valueAfter(index, '--env');
      index += 1;
    }
  }

  if (!options.baseUrl) {
    refusal(
      'missing_base_url',
      '--base-url is required and must not be consumed as another option value.',
    );
  }
  options.baseUrl = validateBaseUrl(options.baseUrl);
  return options;
}

function optionalNumber(value) {
  if (value == null || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The pinned Node adapter derives c.req.url from the local socket and ignores
 * X-Forwarded-Proto. A Cloudflare named tunnel terminates TLS before forwarding
 * HTTP over loopback, so without this marker the public A2A card advertises an
 * incorrect plaintext RPC URL. The mandatory validated base URL establishes
 * that every request to this container represents an HTTPS public authority.
 */
export function installPublicAuthorityMarker(server, baseUrl) {
  const publicAuthority = new URL(baseUrl).host;
  server.prependListener('request', (request) => {
    request.headers.host = publicAuthority;
    let replacedHost = false;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index].toLowerCase() === 'host') {
        request.rawHeaders[index + 1] = publicAuthority;
        replacedHost = true;
      }
    }
    if (!replacedHost) request.rawHeaders.push('Host', publicAuthority);
    request.socket.encrypted = true;
  });
}

async function launchPinnedEngine(args) {
  const options = parseEngineOptions(args, process.env);
  if (
    !Number.isInteger(options.port) ||
    options.port <= 0 ||
    options.port > 65535
  ) {
    throw new Error('Invalid --port');
  }

  const { startServer } = await import('@relaycast/engine/node');

  const mailboxTtlMs = optionalNumber(process.env.RELAYCAST_MAILBOX_TTL_MS);
  const mailboxDepthCap = optionalNumber(
    process.env.RELAYCAST_MAILBOX_DEPTH_CAP,
  );
  const mailbox = {
    ...(mailboxTtlMs !== undefined ? { deliveryTtlMs: mailboxTtlMs } : {}),
    ...(mailboxDepthCap !== undefined ? { depthCap: mailboxDepthCap } : {}),
  };

  const messageTtlDays = optionalNumber(process.env.RELAYCAST_MESSAGE_TTL_DAYS);
  const eventQueue =
    messageTtlDays !== undefined
      ? {
          retention: {
            defaults: {
              messageTtlDays: messageTtlDays > 0 ? messageTtlDays : null,
            },
          },
        }
      : undefined;

  const running = startServer({
    dbPath: options.db,
    port: options.port,
    baseUrl: options.baseUrl,
    config: {
      environment: options.environment,
      ...(Object.keys(mailbox).length > 0 ? { mailbox } : {}),
    },
    ...(eventQueue ? { eventQueue } : {}),
  });

  installPublicAuthorityMarker(running.server, options.baseUrl);
  process.stdout.write(
    `Relaycast self-host listening for ${options.baseUrl} (db: ${options.db})\n`,
  );

  await new Promise((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.stdout.write('\nShutting down…\n');
      void running.stop().then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }

  let args;
  try {
    args = validatedEngineArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = CONFIG_EXIT_CODE;
    return;
  }

  try {
    await launchPinnedEngine(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BaseUrlError) {
      process.stderr.write(`${message}\n`);
      process.exitCode = CONFIG_EXIT_CODE;
    } else {
      process.stderr.write(`relaycast container failed to start: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  await main();
}

import { isIP } from 'node:net';

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

Environment:
  RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET  Stable secret for anonymous keyed workspace retries
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

function isValidDnsHostname(hostname) {
  if (hostname.length > 253) return false;
  return hostname
    .split('.')
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
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

// WHATWG URL "IPv4 number parser": each dot-separated part may be decimal,
// 0x/0X-prefixed hex, or 0-prefixed octal. https://url.spec.whatwg.org/#concept-ipv4-parser
function parseIPv4Number(part) {
  if (part === '') return null;
  let radix = 10;
  let digits = part;
  if (/^0x/i.test(digits)) {
    radix = 16;
    digits = digits.slice(2);
  } else if (digits.length > 1 && digits.startsWith('0')) {
    radix = 8;
    digits = digits.slice(1);
  }
  if (digits === '') return 0;
  const validDigits =
    radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!validDigits.test(digits)) return null;
  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) ? value : null;
}

// Folds a WHATWG-style dotted IPv4 authority (1 to 4 parts, each decimal,
// octal, or hex, with the last part absorbing the remaining bits) into its
// 32-bit address, or returns null if hostname is not entirely numeric in
// that shape. node:net's isIP() only recognizes the strict 4-decimal-octet
// form, so a numeric authority in any other shape it accepts (127.1,
// 0x7f000001, 017700000001, a bare decimal integer, ...) would otherwise
// pass through DNS-hostname validation looking like an ordinary label, while
// curl, browsers, and glibc's resolver all still parse it as an IP address.
function parseIPv4Like(hostname) {
  const parts = hostname.split('.');
  if (parts.length === 0 || parts.length > 4 || parts.some((part) => part === '')) {
    return null;
  }

  const numbers = [];
  for (const part of parts) {
    const value = parseIPv4Number(part);
    if (value === null) return null;
    numbers.push(value);
  }

  for (let index = 0; index < numbers.length - 1; index += 1) {
    if (numbers[index] > 255) return null;
  }
  const last = numbers[numbers.length - 1];
  const maxLast = 256 ** (5 - numbers.length) - 1;
  if (last > maxLast) return null;

  let ipv4 = last;
  for (let index = 0; index < numbers.length - 1; index += 1) {
    ipv4 += numbers[index] * 256 ** (3 - index);
  }
  return ipv4 >>> 0;
}

function isLoopbackHostname(hostname) {
  const host = unbracket(hostname).replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return Number(host.split('.')[0]) === 127;
  if (ipVersion === 6) {
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

  // Not a strict dotted-quad or colon-hex literal that isIP() recognizes;
  // check the disguised numeric forms a real HTTP client would still resolve
  // as an IPv4 address.
  const ipv4 = parseIPv4Like(host);
  return ipv4 !== null && ipv4 >>> 24 === 127;
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

  if (isIP(hostname) !== 0 || parseIPv4Like(hostname) !== null) {
    refusal(
      'ip_literal_base_url',
      '--base-url authority must be a DNS name; IP literals are forbidden.',
    );
  }

  if (hostname.toLowerCase().endsWith('.local')) {
    refusal(
      'local_base_url',
      '--base-url must not use the special-use .local namespace.',
    );
  }

  if (!hostname.includes('.')) {
    refusal(
      'single_label_base_url',
      '--base-url hostname must contain at least two DNS labels (for example, relay.example.com).',
    );
  }

  if (!isValidDnsHostname(hostname)) {
    refusal(
      'invalid_dns_base_url',
      '--base-url hostname must contain valid DNS labels (letters, digits, and non-edge hyphens; 63 characters maximum per label).',
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

export function isHelpRequest(argv) {
  const optionsWithValues = new Set(['--db', '--port', '--base-url', '--env']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (optionsWithValues.has(arg)) {
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      return true;
    }
  }
  return false;
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
 * Build engine configuration from container environment without logging
 * secrets. An omitted or empty secret remains unset so the engine fails closed
 * for keyed anonymous creates while preserving unkeyed and authenticated-owner
 * creation.
 */
export function buildEngineConfig(env, mailbox = {}) {
  return {
    environment: env.RELAYCAST_ENV ?? 'production',
    ...(env.RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET
      ? { workspaceBootstrapSecret: env.RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET }
      : {}),
    ...(Object.keys(mailbox).length > 0 ? { mailbox } : {}),
  };
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
    config: buildEngineConfig({
      ...process.env,
      RELAYCAST_ENV: options.environment,
    }, mailbox),
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
  if (isHelpRequest(argv)) {
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

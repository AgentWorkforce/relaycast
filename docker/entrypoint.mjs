#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const DEFAULT_ENGINE_BINARY = '/opt/relaycast/node_modules/.bin/relaycast-engine';
const CONFIG_EXIT_CODE = 64;

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
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
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
  const isMapped = parts.slice(0, 5).every((part) => part === 0)
    && parts[5] === 0xffff;
  return isMapped && (parts[6] >> 8) === 127;
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
    url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
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

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = validatedEngineArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = CONFIG_EXIT_CODE;
    return;
  }

  const engineBinary = process.env.RELAYCAST_ENGINE_BIN || DEFAULT_ENGINE_BINARY;
  const child = spawn(engineBinary, args, { stdio: 'inherit' });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGINT', forwardSignal);
  process.once('SIGTERM', forwardSignal);

  await new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`relaycast container failed to launch the engine: ${error.message}\n`);
      process.exitCode = 1;
      resolve();
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        process.stderr.write(`relaycast engine exited after signal ${signal}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = code ?? 1;
      }
      resolve();
    });
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  await main();
}

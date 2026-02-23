import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:7528';

export interface LocalRuntimeOptions {
  binaryPath?: string;
  autoStart?: boolean;
}

export interface LocalServerOptions extends LocalRuntimeOptions {
  baseUrl?: string;
}

interface EnsureLocalRuntimeInput extends LocalServerOptions {
  apiKey: string;
}

export interface LocalServerResolved {
  baseUrl: string;
  binaryPath?: string;
}

export interface LocalRuntimeResolved {
  apiKey: string;
  baseUrl: string;
  binaryPath?: string;
}

export function ensureLocalRuntime(
  input: EnsureLocalRuntimeInput,
): LocalRuntimeResolved {
  if (!input.apiKey || input.apiKey.trim().length === 0) {
    throw new Error('RelayCast apiKey is required');
  }

  const server = ensureLocalServer(input);

  const apiKey = input.apiKey.trim();

  return {
    apiKey,
    baseUrl: server.baseUrl,
    binaryPath: server.binaryPath,
  };
}

export function ensureLocalServer(
  input: LocalServerOptions = {},
): LocalServerResolved {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const url = new URL(baseUrl);
  const host = url.hostname || '127.0.0.1';
  const port = url.port ? Number(url.port) : 7528;
  const autoStart = input.autoStart !== false;
  const healthy = isHealthy(baseUrl);
  let binaryPath = resolveBinaryPath(input.binaryPath, false) ?? undefined;

  if (autoStart && !healthy) {
    binaryPath = resolveBinaryPath(input.binaryPath);
    const child = spawn(
      binaryPath,
      ['--host', host, '--port', String(port)],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    child.unref();

    if (!waitForHealth(baseUrl, 40, 100)) {
      throw new Error(
        `Failed to start local relaycast daemon at ${baseUrl}. Set RELAYCAST_LOCAL_BIN to an existing local binary.`,
      );
    }
  }

  return { baseUrl, binaryPath };
}

export function prefetchLocalBinary(binaryPath?: string): string {
  return resolveBinaryPath(binaryPath);
}

function normalizeBaseUrl(input?: string): string {
  const value = (input || process.env.RELAYCAST_LOCAL_BASE_URL || DEFAULT_LOCAL_BASE_URL).trim();
  return value.replace(/\/+$/, '');
}

function resolveBinaryPath(explicit?: string): string;
function resolveBinaryPath(explicit: string | undefined, required: true): string;
function resolveBinaryPath(
  explicit: string | undefined,
  required: false,
): string | null;
function resolveBinaryPath(explicit?: string, required = true): string | null {
  const envPath = process.env.RELAYCAST_LOCAL_BIN?.trim();
  const candidate = explicit || envPath;
  if (candidate) {
    const resolved = resolve(candidate);
    if (!existsSync(resolved)) {
      throw new Error(`RELAYCAST local binary not found: ${resolved}`);
    }
    return resolved;
  }

  const asset = binaryAssetName();
  const bundled = resolveBundledBinary(asset);
  if (bundled) {
    return bundled;
  }

  if (!required) {
    return null;
  }

  throw new Error(
    `Bundled local binary not found for ${asset}. Reinstall @relaycast/sdk or set RELAYCAST_LOCAL_BIN.`,
  );
}

function resolveBundledBinary(asset: string): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'bin', asset),
    join(here, '..', '..', 'local', 'target', 'release', developmentBinaryName()),
    join(here, '..', '..', 'local', 'dist', asset),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    ensureExecutable(candidate);
    return candidate;
  }

  return null;
}

function developmentBinaryName(): string {
  return process.platform === 'win32' ? 'local.exe' : 'local';
}

function binaryAssetName(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'local-darwin-arm64';
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return 'local-darwin-x64';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'local-linux-x64';
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return 'local-windows-x64.exe';
  }

  throw new Error(
    `Unsupported platform for local relaycast runtime: ${process.platform}/${process.arch}`,
  );
}

function ensureExecutable(path: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, 0o755);
  } catch {
    // best effort only
  }
}

function isHealthy(baseUrl: string): boolean {
  const healthUrl = `${baseUrl}/health`;
  const script = `
const [url] = process.argv.slice(1);
(async () => {
  const res = await fetch(url);
  process.exit(res.ok ? 0 : 1);
})().catch(() => process.exit(1));
`;
  const result = spawnSync(
    process.execPath,
    ['-e', script, healthUrl],
    { stdio: 'ignore' },
  );
  return result.status === 0;
}

function waitForHealth(baseUrl: string, attempts: number, sleepMs: number): boolean {
  for (let i = 0; i < attempts; i += 1) {
    if (isHealthy(baseUrl)) return true;
    sleepSync(sleepMs);
  }
  return false;
}

function sleepSync(ms: number): void {
  const blocker = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(blocker, 0, 0, ms);
}

/**
 * The real `relaycast-engine` server process, spawned from source (tsx like
 * the other spawn-based tests): with any RELAYCAST_DATABASE_* variable set it
 * must exit 64 before it opens the SQLite file or listens, and without one
 * the same command line serves from SQLite (the control).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SERVE = fileURLToPath(new URL('../serve.ts', import.meta.url));
const ENGINE_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const FAKE_PASSWORD = 'fake-pw-not-a-secret';
const FAKE_URL = `postgres://u:${FAKE_PASSWORD}@127.0.0.1:1/app`;

/** The parent's environment without any RELAYCAST_* or PORT variable. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('RELAYCAST_') && name !== 'PORT') env[name] = value;
  }
  return { ...env, ...extra };
}

/** A loopback port nothing listens on: bind port 0, read it, close. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

/** Resolve 'connected' or the connect error code for 127.0.0.1:port. */
function tryConnect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(2_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('timeout');
    });
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
  });
}

interface Child {
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal: NodeJS.Signals) => boolean;
  isRunning: () => boolean;
}

function startServe(args: string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVE, ...args], {
    cwd: ENGINE_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  let running = true;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      running = false;
      resolve({ code, signal });
    });
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    kill: (signal) => child.kill(signal),
    isRunning: () => running,
  };
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** SIGTERM, then SIGKILL if the child has not exited in 10s; resolves when it has. */
async function stop(child: Child) {
  if (!child.isRunning()) return child.exited;
  child.kill('SIGTERM');
  try {
    return await within(child.exited, 10_000, 'SIGTERM shutdown');
  } catch {
    child.kill('SIGKILL');
    return within(child.exited, 10_000, 'SIGKILL');
  }
}

describe('relaycast-engine serve startup (spawned process)', { timeout: 90_000 }, () => {
  let dir: string;
  let secretDir: string;
  const children: Child[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'serve-startup-'));
    secretDir = mkdtempSync(join(tmpdir(), 'serve-startup-secret-'));
  });

  afterEach(async () => {
    await Promise.all(children.splice(0).map((child) => stop(child).catch(() => {})));
    rmSync(dir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  async function expectRefused(env: NodeJS.ProcessEnv, variable: string) {
    const port = await freePort();
    const db = join(dir, 'refused.db');
    const child = startServe(['--db', db, '--port', String(port)], env);
    children.push(child);
    // Watch the whole lifetime: the SQLite file must never appear and the port
    // must never accept, not only after exit (stop watching on a violation).
    const seen: string[] = [];
    const deadline = Date.now() + 60_000;
    while (child.isRunning() && seen.length === 0 && Date.now() < deadline) {
      if (existsSync(db)) seen.push('database file created');
      if ((await tryConnect(port)) === 'connected') seen.push('port accepted a connection');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen).toEqual([]);
    const { code, signal } = await within(child.exited, 10_000, 'refused server exit');
    const output = child.stdout() + child.stderr();

    expect(signal).toBeNull();
    expect(code).toBe(64);
    expect(child.stderr()).toContain(variable);
    expect(child.stderr()).toMatch(/relaycast-engine migrate/);
    expect(child.stderr()).toMatch(/relaycast-engine verify-db/);
    expect(output).not.toContain(FAKE_PASSWORD);
    expect(output).not.toContain(FAKE_URL);
    // Refused before SQLite was opened: no database file, journal or tmp files.
    for (const file of [db, `${db}-wal`, `${db}-shm`, `${db}-journal`]) expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    // ... and before listening: nothing accepts on the chosen port.
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
  }

  it('exits 64 with RELAYCAST_DATABASE_URL set, before creating the SQLite file or listening', async () => {
    await expectRefused(cleanEnv({ RELAYCAST_DATABASE_URL: FAKE_URL }), 'RELAYCAST_DATABASE_URL');
  });

  it('exits 64 with RELAYCAST_DATABASE_URL_FILE set, without echoing the file', async () => {
    const urlFile = join(secretDir, 'database-url');
    writeFileSync(urlFile, `${FAKE_URL}\n`, { mode: 0o600 });
    await expectRefused(cleanEnv({ RELAYCAST_DATABASE_URL_FILE: urlFile }), 'RELAYCAST_DATABASE_URL_FILE');
  });

  it('control: without RELAYCAST_DATABASE_* the same command serves from SQLite', async () => {
    const port = await freePort();
    const db = join(dir, 'control.db');
    const child = startServe(['--db', db, '--port', String(port)], cleanEnv());
    children.push(child);

    const deadline = Date.now() + 60_000;
    let health: number | undefined;
    while (Date.now() < deadline && child.isRunning()) {
      if ((await tryConnect(port)) === 'connected') {
        health = (await fetch(`http://127.0.0.1:${port}/health`)).status;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(child.isRunning(), `server exited early: ${child.stderr()}`).toBe(true);
    expect(health).toBe(200);
    expect(existsSync(db)).toBe(true);
    expect(child.stdout()).toContain(`listening on http://localhost:${port}`);

    const exit = await stop(child);
    expect(exit.code !== null || exit.signal !== null).toBe(true);
    expect(await tryConnect(port)).toBe('ECONNREFUSED');
  });
});

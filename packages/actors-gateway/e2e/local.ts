#!/usr/bin/env npx tsx
/**
 * Local proof for relaycast on durable-actors: starts the control plane
 * (`durable-actors dev` for packages/actors-workspace) and two gateway
 * replicas sharing one file directory, runs `smoke.ts` (with a real restart
 * of gateway 1), optionally the repository's `scripts/e2e.ts`, then tears
 * everything down. Exit code 1 on any failed check.
 *
 *   npx tsx packages/actors-gateway/e2e/local.ts [--keep-state] [--with-e2e] [--with-e2e-actions] [--skip-restart]
 *
 * `--with-e2e` / `--with-e2e-actions` also run `scripts/e2e.ts` /
 * `scripts/e2e-actions.ts` against gateway 1; their exit codes are reported
 * but do not fail the proof (parts of them assume legacy credentials).
 *
 * Prerequisites: `npm ci`, the engine built (`npx turbo build --filter=@relaycast/engine`),
 * the gateway built (`npm run build -w @relaycast/actors-gateway`), Bun on PATH or
 * at ~/.bun/bin/bun (durable-actors' CLI runs on Bun), outbound network on the
 * first run (the control-plane binary is downloaded into ~/.cache/durable-actors).
 *
 * Environment (all optional):
 *   RELAYCAST_E2E_CONTROL_PLANE_PORT  default 7100
 *   RELAYCAST_E2E_GATEWAY1_PORT       default 8787
 *   RELAYCAST_E2E_GATEWAY2_PORT       default 8788
 *   RELAYCAST_E2E_WORK_DIR            where state, files and logs go (default: a fresh temp dir,
 *                                     removed on success; with --keep-state:
 *                                     packages/actors-workspace/.durable-actors)
 *   RELAYCAST_E2E_BUN                 Bun executable (default ~/.bun/bin/bun, else `bun` on PATH)
 *   DURABLE_ACTORS_SECRET             when set, the control plane requires it and the gateways send it
 *   RELAYCAST_E2E_FILE_SIGNING_SECRET, RELAYCAST_E2E_CREDENTIAL_KEYRING  override the local secrets
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, type WriteStream } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSmoke } from './smoke.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKSPACE_DIR = path.join(ROOT, 'packages/actors-workspace');
const GATEWAY_BIN = path.join(ROOT, 'packages/actors-gateway/dist/bin.js');
const DURABLE_ACTORS_CLI = path.join(ROOT, 'node_modules/durable-actors/bin/durable-actors.js');

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const KEEP_STATE = flags.has('--keep-state');
const WITH_E2E = flags.has('--with-e2e');
const WITH_E2E_ACTIONS = flags.has('--with-e2e-actions');
const SKIP_RESTART = flags.has('--skip-restart');

const CONTROL_PLANE_PORT = Number(process.env.RELAYCAST_E2E_CONTROL_PLANE_PORT ?? 7100);
const GATEWAY_PORTS = [
  Number(process.env.RELAYCAST_E2E_GATEWAY1_PORT ?? 8787),
  Number(process.env.RELAYCAST_E2E_GATEWAY2_PORT ?? 8788),
];
const CONTROL_PLANE_URL = `http://127.0.0.1:${CONTROL_PLANE_PORT}`;
const GATEWAY_URLS = GATEWAY_PORTS.map((port) => `http://127.0.0.1:${port}`);
const FILE_SIGNING_SECRET = process.env.RELAYCAST_E2E_FILE_SIGNING_SECRET ?? 'local-file-signing-secret';
const CREDENTIAL_KEYRING =
  process.env.RELAYCAST_E2E_CREDENTIAL_KEYRING ?? '{"current":"a","keys":{"a":"local-credential-tag-secret"}}';
const DURABLE_ACTORS_SECRET = process.env.DURABLE_ACTORS_SECRET?.trim() || undefined;

const SIGTERM_GRACE_MS = 10_000;
const CONTROL_PLANE_START_TIMEOUT_MS = 240_000; // first run downloads the native binary
const GATEWAY_START_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const startedAt = Date.now();
function log(line: string): void {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`${elapsed}s ${line}`);
}

let failures = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    log(`[ ok ] ${name} (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    failures += 1;
    log(`[FAIL] ${name} (${Date.now() - started} ms): ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

interface Proc {
  name: string;
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  done: boolean;
  tail: string[];
  logFile: string;
}

const procs: Proc[] = [];

function startProcess(name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logDir: string): Proc {
  const logFile = path.join(logDir, `${name}.log`);
  const stream: WriteStream = createWriteStream(logFile, { flags: 'a' });
  // Its own process group, so stopping it also stops what it spawned (the control plane's native runtime).
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const tail: string[] = [];
  const capture = (chunk: Buffer) => {
    stream.write(chunk);
    for (const line of chunk.toString().split('\n')) {
      if (line.trim() === '') continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const proc: Proc = {
    name,
    child,
    done: false,
    tail,
    logFile,
    exited: new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        proc.done = true;
        stream.end();
        resolve({ code, signal });
      });
      child.once('error', (error) => {
        proc.done = true;
        tail.push(`spawn error: ${error.message}`);
        stream.end();
        resolve({ code: null, signal: null });
      });
    }),
  };
  procs.push(proc);
  return proc;
}

function signalGroup(proc: Proc, signal: NodeJS.Signals): void {
  if (proc.done || !proc.child.pid) return;
  try {
    process.kill(-proc.child.pid, signal);
  } catch {
    try {
      proc.child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** SIGTERM, then SIGKILL after the grace period. Resolves with how it ended. */
async function stopProcess(proc: Proc, graceMs = SIGTERM_GRACE_MS): Promise<string> {
  if (proc.done) return 'already exited';
  signalGroup(proc, 'SIGTERM');
  const outcome = await Promise.race([proc.exited.then((r) => `exited ${r.signal ?? r.code}`), sleep(graceMs).then(() => 'timeout')]);
  if (outcome !== 'timeout') return outcome;
  signalGroup(proc, 'SIGKILL');
  await Promise.race([proc.exited, sleep(5000)]);
  return 'killed after grace period';
}

function printTail(proc: Proc, lines = 40): void {
  console.log(`----- ${proc.name}: last ${Math.min(lines, proc.tail.length)} log lines (${proc.logFile}) -----`);
  for (const line of proc.tail.slice(-lines)) console.log(`  ${line}`);
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

async function waitForHttp(url: string, timeoutMs: number, proc: Proc, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'no response yet';
  while (Date.now() < deadline) {
    if (proc.done) throw new Error(`${label}: ${proc.name} exited before it was ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${label}: ${url} not ready after ${timeoutMs} ms (${lastStatus})`);
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

function resolveBun(): string {
  if (process.env.RELAYCAST_E2E_BUN) return process.env.RELAYCAST_E2E_BUN;
  const home = path.join(os.homedir(), '.bun/bin/bun');
  return existsSync(home) ? home : 'bun';
}

interface Dirs {
  work: string;
  state: string;
  files: string;
  logs: string;
  temporary: boolean;
}

function prepareDirs(): Dirs {
  const explicit = process.env.RELAYCAST_E2E_WORK_DIR;
  const work = explicit
    ? path.resolve(explicit)
    : KEEP_STATE
      ? path.join(WORKSPACE_DIR, '.durable-actors')
      : mkdtempSync(path.join(os.tmpdir(), 'relaycast-actors-e2e-'));
  const dirs: Dirs = {
    work,
    state: KEEP_STATE && !explicit ? work : path.join(work, 'state'),
    files: path.join(work, 'files'),
    logs: path.join(work, 'logs'),
    temporary: !explicit && !KEEP_STATE,
  };
  for (const dir of [dirs.state, dirs.files, dirs.logs]) mkdirSync(dir, { recursive: true });
  return dirs;
}

function startControlPlane(bun: string, dirs: Dirs): Proc {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.dirname(bun)}${path.delimiter}${process.env.PATH ?? ''}`,
    // The Workspace actor's own configuration.
    RELAYCAST_PUBLIC_URL: GATEWAY_URLS[0],
    RELAYCAST_FILE_SIGNING_SECRET: FILE_SIGNING_SECRET,
    // `durable-actors dev` reads these; the secret becomes `--api-key`.
    DURABLE_ACTORS_PROJECT_ID: 'local',
    DURABLE_ACTORS_DATA_DIR: dirs.state,
    DURABLE_ACTORS_SECRET: DURABLE_ACTORS_SECRET,
    DURABLE_ACTORS_API_KEY: DURABLE_ACTORS_SECRET,
  };
  if (!DURABLE_ACTORS_SECRET) {
    delete env.DURABLE_ACTORS_SECRET;
    delete env.DURABLE_ACTORS_API_KEY;
  }
  return startProcess(
    'control-plane',
    bun,
    [DURABLE_ACTORS_CLI, 'dev', '--no-watch', '--port', String(CONTROL_PLANE_PORT)],
    WORKSPACE_DIR,
    env,
    dirs.logs,
  );
}

function startGateway(index: 0 | 1, dirs: Dirs): Proc {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(GATEWAY_PORTS[index]),
    DURABLE_ACTORS_CONTROL_PLANE_URL: CONTROL_PLANE_URL,
    DURABLE_ACTORS_PROJECT_ID: 'local',
    RELAYCAST_FILE_SIGNING_SECRET: FILE_SIGNING_SECRET,
    RELAYCAST_CREDENTIAL_KEYRING: CREDENTIAL_KEYRING,
    RELAYCAST_FILE_STORE: 'local',
    RELAYCAST_FILE_DIR: dirs.files,
    RELAYCAST_LOG_FORMAT: 'text',
    RELAYCAST_ENV: 'local-e2e',
  };
  if (DURABLE_ACTORS_SECRET) env.DURABLE_ACTORS_SECRET = DURABLE_ACTORS_SECRET;
  else delete env.DURABLE_ACTORS_SECRET;
  delete env.DURABLE_ACTORS_API_KEY;
  return startProcess(`gateway-${index + 1}`, process.execPath, [GATEWAY_BIN], ROOT, env, dirs.logs);
}

async function runRepoScript(name: string, script: string, args: string[], logs: string): Promise<number> {
  const proc = startProcess(name, 'npx', ['tsx', script, ...args], ROOT, { ...process.env, CI: '1' }, logs);
  proc.child.stdout?.pipe(process.stdout);
  proc.child.stderr?.pipe(process.stderr);
  const { code } = await proc.exited;
  return code ?? 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let tearingDown = false;
async function teardown(dirs: Dirs | undefined, succeeded: boolean): Promise<void> {
  if (tearingDown) return;
  tearingDown = true;
  for (const proc of [...procs].reverse()) {
    if (proc.done) continue;
    const started = Date.now();
    const outcome = await stopProcess(proc);
    log(`[ ok ] stop ${proc.name}: ${outcome} (${Date.now() - started} ms)`);
  }
  if (!dirs) return;
  if (succeeded && dirs.temporary) {
    rmSync(dirs.work, { recursive: true, force: true });
  } else {
    log(`state, files and logs kept in ${dirs.work}`);
  }
}

async function main(): Promise<number> {
  let dirs: Dirs | undefined;
  let smokeFailed = 0;
  let e2eExit: number | undefined;
  let e2eActionsExit: number | undefined;
  try {
    const bun = resolveBun();
    await step('preflight: gateway build, Bun, free ports', async () => {
      if (!existsSync(GATEWAY_BIN)) throw new Error(`${GATEWAY_BIN} is missing; run: npm run build -w @relaycast/actors-gateway`);
      if (!existsSync(DURABLE_ACTORS_CLI)) throw new Error(`${DURABLE_ACTORS_CLI} is missing; run: npm ci`);
      if (bun !== 'bun' && !existsSync(bun)) throw new Error(`Bun not found at ${bun} (set RELAYCAST_E2E_BUN)`);
      for (const port of [CONTROL_PLANE_PORT, ...GATEWAY_PORTS]) {
        if (!(await portIsFree(port))) throw new Error(`port ${port} is in use (override with RELAYCAST_E2E_*_PORT)`);
      }
    });
    dirs = prepareDirs();
    log(`       work dir ${dirs.work}${DURABLE_ACTORS_SECRET ? ' (control-plane auth on)' : ' (control-plane auth off)'}`);

    const controlPlane = await step(`start control plane (durable-actors dev on ${CONTROL_PLANE_URL}) and wait for /healthz`, async () => {
      const proc = startControlPlane(bun, dirs!);
      await waitForHttp(`${CONTROL_PLANE_URL}/healthz`, CONTROL_PLANE_START_TIMEOUT_MS, proc, 'control plane');
      return proc;
    });

    const gateways: [Proc, Proc] = [
      await step(`start gateway 1 on ${GATEWAY_URLS[0]} and wait for /readyz`, async () => {
        const proc = startGateway(0, dirs!);
        await waitForHttp(`${GATEWAY_URLS[0]}/readyz`, GATEWAY_START_TIMEOUT_MS, proc, 'gateway 1');
        return proc;
      }),
      await step(`start gateway 2 on ${GATEWAY_URLS[1]} and wait for /readyz`, async () => {
        const proc = startGateway(1, dirs!);
        await waitForHttp(`${GATEWAY_URLS[1]}/readyz`, GATEWAY_START_TIMEOUT_MS, proc, 'gateway 2');
        return proc;
      }),
    ];

    const restartGateway1 = async (): Promise<void> => {
      const started = Date.now();
      const outcome = await stopProcess(gateways[0]);
      const stoppedAt = Date.now();
      gateways[0] = startGateway(0, dirs!);
      await waitForHttp(`${GATEWAY_URLS[0]}/readyz`, GATEWAY_START_TIMEOUT_MS, gateways[0], 'gateway 1 (restarted)');
      log(`       gateway 1 ${outcome} in ${stoppedAt - started} ms, ready again ${Date.now() - stoppedAt} ms later`);
    };

    log('--- smoke (packages/actors-gateway/e2e/smoke.ts) ---');
    const smoke = await runSmoke({
      gateway1: GATEWAY_URLS[0],
      gateway2: GATEWAY_URLS[1],
      restartGateway1: SKIP_RESTART ? undefined : restartGateway1,
      log,
    });
    smokeFailed = smoke.failed;
    log(`--- smoke: ${smoke.steps.length - smoke.failed}/${smoke.steps.length} passed${smoke.aliceReconnect ? `, alice reconnect: ${smoke.aliceReconnect}` : ''} ---`);

    if (WITH_E2E) {
      log(`--- scripts/e2e.ts against ${GATEWAY_URLS[0]} (informational; actor mode refuses legacy credentials by design) ---`);
      const started = Date.now();
      e2eExit = await runRepoScript('scripts-e2e', 'scripts/e2e.ts', [GATEWAY_URLS[0], '--ci', '--continue-on-failure'], dirs.logs);
      log(`--- scripts/e2e.ts exited ${e2eExit} (${Date.now() - started} ms) ---`);
    }
    if (WITH_E2E_ACTIONS) {
      log(`--- scripts/e2e-actions.ts against ${GATEWAY_URLS[0]} (informational) ---`);
      const started = Date.now();
      e2eActionsExit = await runRepoScript('scripts-e2e-actions', 'scripts/e2e-actions.ts', [GATEWAY_URLS[0]], dirs.logs);
      log(`--- scripts/e2e-actions.ts exited ${e2eActionsExit} (${Date.now() - started} ms) ---`);
    }

    if (controlPlane.done) throw new Error('the control plane exited during the run');
    for (const gateway of gateways) if (gateway.done) throw new Error(`${gateway.name} exited during the run`);
  } catch (error) {
    if (failures === 0) {
      failures += 1;
      log(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const succeeded = failures === 0 && smokeFailed === 0;
  if (!succeeded) for (const proc of procs) if (!proc.name.startsWith('scripts-')) printTail(proc);
  await teardown(dirs, succeeded);
  log(succeeded ? 'PASS' : `FAIL (${failures + smokeFailed} failed check(s))`);
  if (e2eExit !== undefined) log(`scripts/e2e.ts exit code: ${e2eExit} (not counted above)`);
  if (e2eActionsExit !== undefined) log(`scripts/e2e-actions.ts exit code: ${e2eActionsExit} (not counted above)`);
  return succeeded ? 0 : 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log(`received ${signal}, tearing down`);
    teardown(undefined, false).finally(() => process.exit(130));
  });
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    teardown(undefined, false).finally(() => process.exit(1));
  },
);

/**
 * End to end: a Relaycast self-host server on PostgreSQL, seeded through its
 * HTTP API, exported with `export-for-actors`, imported into a workspace
 * actor under the same id, then the same reads compared on both. Skipped
 * unless the PostgreSQL fixture is configured (RELAYCAST_PG_TEST_URL_OWNER,
 * _URL_RUNTIME, RELAYCAST_PG_TEST_CA_FILE; see postgres.integration.test.ts).
 * Resets the fixture schema as the owner.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPostgresConfig, type PostgresMode } from '../../postgres/config.js';
import { loadBundledPostgresMigrations, runPostgresMigrations } from '../../postgres/migrate.js';
import { openPostgresPool } from '../../postgres/pool.js';
import { holdFixtureLock, resetSchema, SCHEMA } from '../../postgres/__tests__/fixture.js';
import { runMigrationExportCommand, runMigrationPreflightCommand } from '../../postgres/cli.js';
import { blockPlace, exportKey, openBlock } from '../sealing.js';
import { FakeWorkspaceActor } from '../../actor/__tests__/fakeActor.js';
import type { WorkspaceManifest } from '../export.js';
import type { MigrationRow } from '../rows.js';

const OWNER_URL = process.env.RELAYCAST_PG_TEST_URL_OWNER;
const RUNTIME_URL = process.env.RELAYCAST_PG_TEST_URL_RUNTIME;
const CA_FILE = process.env.RELAYCAST_PG_TEST_CA_FILE;
const enabled = Boolean(OWNER_URL && RUNTIME_URL && CA_FILE);

/** The keyring of the fake actor gateway (fakeActor.ts), so credentials minted on Postgres route to the actor. */
const KEYRING = '{"current":"a","keys":{"a":"actor-test-tag-secret"}}';
const INTERNAL_SECRET = 'migration-test-internal-secret-0123456789abcdef';
const PORT = 47000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;
const SERVE = fileURLToPath(new URL('../../../bin/serve.ts', import.meta.url));

const configFor = (url: string, mode: PostgresMode) =>
  loadPostgresConfig({ RELAYCAST_DATABASE_URL: url, RELAYCAST_DATABASE_CA_FILE: CA_FILE }, mode);

interface Envelope<T> { ok: boolean; data: T; error?: { code: string; message: string } }

async function http<T>(method: string, path: string, body?: unknown, token?: string) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: (text ? JSON.parse(text) : null) as Envelope<T> };
}

describe.skipIf(!enabled)('Postgres to workspace actor migration (integration)', { timeout: 180_000 }, () => {
  let owner: pg.Pool;
  let releaseFixture: (() => Promise<void>) | undefined;
  let server: ChildProcess | undefined;
  let outDir: string;

  beforeAll(async () => {
    owner = openPostgresPool(configFor(OWNER_URL!, 'owner'));
    releaseFixture = await holdFixtureLock(owner);
    await resetSchema(owner);
    await runPostgresMigrations(owner, { schema: SCHEMA, bundled: loadBundledPostgresMigrations(), runtimeRole: 'relaycast_runtime' });
    outDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'relaycast-export-'));
    // The server runs in the export dir (its files land in ./relaycast-files):
    // resolve tsx from here, not from that cwd.
    server = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), SERVE, '--port', String(PORT), '--db', join(outDir, 'unused.db')], {
      env: {
        ...process.env,
        RELAYCAST_DATABASE_URL: RUNTIME_URL,
        RELAYCAST_DATABASE_CA_FILE: CA_FILE,
        RELAYCAST_CREDENTIAL_KEYRING: KEYRING,
        RELAYCAST_CREDENTIAL_FORMAT: 'ar',
        RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET,
      },
      cwd: outDir,
      stdio: 'ignore',
    });
    for (let i = 0; i < 200; i += 1) {
      const up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
      if (up) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('the PostgreSQL self-host server did not start');
  }, 150_000);

  afterAll(async () => {
    server?.kill('SIGTERM');
    if (outDir) await rm(outDir, { recursive: true, force: true }).catch(() => {});
    if (owner) await resetSchema(owner).catch(() => {});
    await releaseFixture?.().catch(() => {});
    await owner?.end().catch(() => {});
  }, 60_000);

  it('moves every row of a seeded workspace, verified by digest, and the actor answers as Postgres did', async () => {
    const created = await http<{ workspace_id: string; api_key: string }>('POST', '/internal/workspaces', { name: 'armadillo' },
      INTERNAL_SECRET);
    expect(created.status).toBe(201);
    const workspaceId = created.json.data.workspace_id;
    const key = created.json.data.api_key;
    expect(key).toMatch(/^ar_ws_/);
    const tokens: Record<string, string> = {};
    for (const name of ['alice', 'bob', 'carol']) {
      const agent = await http<{ token: string }>('POST', '/v1/agents', { name }, key);
      expect(agent.status).toBe(201);
      tokens[name] = agent.json.data.token;
    }
    expect((await http('POST', '/v1/channels', { name: 'ops' }, tokens.alice)).status).toBe(201);
    for (const name of ['bob', 'carol']) expect((await http('POST', '/v1/channels/ops/join', {}, tokens[name])).status).toBe(200);
    const ids: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const posted = await http<{ id: string }>('POST', '/v1/channels/ops/messages', { text: `ops message ${i}` }, tokens[['alice', 'bob', 'carol'][i % 3]!]);
      expect(posted.status).toBe(201);
      ids.push(posted.json.data.id);
    }
    expect((await http('POST', `/v1/messages/${ids[3]}/replies`, { text: 'threaded reply' }, tokens.bob)).status).toBe(201);
    expect((await http('POST', `/v1/messages/${ids[4]}/reactions`, { emoji: 'tada' }, tokens.carol)).status).toBe(201);
    for (let i = 0; i < 5; i += 1) expect((await http('POST', '/v1/dm', { to: 'bob', text: `dm ${i}` }, tokens.alice)).status).toBe(201);
    expect((await http('POST', '/v1/webhooks', { name: 'ci', channel: 'ops' }, key)).status).toBe(201);
    expect((await http('POST', '/v1/subscriptions', { events: ['message.created'], url: 'https://hooks.example.com/relay' }, key)).status).toBe(201);

    // Preflight: everything here was created after the switch to ar_, so a switch
    // time in the future marks every principal (and the never-rotated workspace
    // key) as legacy: blocked, unless the operator accepts re-registration.
    const dbEnv = { RELAYCAST_DATABASE_URL: RUNTIME_URL, RELAYCAST_DATABASE_CA_FILE: CA_FILE, RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET };
    const pre: string[] = [];
    const preIo = { out: (line: string) => pre.push(line), err: (line: string) => pre.push(`ERR ${line}`) };
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    expect(await runMigrationPreflightCommand(['--ar-since', future], dbEnv, preIo)).toBe(1);
    expect(pre.find((line) => line.includes('legacy_principals'))).toMatch(/"workspace_key":1/);
    expect(await runMigrationPreflightCommand(['--ar-since', future, '--allow-legacy'], dbEnv, preIo)).toBe(0);
    expect(await runMigrationPreflightCommand(['--ar-since', '0', '--export-dir', outDir], dbEnv, preIo)).toBe(0);
    expect(pre.find((line) => line.includes('export_capacity'))).toMatch(/"ok":true/);
    expect(await runMigrationPreflightCommand([], dbEnv, preIo)).toBe(64);

    // Export through the CLI entry point, as the migration Job runs it.
    const lines: string[] = [];
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(`ERR ${line}`) };
    const exitCode = await runMigrationExportCommand(['--out', outDir, '--run-id', 'run-pg-0001', '--block-rows', '9'], dbEnv, io);
    expect(exitCode, lines.join('\n')).toBe(0);
    for (const line of lines) {
      for (const secret of [key, ...Object.values(tokens), new URL(RUNTIME_URL!).password]) expect(line).not.toContain(secret);
    }
    // At rest: owner-only and sealed (no subscription URL or other row content readable).
    expect((await stat(join(outDir, workspaceId))).mode & 0o777).toBe(0o700);
    expect((await stat(join(outDir, workspaceId, 'event_subscriptions.ndjson'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(outDir, workspaceId, 'event_subscriptions.ndjson'), 'utf8')).not.toContain('hooks.example.com');

    const manifest = JSON.parse(await readFile(join(outDir, workspaceId, 'manifest.json'), 'utf8')) as WorkspaceManifest;
    expect(manifest.tables.find((table) => table.name === 'messages')!.count).toBeGreaterThan(40);
    const exported = await readdir(join(outDir, workspaceId));
    expect(exported).toContain('messages.ndjson');

    const actor = new FakeWorkspaceActor(workspaceId);
    const step = async (body: unknown) => {
      const response = await actor.importData(body);
      return { status: response.status, json: JSON.parse(response.body) as Envelope<unknown> };
    };
    expect((await step({ op: 'begin', run_id: manifest.run_id, tables: manifest.tables.map(({ name, columns }) => ({ name, columns })) })).status).toBe(201);
    const blockKey = await exportKey(INTERNAL_SECRET, manifest.run_id);
    for (const table of manifest.tables) {
      const text = await readFile(join(outDir, workspaceId, `${table.name}.ndjson`), 'utf8');
      const blocks = await Promise.all(text.split('\n').filter(Boolean)
        .map(async (line, seq) => JSON.parse(await openBlock(blockKey, blockPlace(workspaceId, table.name, seq), line)) as MigrationRow[]));
      expect(blocks.length).toBe(table.blocks);
      for (const [seq, rows] of blocks.entries()) {
        const sent = await step({ op: 'chunk', run_id: manifest.run_id, table: table.name, seq, rows });
        expect(sent.status, `${table.name} #${seq}: ${JSON.stringify(sent.json)}`).toBe(200);
      }
    }
    const finished = await step({
      op: 'finish',
      run_id: manifest.run_id,
      manifest: Object.fromEntries(manifest.tables.map(({ name, count, sha256 }) => [name, { count, sha256 }])),
    });
    expect(finished.status, JSON.stringify(finished.json)).toBe(200);
    expect((await step({ op: 'open', run_id: manifest.run_id })).status).toBe(200);

    // The Postgres-issued credentials work on the actor, and every read answers the same.
    const readActor = async (path: string, token: string) => {
      const response = await actor.handle({ method: 'GET', url: `https://armadillo.test${path}`, headers: [['authorization', `Bearer ${token}`]], body: null });
      return { status: response.status, json: JSON.parse(response.body) as Envelope<unknown> };
    };
    for (const [path, token] of [
      ['/v1/channels', tokens.bob],
      ['/v1/channels/ops/messages?limit=100', tokens.bob],
      [`/v1/messages/${ids[3]}/replies`, tokens.bob],
      ['/v1/inbox', tokens.bob],
      ['/v1/dm/conversations', tokens.alice],
      ['/v1/agents', key],
    ] as const) {
      const before = await http(path.startsWith('/v1/agents') ? 'GET' : 'GET', path, undefined, token);
      const after = await readActor(path, token);
      expect(before.status, path).toBe(200);
      expect(after.status, path).toBe(200);
      expect(stripVolatile(after.json), path).toEqual(stripVolatile(before.json));
    }
  });
});

/** Fields computed at read time from the clock or the serving process (presence), not stored. */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !['online', 'presence', 'is_online'].includes(k)).map(([k, v]) => [k, stripVolatile(v)]));
  }
  return value;
}

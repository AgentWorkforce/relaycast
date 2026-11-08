import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';

const script = fileURLToPath(new URL('../../../../../scripts/retain-agents.mts', import.meta.url));
const betterSqlite3 = createRequire(import.meta.url).resolve('better-sqlite3');

// Preloaded into the CLI child process for the D1 preview test: replaces
// global fetch with a fake Cloudflare D1 query endpoint that answers from the
// fixture SQLite file (opened read-only) and logs every request it receives.
const d1FetchStub = `
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
const Database = createRequire(import.meta.url)(${JSON.stringify(betterSqlite3)});
const db = new Database(process.env.D1_STUB_DATABASE, { readonly: true, fileMustExist: true });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  appendFileSync(process.env.D1_STUB_LOG, JSON.stringify({ url: String(url), method: init.method,
    authorization: init.headers.authorization, sql: body.sql, params: body.params }) + '\\n');
  const results = db.prepare(body.sql).all(...body.params);
  return new Response(JSON.stringify({ success: true, result: [{ success: true, results }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
`;

describe('agent retention CLI', () => {
  let directory: string;
  let database: string;
  let handle: SqliteDbHandle;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agent-retention-test-'));
    database = join(directory, 'fixture.db');
    handle = getSqliteDb(database);
    runMigrations(handle);
    handle.sqlite.exec("INSERT INTO workspaces(id,name,api_key_hash) VALUES ('fixture','fixture','fixture')");
    const insert = handle.sqlite.prepare(`INSERT INTO agents(id,workspace_id,name,token_hash,status,created_at,last_seen)
      VALUES (?,'fixture',?,?,?,1,1)`);
    handle.sqlite.transaction(() => {
      for (let i = 0; i < 215; i++) {
        const id = String(i).padStart(4, '0');
        insert.run(id, id, id, i % 10 === 0 ? 'active' : 'offline');
      }
    })();
  });
  afterEach(() => {
    handle?.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', script, '--sqlite', database, '--workspace-id', 'fixture', ...args], {
      encoding: 'utf8', timeout: 15_000,
    });
  }
  function summary(result: ReturnType<typeof run>) {
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
  }
  const rows = () => handle.sqlite.prepare('SELECT id FROM agents ORDER BY id').all();

  it('defaults to dry-run and resumes explicit deletion from disk without losing protected rows', () => {
    const before = rows();
    expect(summary(run())).toMatchObject({ dry_run: true, complete: true, scanned: 215, eligible: 193, deleted: 0 });
    expect(rows()).toEqual(before);

    const state = join(directory, 'deletion.json');
    expect(summary(run('--delete', '--max-pages', '1', '--state-file', state)))
      .toMatchObject({ dry_run: false, complete: false, scanned: 100, deleted: 90 });
    const checkpoint = readFileSync(state, 'utf8');
    expect(rows()).toHaveLength(125);
    expect(summary(run('--delete', '--state-file', state)))
      .toMatchObject({ complete: true, scanned: 115, deleted: 103 });
    expect(rows()).toEqual(before.filter((_, index) => index % 10 === 0));

    // An uncertain response reuses the earlier durable cursor. Registry rows
    // already deleted are absent, while retained rows remain protected.
    const replayState = join(directory, 'replay.json');
    // The saved file's source, policy and mode must stay identical on replay.
    writeFileSync(replayState, checkpoint);
    expect(summary(run('--delete', '--state-file', replayState))).toMatchObject({ complete: true, deleted: 0 });
    expect(rows()).toHaveLength(22);
    expect(run('--delete', '--state-file', state).stderr).toContain('already complete');
  });

  it('bounds preview and deletion with --limit and resumes with a smaller page size', () => {
    const before = rows();
    expect(summary(run('--limit', '10', '--max-pages', '1')))
      .toMatchObject({ dry_run: true, complete: false, scanned: 10, eligible: 9, deleted: 0 });
    expect(rows()).toEqual(before);

    const state = join(directory, 'limited-deletion.json');
    expect(summary(run('--delete', '--limit', '10', '--max-pages', '1', '--state-file', state)))
      .toMatchObject({ complete: false, scanned: 10, deleted: 9 });
    expect(rows()).toEqual(before.filter((_, index) => index === 0 || index >= 10));

    expect(summary(run('--delete', '--limit', '1', '--max-pages', '1', '--state-file', state)))
      .toMatchObject({ complete: false, scanned: 1, deleted: 0 });
    expect(rows()).toHaveLength(206);
    const resumed = run('--delete', '--limit', '5', '--state-file', state);
    expect(summary(resumed)).toMatchObject({ complete: true, scanned: 204, deleted: 184 });
    for (const page of resumed.stdout.trim().split('\n').slice(0, -1).map(line => JSON.parse(line))) {
      expect(page.scanned).toBeLessThanOrEqual(5);
      expect(page.deleted).toBeLessThanOrEqual(5);
    }
    expect(rows()).toEqual(before.filter((_, index) => index % 10 === 0));
    expect(summary(run('--delete', '--limit', '5'))).toMatchObject({ complete: true, deleted: 0 });
  });

  it.each(['0', '-1', '101', '1.5', 'invalid', 'NaN', 'Infinity', ''])(
    'rejects invalid --limit %j before deleting or advancing state', (limit) => {
      const before = rows();
      const state = join(directory, 'invalid-limit.json');
      summary(run('--delete', '--max-pages', '1', '--limit', '1', '--state-file', state));
      const checkpoint = readFileSync(state, 'utf8');
      const result = run('--delete', `--limit=${limit}`, '--state-file', state);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('limit');
      expect(result.stdout).toBe('');
      expect(readFileSync(state, 'utf8')).toBe(checkpoint);
      expect(rows()).toEqual(before);
    },
  );

  it('rejects reuse of preview state for deletion and of state for another policy', () => {
    const state = join(directory, 'preview.json');
    summary(run('--max-pages', '1', '--state-file', state));
    const checkpoint = readFileSync(state, 'utf8');
    for (const args of [['--delete'], ['--retention-days', '7']]) {
      const result = run('--state-file', state, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('different source, policy, or mode');
      expect(readFileSync(state, 'utf8')).toBe(checkpoint);
      expect(rows()).toHaveLength(215);
    }
  });

  it('previews a D1 database read-only through the Cloudflare query API', () => {
    const before = rows();
    const stub = join(directory, 'd1-fetch-stub.mjs');
    const log = join(directory, 'd1-requests.jsonl');
    writeFileSync(stub, d1FetchStub);
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', stub, script,
      '--d1-database-id', 'db/1', '--workspace-id', 'fixture', '--limit', '50'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: 'dummy-token', CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
        D1_STUB_DATABASE: database, D1_STUB_LOG: log },
    });
    expect(summary(result)).toMatchObject({ dry_run: true, complete: true, scanned: 215, eligible: 193, deleted: 0 });
    expect(rows()).toEqual(before);
    const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).toMatchObject({
        url: 'https://api.cloudflare.com/client/v4/accounts/dummy-account/d1/database/db%2F1/query',
        method: 'POST', authorization: 'Bearer dummy-token',
      });
      expect(request.sql).toMatch(/^\s*(SELECT|WITH)\b/i);
      expect(Array.isArray(request.params)).toBe(true);
    }
  });

  it('preserves the saved cursor and every row when deletion cannot verify history', () => {
    const state = join(directory, 'deletion.json');
    summary(run('--delete', '--max-pages', '1', '--state-file', state));
    const checkpoint = readFileSync(state, 'utf8');
    const before = rows();
    handle.sqlite.exec('DROP INDEX idx_messages_agent');
    const result = run('--delete', '--state-file', state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires migration');
    expect(readFileSync(state, 'utf8')).toBe(checkpoint);
    expect(rows()).toEqual(before);
  });
});

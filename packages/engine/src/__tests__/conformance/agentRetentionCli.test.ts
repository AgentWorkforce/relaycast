import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';

const script = fileURLToPath(new URL('../../../../../scripts/retain-agents.mts', import.meta.url));

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

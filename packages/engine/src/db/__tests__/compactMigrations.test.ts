import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { planMigrations } from '../migrationPlan.js';

const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
const replacement = '0050_compact_maintenance_indexes.sql';
const older = ['0048_bounded_maintenance.sql', '0049_redrive_review_hardening.sql'];
const metadata: unknown = JSON.parse(readFileSync(directory + 'supersessions.json', 'utf8'));
const ddl = (name: string) => readFileSync(directory + name, 'utf8');
const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

/** Build the deployed pre-0048 shape with live and terminal rows, no remote data. */
function fixture(count = 20) {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  const db = handle.sqlite;
  db.exec('CREATE TABLE _engine_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const name of files.filter(name => name < older[0]!)) {
    db.exec(ddl(name));
    db.prepare('INSERT INTO _engine_migrations VALUES (?,0)').run(name);
  }
  db.exec(`INSERT INTO workspaces(id,name,api_key_hash) VALUES ('workspace11','fixture','key');
    INSERT INTO nodes(id,workspace_id,name,token_hash) VALUES ('node0000011','workspace11','node','node-key');
    INSERT INTO agents(id,workspace_id,name,token_hash) VALUES ('agent0000000000000','workspace11','agent','agent-key');
    INSERT INTO channels(id,workspace_id,name) VALUES ('channel','workspace11','general');`);
  const message = db.prepare("INSERT INTO messages(id,workspace_id,channel_id,agent_id,body) VALUES (?,'workspace11','channel','agent0000000000000','preserve me')");
  const delivery = db.prepare(`INSERT INTO deliveries(id,workspace_id,message_id,agent_id,status,seq,route_node_id,route_node_kind,expires_at)
    VALUES (?,'workspace11',?,'agent0000000000000',?,?,'node0000011','ws',1788000000)`);
  db.transaction(() => {
    for (let n = 1; n <= count; n++) {
      const id = String(n).padStart(19, '0');
      message.run(id);
      delivery.run('d_' + id + '_' + 'agent0000000000000', id, n % 2 ? 'queued' : 'dead_lettered', n);
    }
  })();
  return handle;
}

/** Compare durable rows/constraints, excluding the intentionally different journal. */
function snapshot(handle: SqliteDbHandle) {
  const tables = handle.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_engine_migrations','maintenance_cursors') ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => {
    const rows = handle.sqlite.prepare(`SELECT * FROM "${name}"`).all().map(row => JSON.stringify(row)).sort();
    return [name, rows.length, createHash('sha256').update(JSON.stringify(rows)).digest('hex')];
  });
}

describe('compact maintenance migration path', () => {
  it('boots an empty database without applying superseded SQL', () => {
    const handle = getSqliteDb(':memory:');
    handles.push(handle);
    expect(runMigrations(handle).applied).toEqual(files.filter(name => !older.includes(name)));
    expect(runMigrations(handle).applied).toEqual([]);
    expect(handle.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([[], [older[0]!], [older[1]!], older].map(already => ({ already })))('preserves every row and converges from $already', ({ already }) => {
    const handle = fixture();
    for (const name of already) {
      handle.sqlite.exec(ddl(name));
      handle.sqlite.prepare('INSERT INTO _engine_migrations VALUES (?,0)').run(name);
    }
    const before = snapshot(handle);
    expect(runMigrations(handle).applied).toEqual([replacement]);
    expect(snapshot(handle)).toEqual(before);
    expect(handle.sqlite.pragma('foreign_key_check')).toEqual([]);
    const retained = handle.sqlite.prepare("SELECT name FROM _engine_migrations WHERE name IN (?,?) ORDER BY name").all(...older);
    expect(retained).toEqual([...already].sort().map(name => ({ name })));
    expect(runMigrations(handle).applied).toEqual([]);
    const indexes = handle.sqlite.pragma('index_list(deliveries)') as { name: string; unique: number }[];
    expect(indexes.find(index => index.name === 'deliveries_message_agent_unique')?.unique).toBe(1);
    expect(indexes.find(index => index.name === 'deliveries_agent_seq_unique')?.unique).toBe(1);
    expect(indexes.find(index => index.name === 'idx_deliveries_id_lookup')?.unique).toBe(1);
    expect(indexes.some(index => index.name === 'idx_deliveries_initial_due')).toBe(false);
    const lookup = JSON.stringify(handle.sqlite.prepare('EXPLAIN QUERY PLAN SELECT id FROM deliveries WHERE message_id = ?').all('0000000000000000001'));
    expect(lookup).toContain('deliveries_message_agent_unique');
    expect(lookup).not.toContain('SCAN deliveries');
  });

  it('gives the identical schema through legacy and compact paths', () => {
    const legacy = fixture();
    const compact = fixture();
    for (const name of [...older, replacement]) legacy.sqlite.exec(ddl(name));
    compact.sqlite.exec(ddl(replacement));
    const schema = (handle: SqliteDbHandle) => handle.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    expect(schema(compact)).toEqual(schema(legacy));
  });

  it('reduces peak allocation without deleting data or relying on VACUUM', () => {
    const legacy = fixture(10_000);
    const compact = fixture(10_000);
    const before = snapshot(compact);
    const size = (handle: SqliteDbHandle) => Number(handle.sqlite.pragma('page_count', { simple: true })) * Number(handle.sqlite.pragma('page_size', { simple: true }));
    const baseline = size(compact);
    for (const name of older) legacy.sqlite.exec(ddl(name));
    const legacyGrowth = size(legacy) - baseline;
    let peak = baseline;
    compact.sqlite.exec('BEGIN');
    for (const statement of ddl(replacement).replace(/^--.*$/gm, '').split(';').filter(part => part.trim())) {
      compact.sqlite.exec(statement);
      peak = Math.max(peak, size(compact));
    }
    compact.sqlite.exec('COMMIT');
    expect(legacyGrowth).toBeGreaterThan(0);
    expect(peak - baseline).toBeLessThan(legacyGrowth * 0.6);
    expect(snapshot(compact)).toEqual(before);
  }, 30_000);

  it('fails closed when the replacement is missing or metadata points backwards', () => {
    expect(() => planMigrations(files.filter(name => name !== replacement), new Set(), metadata)).toThrow('Invalid migration supersession');
    expect(() => planMigrations(files, new Set(), { [replacement]: older[0] })).toThrow();
    expect(() => planMigrations(files, new Set(), {})).toThrow();
    expect(() => planMigrations(files, new Set(), { '../unsafe.sql': replacement })).toThrow();
  });
});

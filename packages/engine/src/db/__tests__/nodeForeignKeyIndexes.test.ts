import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';

const migration = readFileSync(new URL('../migrations/0051_node_foreign_key_indexes.sql', import.meta.url), 'utf8');
const keys = [
  ['deliveries', 'location_node_id', 'idx_deliveries_location_node_fk'],
  ['deliveries', 'route_node_id', 'idx_deliveries_route_node_fk'],
  ['agents', 'location_node_id', 'idx_agents_location_node_fk'],
  ['agents', 'origin_node_id', 'idx_agents_origin_node_fk'],
  ['agent_node_bindings', 'node_id', 'idx_agent_node_bindings_node_fk'],
  ['node_providers', 'node_id', 'idx_node_providers_node_fk'],
] as const;
const handles: SqliteDbHandle[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.sqlite.close(); });

function fixture(history = 10_000) {
  const handle = getSqliteDb(':memory:');
  handles.push(handle);
  runMigrations(handle);
  const db = handle.sqlite;
  db.exec(`
    INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','test','key'), ('other','other','other-key');
    INSERT INTO nodes(id,workspace_id,name,token_hash) VALUES
      ('target','ws','target','target-key'), ('unrelated','other','unrelated','unrelated-key'),
      ('empty','ws','empty','empty-key');
    INSERT INTO channels(id,workspace_id,name) VALUES ('channel','ws','general');
  `);
  const agent = db.prepare(`INSERT INTO agents(id,workspace_id,name,token_hash,location_node_id,origin_node_id)
    VALUES (?,?,?,?,?,?)`);
  const message = db.prepare(`INSERT INTO messages(id,workspace_id,channel_id,agent_id,body)
    VALUES (?,'ws','channel',?,'retained')`);
  const delivery = db.prepare(`INSERT INTO deliveries(id,workspace_id,message_id,agent_id,status,seq,location_node_id,route_node_id)
    VALUES (?,?,?,?,'acked',1,?,?)`);
  const binding = db.prepare(`INSERT INTO agent_node_bindings(id,workspace_id,agent_id,node_id,status)
    VALUES (?,?,?,?,'inactive')`);
  const provider = db.prepare(`INSERT INTO node_providers(id,workspace_id,node_id,name,instance_id)
    VALUES (?,?,?,?,?)`);
  db.transaction(() => {
    for (let n = 0; n <= history; n++) {
      const id = String(n);
      const workspace = n === 0 ? 'ws' : 'other';
      const node = n === 0 ? 'target' : 'unrelated';
      // Cover NULL history as well as references to another tenant's node.
      const nullableNode = n > 0 && n % 2 === 0 ? null : node;
      agent.run(id, workspace, id, id, nullableNode, nullableNode);
      message.run(id, id);
      delivery.run(id, workspace, id, id, nullableNode, nullableNode);
      binding.run(id, workspace, id, node);
      provider.run(id, workspace, node, id, id);
    }
  })();
  return db;
}

describe('node deletion foreign-key work', () => {
  it('visits only matching child rows instead of retained history, including empty-node probes', () => {
    const db = fixture();
    // Replay the same probe before and after the additive migration. These are
    // SQLite's child-key equality probes for REFERENCES nodes(id), with a
    // non-deterministic predicate recording every candidate row considered.
    // No elapsed-time assertion, forced index, or result-count proxy.
    for (const [, , index] of keys) db.exec(`DROP INDEX ${index}`);
    let visits = 0;
    db.function('record_fk_read', () => { visits++; return 1; });
    const probe = (table: string, column: string, node: string) => {
      visits = 0;
      const rows = db.prepare(`SELECT rowid FROM ${table} WHERE record_fk_read() = 1 AND ${column} = ?`).all(node);
      return { visits, rows };
    };
    for (const column of ['location_node_id', 'route_node_id']) {
      expect(probe('deliveries', column, 'target')).toMatchObject({ visits: 10_001 });
      expect(probe('deliveries', column, 'empty')).toEqual({ visits: 10_001, rows: [] });
    }
    db.exec(migration);
    for (const [table, column] of keys) {
      const result = probe(table, column, 'target');
      expect(result.visits, `${table}.${column}`).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(probe(table, column, 'empty')).toEqual({ visits: 0, rows: [] });
    }
    // A second application must be safe, including for adapters that retry DDL.
    db.exec(migration);
  });

  it('uses child-key seeks in the real DELETE and preserves SET NULL/CASCADE semantics', () => {
    const db = fixture();
    db.exec('ANALYZE');
    const statement = 'DELETE FROM nodes WHERE workspace_id = ? AND id = ?';
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + statement).all('ws', 'target') as { detail: string }[];
    for (const [table, , index] of keys) {
      expect(plan.some(row => row.detail.includes(index)), `${table} FK seek`).toBe(true);
      expect(plan.some(row => row.detail.startsWith(`SCAN ${table}`)), `${table} scan`).toBe(false);
    }
    expect(db.prepare(statement).run('ws', 'target').changes).toBe(1);
    expect(db.prepare("SELECT location_node_id, route_node_id FROM deliveries WHERE id = '0'").get())
      .toEqual({ location_node_id: null, route_node_id: null });
    expect(db.prepare("SELECT location_node_id, origin_node_id FROM agents WHERE id = '0'").get())
      .toEqual({ location_node_id: null, origin_node_id: null });
    for (const table of ['agent_node_bindings', 'node_providers']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE node_id = 'target'`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE node_id = 'unrelated'`).get()).toEqual({ n: 10_000 });
    }
    expect(db.prepare("SELECT location_node_id, route_node_id FROM deliveries WHERE id = '1'").get())
      .toEqual({ location_node_id: 'unrelated', route_node_id: 'unrelated' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 10_001 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

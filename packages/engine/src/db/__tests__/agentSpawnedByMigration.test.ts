import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';

it('adds agents.spawned_by additively, leaving existing agents unowned', () => {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const handle = getSqliteDb(':memory:');
  const db = handle.sqlite;
  try {
    db.exec('CREATE TABLE _engine_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < '0062').sort()) {
      db.exec(readFileSync(directory + name, 'utf8'));
      db.prepare('INSERT INTO _engine_migrations VALUES (?,0)').run(name);
    }
    db.exec(`INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','fixture','key');
      INSERT INTO agents(id,workspace_id,name,token_hash) VALUES ('lead','ws','lead','lead-token');`);
    const columns = db.pragma('table_info(agents)') as { name: string }[];
    const rows = db.prepare('SELECT * FROM agents').all();
    const fks = db.pragma('foreign_key_list(agents)');

    expect(runMigrations(handle).applied).toEqual(['0062_agent_spawned_by.sql']);
    const after = db.pragma('table_info(agents)') as { name: string; type: string; notnull: number; dflt_value: unknown }[];
    expect(after.slice(0, columns.length)).toEqual(columns);
    expect(after.slice(columns.length)).toEqual([
      expect.objectContaining({ name: 'spawned_by', type: 'TEXT', notnull: 0, dflt_value: null }),
    ]);
    expect(db.pragma('foreign_key_list(agents)')).toEqual(fks);
    expect(db.prepare(`SELECT ${columns.map(c => c.name).join(',')} FROM agents`).all()).toEqual(rows);
    expect(db.prepare('SELECT spawned_by FROM agents').get()).toEqual({ spawned_by: null });
    expect(runMigrations(handle).applied).toEqual([]);
  } finally { db.close(); }
});

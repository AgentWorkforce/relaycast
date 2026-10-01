import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';

it('upgrades existing actions and results additively, preserving rows and every original column and constraint', () => {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const handle = getSqliteDb(':memory:');
  const db = handle.sqlite;
  try {
    db.exec('CREATE TABLE _engine_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const name of readdirSync(directory).filter(name => name.endsWith('.sql') && name < '0060').sort()) {
      db.exec(readFileSync(directory + name, 'utf8'));
      db.prepare('INSERT INTO _engine_migrations VALUES (?,0)').run(name);
    }
    db.exec(`INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','fixture','key');
      INSERT INTO actions(id,workspace_id,name,description) VALUES ('act','ws','echo','existing short action');
      INSERT INTO action_invocations(id,workspace_id,action_id,action_name,status,output,completed_at)
        VALUES ('inv','ws','act','echo','completed','{"answer":42}',1000);`);
    const tables = ['actions', 'action_invocations'];
    const before = tables.map(name => ({ name,
      columns: db.pragma(`table_info(${name})`) as { name: string }[],
      rows: db.prepare(`SELECT * FROM ${name}`).all(),
      fks: db.pragma(`foreign_key_list(${name})`),
    }));
    expect(runMigrations(handle).applied).toEqual([
      '0060_durable_task_invocations.sql',
      '0061_messages_workspace_length_id_index.sql',
    ]);
    for (const table of before) {
      const columns = db.pragma(`table_info(${table.name})`) as { name: string }[];
      expect(columns.slice(0, table.columns.length)).toEqual(table.columns);
      expect(columns).toHaveLength(table.columns.length + 1);
      expect(db.pragma(`foreign_key_list(${table.name})`)).toEqual(table.fks);
      expect(db.prepare(`SELECT ${table.columns.map(c => c.name).join(',')} FROM ${table.name}`).all()).toEqual(table.rows);
    }
    expect(db.prepare('SELECT execution_mode FROM actions').get()).toEqual({ execution_mode: 'short' });
    expect(db.prepare('SELECT task_state FROM action_invocations').get()).toEqual({ task_state: null });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(handle).applied).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_action_invocations_task_deadline'").get()).toBeDefined();
  } finally { db.close(); }
});

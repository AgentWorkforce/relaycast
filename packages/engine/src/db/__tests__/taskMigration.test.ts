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
      '0062_direct_dm_idempotency.sql',
      '0063_node_rotation_recovery.sql',
      '0064_action_invocations_status_dispatched_index.sql',
      '0065_action_invocations_task_deadline_any_status.sql',
      '0066_action_invocations_status_sweep_ranges.sql',
      '0067_webhook_delivery_reliability.sql',
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
    // The sweeps bind statuses as parameters, which a partial index on literal
    // statuses cannot serve; production scanned the whole table (D1 overload).
    const plan = (query: string, ...params: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) as { detail: string }[]).map(row => row.detail).join(' | ');
    // Each sweep must seek a range on its own timestamp, not merely the status prefix.
    expect(plan('SELECT * FROM action_invocations WHERE status IN (?) AND dispatched_at <= ?', 'dispatched', 0))
      .toMatch(/idx_action_invocations_status_dispatched \(status=\? AND dispatched_at<\?\)/);
    expect(plan('SELECT * FROM action_invocations WHERE status = ? AND retry_after_at <= ?', 'pending', 0))
      .toMatch(/idx_action_invocations_status_retry_after \(status=\? AND retry_after_at<\?\)/);
    expect(plan("UPDATE action_invocations SET status = 'failed' WHERE task_state IS NOT NULL AND status IN (?, ?, ?) AND json_extract(task_state, '$.deadline') <= ?", 'pending', 'dispatched', 'running', '2026-01-01'))
      .toMatch(/idx_action_invocations_status_task_deadline \(status=\? AND <expr><\?\)/);
  } finally { db.close(); }
});

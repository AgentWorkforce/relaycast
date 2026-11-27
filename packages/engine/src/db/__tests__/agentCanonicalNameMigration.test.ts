import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';
import { registerAgent } from '../../engine/agent.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

describe('0089_agent_canonical_name migration', () => {
  it('migrates pre-0089 legacy case-duplicate agents safely without data loss and still blocks new variants', async () => {
    const handle = getSqliteDb(':memory:');
    try {
      const sqlFiles = readdirSync(migrationsDir)
        .filter((file) => file.endsWith('.sql') && file < '0089_agent_canonical_name.sql')
        .sort();
      handle.sqlite.exec(`CREATE TABLE IF NOT EXISTS _engine_migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`);
      for (const file of sqlFiles) {
        if (file === '0048_bounded_maintenance.sql' || file === '0049_redrive_review_hardening.sql') continue;
        handle.sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
        handle.sqlite.prepare('INSERT INTO _engine_migrations (name) VALUES (?)').run(file);
      }

      // Seed a legacy workspace that already had two case-colliding active agents
      // plus one released tombstone before migration 0089.
      handle.sqlite.exec(`
        INSERT INTO workspaces(id, name, api_key_hash) VALUES ('ws_legacy', 'legacy', 'hash_legacy');
        INSERT INTO agents(id, workspace_id, name, handle, token_hash, status, created_at) VALUES
          ('a_first', 'ws_legacy', 'alpha1', '@alpha1', 'tok_1', 'active', 100),
          ('a_second', 'ws_legacy', 'ALPHA1', '@ALPHA1', 'tok_2', 'active', 200),
          ('a_gone', 'ws_legacy', 'beta1#released-a_gone', '@beta1#released-a_gone', 'tok_3', 'released', 50);
      `);

      // Migration 0089 succeeds despite the pre-existing case duplicates.
      expect(runMigrations(handle).applied).toEqual(['0089_agent_canonical_name.sql']);

      const rows = handle.sqlite
        .prepare('SELECT id, name, canonical_name, status FROM agents ORDER BY id')
        .all() as Array<{ id: string; name: string; canonical_name: string | null; status: string }>;
      expect(rows).toEqual([
        { id: 'a_first', name: 'alpha1', canonical_name: 'alpha1', status: 'active' },
        { id: 'a_gone', name: 'beta1#released-a_gone', canonical_name: null, status: 'released' },
        { id: 'a_second', name: 'ALPHA1', canonical_name: null, status: 'active' },
      ]);

      // Even if the first legacy row is released, the surviving legacy row with
      // canonical_name = NULL still prevents registering a new case variant.
      handle.sqlite
        .prepare("UPDATE agents SET name = 'alpha1#released-a_first', canonical_name = NULL, status = 'released' WHERE id = 'a_first'")
        .run();

      await expect(
        registerAgent(handle.db, 'ws_legacy', { name: 'Alpha1' }),
      ).rejects.toMatchObject({ code: 'agent_already_exists', status: 409 });

      // Once both legacy rows are released, `Alpha1` can register cleanly.
      handle.sqlite
        .prepare("UPDATE agents SET name = 'ALPHA1#released-a_second', canonical_name = NULL, status = 'released' WHERE id = 'a_second'")
        .run();
      const fresh = await registerAgent(handle.db, 'ws_legacy', { name: 'Alpha1' });
      expect(fresh.name).toBe('Alpha1');
    } finally {
      handle.sqlite.close();
    }
  });
});

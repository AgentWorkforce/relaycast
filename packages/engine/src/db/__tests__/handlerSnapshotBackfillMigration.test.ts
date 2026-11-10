import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';
import { completeInvocation } from '../../engine/action.js';

const superseded = new Set([
  '0048_bounded_maintenance.sql',
  '0049_redrive_review_hardening.sql',
]);

describe('registered invocation handler snapshot backfill', () => {
  it('restores legacy completion authority without granting it to a different agent or node-owned action', async () => {
    const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const handle = getSqliteDb(':memory:');
    try {
      handle.sqlite.exec('CREATE TABLE _engine_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      for (const name of readdirSync(directory)
        .filter((candidate) => candidate.endsWith('.sql') && candidate < '0084')
        .filter((candidate) => !superseded.has(candidate))
        .sort()) {
        handle.sqlite.exec(readFileSync(directory + name, 'utf8'));
        handle.sqlite.prepare('INSERT INTO _engine_migrations VALUES (?,0)').run(name);
      }

      handle.sqlite.exec(`
        INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','fixture','workspace-key');
        INSERT INTO agents(id,workspace_id,name,token_hash) VALUES
          ('handler','ws','handler','handler-token'),
          ('other','ws','other','other-token');
        INSERT INTO nodes(id,workspace_id,name,token_hash)
          VALUES ('node','ws','node','node-token');
        INSERT INTO actions(id,workspace_id,name,description,handler_agent_id)
          VALUES ('agent-action','ws','summarize','agent action','handler');
        INSERT INTO actions(id,workspace_id,name,description,handler_node_id)
          VALUES ('node-action','ws','node-work','node action','node');
        INSERT INTO action_invocations(
          id,workspace_id,action_id,action_name,invocation_origin,status,dispatched_node_id,
          handler_agent_id,handler_node_id
        ) VALUES
          ('agent-invocation','ws','agent-action','summarize','registered_action','dispatched','node',NULL,NULL),
          ('node-invocation','ws','node-action','node-work','registered_action','dispatched','node',NULL,NULL);
      `);

      expect(runMigrations(handle).applied).toEqual(['0084_strict_spawn_dispatch_generation.sql']);
      expect(handle.sqlite.prepare(`
        SELECT id, handler_agent_id, handler_node_id, spawn_dispatch_generation
        FROM action_invocations ORDER BY id
      `).all()).toEqual([
        {
          id: 'agent-invocation',
          handler_agent_id: 'handler',
          handler_node_id: null,
          spawn_dispatch_generation: 0,
        },
        {
          id: 'node-invocation',
          handler_agent_id: null,
          handler_node_id: 'node',
          spawn_dispatch_generation: 0,
        },
      ]);

      await expect(completeInvocation(handle.db, 'ws', 'summarize', 'agent-invocation', {
        caller_agent_id: 'other',
        output: { summary: 'forged' },
      })).rejects.toMatchObject({ code: 'forbidden', status: 403 });

      await expect(completeInvocation(handle.db, 'ws', 'summarize', 'agent-invocation', {
        caller_agent_id: 'handler',
        output: { summary: 'done' },
      })).resolves.toMatchObject({ status: 'completed', output: { summary: 'done' } });

      await expect(completeInvocation(handle.db, 'ws', 'node-work', 'node-invocation', {
        caller_agent_id: 'other',
        output: { forged: true },
      })).rejects.toMatchObject({ code: 'node_owned_invocation', status: 403 });
    } finally {
      handle.sqlite.close();
    }
  });
});

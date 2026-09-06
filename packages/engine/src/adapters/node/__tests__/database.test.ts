import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const handles: Database.Database[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.close(); } catch { /* already closed */ }
  }
});

describe('delivery sequence high-water migration', () => {
  it('repairs the full active queue above a collision-free base in FIFO order', () => {
    const sqlite = new Database(':memory:');
    handles.push(sqlite);
    sqlite.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        delivery_ack_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(workspace_id, agent_id, seq)
      );

      INSERT INTO agents (id, workspace_id, delivery_ack_seq) VALUES
        ('agent_affected', 'ws_1', 5),
        ('agent_healthy', 'ws_1', 2),
        ('agent_fully_pruned', 'ws_1', 7);

      INSERT INTO deliveries (id, workspace_id, agent_id, status, seq, created_at) VALUES
        ('terminal_collision', 'ws_1', 'agent_affected', 'acked', 10, 50),
        ('hidden_older', 'ws_1', 'agent_affected', 'queued', 4, 100),
        ('visible_newer', 'ws_1', 'agent_affected', 'delivered', 8, 200),
        ('healthy_active', 'ws_1', 'agent_healthy', 'queued', 4, 100);
    `);

    const migration = readFileSync(
      new URL('../../../db/migrations/0029_delivery_sequence_high_water.sql', import.meta.url),
      'utf8',
    );
    sqlite.exec(migration);

    const repaired = sqlite.prepare(`
      SELECT id, seq
      FROM deliveries
      WHERE agent_id = 'agent_affected' AND status IN ('queued', 'delivered')
      ORDER BY created_at, id
    `).all();
    expect(repaired).toEqual([
      { id: 'hidden_older', seq: 11 },
      { id: 'visible_newer', seq: 12 },
    ]);
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_affected'`).get())
      .toEqual({ delivery_seq: 12 });
    expect(sqlite.prepare(`SELECT seq FROM deliveries WHERE id = 'healthy_active'`).get())
      .toEqual({ seq: 4 });
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_healthy'`).get())
      .toEqual({ delivery_seq: 4 });
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_fully_pruned'`).get())
      .toEqual({ delivery_seq: 7 });

    sqlite.exec(`
      INSERT INTO deliveries (id, workspace_id, agent_id, status, seq, created_at)
      SELECT 'next_delivery', workspace_id, id, 'queued', delivery_seq + 1, 300
      FROM agents
      WHERE id = 'agent_affected';
    `);
    expect(sqlite.prepare(`SELECT seq FROM deliveries WHERE id = 'next_delivery'`).get())
      .toEqual({ seq: 13 });
    expect(sqlite.prepare(`SELECT delivery_seq FROM agents WHERE id = 'agent_affected'`).get())
      .toEqual({ delivery_seq: 13 });

    sqlite.exec(`
      INSERT INTO deliveries (id, workspace_id, agent_id, status, seq, created_at)
      SELECT 'after_full_prune', workspace_id, id, 'queued', delivery_seq + 1, 300
      FROM agents
      WHERE id = 'agent_fully_pruned';
    `);
    expect(sqlite.prepare(`SELECT seq FROM deliveries WHERE id = 'after_full_prune'`).get())
      .toEqual({ seq: 8 });
  });
});
describe('action invocation provider migration', () => {
  it('backfills action-owned and legacy node dispatches without claiming undispatched work', () => {
    const sqlite = new Database(':memory:');
    handles.push(sqlite);
    sqlite.exec(`
      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        handler_provider TEXT DEFAULT NULL,
        handler_agent_id TEXT DEFAULT NULL,
        handler_node_id TEXT DEFAULT NULL
      );
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        provider_name TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE node_providers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        name TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE action_invocations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        action_id TEXT DEFAULT NULL,
        action_name TEXT NOT NULL,
        input TEXT NOT NULL DEFAULT '{}',
        dispatched_node_id TEXT DEFAULT NULL
      );
      INSERT INTO agents (id, workspace_id, name, provider_name) VALUES
        ('agent_ruby', 'ws_1', 'ruby-worker', 'ruby'),
        ('agent_go', 'ws_1', 'go-worker', 'go');
      INSERT INTO actions (id, workspace_id, name, handler_provider, handler_agent_id, handler_node_id) VALUES
        ('action_named', 'ws_1', 'run-etl', 'python', NULL, 'node_a'),
        ('action_agent', 'ws_1', 'agent-task', NULL, 'agent_ruby', NULL),
        ('action_shadow', 'ws_1', 'spawn:codex', 'policy', NULL, 'node_a'),
        ('action_ambiguous', 'ws_1', 'spawn:claude', 'policy', NULL, 'node_a');
      INSERT INTO node_providers (id, workspace_id, node_id, name, capabilities) VALUES
        ('provider_default', 'ws_1', 'node_a', 'default', '[]'),
        ('provider_python', 'ws_1', 'node_a', 'python-capacity', '[{"name":"spawn:python","kind":"capacity"}]'),
        ('provider_claude', 'ws_1', 'node_a', 'claude-capacity', '[{"name":"spawn:claude","kind":"capacity"}]'),
        ('provider_legacy', 'ws_1', 'node_legacy', 'default', '[]');
      INSERT INTO action_invocations (id, workspace_id, action_id, action_name, input, dispatched_node_id) VALUES
        ('named_action', 'ws_1', 'action_named', 'run-etl', '{}', 'node_a'),
        ('agent_action', 'ws_1', 'action_agent', 'agent-task', '{}', 'node_a'),
        ('release_named', 'ws_1', NULL, 'release', '{"name":"go-worker"}', 'node_a'),
        ('shadow_spawn', 'ws_1', NULL, 'spawn', '{"cli":"codex"}', 'node_a'),
        ('ambiguous_spawn', 'ws_1', NULL, 'spawn', '{"cli":"claude"}', 'node_a'),
        ('native_capacity', 'ws_1', NULL, 'spawn', '{"cli":"python"}', 'node_a'),
        ('legacy_unknown', 'ws_1', NULL, 'spawn', '{}', 'node_legacy'),
        ('ambiguous_unknown', 'ws_1', NULL, 'spawn', '{}', 'node_a'),
        ('not_dispatched', 'ws_1', 'action_named', 'run-etl', '{}', NULL);
    `);

    const migration = readFileSync(
      new URL('../../../db/migrations/0030_action_invocation_provider.sql', import.meta.url),
      'utf8',
    );
    sqlite.exec(migration);

    expect(sqlite.prepare(`
      SELECT id, dispatched_provider
      FROM action_invocations
      ORDER BY id
    `).all()).toEqual([
      { id: 'agent_action', dispatched_provider: 'ruby' },
      { id: 'ambiguous_spawn', dispatched_provider: null },
      { id: 'ambiguous_unknown', dispatched_provider: null },
      { id: 'legacy_unknown', dispatched_provider: 'default' },
      { id: 'named_action', dispatched_provider: 'python' },
      { id: 'native_capacity', dispatched_provider: 'python-capacity' },
      { id: 'not_dispatched', dispatched_provider: null },
      { id: 'release_named', dispatched_provider: 'go' },
      { id: 'shadow_spawn', dispatched_provider: 'policy' },
    ]);
  });
});

describe('action invocation handler snapshot migration', () => {
  it('adds an immutable nullable handler identity without rewriting existing invocations', () => {
    const sqlite = new Database(':memory:');
    handles.push(sqlite);
    sqlite.exec(`
      CREATE TABLE action_invocations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        action_name TEXT NOT NULL
      );
      INSERT INTO action_invocations (id, workspace_id, action_name)
      VALUES ('inv_existing', 'ws_1', 'summarize');
    `);

    const migration = readFileSync(
      new URL('../../../db/migrations/0042_action_invocation_handler_snapshot.sql', import.meta.url),
      'utf8',
    );
    sqlite.exec(migration);

    expect(sqlite.prepare(`
      SELECT id, handler_agent_id, handler_node_id
      FROM action_invocations
    `).all()).toEqual([{
      id: 'inv_existing',
      handler_agent_id: null,
      handler_node_id: null,
    }]);
  });
});

describe('action invocation origin migration', () => {
  it('preserves registered provenance and fails ambiguous open invocations closed', () => {
    const sqlite = new Database(':memory:');
    handles.push(sqlite);
    sqlite.exec(`
      CREATE TABLE action_invocations (
        id TEXT PRIMARY KEY,
        action_id TEXT DEFAULT NULL,
        action_name TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT DEFAULT NULL,
        completed_at INTEGER DEFAULT NULL
      );
      INSERT INTO action_invocations (id, action_id, action_name, status) VALUES
        ('registered_release', 'action_release', 'release', 'dispatched'),
        ('legacy_open_release', NULL, 'release', 'pending'),
        ('legacy_completed_release', NULL, 'release', 'completed'),
        ('legacy_spawn', NULL, 'spawn', 'pending');
    `);

    const migration = readFileSync(
      new URL('../../../db/migrations/0046_action_invocation_origin.sql', import.meta.url),
      'utf8',
    );
    sqlite.exec(migration);

    expect(sqlite.prepare(`
      SELECT id, invocation_origin, status, error, completed_at IS NOT NULL AS completed
      FROM action_invocations
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'legacy_completed_release',
        invocation_origin: 'legacy_unknown',
        status: 'completed',
        error: null,
        completed: 0,
      },
      {
        id: 'legacy_open_release',
        invocation_origin: 'legacy_unknown',
        status: 'failed',
        error: 'invocation_origin_unavailable',
        completed: 1,
      },
      {
        id: 'legacy_spawn',
        invocation_origin: 'legacy_unknown',
        status: 'failed',
        error: 'invocation_origin_unavailable',
        completed: 1,
      },
      {
        id: 'registered_release',
        invocation_origin: 'registered_action',
        status: 'dispatched',
        error: null,
        completed: 0,
      },
    ]);

    expect(() => sqlite.exec(`
      INSERT INTO action_invocations
        (id, action_name, status, invocation_origin)
      VALUES ('invalid_origin', 'release', 'pending', 'invented');
    `)).toThrow();
  });
});

describe('session_ref lookup migration', () => {
  it('backfills the indexed key and durable payload-free session ledger', () => {
    const sqlite = new Database(':memory:');
    handles.push(sqlite);
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        token_hash TEXT
      );
      INSERT INTO workspaces (id) VALUES ('ws_1');
      INSERT INTO webhooks (id, token_hash) VALUES
        ('hook_open', NULL),
        ('hook_protected', 'hashed-secret');
      INSERT INTO messages (id, workspace_id, metadata, created_at) VALUES
        ('100', 'ws_1', '{"session_ref":"session-1"}', 10),
        ('200', 'ws_1', '{"session_ref":"session-1"}', 20),
        ('300', 'ws_1', '{"session_ref":42}', 30),
        ('400', 'ws_1', '{}', 40),
        ('500', 'ws_1', '{"session_ref":"emoji-😀"}', 50),
        ('600', 'ws_1', '{"session_ref":"untrusted","__relaycast_origin":"inbound_webhook","__relaycast_webhook_id":"hook_open"}', 60),
        ('700', 'ws_1', '{"session_ref":"trusted","__relaycast_origin":"inbound_webhook","__relaycast_webhook_id":"hook_protected"}', 70),
        ('750', 'ws_1', '{"session_ref":"relayfile-session","__relaycast_origin":"inbound_webhook","__relaycast_webhook_id":"relayfile:slack"}', 75);
    `);
    sqlite.prepare(
      'INSERT INTO messages (id, workspace_id, metadata, created_at) VALUES (?, ?, ?, ?)',
    ).run('800', 'ws_1', JSON.stringify({ session_ref: '😀'.repeat(256) }), 80);

    const migration = readFileSync(
      new URL('../../../db/migrations/0038_session_ref_lookup.sql', import.meta.url),
      'utf8',
    );
    sqlite.exec(migration);

    expect(sqlite.prepare(`
      SELECT id, session_ref
      FROM messages
      ORDER BY id
    `).all()).toEqual([
      { id: '100', session_ref: 'session-1' },
      { id: '200', session_ref: 'session-1' },
      { id: '300', session_ref: null },
      { id: '400', session_ref: null },
      { id: '500', session_ref: 'emoji-😀' },
      { id: '600', session_ref: null },
      { id: '700', session_ref: 'trusted' },
      { id: '750', session_ref: 'relayfile-session' },
      { id: '800', session_ref: null },
    ]);
    expect(sqlite.prepare(`
      SELECT workspace_id, session_ref, first_message_at, last_message_at, start_is_known
      FROM message_sessions
      ORDER BY session_ref
    `).all()).toEqual([
      {
        workspace_id: 'ws_1',
        session_ref: 'emoji-😀',
        first_message_at: 50,
        last_message_at: 50,
        start_is_known: 0,
      },
      {
        workspace_id: 'ws_1',
        session_ref: 'relayfile-session',
        first_message_at: 75,
        last_message_at: 75,
        start_is_known: 0,
      },
      {
        workspace_id: 'ws_1',
        session_ref: 'session-1',
        first_message_at: 10,
        last_message_at: 20,
        start_is_known: 0,
      },
      {
        workspace_id: 'ws_1',
        session_ref: 'trusted',
        first_message_at: 70,
        last_message_at: 70,
        start_is_known: 0,
      },
    ]);

    const indexedPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM messages
      WHERE workspace_id = ? AND session_ref = ?
      ORDER BY length(id), id
      LIMIT 10
    `).all('ws_1', 'session-1') as Array<{ detail: string }>;
    expect(indexedPlan.map((row) => row.detail).join('\n')).toContain(
      'idx_messages_workspace_session',
    );
  });
});

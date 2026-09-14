// Real local workerd/D1 coverage for the portable task CAS and additive migration.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { drizzle } from 'drizzle-orm/d1';
import { getSqliteDb, runMigrations } from '../dist/adapters/node/database.js';
import * as schema from '../dist/db/schema.js';
import { acceptTaskInvocation, completeTaskInvocation, createTaskState, expireTaskInvocations } from '../dist/engine/taskInvocation.js';
import { getInvocation } from '../dist/engine/action.js';

const sqlite = getSqliteDb(':memory:');
const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture") } }', compatibilityDate: '2026-05-11', d1Databases: ['DB'] });
try {
  runMigrations(sqlite);
  const d1 = await mf.getD1Database('DB');
  const db = drizzle(d1, { schema });
  const shadow = new Set(sqlite.sqlite.prepare('PRAGMA table_list').all().filter(row => row.type === 'shadow').map(row => row.name));
  const definitions = sqlite.sqlite.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,rowid").all();
  for (const row of definitions) {
    if (shadow.has(row.name) || row.name === 'idx_action_invocations_task_deadline') continue;
    // Build the previous schema, then exercise the actual migration against it.
    const ddl = row.sql.replace(", execution_mode TEXT NOT NULL DEFAULT 'short'", '').replace(', task_state TEXT', '');
    await d1.prepare(ddl).run();
  }
  await d1.prepare("INSERT INTO workspaces(id,name,api_key_hash) VALUES ('ws','fixture','fixture-key')").run();
  await d1.prepare("INSERT INTO nodes(id,workspace_id,name,token_hash) VALUES ('node','ws','fixture','fixture-node-key')").run();
  await d1.prepare("INSERT INTO actions(id,workspace_id,name,description) VALUES ('legacy','ws','echo','short')").run();
  const migration = readFileSync(new URL('../src/db/migrations/0060_durable_task_invocations.sql', import.meta.url), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)) await d1.prepare(statement).run();
  assert.equal((await d1.prepare("SELECT execution_mode FROM actions WHERE id='legacy'").first()).execution_mode, 'short');
  const state = createTaskState({ task_context: { run_id: 'run', step_id: 'step', dispatch_id: 'dispatch', timeout_ms: 120000 } });
  const seed = async id => db.insert(schema.actionInvocations).values({ id, workspaceId: 'ws', actionName: 'task.run', status: 'dispatched', dispatchedNodeId: 'node', dispatchedProvider: 'default', dispatchAttempts: 1, taskState: state });
  await seed('inv');
  const accept = { v: 1, id: 'accept', type: 'action.accept', invocation_id: 'inv', execution_id: 'inv/1', worker_generation: 'generation' };
  const accepted = await Promise.all([acceptTaskInvocation(db, 'ws', 'node', 'default', accept), acceptTaskInvocation(db, 'ws', 'node', 'default', accept)]);
  assert.equal(accepted.filter(receipt => receipt.newly_accepted).length, 1);
  assert.ok(accepted.every(receipt => receipt.status === 'running'));
  const final = { ...accept, id: 'result', type: 'action.result', final: true, output: { answer: 42 }, accounting: { tokens: 17 } };
  await completeTaskInvocation(db, 'ws', 'node', 'default', { ...final, final: false });
  assert.equal((await getInvocation(db, 'ws', 'task.run', 'inv')).status, 'running');
  await assert.rejects(completeTaskInvocation(db, 'ws', 'node', 'default', { ...final, execution_id: 'inv/0' }));
  await assert.rejects(completeTaskInvocation(db, 'ws', 'node', 'default', { ...final, worker_generation: 'stale' }));
  const results = await Promise.all([completeTaskInvocation(db, 'ws', 'node', 'default', final), completeTaskInvocation(db, 'ws', 'node', 'default', final)]);
  assert.equal(results.filter(value => value.completed).length, 1);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  // A fresh Drizzle handle retains no caller/provider object history.
  const reopened = drizzle(d1, { schema });
  const terminal = await getInvocation(reopened, 'ws', 'task.run', 'inv');
  assert.equal(terminal.status, 'completed');
  assert.deepEqual(terminal.output, { answer: 42 });
  assert.deepEqual(terminal.task_execution.accounting, { tokens: 17 });
  await assert.rejects(completeTaskInvocation(reopened, 'ws', 'node', 'default', { ...final, output: 'conflict' }));
  assert.deepEqual((await completeTaskInvocation(reopened, 'ws', 'node', 'default', final)).receipt, results[0].receipt);
  await seed('deadline');
  await acceptTaskInvocation(db, 'ws', 'node', 'default', { ...accept, invocation_id: 'deadline', execution_id: 'deadline/1' });
  await d1.prepare("UPDATE action_invocations SET task_state=json_set(task_state,'$.deadline','2000-01-01T00:00:00.000Z') WHERE id='deadline'").run();
  await expireTaskInvocations(db);
  assert.equal((await getInvocation(db, 'ws', 'task.run', 'deadline')).error, 'task_deadline_exceeded');
  console.log('PASS workerd-d1 task migration, concurrent accept/final CAS, interim, stale fences, immutable replay, fresh-handle readback, and deadline');
} finally {
  sqlite.sqlite.close();
  await mf.dispose();
}

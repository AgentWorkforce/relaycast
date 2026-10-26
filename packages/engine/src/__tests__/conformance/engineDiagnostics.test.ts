import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../engine.js';
import { configureEngineDiagnostics } from '../../lib/engineDiagnostics.js';
import type { EngineDb } from '../../ports/index.js';
import type { EngineOperationSample, EngineProgressSample } from '../../ports/diagnostics.js';
import { backfillMessageMentionFts } from '../../engine/inbox.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

describe('engine diagnostics', () => {
  let stack: TestStack;
  let operations: EngineOperationSample[];
  let progress: EngineProgressSample[];

  beforeEach(() => {
    stack = makeNodeStack();
    operations = [];
    progress = [];
  });
  afterEach(async () => {
    configureEngineDiagnostics(undefined);
    await stack.close();
  });

  const appWithDiagnostics = (overrides: { db?: EngineDb; captureException?: (err: unknown, ctx?: Record<string, unknown>) => void } = {}) =>
    createEngine({
      ...stack.runtime.deps,
      ...(overrides.db ? { db: overrides.db } : {}),
      telemetry: { capture: () => {}, captureException: overrides.captureException ?? (() => {}) },
      diagnostics: {
        operation: sample => { operations.push(sample); },
        progress: sample => { progress.push(sample); },
      },
    });

  it('labels inbox and delivery reads with their workspace', async () => {
    const ws = await createWorkspace(stack.app, 'diagnostics-labels');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'diag-agent');
    const app = appWithDiagnostics();
    const headers = { authorization: `Bearer ${agent.token}` };
    expect((await app.request('/v1/inbox', { headers })).status).toBe(200);
    expect((await app.request('/v1/deliveries?status=dead_lettered', { headers })).status).toBe(200);
    await stack.settle();
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'inbox.get', workspaceId: ws.workspaceId, outcome: 'ok' }),
      expect.objectContaining({ label: 'deliveries.list', workspaceId: ws.workspaceId, outcome: 'ok' }),
    ]));
  });

  it('reports a failed request with its workspace, caller, operation and route — never the raw path', async () => {
    const ws = await createWorkspace(stack.app, 'diagnostics-errors');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'diag-failing-agent');
    // Fail only the inbox's raw unread-count query; auth and everything else are real.
    const db = Object.create(stack.runtime.deps.db) as EngineDb & { all: unknown };
    db.all = () => Promise.reject(new Error('injected inbox failure'));
    const captureException = vi.fn();
    const app = appWithDiagnostics({ db, captureException });
    const response = await app.request('/v1/inbox', { headers: { authorization: `Bearer ${agent.token}` } });
    expect(response.status).toBe(500);
    await stack.settle();
    expect(captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspace_id: ws.workspaceId,
      agent_id: agent.agentId,
      engine_operation: 'inbox.get',
      route: '/v1/inbox',
    }));
    expect(operations).toContainEqual(expect.objectContaining({ label: 'inbox.get', outcome: 'error' }));
  });

  it('reports backfill progress through to completion', async () => {
    appWithDiagnostics(); // configures the module-level sink, as a host would
    const db = stack.runtime.deps.db;
    // A pending copy whose remaining range holds no rows: one call completes it.
    stack.runtime.handle.sqlite.prepare(
      "UPDATE maintenance_cursors SET cursor = '0/5' WHERE id = 'mention-fts-backfill'",
    ).run();
    await backfillMessageMentionFts(db);
    expect(progress.at(-1)).toMatchObject({ operation: 'backfill.mention_fts', phase: 'completed', remaining: 0 });
    expect(operations).toContainEqual(expect.objectContaining({ label: 'backfill.mention_fts', outcome: 'ok' }));
  });
});

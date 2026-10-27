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

  it('keeps the operation when a plain-object rejection is wrapped into an Error', async () => {
    const ws = await createWorkspace(stack.app, 'diagnostics-plain-rejection');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'diag-plain-rejection');
    // A database adapter that rejects with a non-Error object.
    const db = Object.create(stack.runtime.deps.db) as EngineDb & { all: unknown };
    db.all = () => Promise.reject({ message: 'adapter failure' });
    const captureException = vi.fn();
    const app = appWithDiagnostics({ db, captureException });
    const response = await app.request('/v1/inbox', { headers: { authorization: `Bearer ${agent.token}` } });
    expect(response.status).toBe(500);
    await stack.settle();
    expect(captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      engine_operation: 'inbox.get',
    }));
  });

  it('reports backfill progress through to completion', async () => {
    // Maintenance runs outside any app request: hosts configure the fallback sink.
    configureEngineDiagnostics({
      operation: sample => { operations.push(sample); },
      progress: sample => { progress.push(sample); },
    });
    const db = stack.runtime.deps.db;
    // A pending copy whose remaining range holds no rows: one call completes it.
    stack.runtime.handle.sqlite.prepare(
      "UPDATE maintenance_cursors SET cursor = '0/5' WHERE id = 'mention-fts-backfill'",
    ).run();
    await backfillMessageMentionFts(db);
    expect(progress.at(-1)).toMatchObject({ operation: 'backfill.mention_fts', phase: 'completed', remaining: 0 });
    expect(operations).toContainEqual(expect.objectContaining({ label: 'backfill.mention_fts', outcome: 'ok' }));
  });
  it('keeps two apps diagnostics apart, and an app without a sink silent', async () => {
    const ws = await createWorkspace(stack.app, 'diagnostics-two-apps');
    const agent = await registerAgent(stack.app, ws.workspaceKey, 'diag-two-apps');
    const other: EngineOperationSample[] = [];
    const appA = appWithDiagnostics();
    const appB = createEngine({ ...stack.runtime.deps, diagnostics: { operation: sample => { other.push(sample); } } });
    const plain = createEngine(stack.runtime.deps);
    const headers = { authorization: `Bearer ${agent.token}` };
    expect((await appA.request('/v1/inbox', { headers })).status).toBe(200);
    expect((await plain.request('/v1/inbox', { headers })).status).toBe(200);
    expect((await appB.request('/v1/deliveries', { headers })).status).toBe(200);
    await stack.settle();
    expect(operations.map(sample => sample.label)).toEqual(['inbox.get']);
    expect(other.map(sample => sample.label)).toEqual(['deliveries.list']);
  });
});

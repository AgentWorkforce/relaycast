import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureEngineDiagnostics,
  currentEngineOperation,
  engineOperationOf,
  reportEngineProgress,
  runWithEngineDiagnostics,
  withEngineOperation,
} from '../engineDiagnostics.js';

afterEach(() => configureEngineDiagnostics(undefined));

describe('withEngineOperation', () => {
  it('reports duration and outcome, and exposes the scope to statements it awaits', async () => {
    const operation = vi.fn();
    configureEngineDiagnostics({ operation });
    const seen: unknown[] = [];
    const result = await withEngineOperation('inbox.get', 'ws_1', async () => {
      await Promise.resolve();
      seen.push(currentEngineOperation());
      await new Promise(resolve => setTimeout(resolve, 1));
      seen.push(currentEngineOperation());
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual([{ label: 'inbox.get', workspaceId: 'ws_1' }, { label: 'inbox.get', workspaceId: 'ws_1' }]);
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({
      label: 'inbox.get', workspaceId: 'ws_1', outcome: 'ok', durationMs: expect.any(Number),
    }));
    expect(currentEngineOperation()).toBeUndefined();
  });

  it('lets the innermost operation win while it runs, then restores the outer one', async () => {
    const seen: unknown[] = [];
    await withEngineOperation('workspace.delete', undefined, async () => {
      await withEngineOperation('backfill.mention_fts', undefined, async () => {
        seen.push(currentEngineOperation()?.label);
      });
      seen.push(currentEngineOperation()?.label);
    });
    expect(seen).toEqual(['backfill.mention_fts', 'workspace.delete']);
  });

  it('labels a thrown error without exposing its message, and rethrows it', async () => {
    const operation = vi.fn();
    configureEngineDiagnostics({ operation });
    const failure = new TypeError('tenant secret in message');
    await expect(withEngineOperation('deliveries.list', 'ws_1', async () => { throw failure; })).rejects.toBe(failure);
    expect(engineOperationOf(failure)).toBe('deliveries.list');
    expect(Object.getOwnPropertySymbols(failure)).toEqual([]);
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'error', errorName: 'TypeError' }));
    expect(JSON.stringify(operation.mock.calls)).not.toContain('tenant secret');
  });

  it('keeps the innermost label on an error that crosses nested operations', async () => {
    const failure = new Error('boom');
    await expect(withEngineOperation('workspace.delete', undefined, () =>
      withEngineOperation('inbox.get', undefined, async () => { throw failure; }))).rejects.toBe(failure);
    expect(engineOperationOf(failure)).toBe('inbox.get');
  });

  it('never lets a throwing sink change the result', async () => {
    configureEngineDiagnostics({
      operation: () => { throw new Error('sink down'); },
      progress: () => { throw new Error('sink down'); },
    });
    await expect(withEngineOperation('inbox.get', undefined, async () => 'ok')).resolves.toBe('ok');
    expect(() => reportEngineProgress({ operation: 'workspace.delete', phase: 'started' })).not.toThrow();
  });

  it('is a no-op without a configured sink', async () => {
    await expect(withEngineOperation('inbox.get', undefined, async () => 'ok')).resolves.toBe('ok');
    expect(() => reportEngineProgress({ operation: 'backfill.mention_fts', phase: 'batch', rows: 1 })).not.toThrow();
  });
  it('rethrows a frozen error untouched, keeping its status and code', async () => {
    const failure = Object.freeze(Object.assign(new Error('busy'), { code: 'database_overloaded', status: 503 }));
    await expect(withEngineOperation('inbox.get', undefined, async () => { throw failure; })).rejects.toBe(failure);
    expect(engineOperationOf(failure)).toBe('inbox.get');
  });

  it('contains a rejected async sink without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      configureEngineDiagnostics({
        operation: async () => { throw new Error('sink down'); },
        progress: async () => { throw new Error('sink down'); },
      });
      await expect(withEngineOperation('inbox.get', undefined, async () => 'ok')).resolves.toBe('ok');
      reportEngineProgress({ operation: 'workspace.delete', phase: 'started' });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports to the sink of the scope it runs in, never another scope', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const fallbackSink = vi.fn();
    configureEngineDiagnostics({ operation: fallbackSink });
    await runWithEngineDiagnostics({ operation: a }, () => withEngineOperation('inbox.get', 'ws_a', async () => {}));
    await runWithEngineDiagnostics({ operation: b }, () => withEngineOperation('inbox.get', 'ws_b', async () => {}));
    // A scope without a sink, and work outside any scope, use the host's fallback.
    await runWithEngineDiagnostics(undefined, () => withEngineOperation('inbox.get', 'ws_none', async () => {}));
    await withEngineOperation('invocations.sweep', undefined, async () => {});
    expect(a.mock.calls.map(([s]) => s.workspaceId)).toEqual(['ws_a']);
    expect(b.mock.calls.map(([s]) => s.workspaceId)).toEqual(['ws_b']);
    expect(fallbackSink.mock.calls.map(([s]) => s.label)).toEqual(['inbox.get', 'invocations.sweep']);
  });
});

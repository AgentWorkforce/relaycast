import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, toErrorDetails } from '../logger.js';
describe('host-owned log transport', () => {
  afterEach(() => vi.restoreAllMocks());
  it('has no outbound transport by default', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const logger = createLogger({ environment: 'test' }, { source: 'test' });
    logger.info('hello'); await logger.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('exports structured logs with occurrence time through the injected callback', async () => {
    const logExport = vi.fn();
    const logger = createLogger({ environment: 'test', logExport }, { source: 'test' });
    logger.child('child').info('hello', { count: 2 }); await logger.flush();
    expect(logExport).toHaveBeenCalledWith({ level: 'info', message: 'hello', occurredAt: expect.any(String), fields: expect.objectContaining({ source: 'child', count: 2 }) });
  });
  it.each(['throw', 'reject'])('contains exporter %s', async mode => {
    const logExport = () => { if (mode === 'throw') throw Error('private'); return Promise.reject(Error('private')); };
    const logger = createLogger({ environment: 'test', logExport }, { source: 'test' });
    expect(() => logger.info('hello')).not.toThrow(); await expect(logger.flush()).resolves.toBeUndefined();
  });
});
describe('toErrorDetails', () => {
  it('appends the cause chain so a wrapped D1 reason reaches the log', () => {
    const d1 = new Error('D1_ERROR: too many SQL variables at offset 481: SQLITE_ERROR');
    const drizzle = new Error('Failed query: update "agent_node_bindings" set "status" = ?', { cause: d1 });
    expect(toErrorDetails(drizzle)).toMatchObject({
      error_name: 'Error',
      error_message: 'Failed query: update "agent_node_bindings" set "status" = ? | cause: D1_ERROR: too many SQL variables at offset 481: SQLITE_ERROR',
    });
  });
  it('stops on a cyclic cause and stringifies non-Error causes', () => {
    const outer = new Error('outer', { cause: 'driver said no' });
    expect(toErrorDetails(outer).error_message).toBe('outer | cause: driver said no');
    const cyclic = new Error('loop');
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(toErrorDetails(cyclic).error_message).toBe('loop');
  });
});

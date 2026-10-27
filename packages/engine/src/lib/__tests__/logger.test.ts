import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
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

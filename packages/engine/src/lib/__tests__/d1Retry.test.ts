import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  D1WriteRetryExhaustedError,
  retryD1Write,
  retryableD1ErrorCode,
} from '../d1Retry.js';

describe('D1 write retries', () => {
  afterEach(() => vi.useRealTimers());

  it('classifies a nested D1 cause without inspecting the outer SQL and parameters', () => {
    const cause = new Error('D1_ERROR: D1 DB is overloaded. Too many requests queued.');
    const error = new Error('Failed query: insert into "workspaces" params: secret', { cause });

    expect(retryableD1ErrorCode(error)).toBe('queue_full');
    expect(
      retryableD1ErrorCode(new Error('outer query failure', {
        cause: { message: 'D1_ERROR: Network connection lost.' },
      })),
    ).toBe('network_connection_lost');
    expect(
      retryableD1ErrorCode(
        new Error('Failed query params: D1_ERROR: D1 DB is overloaded. Too many requests queued.'),
      ),
    ).toBeUndefined();
  });

  it('retries a documented transient D1 failure', async () => {
    vi.useFakeTimers();
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('D1_ERROR: Network connection lost.'))
      .mockResolvedValue('created');

    const result = retryD1Write(write);
    const expectation = expect(result).resolves.toBe('created');
    await vi.runAllTimersAsync();

    await expectation;
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('retries a transient D1 message carried by a plain object', async () => {
    vi.useFakeTimers();
    const write = vi.fn()
      .mockRejectedValueOnce({
        message: 'D1_ERROR: D1 DB is overloaded. Too many requests queued.',
      })
      .mockResolvedValue('created');

    const result = retryD1Write(write);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('created');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-transient D1 failure', async () => {
    const write = vi.fn().mockRejectedValue(new Error('D1_TYPE_ERROR: Type mismatch'));

    await expect(retryD1Write(write)).rejects.toThrow('D1_TYPE_ERROR');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns only a safe classification when retries are exhausted', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValue(new Error('D1_ERROR: Network connection lost.'));

    const result = retryD1Write(write, 2);
    const expectation = expect(result).rejects.toMatchObject({
      name: 'D1WriteRetryExhaustedError',
      attempts: 2,
      storageError: 'network_connection_lost',
    } satisfies Partial<D1WriteRetryExhaustedError>);
    await vi.runAllTimersAsync();

    await expectation;
  });
});

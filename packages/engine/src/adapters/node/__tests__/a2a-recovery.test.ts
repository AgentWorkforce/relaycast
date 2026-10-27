import { afterEach, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../index.js';
import { sweepPendingA2aEgress } from '../../../engine/a2aEgress.js';

vi.mock('../../../engine/a2aEgress.js', () => ({ sweepPendingA2aEgress: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('the actual Node timer skips in-flight recovery and resumes after success and error', async () => {
  const intervals: { callback: () => void; delay: number | undefined }[] = [];
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay?: number) => {
    intervals.push({ callback, delay });
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  vi.mocked(sweepPendingA2aEgress).mockResolvedValue({ attempted: 0, failed: 0 });
  const runtime = createNodeRuntime({ dbPath: ':memory:', baseUrl: 'http://localhost:0', presence: { sweepIntervalMs: 0 }, eventQueue: { pollIntervalMs: 0 } });
  try {
    const tick = intervals.findLast(entry => entry.delay === 15_000)!.callback;
    let finish!: () => void;
    vi.mocked(sweepPendingA2aEgress).mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ attempted: 0, failed: 0 }); }));
    tick(); tick();
    expect(sweepPendingA2aEgress).toHaveBeenCalledTimes(1);
    finish(); await new Promise(resolve => setTimeout(resolve, 10));
    vi.mocked(sweepPendingA2aEgress).mockRejectedValueOnce(new Error('recovery SQL unavailable'));
    tick(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(sweepPendingA2aEgress).toHaveBeenCalledTimes(2);
    vi.mocked(sweepPendingA2aEgress).mockResolvedValue({ attempted: 0, failed: 0 });
    tick(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(sweepPendingA2aEgress).toHaveBeenCalledTimes(3);
  } finally { await new Promise(resolve => setTimeout(resolve, 20)); runtime.close(); }
});

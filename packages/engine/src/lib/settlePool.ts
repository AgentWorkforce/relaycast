/** Settle independent tasks with a rolling concurrency cap; never fail fast. */
export async function settlePool(tasks: readonly (() => Promise<unknown>)[], concurrency: number): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive finite integer');
  }
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const run = tasks[next++]!;
      try { await run(); } catch { /* Preserve independent all-settled failure handling. */ }
    }
  });
  await Promise.all(workers);
}

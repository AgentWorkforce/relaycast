/** Coalesce triggers while work runs, including a trailing pass for new triggers. */
export function trailingSingleFlight<K>(
  flights: Map<K, { dirty: boolean; promise: Promise<number> }>,
  key: K,
  run: () => Promise<number>,
): Promise<number> {
  const existing = flights.get(key);
  if (existing) { existing.dirty = true; return existing.promise; }
  const flight = { dirty: false, promise: Promise.resolve(0) };
  flight.promise = Promise.resolve().then(async () => {
    try {
      let count = 0;
      do {
        flight.dirty = false;
        count += await run();
      } while (flight.dirty);
      return count;
    } finally {
      // No await between the last dirty check and deletion. An external promise
      // finalizer would leave a microtask window where triggers can be lost.
      if (flights.get(key) === flight) flights.delete(key);
    }
  });
  flights.set(key, flight);
  return flight.promise;
}

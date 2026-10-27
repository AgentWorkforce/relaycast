/**
 * Per-node serialization for node-control operations.
 *
 * Registration (duplicate-provider check + `node_providers` upsert + registry
 * bind + node-aggregate recompute) and connection teardown both read and write
 * the same shared node state (the provider rows and the `nodes` aggregate).
 * `handleNodeControlMessage` and the socket-close path are async and would
 * otherwise interleave for a single node, so two providers attaching at once can
 * overwrite each other's row or clobber the aggregate, and on better-sqlite3 a
 * register's isolated transaction can deadlock a concurrent teardown's write.
 *
 * All operations for one node run one-at-a-time through this queue. Keyed by
 * `workspaceId:nodeId`, it is a no-op for callers that already serialize (a
 * per-node Durable Object) and the ordering guarantee self-hosting needs.
 */
const chains = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  chains.set(key, tail);
  void tail.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export function serializeNodeOp<T>(workspaceId: string, nodeId: string, fn: () => Promise<T>): Promise<T> {
  // Collision-safe key: ids are free-form and may contain any separator, so
  // encode the tuple rather than joining on a character. The leading tag keeps
  // node keys and machine keys in separate namespaces.
  return runSerialized(JSON.stringify(['node', workspaceId, nodeId]), fn);
}

/**
 * Serialize enrollments that key on the same machine.
 *
 * `resolveNodeForEnroll`'s machine lookup and the insert that follows are not
 * one atomic step, and the supporting index is deliberately non-unique (the
 * roster already holds many rows per machine, and direct nodes are meant to
 * repeat), so two concurrent first-enrollments of one machine could each miss
 * the lookup and each insert.
 *
 * Same-process only, exactly like `serializeNodeOp`: it closes the race within
 * an isolate, not across them. A duplicate that still slips through is
 * self-correcting rather than harmful -- the machine lookup resolves
 * oldest-first, so the next enrollment converges on the earliest row.
 */
export function serializeMachineEnroll<T>(workspaceId: string, machineId: string, fn: () => Promise<T>): Promise<T> {
  return runSerialized(JSON.stringify(['machine', workspaceId, machineId]), fn);
}

/**
 * TODO: in-memory AssignmentBus is per-process. Multi-instance cloud deployments require a
 * Redis-backed bus. Same limitation as packages/core/src/relay-file-access.ts revocation tracker.
 */

import type { AssignmentBus, AssignmentBusEvent, AssignmentBusListener } from "./types.js";

function normalizeWorkerId(workerId: string): string {
  const normalizedWorkerId = workerId.trim();
  if (!normalizedWorkerId) {
    throw new Error("workerId is required");
  }

  return normalizedWorkerId;
}

export class InMemoryAssignmentBus implements AssignmentBus {
  private readonly listenersByWorker = new Map<string, Set<AssignmentBusListener>>();

  subscribe(workerId: string, listener: AssignmentBusListener): () => void {
    const normalizedWorkerId = normalizeWorkerId(workerId);
    const listeners =
      this.listenersByWorker.get(normalizedWorkerId) ?? new Set<AssignmentBusListener>();
    listeners.add(listener);
    this.listenersByWorker.set(normalizedWorkerId, listeners);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) {
        return;
      }

      unsubscribed = true;

      const activeListeners = this.listenersByWorker.get(normalizedWorkerId);
      if (!activeListeners) {
        return;
      }

      activeListeners.delete(listener);
      if (activeListeners.size === 0) {
        this.listenersByWorker.delete(normalizedWorkerId);
      }
    };
  }

  async publish(workerId: string, event: AssignmentBusEvent): Promise<void> {
    const listeners = this.listenersByWorker.get(normalizeWorkerId(workerId));
    if (!listeners || listeners.size === 0) {
      return;
    }

    const snapshot = [...listeners];
    await Promise.allSettled(snapshot.map(async (listener) => listener(event)));
  }
}

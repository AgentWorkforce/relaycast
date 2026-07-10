import type { AssignmentBus, AssignmentBusEvent, WorkAssignment } from "@cloud/core/workers/index.js";
import type { WorkAssignmentRecord, WorkerBusEvent, WorkerWorkflowRef } from "./types";

type WorkerSubscriber = (event: WorkerBusEvent) => void | Promise<void>;

class InMemoryWorkerAssignmentBus {
  private readonly subscribers = new Map<string, Set<WorkerSubscriber>>();

  async publish(workerId: string, event: WorkerBusEvent): Promise<void> {
    const listeners = this.subscribers.get(workerId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    await Promise.allSettled([...listeners].map(async (listener) => listener(event)));
  }

  subscribe(workerId: string, listener: WorkerSubscriber): () => void {
    const listeners = this.subscribers.get(workerId) ?? new Set<WorkerSubscriber>();
    listeners.add(listener);
    this.subscribers.set(workerId, listeners);

    return () => {
      const current = this.subscribers.get(workerId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.subscribers.delete(workerId);
      }
    };
  }
}

function toWorkerAssignment(assignment: WorkAssignment): WorkAssignmentRecord {
  return {
    id: assignment.id,
    workspaceId: assignment.workspaceId,
    workerId: assignment.workerId,
    runId: assignment.runId,
    workflowRef: assignment.workflowRef as WorkerWorkflowRef,
    status: assignment.status,
    queuedAt: assignment.queuedAt.toISOString(),
    assignedAt: assignment.assignedAt ? assignment.assignedAt.toISOString() : null,
    startedAt: assignment.startedAt ? assignment.startedAt.toISOString() : null,
    completedAt: assignment.completedAt ? assignment.completedAt.toISOString() : null,
    queueDeadline: assignment.queueDeadline.toISOString(),
    result: assignment.result,
    error: assignment.error,
  };
}

function toCoreAssignment(assignment: WorkAssignmentRecord): WorkAssignment {
  return {
    id: assignment.id,
    workspaceId: assignment.workspaceId,
    workerId: assignment.workerId,
    runId: assignment.runId,
    workflowRef: assignment.workflowRef,
    status: assignment.status,
    queuedAt: new Date(assignment.queuedAt),
    assignedAt: assignment.assignedAt ? new Date(assignment.assignedAt) : null,
    startedAt: assignment.startedAt ? new Date(assignment.startedAt) : null,
    completedAt: assignment.completedAt ? new Date(assignment.completedAt) : null,
    queueDeadline: new Date(assignment.queueDeadline),
    result: assignment.result,
    error: assignment.error,
  };
}

function toCoreEvent(event: Exclude<WorkerBusEvent, { type: "revoke" }>): AssignmentBusEvent {
  return {
    type: event.type,
    assignment: toCoreAssignment(event.assignment),
  };
}

function toWorkerEvent(event: AssignmentBusEvent): WorkerBusEvent {
  return {
    type: event.type,
    assignment: toWorkerAssignment(event.assignment),
  };
}

declare global {
  // TODO: This in-memory bus only works for single-process deployments. Use Redis or equivalent for multi-instance workers.
  var __workerAssignmentBus: InMemoryWorkerAssignmentBus | undefined;
  var __workerOfflineTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
}

export function getWorkerAssignmentBus(): InMemoryWorkerAssignmentBus {
  if (!globalThis.__workerAssignmentBus) {
    globalThis.__workerAssignmentBus = new InMemoryWorkerAssignmentBus();
  }
  return globalThis.__workerAssignmentBus;
}

export function createCoreAssignmentBus(): AssignmentBus {
  const bus = getWorkerAssignmentBus();

  return {
    subscribe(workerId, listener) {
      return bus.subscribe(workerId, (event) => {
        if (event.type === "revoke") {
          return;
        }

        return listener(toCoreEvent(event));
      });
    },
    publish(workerId, event) {
      return bus.publish(workerId, toWorkerEvent(event));
    },
  };
}

export function getWorkerOfflineTimers(): Map<string, ReturnType<typeof setTimeout>> {
  if (!globalThis.__workerOfflineTimers) {
    globalThis.__workerOfflineTimers = new Map();
  }
  return globalThis.__workerOfflineTimers;
}

import { getWorkerOfflineTimers } from "./bus";
import type { WorkAssignmentRecord, WorkerBusEvent } from "./types";

const encoder = new TextEncoder();
const PING_FRAME = "event: ping\ndata: {}\n\n";
const OFFLINE_GRACE_MS = 60 * 1000;

function encodeSseFrame(event: string, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function clearWorkerOfflineTimer(workerId: string): void {
  const timers = getWorkerOfflineTimers();
  const existing = timers.get(workerId);
  if (!existing) {
    return;
  }

  clearTimeout(existing);
  timers.delete(workerId);
}

export async function scheduleWorkerOffline(
  workerId: string,
  createOfflineTransition: () => Promise<() => Promise<void>>,
): Promise<void> {
  const timers = getWorkerOfflineTimers();
  clearWorkerOfflineTimer(workerId);
  const markWorkerOffline = await createOfflineTransition();

  const timer = setTimeout(() => {
    timers.delete(workerId);
    void markWorkerOffline().catch((error) => {
      console.error(
        "Worker offline transition failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, OFFLINE_GRACE_MS);

  timers.set(workerId, timer);
}

function emitBusEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: WorkerBusEvent,
): void {
  if (event.type === "revoke") {
    controller.enqueue(encodeSseFrame("revoke", {}));
    return;
  }

  controller.enqueue(encodeSseFrame(event.type, event.assignment));
}

export function createAssignmentStream(input: {
  workerId: string;
  bus: {
    subscribe(workerId: string, onEvent: (event: WorkerBusEvent) => void): () => void;
  };
  signal: AbortSignal;
  getInitialAssignments: () => Promise<WorkAssignmentRecord[]>;
  createOfflineTransition: () => Promise<() => Promise<void>>;
}): ReadableStream<Uint8Array> {
  let finishStream: ((options?: { scheduleOffline?: boolean }) => Promise<void>) | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let draining = true;
      const bufferedEvents: WorkerBusEvent[] = [];
      let pingInterval: ReturnType<typeof setInterval> | null = null;
      let unsubscribe = () => {};

      const finish = async (options?: { scheduleOffline?: boolean }) => {
        if (closed) {
          return;
        }
        closed = true;

        if (pingInterval) {
          clearInterval(pingInterval);
          pingInterval = null;
        }

        unsubscribe();
        input.signal.removeEventListener("abort", onAbort);

        if (options?.scheduleOffline !== false) {
          await scheduleWorkerOffline(input.workerId, input.createOfflineTransition);
        }
      };
      finishStream = finish;

      const onAbort = () => {
        void finish().finally(() => {
          controller.close();
        });
      };

      unsubscribe = input.bus.subscribe(input.workerId, (event) => {
        if (closed) {
          return;
        }

        if (draining) {
          bufferedEvents.push(event);
          return;
        }

        emitBusEvent(controller, event);
        if (event.type === "revoke") {
          void finish({ scheduleOffline: false }).finally(() => {
            controller.close();
          });
        }
      });

      input.signal.addEventListener("abort", onAbort, { once: true });
      pingInterval = setInterval(() => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(PING_FRAME));
      }, 20 * 1000);

      try {
        const initialAssignments = await input.getInitialAssignments();
        for (const assignment of initialAssignments) {
          controller.enqueue(encodeSseFrame("assignment", assignment));
        }

        draining = false;
        for (const event of bufferedEvents.splice(0)) {
          emitBusEvent(controller, event);
          if (event.type === "revoke") {
            await finish({ scheduleOffline: false });
            controller.close();
            return;
          }
        }
      } catch (error) {
        await finish({ scheduleOffline: false });
        controller.error(error);
      }
    },
    async cancel() {
      if (finishStream) {
        await finishStream();
        return;
      }

      await scheduleWorkerOffline(input.workerId, input.createOfflineTransition);
    },
  });
}

import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EngineDiagnostics,
  EngineOperationLabel,
  EngineOperationScope,
  EngineProgressSample,
} from '../ports/diagnostics.js';

// Two sources of a sink, so separately configured apps never cross:
//  - each app runs its requests inside `runWithEngineDiagnostics` with its own
//    `deps.diagnostics` (or none), and work a request starts in the background
//    inherits that scope;
//  - `configureEngineDiagnostics` sets the host's own fallback, used by
//    maintenance sweeps outside any request and by apps built without a sink.
//    `createEngine` never sets it, so one app's sink cannot leak into another.
let fallback: EngineDiagnostics | undefined;
const appScope = new AsyncLocalStorage<{ sink: EngineDiagnostics | undefined }>();
const operationScope = new AsyncLocalStorage<EngineOperationScope>();
// A WeakMap rather than a property: a frozen or non-extensible error must be
// rethrown untouched, never replaced by the TypeError a defineProperty raises.
const operationLabels = new WeakMap<object, EngineOperationLabel>();

/** The sink for maintenance callers that run outside an app's requests. */
export function configureEngineDiagnostics(next: EngineDiagnostics | undefined): void {
  fallback = next;
}

/** Run `fn` with `sink` as the diagnostics destination (`createEngine` does this per request). */
export function runWithEngineDiagnostics<T>(sink: EngineDiagnostics | undefined, fn: () => T): T {
  return appScope.run({ sink }, fn);
}

function activeSink(): EngineDiagnostics | undefined {
  // An app's own sink wins; an app built without one reports to the sink the
  // host configured explicitly, never to another app's.
  return appScope.getStore()?.sink ?? fallback;
}

/**
 * The labelled operation the caller is running inside, if any. A host database
 * wrapper uses this to attribute each statement's cost to an operation.
 */
export function currentEngineOperation(): EngineOperationScope | undefined {
  return operationScope.getStore();
}

/** The operation an error was thrown inside, so the request error path can report it. */
export function engineOperationOf(error: unknown): EngineOperationLabel | undefined {
  return typeof error === 'object' && error !== null ? operationLabels.get(error) : undefined;
}

function isolate(callback: () => unknown): void {
  // A host callback must never alter engine behavior, sync or async.
  try {
    const pending = callback();
    if (pending && typeof (pending as Promise<unknown>).then === 'function') {
      void Promise.resolve(pending).catch(() => {});
    }
  } catch { /* best effort */ }
}

/**
 * Run `fn` as a labelled operation: hosts see its duration and outcome, and any
 * statement it issues can be attributed to it via `currentEngineOperation()`.
 * The innermost label wins when operations nest.
 */
export async function withEngineOperation<T>(
  label: EngineOperationLabel,
  workspaceId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const context: EngineOperationScope = workspaceId === undefined ? { label } : { label, workspaceId };
  const sink = activeSink();
  const start = performance.now();
  try {
    const result = await operationScope.run(context, fn);
    if (sink?.operation) {
      isolate(() => sink.operation!({ ...context, durationMs: performance.now() - start, outcome: 'ok' }));
    }
    return result;
  } catch (error) {
    if (typeof error === 'object' && error !== null && !operationLabels.has(error)) {
      operationLabels.set(error, label);
    }
    if (sink?.operation) {
      const errorName = error instanceof Error ? error.name : undefined;
      isolate(() => sink.operation!({
        ...context,
        durationMs: performance.now() - start,
        outcome: 'error',
        ...(errorName ? { errorName } : {}),
      }));
    }
    throw error;
  }
}

export function reportEngineProgress(sample: EngineProgressSample): void {
  const sink = activeSink();
  if (sink?.progress) isolate(() => sink.progress!(sample));
}

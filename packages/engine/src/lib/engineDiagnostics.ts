import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EngineDiagnostics,
  EngineOperationLabel,
  EngineOperationScope,
  EngineProgressSample,
} from '../ports/diagnostics.js';

// Module-level rather than per-request: the operations worth timing include
// maintenance sweeps that run without an app or request context. Configured by
// `createEngine` from `EngineDeps.diagnostics`; hosts that drive maintenance
// without building the app configure it themselves.
let sink: EngineDiagnostics | undefined;
const scope = new AsyncLocalStorage<EngineOperationScope>();

export function configureEngineDiagnostics(next: EngineDiagnostics | undefined): void {
  sink = next;
}

/**
 * The labelled operation the caller is running inside, if any. A host database
 * wrapper uses this to attribute each statement's cost to an operation.
 */
export function currentEngineOperation(): EngineOperationScope | undefined {
  return scope.getStore();
}

/** Label an error thrown inside an operation so the request error path can report it. */
const OPERATION = Symbol.for('relaycast.engineOperation');

export function engineOperationOf(error: unknown): EngineOperationLabel | undefined {
  return typeof error === 'object' && error !== null
    ? (error as { [OPERATION]?: EngineOperationLabel })[OPERATION]
    : undefined;
}

function isolate(callback: () => void): void {
  // A host callback must never alter engine behavior.
  try { callback(); } catch { /* best effort */ }
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
  const start = performance.now();
  try {
    const result = await scope.run(context, fn);
    const current = sink;
    if (current?.operation) {
      isolate(() => current.operation!({ ...context, durationMs: performance.now() - start, outcome: 'ok' }));
    }
    return result;
  } catch (error) {
    if (typeof error === 'object' && error !== null && !(OPERATION in error)) {
      Object.defineProperty(error, OPERATION, { value: label, enumerable: false });
    }
    const current = sink;
    if (current?.operation) {
      const errorName = error instanceof Error ? error.name : undefined;
      isolate(() => current.operation!({
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
  const current = sink;
  if (current?.progress) isolate(() => current.progress!(sample));
}

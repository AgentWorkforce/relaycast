/**
 * Write-group semantics inside one `@Atomic` durable actor call.
 *
 * The engine groups multi-statement writes (`runAtomicWrites`, `runAtomic`)
 * and expects a failed group to roll back while the request carries on, often
 * to a 4xx and sometimes to a different write path (for example, registration
 * reclaiming a released verifier and retrying). The actor runtime has no
 * partial rollback: the call is one transaction, and the only way to undo
 * writes is to throw from the `@Atomic` method, which undoes the whole call.
 *
 * So a call runs as a sequence of passes over the same request:
 *
 * 1. Each write group gets an index in execution order. A group that fails
 *    before any of its statements wrote anything has nothing to undo (SQLite
 *    rolls back a failing statement by itself); its error propagates and the
 *    pass continues.
 * 2. A group that fails after writing leaves partial state the engine assumes
 *    is gone. The pass records `{ index, error }` and finishes so the engine
 *    can decide what to do, but its result can't commit: the call throws
 *    {@link ActorReplayRequired} and the runtime rolls the call back.
 * 3. The caller invokes again with the recorded failures. In that pass, group
 *    `index` fails immediately with the recorded error and writes nothing,
 *    which is exactly what a rolled-back group leaves behind, so the engine
 *    takes the same branch it took before with consistent state.
 *
 * A pass records only its first such failure: later groups ran on top of the
 * partial writes, so their outcomes are decided again by the next pass. Each
 * pass adds one failure, and a pass commits once no group left partial writes. Group indices line up across passes because the
 * request, the database state before it, and the engine's control flow are
 * the same; only generated ids and timestamps differ.
 */

/** A write group failure, in a JSON-compatible form an actor call can return or receive. */
export interface ActorWriteGroupFailure {
  /** The group's position among the call's write groups, in execution order. */
  index: number;
  /** The error, then its `cause`, then that one's `cause`, and so on. */
  error: ActorSerializedError[];
}

/**
 * One error of a cause chain, reduced to what the engine reads from it: name,
 * message, and own JSON fields such as `code`/`status`. Engine error
 * classifiers walk `cause` (drizzle wraps driver errors), so the chain is kept.
 */
export interface ActorSerializedError {
  name: string;
  message: string;
  /** JSON object of the error's own enumerable, JSON-compatible fields. */
  fields: string;
}

const REPLAY_MARKER = 'relaycast_actor_replay:';

/**
 * Thrown from an `@Atomic` actor call to roll it back. The message carries the
 * failures the next pass must replay, because a rolled-back call's only output
 * is its failure.
 */
export class ActorReplayRequired extends Error {
  constructor(readonly failures: readonly ActorWriteGroupFailure[]) {
    super(`${REPLAY_MARKER}${JSON.stringify(failures)}`);
    this.name = 'ActorReplayRequired';
  }
}

/**
 * Recover the failures from a rolled-back call's error message, as the actor
 * runtime reports it to the caller. Returns `undefined` for any other failure.
 */
export function parseActorReplay(message: string): ActorWriteGroupFailure[] | undefined {
  const at = message.indexOf(REPLAY_MARKER);
  if (at < 0) return undefined;
  const encoded = message.slice(at + REPLAY_MARKER.length);
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed)) throw new Error('Malformed actor replay failures');
  return parsed.map((entry) => {
    const failure = entry as ActorWriteGroupFailure;
    if (
      typeof failure?.index !== 'number' ||
      !Array.isArray(failure.error) ||
      failure.error.length === 0 ||
      !failure.error.every((link) => (
        typeof link?.name === 'string' && typeof link.message === 'string' && typeof link.fields === 'string'
      ))
    ) {
      throw new Error('Malformed actor replay failure');
    }
    return failure;
  });
}

function jsonFields(error: object): string {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (key === 'message' || key === 'name' || key === 'stack' || key === 'cause') continue;
    try {
      fields[key] = JSON.parse(JSON.stringify(value));
    } catch {
      // Not JSON-compatible; the engine never branches on such fields.
    }
  }
  return JSON.stringify(fields);
}

const MAX_CAUSE_DEPTH = 8;

/** Serialize `error` and its `cause` chain. */
export function serializeError(error: unknown): ActorSerializedError[] {
  const chain: ActorSerializedError[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < MAX_CAUSE_DEPTH) {
    seen.add(current);
    chain.push(serializeLink(current));
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function serializeLink(error: unknown): ActorSerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, fields: jsonFields(error) };
  }
  if (error && typeof error === 'object') {
    const message = 'message' in error ? String((error as { message: unknown }).message) : String(error);
    return { name: 'Error', message, fields: jsonFields(error) };
  }
  return { name: 'Error', message: String(error), fields: '{}' };
}

/** Rebuild a recorded failure as plain `Error`s carrying the same names, messages, fields and causes. */
export function rehydrateError(chain: readonly ActorSerializedError[]): Error {
  let cause: Error | undefined;
  for (const link of [...chain].reverse()) {
    const error: Error = Object.assign(new Error(link.message, cause ? { cause } : undefined), JSON.parse(link.fields) as object);
    error.name = link.name;
    cause = error;
  }
  if (!cause) throw new Error('Empty error chain');
  return cause;
}

/**
 * One pass of one actor call. Tracks write groups, replays recorded failures,
 * and records new groups that failed after writing.
 */
export class ActorCallScope {
  private nextIndex = 0;
  private openGroups = 0;
  private groupWrites = 0;
  private readonly replay: ReadonlyMap<number, readonly ActorSerializedError[]>;
  readonly failures: ActorWriteGroupFailure[] = [];

  constructor(replay: readonly ActorWriteGroupFailure[] = []) {
    this.replay = new Map(replay.map((failure) => [failure.index, failure.error]));
  }

  /** The pass must not commit: a group failed after writing. */
  get mustRollBack(): boolean {
    return this.failures.length > 0;
  }

  /** Called by the SQL shim after every statement that wrote. */
  onWrite(): void {
    if (this.openGroups > 0) this.groupWrites += 1;
  }

  async runGroup<T>(body: () => Promise<T>): Promise<T> {
    const index = this.nextIndex++;
    const replayed = this.replay.get(index);
    if (replayed) throw rehydrateError(replayed);

    const writesBefore = this.groupWrites;
    this.openGroups += 1;
    try {
      return await body();
    } catch (error) {
      // Only the first such failure is real: every later group in this pass
      // ran on top of its partial writes, so the next pass decides those again.
      if (this.groupWrites > writesBefore && this.failures.length === 0) {
        this.failures.push({ index, error: serializeError(error) });
      }
      throw error;
    } finally {
      this.openGroups -= 1;
    }
  }
}

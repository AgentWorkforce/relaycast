import { RelayFileApiError, type RelayFileClient } from "@relayfile/sdk";

export const GITHUB_CLONE_CHUNK_SIZE = 25;
export const GITHUB_CLONE_MAX_CONCURRENT = 1;
export const GITHUB_CLONE_MAX_BULK_WRITE_BODY_BYTES = 8 * 1024 * 1024;

export const CLONE_RETRY_MAX_ATTEMPTS = 5;
export const CLONE_RETRY_BASE_DELAY_MS = 5_000;
export const CLONE_RETRY_MAX_DELAY_MS = 60_000;
export const CLONE_RETRY_DEADLINE_MS = 2 * 60 * 1000;
const CLONE_RETRYABLE_BACKPRESSURE_CODES = new Set([
  "workspace_busy",
  "durable_object_overloaded",
]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  deadlineMs?: number;
}

export interface ChunkedWriteInput {
  client: RelayFileClient;
  workspaceId: string;
  jobId?: string;
  files: Array<{
    path: string;
    content: string;
    contentType?: string;
    encoding: "utf-8" | "base64";
  }>;
  chunkSize?: number;
  maxConcurrent?: number;
  signal?: AbortSignal;
  retryOptions?: RetryOptions;
}

export interface ChunkedWriteResult {
  written: number;
  errors: Array<{ path: string; code: string; message: string }>;
}

interface SemaphoreState {
  inFlight: number;
  waiters: Array<() => void>;
}

function createSemaphoreState(): SemaphoreState {
  return { inFlight: 0, waiters: [] };
}

function normalizeChunkSize(chunkSize?: number): number {
  if (!Number.isFinite(chunkSize) || !chunkSize || chunkSize < 1) {
    return GITHUB_CLONE_CHUNK_SIZE;
  }

  return Math.max(1, Math.floor(chunkSize));
}

function normalizeConcurrency(maxConcurrent?: number): number {
  if (!Number.isFinite(maxConcurrent) || !maxConcurrent || maxConcurrent < 1) {
    return GITHUB_CLONE_MAX_CONCURRENT;
  }

  return Math.min(GITHUB_CLONE_MAX_CONCURRENT, Math.max(1, Math.floor(maxConcurrent)));
}

function toAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("The operation was aborted.");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toAbortError(signal);
  }
}

function estimateBulkWriteBodyBytes(files: ChunkedWriteInput["files"]): number {
  return new TextEncoder().encode(JSON.stringify({ files })).byteLength;
}

function splitIntoBoundedChunks(
  files: ChunkedWriteInput["files"],
  chunkSize: number,
  maxBodyBytes: number,
): Array<ChunkedWriteInput["files"]> {
  const chunks: Array<ChunkedWriteInput["files"]> = [];
  let current: ChunkedWriteInput["files"] = [];

  for (const file of files) {
    const next = [...current, file];
    if (
      current.length > 0 &&
      (current.length >= chunkSize ||
        estimateBulkWriteBodyBytes(next) > maxBodyBytes)
    ) {
      chunks.push(current);
      current = [file];
      continue;
    }

    current = next;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function waitForSemaphoreTurn(
  state: SemaphoreState,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wake = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(toAbortError(signal));
    };
    const cleanup = () => {
      const waiterIndex = state.waiters.indexOf(wake);
      if (waiterIndex >= 0) {
        state.waiters.splice(waiterIndex, 1);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    state.waiters.push(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireSemaphore(
  state: SemaphoreState,
  limit: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  while (state.inFlight >= GITHUB_CLONE_MAX_CONCURRENT || state.inFlight >= limit) {
    await waitForSemaphoreTurn(state, signal);
    throwIfAborted(signal);
  }

  state.inFlight += 1;
}

function releaseSemaphore(state: SemaphoreState): void {
  state.inFlight = Math.max(0, state.inFlight - 1);
  state.waiters.shift()?.();
}

function readHeaderValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  const lowerName = name.toLowerCase();

  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): string | null }).get(name)
      ?? (headers as { get(name: string): string | null }).get(lowerName);
    return value?.trim() || null;
  }

  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() !== lowerName) continue;
      if (Array.isArray(value)) {
        const first = value.find((entry) => typeof entry === "string" && entry.trim().length > 0);
        return first?.trim() || null;
      }
      if (typeof value === "string") return value.trim() || null;
      if (typeof value === "number") return String(value);
    }
  }

  return null;
}

function retryAfterMs(error: unknown, now: number, maxDelayMs: number): number | null {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const response = record.response && typeof record.response === "object"
    ? record.response as Record<string, unknown>
    : {};
  const value = readHeaderValue(record.headers, "retry-after")
    ?? readHeaderValue(response.headers, "retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, maxDelayMs);
    }

    const dateMs = Date.parse(value);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - now), maxDelayMs);
    }
  }

  for (const candidate of [record.details, record.body, response.body]) {
    if (!candidate || typeof candidate !== "object") continue;
    const retryAfterSeconds = (candidate as Record<string, unknown>).retryAfterSeconds;
    if (typeof retryAfterSeconds === "number" && retryAfterSeconds >= 0) {
      return Math.min(retryAfterSeconds * 1000, maxDelayMs);
    }
  }

  return null;
}

function errorStatus(error: unknown): number | null {
  if (error instanceof RelayFileApiError) return error.status;
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  if (typeof record.status === "number") return record.status;
  const response = record.response as Record<string, unknown> | undefined;
  return typeof response?.status === "number" ? response.status : null;
}

function errorCode(error: unknown): string | null {
  if (error instanceof RelayFileApiError) return error.code || null;
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function isRetryableBackpressure(error: unknown, maxDelayMs: number): boolean {
  if (errorStatus(error) !== 429) return false;
  const code = errorCode(error);
  return code !== null && CLONE_RETRYABLE_BACKPRESSURE_CODES.has(code);
}

function computeRetryDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const jitter = Math.random() * exponential * 0.2;
  return exponential + jitter;
}

function nextRetryDelayMs(error: unknown, attempt: number, baseMs: number, maxMs: number, now: number): number {
  return retryAfterMs(error, now, maxMs) ?? computeRetryDelay(attempt, baseMs, maxMs);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(toAbortError(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function bulkWriteFailureMessage(error: unknown, attempts: number, startedAt: number, maxDelayMs: number): string {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "Relayfile bulk write failed.";
  if (attempts <= 1 || !isRetryableBackpressure(error, maxDelayMs)) {
    return message;
  }

  return `${message} (bulkWrite workspace_busy retry exhausted after ${attempts} attempts over ${Math.max(
    0,
    Date.now() - startedAt,
  )}ms; status=${errorStatus(error) ?? "unknown"} code=${errorCode(error) ?? "unknown"})`;
}

async function writeChunk(
  state: SemaphoreState,
  input: ChunkedWriteInput,
  chunk: ChunkedWriteInput["files"],
  chunkIndex: number,
  maxConcurrent: number,
): Promise<ChunkedWriteResult> {
  const maxAttempts = input.retryOptions?.maxAttempts ?? CLONE_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = input.retryOptions?.baseDelayMs ?? CLONE_RETRY_BASE_DELAY_MS;
  const maxDelayMs = input.retryOptions?.maxDelayMs ?? CLONE_RETRY_MAX_DELAY_MS;
  const deadlineMs = input.retryOptions?.deadlineMs ?? CLONE_RETRY_DEADLINE_MS;

  await acquireSemaphore(state, maxConcurrent, input.signal);

  try {
    const startedAt = Date.now();
    let attempts = 0;

    for (;;) {
      attempts += 1;
      try {
        const result = await input.client.bulkWrite({
          workspaceId: input.workspaceId,
          files: chunk,
          correlationId: input.jobId
            ? `github-clone-job:${input.jobId}:chunk:${chunkIndex}`
            : `github-clone-${input.workspaceId}-${chunkIndex}`,
          signal: input.signal,
        });

        return {
          written: result.written,
          errors: result.errors,
        };
      } catch (error) {
        if (input.signal?.aborted) {
          throw toAbortError(input.signal);
        }

        const now = Date.now();
        const delay = nextRetryDelayMs(error, attempts, baseDelayMs, maxDelayMs, now);
        if (
          isRetryableBackpressure(error, maxDelayMs) &&
          attempts < maxAttempts &&
          now + delay - startedAt <= deadlineMs
        ) {
          await abortableSleep(delay, input.signal);
          continue;
        }

        const code = errorCode(error) ?? "bulk_write_failed";
        const message = bulkWriteFailureMessage(error, attempts, startedAt, maxDelayMs);

        return {
          written: 0,
          errors: chunk.map((file) => ({
            path: file.path,
            code,
            message,
          })),
        };
      }
    }
  } finally {
    releaseSemaphore(state);
  }
}

export async function chunkedBulkWrite(input: ChunkedWriteInput): Promise<ChunkedWriteResult> {
  throwIfAborted(input.signal);

  if (input.files.length === 0) {
    return {
      written: 0,
      errors: [],
    };
  }

  const chunkSize = normalizeChunkSize(input.chunkSize);
  const maxConcurrent = normalizeConcurrency(input.maxConcurrent);
  const chunks = splitIntoBoundedChunks(
    input.files,
    chunkSize,
    GITHUB_CLONE_MAX_BULK_WRITE_BODY_BYTES,
  );
  const state = createSemaphoreState();
  let written = 0;
  const errors: ChunkedWriteResult["errors"] = [];
  let nextChunkIndex = 0;
  const running = new Set<Promise<void>>();

  while (nextChunkIndex < chunks.length || running.size > 0) {
    while (nextChunkIndex < chunks.length && running.size < maxConcurrent) {
      const chunk = chunks[nextChunkIndex];
      const chunkIndex = nextChunkIndex;
      nextChunkIndex += 1;

      let task: Promise<void>;
      task = writeChunk(state, input, chunk, chunkIndex, maxConcurrent)
        .then((result) => {
          written += result.written;
          errors.push(...result.errors);
        })
        .finally(() => {
          running.delete(task);
        });

      running.add(task);
    }

    if (running.size > 0) {
      await Promise.race(running);
    }
  }

  return {
    written,
    errors,
  };
}

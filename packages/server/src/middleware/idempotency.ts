import { createHash } from 'node:crypto';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_LOCK_TTL_SECONDS = 30;
const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

interface StoredIdempotencyRecord<T> {
  status: number;
  data: T;
  fingerprint?: string;
}

export interface IdempotentResult<T> {
  status: number;
  data: T;
  replayed: boolean;
}

interface RunIdempotentOptions<T> {
  workspaceId: string;
  actorId: string;
  scope: string;
  key?: string;
  status?: number;
  fingerprint?: string;
  ttlSeconds?: number;
  kv?: KVNamespace;
  operation: () => Promise<T>;
}

function buildKey(workspaceId: string, actorId: string, scope: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex');
  const scopeDigest = createHash('sha256').update(scope).digest('hex').slice(0, 16);
  return `idem:v1:${workspaceId}:${actorId}:${scopeDigest}:${digest}`;
}

export function parseIdempotencyKey(headerValue: string | undefined): { key?: string; error?: string } {
  if (headerValue === undefined) {
    return {};
  }

  const key = headerValue.trim();
  if (!key) {
    return { error: 'Idempotency-Key cannot be empty' };
  }

  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      error: `Idempotency-Key must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer`,
    };
  }

  // Restrict to visible ASCII (no whitespace/control chars)
  if (/[^\x21-\x7E]/.test(key)) {
    return {
      error: 'Idempotency-Key must contain only visible ASCII characters',
    };
  }

  return { key };
}

export async function runIdempotent<T>(
  options: RunIdempotentOptions<T>,
): Promise<IdempotentResult<T>> {
  const {
    workspaceId,
    actorId,
    scope,
    key,
    fingerprint,
    operation,
    status = 201,
    ttlSeconds = IDEMPOTENCY_TTL_SECONDS,
    kv,
  } = options;

  if (!key) {
    const data = await operation();
    return { status, data, replayed: false };
  }

  let kvStore: KVNamespace | null = kv ?? null;
  let kvKey: string | null = null;
  let lockKey: string | null = null;
  let lockAcquired = false;

  if (kvStore) {
    kvKey = buildKey(workspaceId, actorId, scope, key);
    lockKey = `${kvKey}:lock`;

    try {
      const existingRaw = await kvStore.get(kvKey);
      if (existingRaw) {
        const parsed = JSON.parse(existingRaw) as StoredIdempotencyRecord<T>;
        if (fingerprint && parsed.fingerprint && parsed.fingerprint !== fingerprint) {
          const err = new Error('Idempotency-Key was reused with a different request payload');
          Object.assign(err, { code: 'idempotency_key_reused', status: 409 });
          throw err;
        }

        return {
          status: parsed.status || status,
          data: parsed.data,
          replayed: true,
        };
      }

      // KV doesn't support atomic NX-style set, so we do a read-then-write for the lock.
      // This is best-effort; in rare race conditions, duplicate operations may run.
      const existingLock = await kvStore.get(lockKey);
      if (existingLock) {
        // Another request may be processing. Check if result is now available.
        const concurrentRaw = await kvStore.get(kvKey);
        if (concurrentRaw) {
          const parsed = JSON.parse(concurrentRaw) as StoredIdempotencyRecord<T>;
          if (fingerprint && parsed.fingerprint && parsed.fingerprint !== fingerprint) {
            const err = new Error('Idempotency-Key was reused with a different request payload');
            Object.assign(err, { code: 'idempotency_key_reused', status: 409 });
            throw err;
          }

          return {
            status: parsed.status || status,
            data: parsed.data,
            replayed: true,
          };
        }

        const err = new Error('Another request with this Idempotency-Key is still processing');
        Object.assign(err, { code: 'idempotency_in_progress', status: 409 });
        throw err;
      }

      // Acquire lock
      await kvStore.put(lockKey, '1', { expirationTtl: IDEMPOTENCY_LOCK_TTL_SECONDS });
      lockAcquired = true;

      // Re-check record after acquiring lock to handle race with completed request
      const recheckRaw = await kvStore.get(kvKey);
      if (recheckRaw) {
        await kvStore.delete(lockKey);
        const parsed = JSON.parse(recheckRaw) as StoredIdempotencyRecord<T>;
        if (fingerprint && parsed.fingerprint && parsed.fingerprint !== fingerprint) {
          const err = new Error('Idempotency-Key was reused with a different request payload');
          Object.assign(err, { code: 'idempotency_key_reused', status: 409 });
          throw err;
        }
        return {
          status: parsed.status || status,
          data: parsed.data,
          replayed: true,
        };
      }
    } catch (err) {
      if (err instanceof Error && ['idempotency_key_reused', 'idempotency_in_progress'].includes((err as any).code)) {
        throw err;
      }
      // KV unavailable or decode failure: proceed without idempotency.
      kvStore = null;
      kvKey = null;
      lockKey = null;
      lockAcquired = false;
    }
  }

  try {
    const data = await operation();

    if (kvStore && kvKey && lockAcquired) {
      const record: StoredIdempotencyRecord<T> = {
        status,
        data,
        fingerprint,
      };
      try {
        await kvStore.put(kvKey, JSON.stringify(record), { expirationTtl: ttlSeconds });
      } catch {
        // KV failure during record storage — proceed without idempotency record.
      } finally {
        if (lockKey) {
          try { await kvStore.delete(lockKey); } catch { /* ignore */ }
        }
      }
    }

    return { status, data, replayed: false };
  } catch (err) {
    if (kvStore && lockKey && lockAcquired) {
      try { await kvStore.delete(lockKey); } catch { /* ignore */ }
    }
    throw err;
  }
}

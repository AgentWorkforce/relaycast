import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { getRedis } from '../redis/index.js';

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
  operation: () => Promise<T>;
}

function buildKey(workspaceId: string, actorId: string, scope: string, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex');
  const scopeDigest = createHash('sha256').update(scope).digest('hex').slice(0, 16);
  return `idem:v1:${workspaceId}:${actorId}:${scopeDigest}:${digest}`;
}

export function parseIdempotencyKey(req: Request): { key?: string; error?: string } {
  const raw = req.header('Idempotency-Key');
  if (raw === undefined) {
    return {};
  }

  const key = raw.trim();
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
  } = options;

  if (!key) {
    const data = await operation();
    return { status, data, replayed: false };
  }

  let redis: ReturnType<typeof getRedis> | null = null;
  let redisKey: string | null = null;
  let lockKey: string | null = null;
  let lockAcquired = false;

  try {
    redis = getRedis();
    // In tests/mocks this can be a partial object. If core methods don't exist,
    // degrade gracefully to non-idempotent behavior.
    if (
      typeof (redis as any).get !== 'function'
      || typeof (redis as any).set !== 'function'
      || typeof (redis as any).del !== 'function'
    ) {
      redis = null;
    }
  } catch {
    redis = null;
  }

  if (redis) {
    redisKey = buildKey(workspaceId, actorId, scope, key);
    lockKey = `${redisKey}:lock`;

    try {
      const existingRaw = await redis.get(redisKey);
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

      const lockResult = await redis.set(
        lockKey,
        '1',
        'EX',
        IDEMPOTENCY_LOCK_TTL_SECONDS,
        'NX',
      );

      if (!lockResult) {
        const concurrentRaw = await redis.get(redisKey);
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

      lockAcquired = true;

      // Re-check record after acquiring lock to handle race with completed request
      const recheckRaw = await redis.get(redisKey);
      if (recheckRaw) {
        await redis.del(lockKey).catch(() => {});
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
      // Redis unavailable or decode failure: proceed without idempotency.
      redis = null;
      redisKey = null;
      lockKey = null;
      lockAcquired = false;
    }
  }

  try {
    const data = await operation();

    if (redis && redisKey && lockAcquired) {
      const record: StoredIdempotencyRecord<T> = {
        status,
        data,
        fingerprint,
      };
      try {
        await redis.set(redisKey, JSON.stringify(record), 'EX', ttlSeconds);
      } catch {
        // Redis failure during record storage — proceed without idempotency record.
      } finally {
        if (lockKey) {
          await redis.del(lockKey).catch(() => {});
        }
      }
    }

    return { status, data, replayed: false };
  } catch (err) {
    if (redis && lockKey && lockAcquired) {
      await redis.del(lockKey).catch(() => {});
    }
    throw err;
  }
}

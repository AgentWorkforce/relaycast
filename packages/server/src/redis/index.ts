import Redis from 'ioredis';

let redisClient: Redis | null = null;
let redisSub: Redis | null = null;

export interface RedisConfig {
  url?: string;
  maxRetriesPerRequest?: number;
  retryStrategy?: (times: number) => number | null;
}

export function getRedis(config?: RedisConfig): Redis {
  if (!redisClient) {
    const url = config?.url || process.env.REDIS_URL || 'redis://localhost:6379';

    redisClient = new Redis(url, {
      maxRetriesPerRequest: config?.maxRetriesPerRequest ?? 3,
      retryStrategy:
        config?.retryStrategy ??
        ((times: number) => {
          if (times > 10) return null; // stop retrying after 10 attempts
          return Math.min(times * 200, 5000); // exponential backoff, max 5s
        }),
      lazyConnect: true,
    });
  }
  return redisClient;
}

// Separate client for pub/sub (Redis requires dedicated connection for subscribe).
export function getRedisSub(config?: RedisConfig): Redis {
  if (!redisSub) {
    const url = config?.url || process.env.REDIS_URL || 'redis://localhost:6379';

    redisSub = new Redis(url, {
      maxRetriesPerRequest: config?.maxRetriesPerRequest ?? 3,
      retryStrategy:
        config?.retryStrategy ??
        ((times: number) => {
          if (times > 10) return null;
          return Math.min(times * 200, 5000);
        }),
      lazyConnect: true,
    });
  }
  return redisSub;
}

export async function connectRedis(): Promise<void> {
  const client = getRedis();
  if (client.status === 'wait') {
    await client.connect();
  }
}

export async function connectRedisSub(): Promise<void> {
  const sub = getRedisSub();
  if (sub.status === 'wait') {
    await sub.connect();
  }
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
  if (redisSub) {
    await redisSub.quit();
    redisSub = null;
  }
}

export async function redisHealthCheck(): Promise<boolean> {
  try {
    const client = getRedis();
    if (client.status === 'wait') {
      await client.connect();
    }
    const result = await client.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}


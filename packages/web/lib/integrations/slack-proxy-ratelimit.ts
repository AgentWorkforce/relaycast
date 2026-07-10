export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number; scope: "channel" | "workspace" };

const CHANNEL_LIMIT = 1;
const CHANNEL_WINDOW_MS = 1100;
const WORKSPACE_LIMIT = 50;
const WORKSPACE_WINDOW_MS = 60_000;

const workspaceRequestTimestamps = new Map<string, number[]>();
const channelRequestTimestamps = new Map<string, number[]>();

function getBucket(map: Map<string, number[]>, key: string): number[] {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const created: number[] = [];
  map.set(key, created);
  return created;
}

function pruneWindow(bucket: number[], windowMs: number, now: number): void {
  let writeIndex = 0;

  for (const timestamp of bucket) {
    if (now - timestamp < windowMs) {
      bucket[writeIndex] = timestamp;
      writeIndex += 1;
    }
  }

  bucket.length = writeIndex;
}

function getRetryAfterMs(bucket: number[], limit: number, windowMs: number, now: number): number {
  if (bucket.length < limit) {
    return 0;
  }

  const retryAfterMs = bucket[0] + windowMs - now;
  return retryAfterMs > 0 ? retryAfterMs : 0;
}

function maybeDeleteEmptyBucket(map: Map<string, number[]>, key: string, bucket: number[]): void {
  if (bucket.length === 0) {
    map.delete(key);
  }
}

function getChannelKey(workspaceId: string, channel: string): string {
  return `${workspaceId}\u0000${channel}`;
}

export function checkSlackProxyRateLimit(input: {
  workspaceId: string;
  channel?: string;
  now?: number;
}): RateLimitResult {
  const now = input.now ?? Date.now();
  const workspaceBucket = getBucket(workspaceRequestTimestamps, input.workspaceId);
  const normalizedChannel =
    typeof input.channel === "string" && input.channel.trim().length > 0
      ? input.channel.trim()
      : undefined;
  const channelKey = normalizedChannel
    ? getChannelKey(input.workspaceId, normalizedChannel)
    : null;
  const channelBucket = channelKey ? getBucket(channelRequestTimestamps, channelKey) : null;

  pruneWindow(workspaceBucket, WORKSPACE_WINDOW_MS, now);
  if (channelBucket) {
    pruneWindow(channelBucket, CHANNEL_WINDOW_MS, now);
  }

  const workspaceRetryAfterMs = getRetryAfterMs(
    workspaceBucket,
    WORKSPACE_LIMIT,
    WORKSPACE_WINDOW_MS,
    now,
  );
  const channelRetryAfterMs = channelBucket
    ? getRetryAfterMs(channelBucket, CHANNEL_LIMIT, CHANNEL_WINDOW_MS, now)
    : 0;

  if (workspaceRetryAfterMs > 0 || channelRetryAfterMs > 0) {
    maybeDeleteEmptyBucket(workspaceRequestTimestamps, input.workspaceId, workspaceBucket);
    if (channelBucket && channelKey) {
      maybeDeleteEmptyBucket(channelRequestTimestamps, channelKey, channelBucket);
    }

    if (channelRetryAfterMs > workspaceRetryAfterMs) {
      return {
        ok: false,
        retryAfterMs: channelRetryAfterMs,
        scope: "channel",
      };
    }

    return {
      ok: false,
      retryAfterMs: workspaceRetryAfterMs,
      scope: "workspace",
    };
  }

  workspaceBucket.push(now);
  if (channelBucket) {
    channelBucket.push(now);
  }

  return { ok: true };
}

export function resetSlackProxyRateLimit(): void {
  workspaceRequestTimestamps.clear();
  channelRequestTimestamps.clear();
}

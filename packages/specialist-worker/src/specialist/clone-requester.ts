/**
 * Worker-flavored twin of sage/src/integrations/clone-requester.ts.
 *
 * Fires fire-and-forget POST /api/v1/github/clone/request at the cloud web
 * app so a subsequent VFS read (after the queue settles) can hit fresh
 * per-file content for a repo the specialist was asked about but whose
 * VFS is empty / stale.
 *
 * Important:
 *   - cooldown-dedup per (workspaceId, owner, repo) so repeated queries
 *     don't spam cloud's queue.
 *   - response bodies are cancelled on resolution to avoid starving the
 *     Worker in-flight HTTP cap (sage#115 learning).
 *   - All outbound fetches go through globalThis.fetch (see
 *     .claude/rules/workers-fetch.md).
 *   - When the cloud API token isn't configured the factory returns a
 *     no-op CloneRequester so the rest of the specialist degrades
 *     gracefully.
 */

const DEFAULT_COOLDOWN_MS = 300_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const CLEANUP_THRESHOLD = 1_000;
const CLONE_REQUEST_PATH = "/api/v1/github/clone/request";

export interface CloneRequesterConfig {
  cloudApiUrl: string;
  cloudApiToken: string;
  cooldownMs?: number;
  failureCooldownMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

export interface CloneRequester {
  requestIfNeeded(workspaceId: string, owner: string, repo: string): void;
  readonly cooldownSize: number;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

class HttpCloneRequester implements CloneRequester {
  private readonly baseUrl: string;
  private readonly cloudApiToken: string;
  private readonly cooldownMs: number;
  private readonly failureCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;
  private readonly cooldowns = new Map<string, number>();
  private readonly inflight = new Set<string>();

  constructor(config: CloneRequesterConfig) {
    const url = config.cloudApiUrl?.trim();
    const token = config.cloudApiToken?.trim();
    if (!url) throw new Error("CloneRequester requires cloudApiUrl");
    if (!token) throw new Error("CloneRequester requires cloudApiToken");
    this.baseUrl = url.replace(/\/+$/, "");
    this.cloudApiToken = token;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.failureCooldownMs = config.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = config.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = config.now ?? Date.now;
    this.logger = config.logger ?? console;
  }

  get cooldownSize(): number {
    return this.cooldowns.size;
  }

  requestIfNeeded(workspaceId: string, owner: string, repo: string): void {
    const workspace = workspaceId?.trim();
    const ownerTrim = owner?.trim();
    const repoTrim = repo?.trim();
    if (!workspace || !ownerTrim || !repoTrim) return;

    const key = `${workspace}:${ownerTrim}/${repoTrim}`;
    const now = this.now();

    this.cleanupExpired(now);

    const cooldownExpiresAt = this.cooldowns.get(key);
    if ((cooldownExpiresAt !== undefined && cooldownExpiresAt > now) || this.inflight.has(key)) {
      return;
    }

    this.inflight.add(key);

    try {
      // Fire-and-forget, but still consume the body and inspect status so
      // Workers doesn't retain the response and operators can see rejected
      // warmups instead of losing them behind a cooldown.
      this.doFetch(`${this.baseUrl}${CLONE_REQUEST_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cloudApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: workspace,
          owner: ownerTrim,
          repo: repoTrim,
          ref: "HEAD",
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
        .then(async (response) => {
          const bodyText = await response.text().catch(() => "");
          if (!response.ok) {
            this.applyFailureCooldown(key);
            this.logger.warn("[specialist/clone-requester] clone request rejected", {
              workspaceId: workspace,
              owner: ownerTrim,
              repo: repoTrim,
              status: response.status,
              body: bodyText.slice(0, 300),
            });
            return;
          }
          this.cooldowns.set(key, this.now() + this.cooldownMs);
        })
        .catch((error: unknown) => {
          this.applyFailureCooldown(key);
          this.logger.warn(
            `[specialist/clone-requester] clone request failed for ${key}: ${toErrorMessage(error)}`,
          );
        })
        .finally(() => {
          this.inflight.delete(key);
        });
    } catch (error) {
      this.inflight.delete(key);
      this.applyFailureCooldown(key);
      this.logger.warn(
        `[specialist/clone-requester] clone request failed for ${key}: ${toErrorMessage(error)}`,
      );
    }
  }

  private applyFailureCooldown(key: string): void {
    if (this.failureCooldownMs <= 0) {
      return;
    }
    this.cooldowns.set(key, this.now() + this.failureCooldownMs);
  }

  private cleanupExpired(now: number): void {
    if (this.cooldowns.size <= CLEANUP_THRESHOLD) return;
    for (const [key, expiresAt] of this.cooldowns) {
      if (expiresAt <= now) {
        this.cooldowns.delete(key);
      }
    }
  }
}

class NoopCloneRequester implements CloneRequester {
  readonly cooldownSize = 0;
  requestIfNeeded(): void {
    /* no-op */
  }
}

/**
 * Factory — returns a no-op impl when cloudApiUrl or cloudApiToken is
 * empty so the specialist can still run (just without triggering VFS
 * warmup clones).
 */
export function createCloneRequester(config: {
  cloudApiUrl?: string;
  cloudApiToken?: string;
  cooldownMs?: number;
  failureCooldownMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}): CloneRequester {
  const url = config.cloudApiUrl?.trim();
  const token = config.cloudApiToken?.trim();
  if (!url || !token) {
    return new NoopCloneRequester();
  }
  return new HttpCloneRequester({
    cloudApiUrl: url,
    cloudApiToken: token,
    ...(config.cooldownMs !== undefined ? { cooldownMs: config.cooldownMs } : {}),
    ...(config.failureCooldownMs !== undefined ? { failureCooldownMs: config.failureCooldownMs } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.now ? { now: config.now } : {}),
    ...(config.logger ? { logger: config.logger } : {}),
  });
}

// Exported for tests that need to assert no-op vs real behaviour.
export { HttpCloneRequester, NoopCloneRequester };

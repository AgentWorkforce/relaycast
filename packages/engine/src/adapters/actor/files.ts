import type { FileStorage } from '../../ports/files.js';
import { signFileToken, type FileTokenPayload } from '../../lib/fileTokens.js';

const URL_TTL_SECONDS = 3600;
/**
 * How long a gateway's stored-size record ({@link SignedUrlFileStorageOptions.storedSize})
 * lives: past the upload URL's lifetime, plus a margin for a slow `complete`.
 */
export const FILE_STORED_TTL_SECONDS = URL_TTL_SECONDS + 15 * 60;
const DELETE_TTL_SECONDS = 300;
const STAT_TTL_SECONDS = 60;
/** Completion waits this long at most for the gateway; it holds the actor's mailbox meanwhile. */
const STAT_TIMEOUT_MS = 5_000;
/** A gateway that does not answer must not hold the actor's mailbox. */
const DELETE_TIMEOUT_MS = 10_000;

/** Path the gateway serves signed file URLs on. */
export const ACTOR_FILE_ROUTE = '/_relayfiles';

/** Response header a gateway answers a signed `stat` (`HEAD`) with: the stored byte count. */
export const OBJECT_SIZE_HEADER = 'x-relaycast-object-size';

/**
 * File storage for a workspace actor. Blob bytes never pass through the
 * actor: upload, download and delete URLs point at the gateway's
 * `/_relayfiles` route, signed with a secret the gateway shares, and the
 * gateway moves the bytes to and from its blob store (`verifyFileToken`). An
 * upload URL binds the declared size and content type, which the gateway
 * enforces.
 *
 * Upload completion verifies the stored bytes, as on every adapter. The
 * gateway reports each upload it stored to the actor (`fileStored`, through
 * the control plane) and acknowledges the PUT only once the actor has the
 * record, so `statObject` reads it through `storedSize` and needs no network.
 *
 * Without a record it asks the gateway (`HEAD` with a signed `stat` token)
 * inside the completing request through `statFetch`, bounded by a short
 * timeout. That fallback exists only for gateways that predate `fileStored`
 * (a rolling deploy): it needs the actor to reach `baseUrl`, which a pod whose
 * egress is limited to public addresses may not. `deleteObjects` calls the gateway through `fetch`, which the
 * actor runtime allows only during maintenance; inside a request it fails, and
 * the engine's durable cleanup queue retries the deletion from maintenance.
 */
export interface SignedUrlFileStorageOptions {
  /** Public origin of the gateway that serves {@link ACTOR_FILE_ROUTE}. */
  baseUrl: string;
  /** HMAC secret shared with that gateway. */
  secret: string;
  /** Transport for blob deletes. */
  fetch: typeof globalThis.fetch;
  /** Transport for upload completion's size check without a stored-size record (gateways that predate `fileStored`). */
  statFetch: typeof globalThis.fetch;
  /**
   * The size the gateway reported storing under a key (`fileStored`), or
   * `null` when it reported nothing (still valid). Absent: always `stat`.
   */
  storedSize?: (storageKey: string) => Promise<number | null>;
  /** Per-delete timeout. Default 10s. */
  deleteTimeoutMs?: number;
}

export class SignedUrlFileStorage implements FileStorage {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly statFetch: typeof globalThis.fetch;
  private readonly storedSize: ((storageKey: string) => Promise<number | null>) | undefined;
  private readonly deleteTimeoutMs: number;

  constructor(options: SignedUrlFileStorageOptions) {
    this.baseUrl = options.baseUrl;
    this.secret = options.secret;
    this.fetch = options.fetch;
    this.statFetch = options.statFetch;
    this.storedSize = options.storedSize;
    this.deleteTimeoutMs = options.deleteTimeoutMs ?? DELETE_TIMEOUT_MS;
  }

  /**
   * The stored size: the gateway's `fileStored` record when there is one,
   * else asked of the gateway; `null` when nothing is stored under `storageKey`.
   */
  async statObject(args: { storageKey: string }): Promise<{ sizeBytes: number } | null> {
    const recorded = await this.storedSize?.(args.storageKey);
    if (recorded !== undefined && recorded !== null) return { sizeBytes: recorded };
    const exp = Math.floor(Date.now() / 1000) + STAT_TTL_SECONDS;
    const response = await this.statFetch(await this.url({ key: args.storageKey, op: 'stat', exp }), {
      method: 'HEAD',
      signal: AbortSignal.timeout(STAT_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status === 404) return null;
    const size = Number(response.headers.get(OBJECT_SIZE_HEADER));
    if (!response.ok || !Number.isSafeInteger(size)) {
      throw new Error(`Blob stat failed for ${args.storageKey} (HTTP ${response.status})`);
    }
    return { sizeBytes: size };
  }

  private async url(payload: FileTokenPayload): Promise<string> {
    const token = await signFileToken(this.secret, payload);
    return `${this.baseUrl.replace(/\/$/, '')}${ACTOR_FILE_ROUTE}?token=${token}`;
  }

  async createUploadUrl(args: { storageKey: string; contentType: string; sizeBytes: number }) {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    return {
      uploadUrl: await this.url({ key: args.storageKey, op: 'put', exp, size: args.sizeBytes, type: args.contentType }),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async createDownloadUrl(args: { storageKey: string }): Promise<string> {
    return this.url({ key: args.storageKey, op: 'get', exp: Math.floor(Date.now() / 1000) + URL_TTL_SECONDS });
  }

  /** Deletes in order; when one fails (or the pass's budget runs out) it reports the keys already gone. */
  async deleteObjects(args: { storageKeys: string[] }): Promise<void | { deletedKeys: string[] }> {
    const deletedKeys: string[] = [];
    for (const key of args.storageKeys) {
      try {
        await this.deleteObject(key);
      } catch (error) {
        if (deletedKeys.length === 0) throw error;
        return { deletedKeys };
      }
      deletedKeys.push(key);
    }
  }

  private async deleteObject(key: string): Promise<void> {
    // A fresh token per key: a long batch must not outlive one shared expiry.
    const exp = Math.floor(Date.now() / 1000) + DELETE_TTL_SECONDS;
    const response = await this.fetch(await this.url({ key, op: 'delete', exp }), {
      method: 'DELETE',
      signal: AbortSignal.timeout(this.deleteTimeoutMs),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Blob delete failed for ${key} (HTTP ${response.status})`);
  }
}

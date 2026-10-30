import type { FileStorage } from '../../ports/files.js';
import { signFileToken, type FileTokenPayload } from '../../lib/fileTokens.js';

const URL_TTL_SECONDS = 3600;
const DELETE_TTL_SECONDS = 300;
/** A gateway that does not answer must not hold the actor's mailbox. */
const DELETE_TIMEOUT_MS = 10_000;

/** Path the gateway serves signed file URLs on. */
export const ACTOR_FILE_ROUTE = '/_relayfiles';

/**
 * File storage for a workspace actor. Blob bytes never pass through the
 * actor: upload, download and delete URLs point at the gateway's
 * `/_relayfiles` route, signed with a secret the gateway shares, and the
 * gateway moves the bytes to and from its blob store (`verifyFileToken`). An
 * upload URL binds the declared size and content type, which the gateway
 * enforces.
 *
 * `deleteObjects` calls the gateway through `fetch`, which the actor runtime
 * allows only during maintenance; inside a request it fails, and the engine's
 * durable cleanup queue retries the deletion from maintenance. Upload
 * completion is trusted (no `statObject`).
 */
export class SignedUrlFileStorage implements FileStorage {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetch: typeof globalThis.fetch,
    private readonly deleteTimeoutMs: number = DELETE_TIMEOUT_MS,
  ) {}

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

  async deleteObjects(args: { storageKeys: string[] }): Promise<void> {
    const exp = Math.floor(Date.now() / 1000) + DELETE_TTL_SECONDS;
    for (const key of args.storageKeys) {
      const response = await this.fetch(await this.url({ key, op: 'delete', exp }), {
        method: 'DELETE',
        signal: AbortSignal.timeout(this.deleteTimeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`Blob delete failed for ${key} (HTTP ${response.status})`);
    }
  }
}

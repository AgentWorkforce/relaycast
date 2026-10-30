import type { FileStorage } from '../../ports/files.js';
import { signFileToken } from '../../lib/fileTokens.js';

const URL_TTL_SECONDS = 3600;

/** Path the gateway serves signed file URLs on. */
export const ACTOR_FILE_ROUTE = '/_relayfiles';

/**
 * File storage for a workspace actor. Blob bytes never pass through the
 * actor: upload and download URLs point at the gateway's `/_relayfiles`
 * route, signed with a secret the gateway shares, and the gateway moves the
 * bytes to and from its blob store (`verifyFileToken`).
 *
 * The actor cannot reach the blob store, so it does not implement the
 * optional `statObject` / `deleteObjects`: upload completion is trusted, and
 * deleted blobs stay in the blob store until a store-side lifecycle rule
 * removes them.
 */
export class SignedUrlFileStorage implements FileStorage {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  private async url(key: string, op: 'put' | 'get', exp: number): Promise<string> {
    const token = await signFileToken(this.secret, { key, op, exp });
    return `${this.baseUrl.replace(/\/$/, '')}${ACTOR_FILE_ROUTE}?token=${token}`;
  }

  async createUploadUrl(args: { storageKey: string; contentType: string; sizeBytes: number }) {
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
    return {
      uploadUrl: await this.url(args.storageKey, 'put', exp),
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async createDownloadUrl(args: { storageKey: string }): Promise<string> {
    return this.url(args.storageKey, 'get', Math.floor(Date.now() / 1000) + URL_TTL_SECONDS);
  }
}

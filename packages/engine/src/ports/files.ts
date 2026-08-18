/**
 * File storage port — replaces the R2/S3 presigned-URL surface in `engine/file.ts`.
 *
 * The database rows (the `files` table: pending → complete → deleted lifecycle)
 * are portable domain logic and stay in the engine. Only the blob backend is the
 * port: Cloudflare signs R2 (S3-compatible) URLs and deletes R2 objects; the
 * Node adapter stores blobs on local disk, serves them through an engine-mounted
 * download route using a short-lived signed token, and removes them from disk.
 */
export interface FileStorage {
  /**
   * Return a URL the client can `PUT` the file bytes to, valid ~1h.
   * `storageKey` is the engine-assigned object key (`<workspaceId>/<id>/<name>`).
   */
  createUploadUrl(args: {
    storageKey: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<{ uploadUrl: string; expiresAt: string }>;

  /** Return a URL the client can `GET` the file bytes from, valid ~1h. */
  createDownloadUrl(args: { storageKey: string }): Promise<string>;

  /**
   * Permanently remove the supplied objects. Implementations must be
   * idempotent and resolve only after previously issued download URLs can no
   * longer read the bytes.
   */
  deleteObjects(args: { storageKeys: string[] }): Promise<void>;
}

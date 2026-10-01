import { eq, and, ne, sql } from 'drizzle-orm';
import { files, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import type { getDb } from '../db/index.js';
import type { FileStorage } from '../ports/files.js';

type Db = ReturnType<typeof getDb>;

export async function createUpload(
  db: Db,
  storage: FileStorage,
  workspaceId: string,
  agentId: string,
  data: { filename: string; content_type: string; size_bytes: number },
) {
  const id = generateId();
  const storageKey = `${workspaceId}/${id}/${data.filename}`;

  // Sign the upload URL before persisting, so a storage error doesn't leave an
  // orphaned `pending` row behind.
  const { uploadUrl, expiresAt } = await storage.createUploadUrl({
    storageKey,
    contentType: data.content_type,
    sizeBytes: data.size_bytes,
  });
  const uploadExpiresAt = new Date(expiresAt);
  if (!Number.isFinite(uploadExpiresAt.getTime())) {
    throw new Error('File storage returned an invalid upload expiry');
  }

  await db.insert(files).values({
    id,
    workspaceId,
    uploadedBy: agentId,
    filename: data.filename,
    contentType: data.content_type,
    sizeBytes: data.size_bytes,
    storageKey,
    uploadExpiresAt,
    status: 'pending',
  });

  return {
    id,
    upload_url: uploadUrl,
    expires_at: expiresAt,
  };
}

export async function completeUpload(
  db: Db,
  storage: FileStorage,
  workspaceId: string,
  fileId: string,
  agentId: string,
) {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)));

  if (!file || file.uploadedBy !== agentId || file.status !== 'pending') {
    return null;
  }

  // Generate the URL before flipping status, so a transient storage error keeps
  // completeUpload retry-safe (the row stays `pending` rather than `complete`).
  const downloadUrl = await storage.createDownloadUrl({ storageKey: file.storageKey });

  await db
    .update(files)
    .set({ status: 'complete' })
    .where(eq(files.id, fileId));

  return {
    id: file.id,
    download_url: downloadUrl,
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
  };
}

export async function getFile(db: Db, storage: FileStorage, workspaceId: string, fileId: string) {
  const [file] = await db
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.workspaceId, workspaceId),
        ne(files.status, 'deleted'),
      ),
    );
  if (!file) return null;

  const [agent] = await db.select().from(agents).where(eq(agents.id, file.uploadedBy));

  let downloadUrl: string | null = null;
  if (file.status === 'complete') {
    downloadUrl = await storage.createDownloadUrl({ storageKey: file.storageKey });
  }

  return {
    id: file.id,
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
    status: file.status,
    uploaded_by: agent?.name ?? 'unknown',
    download_url: downloadUrl,
    created_at: file.createdAt.toISOString(),
  };
}

export async function deleteFile(
  db: Db,
  workspaceId: string,
  fileId: string,
  agentId: string,
): Promise<true | null | 'forbidden'> {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.workspaceId, workspaceId)));
  if (!file) return null;

  if (file.uploadedBy !== agentId) return 'forbidden';

  await db
    .update(files)
    .set({ status: 'deleted' })
    .where(eq(files.id, fileId));

  return true;
}

export async function listFiles(
  db: Db,
  workspaceId: string,
  opts?: { uploaded_by?: string; limit?: number },
) {
  const limit = Math.min(Math.max(opts?.limit || 50, 1), 100);

  const conditions = [
    eq(files.workspaceId, workspaceId),
    ne(files.status, 'deleted'),
  ];

  if (opts?.uploaded_by) {
    conditions.push(eq(files.uploadedBy, opts.uploaded_by));
  }

  const rows = await db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(sql`${files.createdAt} DESC`)
    .limit(limit);

  return rows.map((f) => ({
    id: f.id,
    filename: f.filename,
    content_type: f.contentType,
    size_bytes: f.sizeBytes,
    status: f.status,
    created_at: f.createdAt.toISOString(),
  }));
}

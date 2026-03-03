import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { eq, and, ne, sql } from 'drizzle-orm';
import { files, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';
import type { getDb } from '../db/index.js';
import { touchLastActivity } from './workspace.js';

type Db = ReturnType<typeof getDb>;

/**
 * Build an S3-compatible client pointing at R2.
 * R2 exposes an S3-compatible API at `<account-id>.r2.cloudflarestorage.com`.
 */
function getS3Client(accountId: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: 'auto',
    credentials: { accessKeyId, secretAccessKey },
  });
}

const BUCKET = 'relaycast-files';

export async function createUpload(
  db: Db,
  s3: S3Client,
  workspaceId: string,
  agentId: string,
  data: { filename: string; content_type: string; size_bytes: number },
) {
  const id = generateId();
  const storageKey = `${workspaceId}/${id}/${data.filename}`;

  await db.insert(files).values({
    id,
    workspaceId,
    uploadedBy: agentId,
    filename: data.filename,
    contentType: data.content_type,
    sizeBytes: data.size_bytes,
    storageKey,
    status: 'pending',
  });

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    ContentType: data.content_type,
    ContentLength: data.size_bytes,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

  await touchLastActivity(db, workspaceId);

  return {
    id,
    upload_url: uploadUrl,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
}

export async function completeUpload(
  db: Db,
  s3: S3Client,
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

  await db
    .update(files)
    .set({ status: 'complete' })
    .where(eq(files.id, fileId));

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: file.storageKey,
  });
  const downloadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

  return {
    id: file.id,
    download_url: downloadUrl,
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
  };
}

export async function getFile(db: Db, s3: S3Client, workspaceId: string, fileId: string) {
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
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: file.storageKey,
    });
    downloadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
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

export { getS3Client };

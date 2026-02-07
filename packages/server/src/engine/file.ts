import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { eq, and, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { files, agents } from '../db/schema.js';
import { generateId } from './snowflake.js';

const BUCKET = process.env.S3_BUCKET || 'relay-files';

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
    region: process.env.S3_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY || 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_KEY || 'minioadmin',
    },
  });
}

export async function createUpload(
  workspaceId: string,
  agentId: string,
  data: { filename: string; content_type: string; size_bytes: number },
) {
  const db = getDb();
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

  const s3 = getS3Client();
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: storageKey,
    ContentType: data.content_type,
    ContentLength: data.size_bytes,
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

  return {
    id,
    upload_url: uploadUrl,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
}

export async function completeUpload(
  workspaceId: string,
  fileId: string,
  agentId: string,
) {
  const db = getDb();

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

  const s3 = getS3Client();
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

export async function getFile(workspaceId: string, fileId: string) {
  const db = getDb();

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
    const s3 = getS3Client();
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
  workspaceId: string,
  fileId: string,
  agentId: string,
): Promise<true | null | 'forbidden'> {
  const db = getDb();

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
  workspaceId: string,
  opts?: { uploaded_by?: string; limit?: number },
) {
  const db = getDb();
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

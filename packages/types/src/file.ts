import { z } from 'zod';

export const FileStatusSchema = z.enum(['pending', 'complete', 'deleted']);
export type FileStatus = z.infer<typeof FileStatusSchema>;

export const FileRecordSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  uploaded_by: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
  storage_key: z.string(),
  status: FileStatusSchema,
  created_at: z.string(),
});
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const UploadRequestSchema = z.object({
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number(),
});
export type UploadRequest = z.infer<typeof UploadRequestSchema>;

export const UploadResponseSchema = z.object({
  file_id: z.string(),
  upload_url: z.string(),
  expires_at: z.string(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;

export const FileAttachmentSchema = z.object({
  file_id: z.string(),
  filename: z.string(),
  url: z.string(),
  size: z.number(),
});
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

export const FileInfoSchema = z.object({
  file_id: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size: z.number(),
  url: z.string(),
  uploaded_by: z.string(),
  created_at: z.string(),
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

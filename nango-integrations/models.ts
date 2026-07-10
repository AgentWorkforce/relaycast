import * as z from 'zod';

export const ActionResponseErrorDetails = z.object({
  message: z.string(),
  method: z.string(),
  url: z.string(),
  code: z.string(),
});
export type ActionResponseErrorDetails = z.infer<typeof ActionResponseErrorDetails>;

export const ActionResponseError = z.object({
  message: z.string(),
  details: ActionResponseErrorDetails.optional(),
});
export type ActionResponseError = z.infer<typeof ActionResponseError>;

export const NotionRichPageInput = z.object({
  pageId: z.string(),
});
export type NotionRichPageInput = z.infer<typeof NotionRichPageInput>;

export const NotionContentMetadata = z.object({
  id: z.string(),
  path: z.string().optional(),
  type: z.union([z.literal('page'), z.literal('database')]),
  last_modified: z.string(),
  title: z.string().optional(),
  parent_id: z.string().optional(),
});
export type NotionContentMetadata = z.infer<typeof NotionContentMetadata>;

export const NotionRichPage = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  content: z.string(),
  contentType: z.string(),
  meta: z.record(z.string(), z.any()),
  last_modified: z.string(),
  parent_id: z.string().optional(),
});
export type NotionRichPage = z.infer<typeof NotionRichPage>;

export const NotionDatabaseInput = z.object({
  databaseId: z.string(),
});
export type NotionDatabaseInput = z.infer<typeof NotionDatabaseInput>;

export const NotionDatabasePaginatedInput = z.object({
  databaseId: z.string(),
  next_cursor: z.string().optional(),
});
export type NotionDatabasePaginatedInput = z.infer<typeof NotionDatabasePaginatedInput>;

export const NotionDatabaseChangesInput = z.object({
  databaseId: z.string(),
  next_cursor: z.string().optional(),
  timestamp: z.string(),
});
export type NotionDatabaseChangesInput = z.infer<typeof NotionDatabaseChangesInput>;

export const NotionDatabaseEntry = z.record(z.string(), z.any());
export type NotionDatabaseEntry = z.infer<typeof NotionDatabaseEntry>;

export const NotionDatabaseBase = z.object({
  id: z.string(),
  last_modified: z.string(),
  entries: NotionDatabaseEntry.array(),
  schema: z.record(z.string(), z.any()),
});
export type NotionDatabaseBase = z.infer<typeof NotionDatabaseBase>;

export const NotionDatabase = z.object({
  id: z.string(),
  last_modified: z.string(),
  entries: NotionDatabaseEntry.array(),
  schema: z.record(z.string(), z.any()),
  path: z.string(),
  title: z.string(),
  meta: z.record(z.string(), z.any()),
});
export type NotionDatabase = z.infer<typeof NotionDatabase>;

export const NotionDatabaseBaseWithCursor = z.object({
  id: z.string(),
  last_modified: z.string(),
  entries: NotionDatabaseEntry.array(),
  schema: z.record(z.string(), z.any()),
  next_cursor: z.string().optional(),
});
export type NotionDatabaseBaseWithCursor = z.infer<typeof NotionDatabaseBaseWithCursor>;

export const NotionDatabaseWithPagination = z.object({
  id: z.string(),
  last_modified: z.string(),
  entries: NotionDatabaseEntry.array(),
  schema: z.record(z.string(), z.any()),
  path: z.string(),
  title: z.string(),
  meta: z.record(z.string(), z.any()),
  next_cursor: z.string().optional(),
});
export type NotionDatabaseWithPagination = z.infer<typeof NotionDatabaseWithPagination>;

export const NotionUrlOrId = z.object({
  url: z.string().optional(),
  id: z.string().optional(),
});
export type NotionUrlOrId = z.infer<typeof NotionUrlOrId>;

export const RecallRecording = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  status: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
  transcript_text: z.string().nullable().optional(),
}).passthrough();
export type RecallRecording = z.infer<typeof RecallRecording>;

export const RecallTranscript = z.object({
  id: z.string(),
  recording_id: z.string().optional(),
  transcript_text: z.string().nullable().optional(),
  transcript: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();
export type RecallTranscript = z.infer<typeof RecallTranscript>;

export const RecallSdkUpload = z.object({
  id: z.string(),
  recording_id: z.string(),
  upload_token: z.string(),
  status: z.unknown().optional(),
  created_at: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type RecallSdkUpload = z.infer<typeof RecallSdkUpload>;

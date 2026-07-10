import { z } from 'zod';
import {
  notionRichPageSchema as NotionRichPage,
  notionDatabasePaginatedInputSchema as NotionDatabasePaginatedInput,
  notionDatabaseChangesInputSchema as NotionDatabaseChangesInput,
} from './schema.zod.js';
import type { NotionDatabase, NotionDatabaseWithPagination } from './models.js';
import type { PartialDatabaseObjectResponse } from './notion-relay/types.js';

const IdString = z.union([z.string(), z.number()]).transform(String);

const StrictDateString = z
  .string()
  .refine(
    (data: unknown) => {
      if (typeof data !== 'string') {
        return false;
      }
      const date = new Date(data);
      return !isNaN(date.getTime());
    },
    { message: 'Expected valid date string' },
  )
  .transform((data: string) => new Date(data).toISOString());

export const NotionRichPageSchema = NotionRichPage.extend({
  id: IdString,
  last_modified: StrictDateString,
});

export const NotionRichPageInputSchema = z.object({
  pageId: IdString,
});

export const NotionDatabaseInputSchema = z.object({
  databaseId: IdString,
});

export const NotionDatabasePaginatedInputSchema = NotionDatabasePaginatedInput.extend({
  databaseId: IdString,
});

export const NotionDatabaseChangesInputSchema = NotionDatabaseChangesInput.extend({
  databaseId: IdString,
});

export type NotionDatabaseOverride = Omit<NotionDatabase, 'schema' | 'entries'> & {
  schema: PartialDatabaseObjectResponse['properties'];
  entries: PartialDatabaseObjectResponse['properties'][];
};

export type NotionDatabaseWithPaginationSchema = Omit<NotionDatabaseWithPagination, 'schema' | 'entries'> & {
  schema: PartialDatabaseObjectResponse['properties'];
  entries: PartialDatabaseObjectResponse['properties'][];
};

export const RecallRecordingSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  status: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
  transcript_text: z.string().nullable().optional(),
}).passthrough();

export const RecallTranscriptSchema = z.object({
  id: z.string(),
  recording_id: z.string().optional(),
  transcript_text: z.string().nullable().optional(),
  transcript: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
}).passthrough();

export const RecallSdkUploadSchema = z.object({
  id: z.string(),
  recording_id: z.string(),
  upload_token: z.string(),
  status: z.unknown().optional(),
  created_at: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

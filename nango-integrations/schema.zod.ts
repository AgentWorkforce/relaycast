import { z } from 'zod';

export const notionRichPageSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  content: z.string(),
  contentType: z.string(),
  meta: z.record(z.string(), z.any()),
  last_modified: z.string(),
  parent_id: z.string().optional(),
});

export const notionDatabasePaginatedInputSchema = z.object({
  databaseId: z.string(),
  next_cursor: z.string().optional(),
});

export const notionDatabaseChangesInputSchema = z.object({
  databaseId: z.string(),
  next_cursor: z.string().optional(),
  timestamp: z.string(),
});

export const notionUrlOrIdSchema = z.object({
  url: z.string().optional(),
  id: z.string().optional(),
});

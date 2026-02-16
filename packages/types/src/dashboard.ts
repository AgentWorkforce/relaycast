import { z } from 'zod';

export const WorkspaceStatsSchema = z.object({
  agents: z.object({ total: z.number(), online: z.number(), offline: z.number() }),
  channels: z.object({ total: z.number(), archived: z.number() }),
  messages: z.object({ total: z.number(), today: z.number() }),
  dms: z.object({ total_conversations: z.number() }),
  files: z.object({ total: z.number(), storage_bytes: z.number() }),
});
export type WorkspaceStats = z.infer<typeof WorkspaceStatsSchema>;

export const ActivityItemSchema = z.object({
  type: z.enum(['message', 'dm']),
  id: z.string(),
  channel_name: z.string().optional(),
  conversation_id: z.string().optional(),
  agent_name: z.string(),
  text: z.string(),
  created_at: z.string(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const WorkspaceDmConversationSchema = z.object({
  id: z.string(),
  type: z.string(),
  participants: z.array(z.string()),
  last_message: z.object({
    text: z.string(),
    agent_name: z.string(),
    created_at: z.string(),
  }).nullable(),
  message_count: z.number(),
});
export type WorkspaceDmConversation = z.infer<typeof WorkspaceDmConversationSchema>;

export const TokenRotateResponseSchema = z.object({
  name: z.string(),
  token: z.string(),
});
export type TokenRotateResponse = z.infer<typeof TokenRotateResponseSchema>;

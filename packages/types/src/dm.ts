import { z } from 'zod';

export const DmTypeSchema = z.enum(['1:1', 'group']);
export type DmType = z.infer<typeof DmTypeSchema>;

export const DmConversationSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  channel_id: z.string(),
  dm_type: DmTypeSchema,
  name: z.string().nullable(),
  created_at: z.string(),
});
export type DmConversation = z.infer<typeof DmConversationSchema>;

export const DmParticipantSchema = z.object({
  conversation_id: z.string(),
  agent_id: z.string(),
  joined_at: z.string(),
  left_at: z.string().nullable(),
});
export type DmParticipant = z.infer<typeof DmParticipantSchema>;

export const SendDmRequestSchema = z.object({
  to: z.string(),
  text: z.string(),
});
export type SendDmRequest = z.infer<typeof SendDmRequestSchema>;

export const CreateGroupDmRequestSchema = z.object({
  participants: z.array(z.string()),
  name: z.string().optional(),
  text: z.string(),
});
export type CreateGroupDmRequest = z.infer<typeof CreateGroupDmRequestSchema>;

export const DmConversationSummarySchema = z.object({
  id: z.string(),
  type: DmTypeSchema,
  name: z.string().nullable(),
  participants: z.array(z.string()),
  last_message: z.string().nullable(),
  unread_count: z.number(),
});
export type DmConversationSummary = z.infer<typeof DmConversationSummarySchema>;

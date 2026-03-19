import { z } from 'zod';
import { CoreMessagePayloadSchema, MessageInjectionModeSchema } from './message.js';

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

export const DmInjectionModeSchema = MessageInjectionModeSchema;

export const SendDmRequestSchema = z.object({
  to: z.string(),
  text: z.string(),
  attachments: z.array(z.string()).optional(),
  mode: DmInjectionModeSchema.default('wait'),
});
export type SendDmRequest = z.infer<typeof SendDmRequestSchema>;

export const CreateGroupDmRequestSchema = z.object({
  participants: z.array(z.string()),
  name: z.string().optional(),
});
export type CreateGroupDmRequest = z.infer<typeof CreateGroupDmRequestSchema>;

export const DmConversationParticipantSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
});
export type DmConversationParticipant = z.infer<typeof DmConversationParticipantSchema>;

export const DmLastMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  agent_id: z.string(),
  created_at: z.string(),
});
export type DmLastMessage = z.infer<typeof DmLastMessageSchema>;

export const DmConversationSummarySchema = z.object({
  id: z.string(),
  type: DmTypeSchema,
  name: z.string().nullable(),
  participants: z.array(DmConversationParticipantSchema),
  last_message: DmLastMessageSchema.nullable(),
  unread_count: z.number(),
  created_at: z.string(),
});
export type DmConversationSummary = z.infer<typeof DmConversationSummarySchema>;

export const SendDmResponseSchema = z.object({
  conversation_id: z.string(),
  message: CoreMessagePayloadSchema,
  created_at: z.string(),
});
export type SendDmResponse = z.infer<typeof SendDmResponseSchema>;

export const CreateGroupDmResponseSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  dm_type: z.literal('group'),
  name: z.string().nullable(),
  participants: z.array(z.object({ agent_id: z.string() })),
  created_at: z.string(),
});
export type CreateGroupDmResponse = z.infer<typeof CreateGroupDmResponseSchema>;

export const GroupDmMessageResponseSchema = z.object({
  conversation_id: z.string(),
  message: CoreMessagePayloadSchema,
  created_at: z.string(),
});
export type GroupDmMessageResponse = z.infer<typeof GroupDmMessageResponseSchema>;

export const DmMessageSchema = CoreMessagePayloadSchema.extend({
  created_at: z.string(),
});
export type DmMessage = z.infer<typeof DmMessageSchema>;

export const GroupDmParticipantResponseSchema = z.object({
  conversation_id: z.string(),
  agent: z.string(),
  already_member: z.boolean(),
});
export type GroupDmParticipantResponse = z.infer<typeof GroupDmParticipantResponseSchema>;

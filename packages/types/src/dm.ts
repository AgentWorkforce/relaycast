import { z } from 'zod';
import { SentDeliverySchema } from './delivery.js';
import { AgentTypeSchema } from './agent.js';
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

/** Exactly one of `to` (agent name) or `address` (`agent@machine`). */
export const SendDmRequestSchema = z.object({
  to: z.string().optional(),
  address: z.string().optional(),
  text: z.string(),
  attachments: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  mode: DmInjectionModeSchema.default('wait'),
  /** Confirmation budget in ms (0–2000; 1000 recommended): the response parks for the recipient's acceptance. */
  wait_ms: z.number().int().min(0).max(2000).optional(),
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
  agent_type: AgentTypeSchema.optional(),
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
  /** The recipient's durable delivery row, or `null` when none was created (for example a replayed A2A acceptance). */
  delivery: SentDeliverySchema.omit({ agent_id: true }).nullable(),
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

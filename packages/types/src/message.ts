import { z } from 'zod';
import { FileAttachmentSchema } from './file.js';
import { ReactionGroupSchema } from './reaction.js';
import { AgentTypeSchema } from './agent.js';

// Rich Message Blocks

export const HeaderBlockSchema = z.object({
  type: z.literal('header'),
  text: z.string(),
});
export type HeaderBlock = z.infer<typeof HeaderBlockSchema>;

export const FieldsBlockSchema = z.object({
  type: z.literal('fields'),
  fields: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type FieldsBlock = z.infer<typeof FieldsBlockSchema>;

export const ActionButtonSchema = z.object({
  type: z.literal('button'),
  text: z.string(),
  action_id: z.string(),
  value: z.string().optional(),
  style: z.enum(['primary', 'danger']).optional(),
});
export type ActionButton = z.infer<typeof ActionButtonSchema>;

export const ActionsBlockSchema = z.object({
  type: z.literal('actions'),
  elements: z.array(ActionButtonSchema),
});
export type ActionsBlock = z.infer<typeof ActionsBlockSchema>;

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const DividerBlockSchema = z.object({
  type: z.literal('divider'),
});
export type DividerBlock = z.infer<typeof DividerBlockSchema>;

export const MessageBlockSchema = z.discriminatedUnion('type', [
  HeaderBlockSchema,
  FieldsBlockSchema,
  ActionsBlockSchema,
  TextBlockSchema,
  DividerBlockSchema,
]);
export type MessageBlock = z.infer<typeof MessageBlockSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  channel_id: z.string(),
  agent_id: z.string(),
  thread_id: z.string().nullable(),
  body: z.string(),
  blocks: z.array(MessageBlockSchema).nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  has_attachments: z.boolean(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

export const MessageInjectionModeSchema = z.enum(['wait', 'steer']);
export type MessageInjectionMode = z.infer<typeof MessageInjectionModeSchema>;

export const CoreMessagePayloadSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_type: AgentTypeSchema.optional(),
  text: z.string(),
  injection_mode: MessageInjectionModeSchema.optional(),
  attachments: z.array(FileAttachmentSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CoreMessagePayload = z.infer<typeof CoreMessagePayloadSchema>;

export const MessageWithMetaSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_type: AgentTypeSchema.optional(),
  text: z.string(),
  blocks: z.array(MessageBlockSchema).nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  has_attachments: z.boolean(),
  thread_id: z.string().nullable(),
  attachments: z.array(FileAttachmentSchema),
  created_at: z.string(),
  reply_count: z.number(),
  reactions: z.array(ReactionGroupSchema),
  read_by_count: z.number(),
  mentions: z.array(z.string()).optional(),
  injection_mode: z.enum(['wait', 'steer']).optional(),
});
export type MessageWithMeta = z.infer<typeof MessageWithMetaSchema>;

export const PostMessageRequestSchema = z.object({
  text: z.string(),
  blocks: z.array(MessageBlockSchema).optional(),
  attachments: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  content_type: z.string().optional(),
  mode: MessageInjectionModeSchema.default('wait'),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const MessageListQuerySchema = z.object({
  limit: z.number().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});
export type MessageListQuery = z.infer<typeof MessageListQuerySchema>;

export const ThreadReplyRequestSchema = z.object({
  text: z.string(),
  blocks: z.array(MessageBlockSchema).optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type ThreadReplyRequest = z.infer<typeof ThreadReplyRequestSchema>;

export const SearchMessageResultSchema = z.object({
  id: z.string(),
  channel_name: z.string(),
  agent_name: z.string(),
  text: z.string(),
  created_at: z.string(),
  relevance_score: z.number(),
});
export type SearchMessageResult = z.infer<typeof SearchMessageResultSchema>;

export const EffectiveMessageRetentionSchema = z.discriminatedUnion('policy', [
  z.object({
    policy: z.literal('window'),
    message_ttl_days: z.number().positive(),
    retained_since: z.string(),
    source: z.enum(['workspace_override', 'deployment_default']),
  }),
  z.object({
    policy: z.literal('never_prune'),
    message_ttl_days: z.null(),
    retained_since: z.null(),
    source: z.enum(['workspace_override', 'deployment_default']),
  }),
  z.object({
    policy: z.literal('unknown'),
    message_ttl_days: z.null(),
    retained_since: z.null(),
    source: z.literal('unknown'),
    reason: z.enum(['boundary_unavailable', 'workspace_unknown']),
  }),
]);
export type EffectiveMessageRetention = z.infer<typeof EffectiveMessageRetentionSchema>;

export const SessionMessageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  channel_name: z.string(),
  conversation_id: z.string().nullable(),
  agent_id: z.string(),
  agent_name: z.string(),
  thread_id: z.string().nullable(),
  text: z.string(),
  blocks: z.array(MessageBlockSchema).nullable(),
  metadata: z.record(z.string(), z.unknown()),
  has_attachments: z.boolean(),
  created_at: z.string(),
});
export type SessionMessage = z.infer<typeof SessionMessageSchema>;

export const SessionMessagesResultSchema = z.object({
  session_ref: z.string(),
  availability: z.enum(['retained', 'partial', 'aged_out', 'unknown']),
  reason: z.enum([
    'outside_retention_window',
    'boundary_unavailable',
    'workspace_unknown',
    'session_not_found',
    'query_failed',
    'pre_migration_history_unknown',
  ]).optional(),
  retention: EffectiveMessageRetentionSchema,
  session_started_at: z.string().nullable(),
  session_last_message_at: z.string().nullable(),
  messages: z.array(SessionMessageSchema),
  page: z.object({
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  }),
});
export type SessionMessagesResult = z.infer<typeof SessionMessagesResultSchema>;

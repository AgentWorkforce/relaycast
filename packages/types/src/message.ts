import { z } from 'zod';
import { SentDeliverySchema } from './delivery.js';
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

/** Action classes an owner approval can name (owner-named trusted delegates, v1). */
export const OWNER_APPROVAL_ACTION_CLASSES = [
  'merge',
  'pr_ops',
  'deploy',
  'release',
  'secret_change',
  'destructive',
  'spend',
  'external_comms',
  'prompt_approval',
  'config_change',
] as const;
export const OwnerApprovalActionClassSchema = z.enum(OWNER_APPROVAL_ACTION_CLASSES);
export type OwnerApprovalActionClass = z.infer<typeof OwnerApprovalActionClassSchema>;

/**
 * A condition Cloud checks at redeem. `ci_green`, `head_sha`,
 * `reviews_approved` and `mergeable` apply only to `owner/repo#N` targets;
 * `not_before` applies to any target and is the only one on `prompt_approval`
 * and `config_change`.
 */
export const OwnerApprovalConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ci_green') }).strict(),
  z.object({ type: z.literal('head_sha'), sha: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
  z.object({ type: z.literal('reviews_approved'), min: z.number().int().min(1).max(10) }).strict(),
  z.object({ type: z.literal('mergeable') }).strict(),
  z.object({ type: z.literal('not_before'), at: z.iso.datetime({ offset: true }) }).strict(),
]);
export type OwnerApprovalCondition = z.infer<typeof OwnerApprovalConditionSchema>;
export type OwnerApprovalConditionType = OwnerApprovalCondition['type'];

/**
 * Free text in an approval. U+0000 is refused: Postgres `jsonb` cannot store
 * it, so allowing it would make SQLite and Postgres disagree on one payload.
 */
const approvalText = (max: number, min = 0) => z.string().min(min).max(max)
  .refine((value) => !value.includes('\u0000'), 'must not contain U+0000');

/** An `owner/repo#N` pull request or issue target. */
const PULL_REQUEST_TARGET = /^[^\s/#]+\/[^\s/#]+#[1-9]\d*$/;
/** A `prompt_approval` target in an approval: `<agent id>:<request ref>`, no wildcard. */
const PROMPT_APPROVAL_TARGET = /^[^\s:*]+:[^\s*]+$/;
/**
 * A `config_change` target: `<agent id>:<setting>=<value>`, exact. Non-empty
 * agent id and setting (the setting is everything before the first `=`), a
 * non-empty value, and no `*` anywhere.
 */
const CONFIG_CHANGE_TARGET = /^[^\s:*]+:[^\s=*]+=[^*]+$/;
/** Classes whose targets are not repository targets: only `not_before` applies. */
const NOT_BEFORE_ONLY_CLASSES: ReadonlySet<string> = new Set(['prompt_approval', 'config_change']);
const PULL_REQUEST_CONDITIONS: ReadonlySet<string> = new Set(['ci_green', 'head_sha', 'reviews_approved', 'mergeable']);

export const OwnerApprovalActionSchema = z.object({
  class: OwnerApprovalActionClassSchema,
  target: approvalText(256),
  conditions: z.array(OwnerApprovalConditionSchema).max(5).optional(),
  note: approvalText(280).optional(),
}).strict().superRefine((action, ctx) => {
  if (action.class === 'prompt_approval' && !PROMPT_APPROVAL_TARGET.test(action.target)) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'prompt_approval target must be <agent id>:<request ref>' });
  }
  if (action.class === 'config_change' && !CONFIG_CHANGE_TARGET.test(action.target)) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'config_change target must be <agent id>:<setting>=<value> with no *' });
  }
  const notBeforeOnly = NOT_BEFORE_ONLY_CLASSES.has(action.class);
  const pullRequest = !notBeforeOnly && PULL_REQUEST_TARGET.test(action.target);
  action.conditions?.forEach((condition, index) => {
    if (PULL_REQUEST_CONDITIONS.has(condition.type) && !pullRequest) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditions', index, 'type'],
        message: notBeforeOnly
          ? `only not_before is valid on ${action.class}`
          : `${condition.type} is valid only on owner/repo#N targets`,
      });
    }
  });
});
export type OwnerApprovalAction = z.infer<typeof OwnerApprovalActionSchema>;

/**
 * A delegate's claim that a person approved the named actions, sent as
 * `owner_approval` on a channel message or DM. Relaycast validates and stores
 * it immutably; recipients see only `has_owner_approval`, and only Cloud's
 * attestation (via the by-message proof route) turns it into an approval.
 */
export const OwnerApprovalSchema = z.object({
  v: z.literal(1),
  owner_id: approvalText(128, 1),
  actions: z.array(OwnerApprovalActionSchema).min(1).max(20),
  quote: approvalText(2000).nullable().optional(),
  quoted_at: z.iso.datetime({ offset: true }).nullable().optional(),
  quote_source: approvalText(64).nullable().optional(),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional(),
  approval_ref: z.string().regex(/^apv_[A-Za-z0-9]{8,64}$/).nullable().optional(),
}).strict();
export type OwnerApproval = z.infer<typeof OwnerApprovalSchema>;

export const CoreMessagePayloadSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_type: AgentTypeSchema.optional(),
  /** Sender's `agent@machine` address at send time when the server recorded one. Omitted when the sender has no location node. */
  agent_address: z.string().optional(),
  text: z.string(),
  // The engine accepts arbitrary JSON blocks; realtime must not strip extensions.
  blocks: z.array(z.unknown()).nullable().optional(),
  injection_mode: MessageInjectionModeSchema.optional(),
  attachments: z.array(FileAttachmentSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** The recipient's message this DM explicitly answers (`reply_to_message_id` on send). */
  reply_to_message_id: z.string().nullable().optional(),
  /** `true` when the sender attached an owner approval. Never the approval itself. */
  has_owner_approval: z.literal(true).optional(),
});
export type CoreMessagePayload = z.infer<typeof CoreMessagePayloadSchema>;

export const MessageWithMetaSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  agent_type: AgentTypeSchema.optional(),
  /** Sender's `agent@machine` address at send time when the server recorded one. Omitted when the sender has no location node. */
  agent_address: z.string().optional(),
  text: z.string(),
  blocks: z.array(MessageBlockSchema).nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  has_attachments: z.boolean(),
  thread_id: z.string().nullable(),
  /** The message this one explicitly answers (a thread reply's parent); drives the sender's `replied` state. */
  reply_to_message_id: z.string().nullable().optional(),
  attachments: z.array(FileAttachmentSchema),
  created_at: z.string(),
  reply_count: z.number(),
  reactions: z.array(ReactionGroupSchema),
  read_by_count: z.number(),
  mentions: z.array(z.string()).optional(),
  injection_mode: z.enum(['wait', 'steer']).optional(),
  /** `true` on a send response or event when the sender attached an owner approval. Never the approval itself. */
  has_owner_approval: z.literal(true).optional(),
});
export type MessageWithMeta = z.infer<typeof MessageWithMetaSchema>;

export const PostMessageRequestSchema = z.object({
  text: z.string(),
  blocks: z.array(MessageBlockSchema).optional(),
  attachments: z.array(z.string()).optional(),
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  content_type: z.string().optional(),
  mode: MessageInjectionModeSchema.default('wait'),
  /** Confirmation budget in ms (0–2000; 1000 recommended): the response parks for the recipients' acceptance. */
  wait_ms: z.number().int().min(0).max(2000).optional(),
  owner_approval: OwnerApprovalSchema.nullable().optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

/** `POST /v1/channels/:name/messages`: the message plus the sender's delivery handles. */
export const PostMessageResponseSchema = MessageWithMetaSchema.extend({
  /** The per-recipient delivery rows this post created (the sender excluded), at most 50. */
  deliveries: z.array(SentDeliverySchema),
  /** True when more than 50 rows were created and `deliveries` holds only the first 50. */
  deliveries_truncated: z.boolean(),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponseSchema>;

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
  /** Sender's `agent@machine` address at send time when the server recorded one. Omitted when the sender has no location node. */
  agent_address: z.string().optional(),
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
    'response_invalid',
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
}).superRefine((result, ctx) => {
  if (result.availability !== 'unknown' && result.retention.policy === 'unknown') {
    ctx.addIssue({
      code: 'custom',
      path: ['availability'],
      message: 'unknown retention cannot be presented as replayable',
    });
  }
});
export type SessionMessagesResult = z.infer<typeof SessionMessagesResultSchema>;

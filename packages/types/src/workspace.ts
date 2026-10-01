import { z } from 'zod';
import { EffectiveMessageRetentionSchema } from './message.js';

export const WORKSPACE_CREATION_SOURCES = [
  'api',
  'sdk',
  'cli',
  'mcp',
  'ci',
  'relayflow',
  'dashboard',
  'other',
] as const;
export const WorkspaceCreationSourceSchema = z.enum(WORKSPACE_CREATION_SOURCES);
export type WorkspaceCreationSource = z.infer<typeof WorkspaceCreationSourceSchema>;

export const WORKSPACE_USAGE_CLASSIFICATIONS = ['internal', 'external', 'unknown'] as const;
export const WorkspaceUsageClassificationSchema = z.enum(WORKSPACE_USAGE_CLASSIFICATIONS);
export type WorkspaceUsageClassification = z.infer<typeof WorkspaceUsageClassificationSchema>;

const provenanceIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:/@-]+$/, 'must contain only letters, numbers, dot, underscore, colon, slash, @, or dash');

/** Caller-declared creation context. Analytics only; never an authorization claim. */
export const WorkspaceProvenanceInputSchema = z.object({
  source: WorkspaceCreationSourceSchema,
  origin_id: provenanceIdentifier.optional(),
  classification: WorkspaceUsageClassificationSchema.optional(),
});
export type WorkspaceProvenanceInput = z.infer<typeof WorkspaceProvenanceInputSchema>;

/** Durable provenance snapshot recorded by the server when a workspace is created. */
export const WorkspaceProvenanceSchema = WorkspaceProvenanceInputSchema.extend({
  source_basis: z.enum(['declared', 'origin_client', 'default']),
  origin_actor: z.string().optional(),
  actor_user_id: z.string().optional(),
  actor_machine_id: z.string().optional(),
  actor_org_id: z.string().optional(),
  actor_org_slug: z.string().optional(),
});
export type WorkspaceProvenance = z.infer<typeof WorkspaceProvenanceSchema>;

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  system_prompt: z.string().nullable(),
  plan: z.enum(['free', 'pro', 'enterprise']),
  created_at: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  effective_retention: z.object({
    messages: EffectiveMessageRetentionSchema,
  }).optional(),
  expires_at: z.string().nullable().optional(),
  provenance: WorkspaceProvenanceSchema.nullable().default(null),
  usage_classification: WorkspaceUsageClassificationSchema.default('unknown'),
  classification_source: z.enum(['creator', 'operator', 'unclassified']).default('unclassified'),
  classification_reason: z.string().nullable().default(null),
  classified_at: z.string().nullable().default(null),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string(),
  expires_in_seconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
  provenance: WorkspaceProvenanceInputSchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const CreateWorkspaceResponseSchema = z.object({
  workspace_id: z.string(),
  api_key: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable().optional(),
});
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;

export const WorkspaceLookupSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});
export type WorkspaceLookup = z.infer<typeof WorkspaceLookupSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().optional(),
  system_prompt: z.string().nullable().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

export const SystemPromptSchema = z.object({
  prompt: z.string(),
  is_default: z.boolean(),
});
export type SystemPrompt = z.infer<typeof SystemPromptSchema>;

export const SetSystemPromptRequestSchema = z.object({
  prompt: z.string().nullable().optional(),
  reset: z.boolean().optional(),
});
export type SetSystemPromptRequest = z.infer<typeof SetSystemPromptRequestSchema>;

// --- Activity, DM conversations, token rotation ---

export const ActivityItemSchema = z.object({
  type: z.enum(['message', 'dm']),
  id: z.string(),
  channel_id: z.string().optional(),
  channel_name: z.string().optional(),
  conversation_id: z.string().optional(),
  agent_name: z.string(),
  text: z.string(),
  created_at: z.string(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const WorkspaceDmConversationSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  type: z.string(),
  participants: z.array(z.string()),
  last_message: z.object({
    text: z.string(),
    agent_id: z.string(),
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

// --- Observer tokens ---

export const OBSERVER_SCOPES = [
  'stream:read',
  'messages:read',
  'threads:read',
  'dms:read',
  'channels:read',
  'search:read',
  'agents:read',
  'nodes:read',
  'deliveries:read',
  'activity:read',
  'files:read',
  'reactions:read',
] as const;
export type ObserverScope = typeof OBSERVER_SCOPES[number];

export const ObserverTokenFiltersSchema = z.object({
  channel_ids: z.array(z.string()).optional(),
  channel_names: z.array(z.string()).optional(),
  include_dms: z.boolean().optional(),
  dm_conversation_ids: z.array(z.string()).optional(),
  agent_ids: z.array(z.string()).optional(),
  event_types: z.array(z.string()).optional(),
  created_after: z.string().optional(),
});
export type ObserverTokenFilters = z.infer<typeof ObserverTokenFiltersSchema>;

export const CreateObserverTokenRequestSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  scopes: z.array(z.enum(OBSERVER_SCOPES)).min(1),
  filters: ObserverTokenFiltersSchema.optional(),
  expires_at: z.string().nullable().optional(),
});
export type CreateObserverTokenRequest = z.infer<typeof CreateObserverTokenRequestSchema>;

export const UpdateObserverTokenRequestSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  scopes: z.array(z.enum(OBSERVER_SCOPES)).min(1).optional(),
  filters: ObserverTokenFiltersSchema.optional(),
  expires_at: z.string().nullable().optional(),
});
export type UpdateObserverTokenRequest = z.infer<typeof UpdateObserverTokenRequestSchema>;

export const ObserverTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scopes: z.array(z.enum(OBSERVER_SCOPES)),
  filters: ObserverTokenFiltersSchema,
  status: z.enum(['active', 'revoked']),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  token: z.string().optional(),
});
export type ObserverToken = z.infer<typeof ObserverTokenSchema>;

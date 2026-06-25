import { z } from 'zod';

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  system_prompt: z.string().nullable(),
  plan: z.enum(['free', 'pro', 'enterprise']),
  created_at: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const CreateWorkspaceResponseSchema = z.object({
  workspace_id: z.string(),
  api_key: z.string().optional(),
  created_at: z.string(),
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

import { z } from 'zod';

export const WorkspaceSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  name: z.string(),
  system_prompt: z.string().nullable(),
  plan: z.enum(['free', 'pro']),
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
  api_key: z.string(),
  created_at: z.string(),
});
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;

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

import { z } from 'zod';

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  api_key_hash: z.string(),
  system_prompt: z.string().nullable(),
  plan: z.enum(['free', 'pro', 'enterprise']),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  created_at: z.string(),
  metadata: z.record(z.unknown()),
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
  system_prompt: z.string().optional(),
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

import { z } from 'zod';

export const AgentTypeSchema = z.enum(['agent', 'human', 'system']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentStatusSchema = z.enum(['online', 'offline', 'away']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: AgentTypeSchema,
  status: AgentStatusSchema,
  persona: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  last_seen: z.string(),
  created_at: z.string().optional(),
  channels: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['owner', 'member']),
    joined_at: z.string(),
  })).optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const CreateAgentRequestSchema = z.object({
  name: z.string(),
  type: AgentTypeSchema.optional(),
  persona: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const CreateAgentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  status: AgentStatusSchema,
  created_at: z.string(),
});
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

export const UpdateAgentRequestSchema = z.object({
  status: AgentStatusSchema.optional(),
  persona: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

export const AgentListQuerySchema = z.object({
  status: z.union([AgentStatusSchema, z.literal('all')]).optional(),
});
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;

export const AgentPresenceInfoSchema = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  status: z.enum(['online', 'offline']),
});
export type AgentPresenceInfo = z.infer<typeof AgentPresenceInfoSchema>;

// === Spawn/Release (Agent Lifecycle) ===

export const CliTypeSchema = z.enum(['claude', 'codex', 'gemini', 'aider', 'goose']);
export type CliType = z.infer<typeof CliTypeSchema>;

export const SpawnAgentRequestSchema = z.object({
  name: z.string(),
  cli: CliTypeSchema,
  task: z.string(),
  channel: z.string().nullable().optional(),
  persona: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SpawnAgentRequest = z.infer<typeof SpawnAgentRequestSchema>;

export const SpawnAgentResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  token: z.string(),
  cli: CliTypeSchema,
  task: z.string(),
  channel: z.string().nullable(),
  status: AgentStatusSchema,
  created_at: z.string(),
  already_existed: z.boolean(),
});
export type SpawnAgentResponse = z.infer<typeof SpawnAgentResponseSchema>;

export const ReleaseAgentRequestSchema = z.object({
  name: z.string(),
  reason: z.string().nullable().optional(),
  delete_agent: z.boolean().optional(),
});
export type ReleaseAgentRequest = z.infer<typeof ReleaseAgentRequestSchema>;

export const ReleaseAgentResponseSchema = z.object({
  name: z.string(),
  released: z.boolean(),
  deleted: z.boolean(),
  reason: z.string().nullable(),
});
export type ReleaseAgentResponse = z.infer<typeof ReleaseAgentResponseSchema>;

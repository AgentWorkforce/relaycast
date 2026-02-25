import { z } from 'zod';

export const CommandParameterSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
});
export type CommandParameter = z.infer<typeof CommandParameterSchema>;

export const AgentCommandSchema = z.object({
  id: z.string(),
  command: z.string(),
  description: z.string(),
  handler_agent: z.string(),
  parameters: z.array(CommandParameterSchema),
  created_at: z.string(),
  is_active: z.boolean(),
});
export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export const CreateCommandRequestSchema = z.object({
  command: z.string(),
  description: z.string(),
  handler_agent: z.string(),
  parameters: z.array(CommandParameterSchema).optional(),
});
export type CreateCommandRequest = z.infer<typeof CreateCommandRequestSchema>;

export const CreateCommandResponseSchema = z.object({
  id: z.string(),
  command: z.string(),
  description: z.string(),
  handler_agent: z.string(),
  parameters: z.array(CommandParameterSchema),
  created_at: z.string(),
});
export type CreateCommandResponse = z.infer<typeof CreateCommandResponseSchema>;

export const InvokeCommandRequestSchema = z.object({
  channel: z.string(),
  args: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type InvokeCommandRequest = z.infer<typeof InvokeCommandRequestSchema>;

export const CommandInvocationSchema = z.object({
  id: z.string(),
  command: z.string(),
  channel: z.string(),
  invoked_by: z.string(),
  handler_agent_id: z.string(),
  args: z.string().nullable(),
  parameters: z.record(z.string(), z.unknown()).nullable(),
  message_id: z.string(),
  created_at: z.string(),
});
export type CommandInvocation = z.infer<typeof CommandInvocationSchema>;

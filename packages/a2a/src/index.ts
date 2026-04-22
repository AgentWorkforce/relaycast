import { z } from 'zod';

export const A2aSkillSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const A2aAgentCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  url: z.string().url(),
  version: z.string().min(1),
  skills: z.array(A2aSkillSchema).min(1),
  provider: z.record(z.string(), z.unknown()).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  default_input_modes: z.array(z.string()).optional(),
  default_output_modes: z.array(z.string()).optional(),
  documentation_url: z.string().url().optional(),
});

export const A2aFilePartSchema = z.object({
  kind: z.literal('file'),
  file: z.object({
    name: z.string().min(1),
    mime_type: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    bytes: z.number().int().nonnegative().optional(),
  }),
});

export const A2aDataPartSchema = z.object({
  kind: z.literal('data'),
  data: z.record(z.string(), z.unknown()),
});

export const A2aTextPartSchema = z.object({
  kind: z.literal('text'),
  text: z.string(),
});

export const A2aPartSchema = z.discriminatedUnion('kind', [
  A2aTextPartSchema,
  A2aFilePartSchema,
  A2aDataPartSchema,
]);

export const A2aMessageSchema = z.object({
  message_id: z.string(),
  role: z.enum(['user', 'agent', 'system']).default('user'),
  context_id: z.string().optional(),
  parts: z.array(A2aPartSchema).min(1),
});

export const A2aArtifactSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parts: z.array(A2aPartSchema).min(1),
});

export const A2aTaskStateSchema = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
  'unknown',
]);

export const A2aTaskSchema = z.object({
  id: z.string(),
  context_id: z.string().optional(),
  status: z.object({
    state: A2aTaskStateSchema,
    message: z.string().optional(),
  }),
  artifacts: z.array(A2aArtifactSchema).optional(),
  history: z.array(A2aMessageSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.object({
    message: A2aMessageSchema.optional(),
  }).passthrough().optional(),
});

export const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  result: z.object({
    task: A2aTaskSchema.optional(),
    message: A2aMessageSchema.optional(),
  }).passthrough().optional(),
  error: JsonRpcErrorSchema.optional(),
});

export const A2aResponseSchema = z.object({
  task: A2aTaskSchema.optional(),
  message: A2aMessageSchema.optional(),
  response: JsonRpcResponseSchema.optional(),
});

export type A2aSkill = z.infer<typeof A2aSkillSchema>;
export type A2aAgentCard = z.infer<typeof A2aAgentCardSchema>;
export type A2aFilePart = z.infer<typeof A2aFilePartSchema>;
export type A2aDataPart = z.infer<typeof A2aDataPartSchema>;
export type A2aTextPart = z.infer<typeof A2aTextPartSchema>;
export type A2aPart = z.infer<typeof A2aPartSchema>;
export type A2aMessage = z.infer<typeof A2aMessageSchema>;
export type A2aArtifact = z.infer<typeof A2aArtifactSchema>;
export type A2aTaskState = z.infer<typeof A2aTaskStateSchema>;
export type A2aTask = z.infer<typeof A2aTaskSchema>;
export type A2aJsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type A2aJsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type A2aResponse = z.infer<typeof A2aResponseSchema>;

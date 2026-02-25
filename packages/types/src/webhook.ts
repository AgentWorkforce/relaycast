import { z } from 'zod';

export const WebhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  channel: z.string(),
  url: z.string(),
  created_at: z.string(),
  is_active: z.boolean(),
});
export type Webhook = z.infer<typeof WebhookSchema>;

export const CreateWebhookRequestSchema = z.object({
  name: z.string(),
  channel: z.string(),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const CreateWebhookResponseSchema = z.object({
  webhook_id: z.string(),
  name: z.string(),
  channel: z.string(),
  url: z.string(),
  is_active: z.boolean(),
  created_at: z.string(),
});
export type CreateWebhookResponse = z.infer<typeof CreateWebhookResponseSchema>;

export const WebhookTriggerRequestSchema = z.object({
  text: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  source: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookTriggerRequest = z.infer<typeof WebhookTriggerRequestSchema>;

export const WebhookTriggerResponseSchema = z.object({
  message_id: z.string(),
  channel: z.string(),
  text: z.string(),
  created_at: z.string(),
});
export type WebhookTriggerResponse = z.infer<typeof WebhookTriggerResponseSchema>;

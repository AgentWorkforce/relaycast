import { z } from 'zod';

export const PlanTypeSchema = z.enum(['free', 'pro', 'enterprise']);
export type PlanType = z.infer<typeof PlanTypeSchema>;

export const SubscriptionStatusSchema = z.enum(['active', 'canceled', 'past_due', 'trialing']);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const BillingSubscriptionSchema = z.object({
  subscription_id: z.string(),
  plan: PlanTypeSchema,
  status: SubscriptionStatusSchema,
  current_period_end: z.string(),
});
export type BillingSubscription = z.infer<typeof BillingSubscriptionSchema>;

export const UsageRecordSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  messages_sent: z.number(),
  api_calls: z.number(),
  files_uploaded: z.number(),
  file_bytes: z.number(),
  ws_minutes: z.number(),
  created_at: z.string(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const UsageInfoSchema = z.object({
  messages_sent: z.number(),
  messages_stored: z.number(),
  files_uploaded: z.number(),
  file_storage_bytes: z.number(),
  agents_registered: z.number(),
  api_calls: z.number(),
  websocket_minutes: z.number(),
  period_start: z.string(),
  period_end: z.string(),
});
export type UsageInfo = z.infer<typeof UsageInfoSchema>;

export const SubscribeRequestSchema = z.object({
  plan: PlanTypeSchema,
  payment_method: z.string(),
});
export type SubscribeRequest = z.infer<typeof SubscribeRequestSchema>;

export const PlanLimitsSchema = z.object({
  messages_per_month: z.number(),
  agents: z.number(),
  file_storage_bytes: z.number(),
  message_retention_days: z.number(),
  channels: z.number(),
  api_rate_per_minute: z.number(),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

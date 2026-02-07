export type PlanType = 'free' | 'pro' | 'enterprise';
export type SubscriptionStatus = 'active' | 'canceled' | 'past_due' | 'trialing';

export interface BillingSubscription {
  subscription_id: string;
  plan: PlanType;
  status: SubscriptionStatus;
  current_period_end: string;
}

export interface UsageRecord {
  id: string;
  workspace_id: string;
  period_start: string;
  period_end: string;
  messages_sent: number;
  api_calls: number;
  files_uploaded: number;
  file_bytes: number;
  ws_minutes: number;
  created_at: string;
}

export interface UsageInfo {
  messages_sent: number;
  messages_stored: number;
  files_uploaded: number;
  file_storage_bytes: number;
  agents_registered: number;
  api_calls: number;
  websocket_minutes: number;
  period_start: string;
  period_end: string;
}

export interface SubscribeRequest {
  plan: PlanType;
  payment_method: string;
}

export interface PlanLimits {
  messages_per_month: number;
  agents: number;
  file_storage_bytes: number;
  message_retention_days: number;
  channels: number;
  api_rate_per_minute: number;
}

export interface Webhook {
  id: string;
  workspace_id: string;
  name: string;
  channel_id: string;
  channel_name: string;
  url: string;
  created_by: string | null;
  created_at: string;
  is_active: boolean;
}

export interface CreateWebhookRequest {
  name: string;
  channel: string;
}

export interface CreateWebhookResponse {
  webhook_id: string;
  name: string;
  channel: string;
  url: string;
  created_at: string;
}

export interface WebhookTriggerRequest {
  text?: string;
  blocks?: unknown[];
  source?: string;
  payload?: Record<string, unknown>;
}

export interface WebhookTriggerResponse {
  message_id: string;
  channel: string;
  text: string;
  created_at: string;
}

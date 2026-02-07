export interface ApiSuccess<T> {
  ok: true;
  data: T;
  cursor?: {
    next: string | null;
    has_more: boolean;
  };
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export interface InboxResponse {
  unread_channels: Array<{ channel_name: string; unread_count: number }>;
  mentions: Array<{ id: string; channel_name: string; agent_name: string; text: string; created_at: string }>;
  unread_dms: Array<{ conversation_id: string; from: string; unread_count: number; last_message: string | null }>;
}

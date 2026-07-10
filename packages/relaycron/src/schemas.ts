import { z } from "zod";

// --- Schedule types ---

export const ScheduleType = z.enum(["once", "cron"]);
export type ScheduleType = z.infer<typeof ScheduleType>;

export const TransportType = z.enum(["webhook", "websocket"]);
export type TransportType = z.infer<typeof TransportType>;

export const ScheduleStatus = z.enum([
  "active",
  "paused",
  "completed",
  "expired",
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

export const ExecutionStatus = z.enum(["success", "failure", "timeout"]);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

// --- Transport configs ---

export const WebhookTransportConfig = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeout_ms: z.number().int().min(1000).max(30000).default(10000),
});
export type WebhookTransportConfig = z.infer<typeof WebhookTransportConfig>;

export const WebsocketTransportConfig = z.object({
  channel: z.string().min(1).max(128).optional(),
});
export type WebsocketTransportConfig = z.infer<typeof WebsocketTransportConfig>;

export const TransportConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("webhook"), ...WebhookTransportConfig.shape }),
  z.object({
    type: z.literal("websocket"),
    ...WebsocketTransportConfig.shape,
  }),
]);
export type TransportConfig = z.infer<typeof TransportConfig>;

// --- API request schemas ---

export const CreateScheduleRequest = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  schedule_type: ScheduleType,
  cron_expression: z.string().max(128).optional(),
  scheduled_at: z.string().datetime().optional(),
  timezone: z.string().default("UTC"),
  payload: z.unknown().refine((val) => val !== undefined, { message: "payload is required" }),
  transport: TransportConfig,
  metadata: z.record(z.unknown()).optional(),
});
export type CreateScheduleRequest = z.infer<typeof CreateScheduleRequest>;

export const UpdateScheduleRequest = z.object({
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).optional(),
  cron_expression: z.string().max(128).optional(),
  scheduled_at: z.string().datetime().optional(),
  timezone: z.string().optional(),
  payload: z.unknown().optional(),
  transport: TransportConfig.optional(),
  status: z.enum(["active", "paused"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateScheduleRequest = z.infer<typeof UpdateScheduleRequest>;

export const ListSchedulesQuery = z.object({
  status: ScheduleStatus.optional(),
  schedule_type: ScheduleType.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListSchedulesQuery = z.infer<typeof ListSchedulesQuery>;

export const ListExecutionsQuery = z.object({
  status: ExecutionStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListExecutionsQuery = z.infer<typeof ListExecutionsQuery>;

// --- API response types ---

export interface Schedule {
  id: string;
  name: string;
  description: string | null;
  schedule_type: ScheduleType;
  cron_expression: string | null;
  scheduled_at: string | null;
  timezone: string;
  payload: unknown;
  transport_type: TransportType;
  transport_config: Record<string, unknown>;
  status: ScheduleStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  failure_count: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface Execution {
  id: string;
  schedule_id: string;
  started_at: string;
  completed_at: string | null;
  status: ExecutionStatus;
  transport_type: TransportType;
  http_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
}

export interface ApiResponse<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  ok: true;
  data: T[];
  cursor: string | null;
  has_more: boolean;
}

// --- WebSocket message types ---

export const WsMessageType = z.enum([
  "auth",
  "auth_ok",
  "schedule_fired",
  "ping",
  "pong",
  "error",
  "subscribe",
  "unsubscribe",
]);
export type WsMessageType = z.infer<typeof WsMessageType>;

export interface WsAuthMessage {
  type: "auth";
  api_key: string;
}

export interface WsAuthOkMessage {
  type: "auth_ok";
  agent_id: string;
}

export interface WsScheduleFiredMessage {
  type: "schedule_fired";
  schedule_id: string;
  schedule_name: string;
  execution_id: string;
  payload: unknown;
  fired_at: string;
}

export interface WsPingMessage {
  type: "ping";
}

export interface WsPongMessage {
  type: "pong";
}

export interface WsErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type WsMessage =
  | WsAuthMessage
  | WsAuthOkMessage
  | WsScheduleFiredMessage
  | WsPingMessage
  | WsPongMessage
  | WsErrorMessage;

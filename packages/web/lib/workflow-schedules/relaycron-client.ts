export type RelaycronScheduleType = "once" | "cron";
export type RelaycronScheduleStatus = "active" | "paused" | "completed";

export type RelaycronSchedule = {
  id: string;
  name: string;
  description: string | null;
  schedule_type: RelaycronScheduleType;
  cron_expression: string | null;
  scheduled_at: string | null;
  timezone: string;
  payload: unknown;
  transport_type: "webhook" | "websocket";
  transport_config: unknown;
  status: RelaycronScheduleStatus;
  next_run_at: string | null;
  last_run_at: string | null;
  run_count: number;
  failure_count: number;
  metadata: unknown;
  created_at: string;
  updated_at: string;
};

type RelaycronApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

const RELAYCRON_FETCH_TIMEOUT_MS = 10_000;

export type CreateRelaycronScheduleInput = {
  name: string;
  description?: string;
  schedule_type: RelaycronScheduleType;
  cron_expression?: string;
  scheduled_at?: string;
  timezone?: string;
  payload: unknown;
  transport: {
    type: "webhook";
    url: string;
    headers?: Record<string, string>;
    timeout_ms?: number;
  };
  metadata?: unknown;
};

export type UpdateRelaycronScheduleInput = {
  name?: string;
  description?: string | null;
  cron_expression?: string;
  scheduled_at?: string;
  timezone?: string;
  payload?: unknown;
  status?: "active" | "paused";
  metadata?: unknown;
};

export class RelaycronClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelaycronClientError";
  }
}

export function resolveRelaycronBaseUrl(): string {
  const configured = process.env.RELAYCRON_URL?.trim();
  return (configured || "https://api.agentcron.dev").replace(/\/$/, "");
}

async function relaycronFetch(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAYCRON_FETCH_TIMEOUT_MS);
  try {
    return await globalThis.fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseRelaycronResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as RelaycronApiResponse<T> | null;
  if (!payload || payload.ok !== true) {
    const error = payload && "error" in payload ? payload.error : null;
    throw new RelaycronClientError(
      response.status,
      error?.code ?? "relaycron_error",
      error?.message ?? "Relaycron request failed",
    );
  }
  return payload.data;
}

export async function createRelaycronApiKey(name: string): Promise<string> {
  const response = await relaycronFetch(`${resolveRelaycronBaseUrl()}/v1/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const data = await parseRelaycronResponse<{ api_key: string }>(response);
  return data.api_key;
}

async function relaycronRequest<T>(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await relaycronFetch(`${resolveRelaycronBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseRelaycronResponse<T>(response);
}

export async function createRelaycronSchedule(
  apiKey: string,
  input: CreateRelaycronScheduleInput,
): Promise<RelaycronSchedule> {
  return relaycronRequest<RelaycronSchedule>(apiKey, "POST", "/v1/schedules", input);
}

export async function listRelaycronSchedules(
  apiKey: string,
): Promise<RelaycronSchedule[]> {
  return relaycronRequest<RelaycronSchedule[]>(apiKey, "GET", "/v1/schedules");
}

export async function updateRelaycronSchedule(
  apiKey: string,
  relaycronScheduleId: string,
  input: UpdateRelaycronScheduleInput,
): Promise<RelaycronSchedule> {
  return relaycronRequest<RelaycronSchedule>(
    apiKey,
    "PATCH",
    `/v1/schedules/${relaycronScheduleId}`,
    input,
  );
}

export async function deleteRelaycronSchedule(
  apiKey: string,
  relaycronScheduleId: string,
): Promise<void> {
  await relaycronRequest(apiKey, "DELETE", `/v1/schedules/${relaycronScheduleId}`);
}

import { tryResourceValue } from "@/lib/env";

export type ScheduleSpec =
  | string
  | { name?: string; cron: string; tz?: string }
  | { name?: string; at: string | Date };

export type RelaycronEnv = {
  RELAYCRON_URL?: string;
  RELAYCRON_API_KEY: string;
};

export type RegisteredCronSchedule = {
  gatewayScheduleId: string;
  relaycronScheduleId: string;
  schedule: string;
  scheduleType: "cron" | "once";
  timezone: string;
  name?: string;
  createdAt: string;
  created: boolean;
  cronExpression?: string;
  scheduledAt?: string;
};

export type RelaycronSchedule = {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

type RelaycronScheduleResponse = {
  id: string;
};

type RelaycronListResponse<T> = {
  data: T[];
  cursor?: string | null;
  has_more?: boolean;
};

const DEFAULT_RELAYCRON_URL = "https://api.agentcron.dev";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const RELAYCRON_LIST_PAGE_SIZE = 100;
const DEPLOYMENT_TOKEN_HEADERS = [
  "x-cloud-agent-deployment-token",
  "x-agentrelay-deployment-token",
] as const;
const DEPLOYMENT_TOKEN_QUERY_PARAM = "deployment_token";

export function resolveAgentGatewayRelaycronEnv(_fallbackGatewayBaseUrl?: string): RelaycronEnv {
  const relaycronApiKey =
    tryResourceValue("RelaycronApiKey")
    || process.env.RELAYCRON_API_KEY?.trim();
  if (!relaycronApiKey) {
    throw new Error("RELAYCRON_API_KEY is required to manage persona schedules");
  }

  return {
    RELAYCRON_URL: process.env.RELAYCRON_URL?.trim(),
    RELAYCRON_API_KEY: relaycronApiKey,
  };
}

export async function registerCronSchedules(
  env: RelaycronEnv,
  input: {
    workspace: string;
    agentId: string;
    schedules: ScheduleSpec[];
    // Plaintext secret the cron service must echo in a deployment-token header
    // when firing the webhook. The cloud verifies it against the per-deployment
    // hash stored at `agents.schedule_webhook_secret_hash`. Required when schedules.length > 0.
    webhookSecret: string;
    // Absolute base URL of the cloud app (no trailing slash). The cron service POSTs to
    // `${cloudBaseUrl}/api/v1/workspaces/{workspace}/deployments/{agentId}/ticks` directly —
    // bypassing the agent-gateway hop, which does not yet have a handler for this flow.
    cloudBaseUrl: string;
    existingRelaycronScheduleIds?: string[];
  },
): Promise<RegisteredCronSchedule[]> {
  if (input.schedules.length > 0) {
    if (!input.webhookSecret) {
      throw new Error("webhookSecret is required to register cron schedules");
    }
    if (!input.cloudBaseUrl) {
      throw new Error("cloudBaseUrl is required to register cron schedules");
    }
  }

  const normalizedCloudBaseUrl = input.cloudBaseUrl.replace(/\/+$/, "");

  const normalizedSchedules = input.schedules.map(normalizeScheduleSpec);
  const registrations: RegisteredCronSchedule[] = [];

  for (const [index, schedule] of normalizedSchedules.entries()) {
    const existingRelaycronScheduleId = input.existingRelaycronScheduleIds?.[index];
    const gatewayScheduleId = existingRelaycronScheduleId ?? crypto.randomUUID();
    const tickUrl = new URL(
      `${normalizedCloudBaseUrl}/api/v1/workspaces/${encodeURIComponent(input.workspace)}` +
        `/deployments/${encodeURIComponent(input.agentId)}/ticks`,
    );
    // Production relaycron has delivered webhook requests with delivery.headers
    // and payload omitted. Keep the header contract, but make auth survive as
    // long as relaycron preserves the registered URL.
    tickUrl.searchParams.set(DEPLOYMENT_TOKEN_QUERY_PARAM, input.webhookSecret);
    const body = buildRelaycronScheduleBody({
      workspace: input.workspace,
      agentId: input.agentId,
      gatewayScheduleId,
      schedule,
      webhookSecret: input.webhookSecret,
      tickUrl: tickUrl.toString(),
    });

    const response = existingRelaycronScheduleId
      ? await relaycronRequest<RelaycronScheduleResponse>(
          env,
          `/v1/schedules/${encodeURIComponent(existingRelaycronScheduleId)}`,
          {
            method: "PATCH",
            body: {
              name: body.name,
              description: body.description,
              ...(schedule.scheduledAt
                ? { scheduled_at: schedule.scheduledAt }
                : {
                    cron_expression: schedule.cronExpression ?? schedule.schedule,
                    timezone: schedule.timezone,
                  }),
              payload: body.payload,
              transport: body.delivery,
              metadata: body.metadata,
              status: "active",
            },
          },
        )
      : await relaycronRequest<RelaycronScheduleResponse>(env, "/v1/schedules", {
          method: "POST",
          body,
        });

    registrations.push({
      gatewayScheduleId,
      relaycronScheduleId: response.id ?? existingRelaycronScheduleId,
      schedule: schedule.schedule,
      scheduleType: schedule.scheduleType,
      timezone: schedule.timezone,
      ...(schedule.name ? { name: schedule.name } : {}),
      createdAt: new Date().toISOString(),
      created: !existingRelaycronScheduleId,
      ...(schedule.cronExpression ? { cronExpression: schedule.cronExpression } : {}),
      ...(schedule.scheduledAt ? { scheduledAt: schedule.scheduledAt } : {}),
    });
  }

  return registrations;
}

function buildRelaycronScheduleBody(input: {
  workspace: string;
  agentId: string;
  gatewayScheduleId: string;
  schedule: ReturnType<typeof normalizeScheduleSpec>;
  webhookSecret: string;
  tickUrl: string;
}) {
  const scheduleName = input.schedule.name?.trim();
  return {
    name: `cloud-persona:${input.workspace}:${input.agentId}:${input.gatewayScheduleId.slice(0, 8)}`,
    description: `Cloud persona cron trigger for ${input.agentId}`,
    schedule: input.schedule.scheduledAt
      ? { at: input.schedule.scheduledAt }
      : { cron: input.schedule.cronExpression ?? input.schedule.schedule, tz: input.schedule.timezone },
    payload: {
      workspace: input.workspace,
      agentId: input.agentId,
      ...(scheduleName ? { name: scheduleName, scheduleName } : {}),
      scheduleId: input.gatewayScheduleId,
      gatewayScheduleId: input.gatewayScheduleId,
      schedule: input.schedule.schedule,
      scheduledFor: input.schedule.scheduledAt ?? null,
    },
    delivery: {
      type: "webhook",
      url: input.tickUrl,
      headers: Object.fromEntries(
        DEPLOYMENT_TOKEN_HEADERS.map((header) => [header, input.webhookSecret]),
      ),
      timeout_ms: 10_000,
    },
    metadata: {
      workspace: input.workspace,
      agentId: input.agentId,
      gatewayScheduleId: input.gatewayScheduleId,
      ...(scheduleName ? { scheduleName } : {}),
      source: "cloud",
    },
  };
}

export async function cancelCronSchedule(
  env: RelaycronEnv,
  relaycronScheduleId: string,
): Promise<void> {
  await relaycronRequest<void>(env, `/v1/schedules/${encodeURIComponent(relaycronScheduleId)}`, {
    method: "DELETE",
  });
}

export async function listCronSchedules(
  env: RelaycronEnv,
  input: {
    status?: string;
    filter?: (schedule: RelaycronSchedule) => boolean;
    onPage?: (input: { count: number; cursor: string | null | undefined }) => void;
  } = {},
): Promise<RelaycronSchedule[]> {
  const schedules: RelaycronSchedule[] = [];
  let cursor: string | null | undefined;
  do {
    const params = new URLSearchParams();
    params.set("limit", String(RELAYCRON_LIST_PAGE_SIZE));
    if (input.status) {
      params.set("status", input.status);
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    const page = await relaycronListRequest<RelaycronSchedule>(
      env,
      `/v1/schedules?${params.toString()}`,
      { method: "GET" },
    );
    input.onPage?.({ count: page.data.length, cursor });
    schedules.push(...(input.filter ? page.data.filter(input.filter) : page.data));
    cursor = page.has_more ? page.cursor : null;
  } while (cursor);
  return schedules;
}

export function normalizeScheduleSpec(spec: ScheduleSpec): {
  schedule: string;
  scheduleType: "cron" | "once";
  timezone: string;
  name?: string;
  cronExpression?: string;
  scheduledAt?: string;
} {
  if (typeof spec === "string") {
    const trimmed = spec.trim();
    if (!trimmed) {
      throw new Error("schedule string must not be empty");
    }

    if (looksLikeIsoTimestamp(trimmed)) {
      const scheduledAt = new Date(trimmed).toISOString();
      return {
        schedule: `oneshot:${scheduledAt}`,
        scheduleType: "once",
        timezone: "UTC",
        scheduledAt,
      };
    }

    return {
      schedule: trimmed,
      scheduleType: "cron",
      timezone: "UTC",
      cronExpression: trimmed,
    };
  }

  if ("cron" in spec) {
    const cron = spec.cron.trim();
    if (!cron) {
      throw new Error("cron expression must not be empty");
    }
    return {
      schedule: cron,
      scheduleType: "cron",
      timezone: spec.tz?.trim() || "UTC",
      ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
      cronExpression: cron,
    };
  }

  const scheduledAt =
    spec.at instanceof Date
      ? spec.at.toISOString()
      : new Date(spec.at).toISOString();

  return {
    schedule: `oneshot:${scheduledAt}`,
    scheduleType: "once",
    timezone: "UTC",
    ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
    scheduledAt,
  };
}

async function relaycronRequest<T>(
  env: RelaycronEnv,
  path: string,
  input: {
    method: string;
    body?: unknown;
  },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);

  try {
    const response = await globalThis.fetch(
      new URL(path, normalizeBaseUrl(env.RELAYCRON_URL || DEFAULT_RELAYCRON_URL)),
      {
        method: input.method,
        headers: {
          authorization: `Bearer ${env.RELAYCRON_API_KEY.trim()}`,
          "content-type": "application/json",
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      },
    );

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; data?: T; error?: { code?: string; message?: string } }
      | null;

    if (!response.ok) {
      const message =
        payload?.error?.message
        ?? `relaycron request failed (${response.status})`;
      throw new Error(message);
    }

    if (!payload) {
      throw new Error("relaycron request succeeded but returned no data");
    }

    if (payload.ok !== true) {
      const message =
        payload.error?.message
        ?? `relaycron request failed (${response.status})`;
      throw new Error(message);
    }

    return payload.data as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function relaycronListRequest<T>(
  env: RelaycronEnv,
  path: string,
  input: {
    method: string;
  },
): Promise<RelaycronListResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);

  try {
    const response = await globalThis.fetch(
      new URL(path, normalizeBaseUrl(env.RELAYCRON_URL || DEFAULT_RELAYCRON_URL)),
      {
        method: input.method,
        headers: {
          authorization: `Bearer ${env.RELAYCRON_API_KEY.trim()}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
      },
    );

    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; data?: T[]; cursor?: string | null; has_more?: boolean; error?: { code?: string; message?: string } }
      | null;

    if (!response.ok) {
      const message =
        payload?.error?.message
        ?? `relaycron request failed (${response.status})`;
      throw new Error(message);
    }

    if (!payload) {
      throw new Error("relaycron request succeeded but returned no data");
    }

    if (payload.ok !== true || !Array.isArray(payload.data)) {
      const message =
        payload.error?.message
        ?? `relaycron request failed (${response.status})`;
      throw new Error(message);
    }

    return {
      data: payload.data,
      cursor: payload.cursor,
      has_more: payload.has_more,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /[tT]/.test(value);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

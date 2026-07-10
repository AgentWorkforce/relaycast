export type ScheduleSpec =
  | string
  | { cron: string; tz?: string }
  | { at: string | Date };

export type RelaycronEnv = {
  RELAYCRON_URL?: string;
  RELAYCRON_API_KEY?: string;
  AGENT_GATEWAY_BASE_URL: string;
  AGENT_GATEWAY_INTERNAL_SECRET: string;
};

export type RegisteredCronSchedule = {
  gatewayScheduleId: string;
  relaycronScheduleId: string;
  schedule: string;
  scheduleType: "cron" | "once";
  timezone: string;
  createdAt: string;
  cronExpression?: string;
  scheduledAt?: string;
};

type RelaycronScheduleResponse = {
  id: string;
};

const DEFAULT_RELAYCRON_URL = "https://api.agentcron.dev";
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const INTERNAL_SECRET_QUERY_PARAM = "internal_token";
const WORKSPACE_QUERY_PARAM = "workspace";
const AGENT_ID_QUERY_PARAM = "agent_id";
const GATEWAY_SCHEDULE_ID_QUERY_PARAM = "gateway_schedule_id";
const SCHEDULE_QUERY_PARAM = "schedule";

export async function registerCronSchedules(
  env: RelaycronEnv,
  input: {
    workspace: string;
    agentId: string;
    schedules: ScheduleSpec[];
  },
): Promise<RegisteredCronSchedule[]> {
  const normalizedSchedules = input.schedules.map(normalizeScheduleSpec);
  const registrations: RegisteredCronSchedule[] = [];

  for (const schedule of normalizedSchedules) {
    const gatewayScheduleId = crypto.randomUUID();
    const tickUrl = new URL(
      "/internal/cron/tick",
      normalizeBaseUrl(env.AGENT_GATEWAY_BASE_URL),
    );
    tickUrl.searchParams.set(INTERNAL_SECRET_QUERY_PARAM, env.AGENT_GATEWAY_INTERNAL_SECRET);
    tickUrl.searchParams.set(WORKSPACE_QUERY_PARAM, input.workspace);
    tickUrl.searchParams.set(AGENT_ID_QUERY_PARAM, input.agentId);
    tickUrl.searchParams.set(GATEWAY_SCHEDULE_ID_QUERY_PARAM, gatewayScheduleId);
    tickUrl.searchParams.set(SCHEDULE_QUERY_PARAM, schedule.schedule);
    const response = await relaycronRequest<RelaycronScheduleResponse>(env, "/v1/schedules", {
      method: "POST",
      body: {
        name: `agent-gateway:${input.workspace}:${input.agentId}:${gatewayScheduleId.slice(0, 8)}`,
        description: `Proactive runtime cron trigger for ${input.agentId}`,
        schedule_type: schedule.scheduleType,
        ...(schedule.cronExpression ? { cron_expression: schedule.cronExpression } : {}),
        ...(schedule.scheduledAt ? { scheduled_at: schedule.scheduledAt } : {}),
        timezone: schedule.timezone,
        payload: {
          workspace: input.workspace,
          agentId: input.agentId,
          gatewayScheduleId,
          schedule: schedule.schedule,
          scheduledFor: schedule.scheduledAt ?? null,
        },
        transport: {
          type: "webhook",
          // The worker's `/internal/cron/tick` route normalizes relaycron's payload
          // into a cron envelope and forwards it to the workspace DO enqueue path.
          url: tickUrl.toString(),
          headers: {
            "x-agent-gateway-secret": env.AGENT_GATEWAY_INTERNAL_SECRET,
          },
          timeout_ms: 10_000,
        },
        metadata: {
          workspace: input.workspace,
          agentId: input.agentId,
          gatewayScheduleId,
          source: "agent-gateway",
        },
      },
      }).catch(async (error) => {
        await cancelRegisteredCronSchedulesBestEffort(env, registrations);
        throw error;
      });

    registrations.push({
      gatewayScheduleId,
      relaycronScheduleId: response.id,
      schedule: schedule.schedule,
      scheduleType: schedule.scheduleType,
      timezone: schedule.timezone,
      createdAt: new Date().toISOString(),
      ...(schedule.cronExpression ? { cronExpression: schedule.cronExpression } : {}),
      ...(schedule.scheduledAt ? { scheduledAt: schedule.scheduledAt } : {}),
    });
  }

  return registrations;
}

async function cancelRegisteredCronSchedulesBestEffort(
  env: RelaycronEnv,
  schedules: RegisteredCronSchedule[],
): Promise<void> {
  await Promise.allSettled(
    schedules.map((schedule) => cancelCronSchedule(env, schedule.relaycronScheduleId)),
  );
}

export async function cancelCronSchedule(
  env: RelaycronEnv,
  relaycronScheduleId: string,
): Promise<void> {
  await relaycronRequest<void>(env, `/v1/schedules/${encodeURIComponent(relaycronScheduleId)}`, {
    method: "DELETE",
  });
}

export function normalizeScheduleSpec(spec: ScheduleSpec): {
  schedule: string;
  scheduleType: "cron" | "once";
  timezone: string;
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
          ...(env.RELAYCRON_API_KEY?.trim()
            ? { authorization: `Bearer ${env.RELAYCRON_API_KEY.trim()}` }
            : {}),
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
      return undefined as T;
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

function looksLikeIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && /[tT]/.test(value);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

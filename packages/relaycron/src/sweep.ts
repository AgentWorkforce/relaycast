import type {
  ExecutionContext,
  Request as CloudflareRequest,
  ScheduledEvent,
} from "@cloudflare/workers-types";
import type { Bindings } from "./env.js";

const INTEGRATION_WATCH_DELIVERY_SWEEP_PATH =
  "/cloud/api/internal/proactive-runtime/integration-watch-deliveries/sweep";
const INTEGRATION_WATCH_DELIVERY_SWEEP_LIMIT = 3;
const DEPLOYMENT_TICK_DELIVERY_SWEEP_PATH =
  "/cloud/api/internal/proactive-runtime/deployment-tick-deliveries/sweep";
const DEPLOYMENT_TICK_DELIVERY_SWEEP_LIMIT = 3;
const SANDBOX_REAPER_PATH =
  "/cloud/api/internal/proactive-runtime/sandbox-reaper";
const CLOUD_AGENT_BOX_KEEPALIVE_REAPER_PATH =
  "/cloud/api/internal/cloud-agent-box/keepalive-reaper";
// Preserve post-run forensic/debug access and avoid racing final writeback; the
// route/library still locally filter to STOPPED boxes and active lease state.
const SANDBOX_REAPER_MIN_AGE_HOURS = 4;

type SandboxReaperResponse = {
  ok?: boolean;
  data?: {
    found?: number;
    eligible?: number;
    deleted?: number;
    failed?: unknown[];
    skippedTooYoung?: number;
    skippedMissingCreatedAt?: number;
    skippedActiveLease?: number;
    leasesCleared?: number;
  };
};

type CloudAgentBoxKeepaliveReaperResponse = {
  ok?: boolean;
  data?: {
    found?: number;
    stopped?: number;
    vanished?: number;
    failed?: unknown[];
  };
};

async function pokeSchedule(
  namespace: Bindings["SCHEDULER_DO"],
  scheduleId: string,
): Promise<void> {
  const stub = namespace.get(namespace.idFromName(scheduleId));
  const response = await stub.fetch(
    new Request("https://scheduler/poke", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scheduleId }),
    }) as unknown as CloudflareRequest,
  );

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(
      `[relaycron] sweep poke failed for ${scheduleId}: ${response.status} ${details}`,
    );
  }
}

async function drainIntegrationWatchDeliveries(env: Bindings): Promise<void> {
  const proactiveRuntimeWorker = env.PROACTIVE_RUNTIME_WORKER ?? env.CLOUD_WEB_WORKER;
  const relaycronApiKey = env.RELAYCRON_API_KEY?.trim();
  if (!proactiveRuntimeWorker || !relaycronApiKey) {
    console.warn(
      "[relaycron] integration-watch delivery sweep skipped; proactive-runtime binding or relaycron api key missing",
    );
    return;
  }

  const response = await proactiveRuntimeWorker.fetch(
    new Request(`https://proactive-runtime${INTEGRATION_WATCH_DELIVERY_SWEEP_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relaycronApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: INTEGRATION_WATCH_DELIVERY_SWEEP_LIMIT }),
    }) as unknown as CloudflareRequest,
  );

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(
      `[relaycron] integration-watch delivery sweep failed: ${response.status} ${details}`,
    );
  }
}

async function drainDeploymentTickDeliveries(env: Bindings): Promise<void> {
  const proactiveRuntimeWorker = env.PROACTIVE_RUNTIME_WORKER ?? env.CLOUD_WEB_WORKER;
  const relaycronApiKey = env.RELAYCRON_API_KEY?.trim();
  if (!proactiveRuntimeWorker || !relaycronApiKey) {
    console.warn(
      "[relaycron] deployment-tick delivery sweep skipped; proactive-runtime binding or relaycron api key missing",
    );
    return;
  }

  const response = await proactiveRuntimeWorker.fetch(
    new Request(`https://proactive-runtime${DEPLOYMENT_TICK_DELIVERY_SWEEP_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relaycronApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ limit: DEPLOYMENT_TICK_DELIVERY_SWEEP_LIMIT }),
    }) as unknown as CloudflareRequest,
  );

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(
      `[relaycron] deployment-tick delivery sweep failed: ${response.status} ${details}`,
    );
  }
}

async function reapStoppedSandboxes(env: Bindings): Promise<void> {
  const proactiveRuntimeWorker = env.PROACTIVE_RUNTIME_WORKER ?? env.CLOUD_WEB_WORKER;
  const relaycronApiKey = env.RELAYCRON_API_KEY?.trim();
  if (!proactiveRuntimeWorker || !relaycronApiKey) {
    console.warn(
      "[relaycron] stopped sandbox reaper skipped; proactive-runtime binding or relaycron api key missing",
    );
    return;
  }

  const response = await proactiveRuntimeWorker.fetch(
    new Request(`https://proactive-runtime${SANDBOX_REAPER_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relaycronApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clearLeases: true,
        minAgeHours: SANDBOX_REAPER_MIN_AGE_HOURS,
      }),
    }) as unknown as CloudflareRequest,
  );

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(
      `[relaycron] stopped sandbox reaper failed: ${response.status} ${details}`,
    );
  }

  const result = (await response
    .json()
    .catch(() => null)) as SandboxReaperResponse | null;
  if (result?.data) {
    console.log("[relaycron] stopped sandbox reaper completed", {
      minAgeHours: SANDBOX_REAPER_MIN_AGE_HOURS,
      found: result.data.found ?? 0,
      eligible: result.data.eligible ?? 0,
      deleted: result.data.deleted ?? 0,
      failed: Array.isArray(result.data.failed) ? result.data.failed.length : 0,
      skippedTooYoung: result.data.skippedTooYoung ?? 0,
      skippedMissingCreatedAt: result.data.skippedMissingCreatedAt ?? 0,
      skippedActiveLease: result.data.skippedActiveLease ?? 0,
      leasesCleared: result.data.leasesCleared ?? 0,
    });
  }
}

async function reapCloudAgentBoxKeepalives(env: Bindings): Promise<void> {
  const cloudWebWorker = env.CLOUD_WEB_WORKER;
  const relaycronApiKey = env.RELAYCRON_API_KEY?.trim();
  if (!cloudWebWorker || !relaycronApiKey) {
    console.warn(
      "[relaycron] cloud-agent box keepalive reaper skipped; cloud-web binding or relaycron api key missing",
    );
    return;
  }

  const response = await cloudWebWorker.fetch(
    new Request(`https://cloud-web${CLOUD_AGENT_BOX_KEEPALIVE_REAPER_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${relaycronApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }) as unknown as CloudflareRequest,
  );

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(
      `[relaycron] cloud-agent box keepalive reaper failed: ${response.status} ${details}`,
    );
  }

  const result = (await response
    .json()
    .catch(() => null)) as CloudAgentBoxKeepaliveReaperResponse | null;
  if (result?.data) {
    console.log("[relaycron] cloud-agent box keepalive reaper completed", {
      found: result.data.found ?? 0,
      stopped: result.data.stopped ?? 0,
      vanished: result.data.vanished ?? 0,
      failed: Array.isArray(result.data.failed) ? result.data.failed.length : 0,
    });
  }
}

export async function runRelaycronSweep(
  env: Bindings,
  ctx: ExecutionContext,
): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[relaycron] sweep tick at ${now}`);
  const result = await env.DB.prepare(
    `
        SELECT id
        FROM schedules
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
      `,
  )
    .bind(now)
    .all<{ id: string }>();

  const overdue = result.results ?? [];

  await drainDeploymentTickDeliveries(env).catch((error) => {
    console.error(
      "[relaycron] failed to drain pending deployment-tick deliveries:",
      error,
    );
  });
  await drainIntegrationWatchDeliveries(env).catch((error) => {
    console.error(
      "[relaycron] failed to drain pending integration-watch deliveries:",
      error,
    );
  });
  await reapStoppedSandboxes(env).catch((error) => {
    console.error("[relaycron] failed to reap stopped sandboxes:", error);
  });
  await reapCloudAgentBoxKeepalives(env).catch((error) => {
    console.error("[relaycron] failed to reap cloud-agent box keepalives:", error);
  });

  for (const row of overdue) {
    ctx.waitUntil(
      pokeSchedule(env.SCHEDULER_DO, row.id).catch((error) => {
        console.error(
          `[relaycron] failed to poke overdue schedule ${row.id}:`,
          error,
        );
      }),
    );
  }

  if (overdue.length > 0) {
    console.log(
      `[relaycron] sweep poked ${overdue.length} overdue schedule(s)`,
    );
  }
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runRelaycronSweep(env, ctx);
  },
};

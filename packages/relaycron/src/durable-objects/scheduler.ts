import { DurableObject } from "cloudflare:workers";
import {
  advanceSchedule,
  executeWebhookWithRetry,
  nextTargetMissingState,
  recordExecution,
  TARGET_MISSING_PAUSE_THRESHOLD,
} from "../engine/executor.js";
import { createD1Database } from "../d1-database.js";
import type { Bindings } from "../env.js";

const RETRY_CONFIG = {
  maxAttempts: 3,
  initialBackoffMs: 1000,
  backoffMultiplier: 5,
} as const;
const SCHEDULE_ID_KEY = "scheduleId";
// Legacy key from the old scheduler-do.ts implementation. Existing deployed
// Durable Objects still have pending alarms with data stored under this key,
// so alarm() reads from it as a fallback and migrates to the new key.
const LEGACY_SCHEDULE_ID_KEY = "schedule_id";
const SCHEDULED_RUN_AT_KEY = "scheduledRunAt";
const LAST_EXECUTED_RUN_AT_KEY = "lastExecutedRunAt";
const CONSECUTIVE_TARGET_MISSING_KEY = "consecutiveTargetMissing";
const DUE_SKEW_MS = 1000;

type SchedulerRequestBody = {
  scheduleId?: string;
  runAt?: string;
};

type ScheduleRow = {
  id: string;
  status: string;
  payload: string;
  transport_type: "webhook" | "websocket";
  transport_config: string;
  schedule_type: string;
  cron_expression: string | null;
  next_run_at: string | null;
  timezone: string;
};

function normalizeAlarmTime(runAt: string | number) {
  const targetMs =
    typeof runAt === "number" ? runAt : new Date(runAt).getTime();
  const now = Date.now();
  return Number.isFinite(targetMs) && targetMs > now ? targetMs : now + 100;
}

function parseRunAtMs(runAt: string | number | null | undefined): number | null {
  if (typeof runAt === "number") {
    return Number.isFinite(runAt) ? runAt : null;
  }
  if (!runAt) {
    return null;
  }
  const parsed = new Date(runAt).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export class SchedulerDO extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/set-alarm") {
      const body = await request.json<SchedulerRequestBody>();
      if (!body.scheduleId || !body.runAt) {
        return Response.json(
          { ok: false, error: "scheduleId and runAt are required" },
          { status: 400 },
        );
      }

      const alarmTime = normalizeAlarmTime(body.runAt);
      await this.ctx.storage.put(SCHEDULE_ID_KEY, body.scheduleId);
      await this.ctx.storage.delete(LEGACY_SCHEDULE_ID_KEY);
      await this.ctx.storage.put(
        SCHEDULED_RUN_AT_KEY,
        parseRunAtMs(body.runAt) ?? alarmTime,
      );
      await this.ctx.storage.delete(CONSECUTIVE_TARGET_MISSING_KEY);
      await this.ctx.storage.setAlarm(alarmTime);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/cancel-alarm") {
      await this.ctx.storage.deleteAlarm();
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/poke") {
      const body = await request.json<SchedulerRequestBody>().catch(
        () => ({}) as SchedulerRequestBody,
      );
      const scheduleId =
        body.scheduleId ??
        (await this.ctx.storage.get<string>(SCHEDULE_ID_KEY)) ??
        (await this.ctx.storage.get<string>(LEGACY_SCHEDULE_ID_KEY));

      if (!scheduleId) {
        return Response.json(
          { ok: false, error: "scheduleId is required" },
          { status: 400 },
        );
      }

      await this.ctx.storage.put(SCHEDULE_ID_KEY, scheduleId);
      await this.ctx.storage.delete(LEGACY_SCHEDULE_ID_KEY);
      await this.executeSchedule(scheduleId, "poke");
      return Response.json({ ok: true });
    }

    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    let scheduleId = await this.ctx.storage.get<string>(SCHEDULE_ID_KEY);
    if (!scheduleId) {
      // Fallback for DOs provisioned by the old scheduler-do.ts, which wrote
      // under "schedule_id". Migrate to the new key on first hit.
      const legacyScheduleId = await this.ctx.storage.get<string>(
        LEGACY_SCHEDULE_ID_KEY,
      );
      if (legacyScheduleId) {
        await this.ctx.storage.put(SCHEDULE_ID_KEY, legacyScheduleId);
        await this.ctx.storage.delete(LEGACY_SCHEDULE_ID_KEY);
        scheduleId = legacyScheduleId;
      }
    }
    if (!scheduleId) {
      console.error("[relaycron] SchedulerDO alarm fired without a schedule id");
      return;
    }

    await this.executeSchedule(scheduleId, "alarm");
  }

  private async executeSchedule(
    scheduleId: string,
    source: "alarm" | "poke",
  ): Promise<void> {
    const db = createD1Database(this.env.DB) as any;

    const schedule = await this.env.DB.prepare(
      `
        SELECT
          id,
          status,
          payload,
          transport_type,
          transport_config,
          schedule_type,
          cron_expression,
          next_run_at,
          timezone
        FROM schedules
        WHERE id = ?
        LIMIT 1
      `,
    )
      .bind(scheduleId)
      .first<ScheduleRow>();

    if (!schedule || schedule.status !== "active") {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete(LAST_EXECUTED_RUN_AT_KEY);
      await this.ctx.storage.delete(SCHEDULED_RUN_AT_KEY);
      await this.ctx.storage.delete(CONSECUTIVE_TARGET_MISSING_KEY);
      return;
    }

    const persistedNextRunAt = parseRunAtMs(schedule.next_run_at);
    // Read stored alarm time instead of getAlarm() (which returns null inside alarm())
    const storedScheduledRunAt =
      await this.ctx.storage.get<number>(SCHEDULED_RUN_AT_KEY);
    const scheduledRunAt = persistedNextRunAt ?? storedScheduledRunAt;

    if (scheduledRunAt === null || scheduledRunAt === undefined) {
      console.warn(
        `[relaycron] SchedulerDO ${source} skipped execution for schedule ${scheduleId} because no scheduled run time was found`,
      );
      return;
    }

    if (scheduledRunAt - Date.now() > DUE_SKEW_MS) {
      await this.ctx.storage.put(SCHEDULED_RUN_AT_KEY, scheduledRunAt);
      await this.ctx.storage.setAlarm(normalizeAlarmTime(scheduledRunAt));
      console.log(
        `[relaycron] SchedulerDO ${source} skipped early schedule ${scheduleId} due at ${new Date(scheduledRunAt).toISOString()}`,
      );
      return;
    }

    await this.ctx.storage.put(SCHEDULED_RUN_AT_KEY, scheduledRunAt);

    const lastExecutedRunAt =
      await this.ctx.storage.get<number>(LAST_EXECUTED_RUN_AT_KEY);

    const alreadyExecuted =
      typeof lastExecutedRunAt === "number" &&
      scheduledRunAt === lastExecutedRunAt;

    if (!alreadyExecuted) {
      // Parse stored JSON up front so a malformed row records a failure and
      // advances instead of throwing before the dedup guard — which would
      // otherwise retry the same bad alarm indefinitely.
      let payload: unknown;
      let webhookConfig:
        | {
            url: string;
            headers?: Record<string, string>;
            timeout_ms?: number;
          }
        | null = null;
      let parseError: Error | null = null;
      try {
        payload = JSON.parse(schedule.payload);
        if (schedule.transport_type === "webhook") {
          webhookConfig = JSON.parse(schedule.transport_config) as {
            url: string;
            headers?: Record<string, string>;
            timeout_ms?: number;
          };
        }
      } catch (err) {
        parseError = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[relaycron] SchedulerDO failed to parse schedule ${scheduleId}:`,
          parseError,
        );
      }

      if (parseError) {
        await this.ctx.storage.put(LAST_EXECUTED_RUN_AT_KEY, scheduledRunAt);
        try {
          await recordExecution(db, scheduleId, schedule.transport_type, {
            status: "failure",
            error: `malformed schedule row: ${parseError.message}`,
            duration_ms: 0,
            attempt_count: 0,
          });
        } catch (err) {
          console.error(
            `[relaycron] Failed to record parse failure for ${scheduleId}:`,
            err,
          );
        }
      } else if (schedule.transport_type === "webhook" && webhookConfig) {
        let result: Awaited<ReturnType<typeof executeWebhookWithRetry>>;
        try {
          console.log(
            `[relaycron] SchedulerDO ${source} firing webhook schedule ${scheduleId}`,
          );
          result = await executeWebhookWithRetry(
            webhookConfig.url,
            payload,
            webhookConfig.headers ?? {},
            webhookConfig.timeout_ms ?? 10000,
            RETRY_CONFIG,
            { scheduleId, scheduledRunAt },
          );
        } catch (err) {
          result = {
            status: "failure" as const,
            error: err instanceof Error ? err.message : String(err),
            duration_ms: 0,
            attempt_count: RETRY_CONFIG.maxAttempts,
          };
        }

        // Mark executed before recording/advancing so CF retries skip re-delivery
        await this.ctx.storage.put(LAST_EXECUTED_RUN_AT_KEY, scheduledRunAt);

        try {
          await recordExecution(db, scheduleId, "webhook", result);
        } catch (err) {
          console.error(
            `[relaycron] Failed to record execution for ${scheduleId}:`,
            err,
          );
        }
        const previousTargetMissingCount =
          await this.ctx.storage.get<number>(CONSECUTIVE_TARGET_MISSING_KEY) ?? 0;
        const targetMissingState = nextTargetMissingState(
          previousTargetMissingCount,
          result.http_status,
        );
        if (targetMissingState.pause) {
          const pausedAt = new Date().toISOString();
          await this.env.DB.prepare(
            `
                UPDATE schedules
                SET status = 'paused',
                    updated_at = ?
                WHERE id = ?
                  AND status = 'active'
              `,
          )
            .bind(pausedAt, scheduleId)
            .run();
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.delete(LAST_EXECUTED_RUN_AT_KEY);
          await this.ctx.storage.delete(SCHEDULED_RUN_AT_KEY);
          await this.ctx.storage.delete(CONSECUTIVE_TARGET_MISSING_KEY);
          console.warn(
            "[relaycron] SchedulerDO auto-paused schedule after consecutive target 404s",
            JSON.stringify({
              scheduleId,
              consecutiveTargetMissing: targetMissingState.count,
              threshold: TARGET_MISSING_PAUSE_THRESHOLD,
              httpStatus: result.http_status,
            }),
          );
          return;
        }
        if (targetMissingState.count === 0) {
          await this.ctx.storage.delete(CONSECUTIVE_TARGET_MISSING_KEY);
        } else {
          await this.ctx.storage.put(
            CONSECUTIVE_TARGET_MISSING_KEY,
            targetMissingState.count,
          );
        }
      } else {
        await this.ctx.storage.put(LAST_EXECUTED_RUN_AT_KEY, scheduledRunAt);
        try {
          await recordExecution(db, scheduleId, "websocket", {
            status: "failure",
            error: "WebSocket transport is not supported in cloud mode",
            duration_ms: 0,
            attempt_count: 1,
          });
        } catch (err) {
          console.error(
            `[relaycron] Failed to record execution for ${scheduleId}:`,
            err,
          );
        }
      }
    } else {
      console.warn(
        `[relaycron] SchedulerDO skipping duplicate delivery for schedule ${scheduleId} at ${scheduledRunAt}`,
      );
    }

    // Always advance schedule (even on retry after dedup).
    // Errors propagate so CF retries; dedup guard prevents re-delivery.
    const nextRunAt = await advanceSchedule(
      db,
      scheduleId,
      schedule.schedule_type,
      schedule.cron_expression,
      schedule.timezone,
    );

    if (nextRunAt) {
      const alarmTime = normalizeAlarmTime(nextRunAt);
      await this.ctx.storage.put(
        SCHEDULED_RUN_AT_KEY,
        parseRunAtMs(nextRunAt) ?? alarmTime,
      );
      await this.ctx.storage.delete(LAST_EXECUTED_RUN_AT_KEY);
      await this.ctx.storage.setAlarm(alarmTime);
    } else {
      await this.ctx.storage.delete(LAST_EXECUTED_RUN_AT_KEY);
      await this.ctx.storage.delete(SCHEDULED_RUN_AT_KEY);
    }
  }
}

import type { Bindings } from "./env.js";

type SchedulerRequestBody = {
  scheduleId: string;
  runAt?: string;
};

export class DurableObjectScheduler {
  constructor(
    private readonly namespace: Bindings["SCHEDULER_DO"],
    private readonly ctx: ExecutionContext,
  ) {}

  setAlarm(scheduleId: string, runAt: string): void {
    this.ctx.waitUntil(
      this.dispatch("/set-alarm", {
        scheduleId,
        runAt,
      }),
    );
  }

  cancelAlarm(scheduleId: string): void {
    this.ctx.waitUntil(
      this.dispatch("/cancel-alarm", {
        scheduleId,
      }),
    );
  }

  private async dispatch(
    path: string,
    body: SchedulerRequestBody,
  ): Promise<void> {
    const stub = this.namespace.get(this.namespace.idFromName(body.scheduleId));
    const response = await stub.fetch(
      new Request(`https://scheduler${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );

    if (!response.ok) {
      const details = await response.text().catch(() => response.statusText);
      throw new Error(
        `[relaycron] scheduler request failed (${path}): ${response.status} ${details}`,
      );
    }
  }
}

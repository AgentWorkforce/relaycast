import { describe, expect, it } from "vitest";
import { getNextAgentFire } from "./schedule-next-fire";

describe("getNextAgentFire", () => {
  it("computes next fire from deployed Relaycron schedule specs without workflow schedule ids", () => {
    const nextFire = getNextAgentFire(
      [
        {
          id: "relaycron_sched_123",
          cronExpression: "0 * * * *",
          timezone: "UTC",
        },
      ],
      new Date("2026-06-05T14:22:00.000Z"),
    );

    expect(nextFire?.toISOString()).toBe("2026-06-05T15:00:00.000Z");
  });

  it("returns null when deployed schedules have no cron expressions", () => {
    expect(
      getNextAgentFire(
        [{ id: "relaycron_sched_once", cronExpression: null, timezone: "UTC" }],
        new Date("2026-06-05T14:22:00.000Z"),
      ),
    ).toBeNull();
  });

  it("uses the schedule timezone when matching local cron hours", () => {
    const nextFire = getNextAgentFire(
      [
        {
          id: "relaycron_sched_oslo",
          cronExpression: "0 9 * * *",
          timezone: "Europe/Oslo",
        },
      ],
      new Date("2026-06-05T06:58:00.000Z"),
    );

    expect(nextFire?.toISOString()).toBe("2026-06-05T07:00:00.000Z");
  });

  it("uses cron OR semantics when both day-of-month and day-of-week are restricted", () => {
    const nextFire = getNextAgentFire(
      [
        {
          id: "relaycron_sched_dom_dow",
          cronExpression: "0 9 15 * 2",
          timezone: "UTC",
        },
      ],
      new Date("2024-01-14T09:01:00.000Z"),
    );

    expect(nextFire?.toISOString()).toBe("2024-01-15T09:00:00.000Z");
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nextTargetMissingState,
  TARGET_MISSING_PAUSE_THRESHOLD,
} from "../../packages/relaycron/src/engine/executor.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEDULER_DO_TS = resolve(
  __dirname,
  "../../packages/relaycron/src/durable-objects/scheduler.ts",
);
const SWEEP_TS = resolve(__dirname, "../../packages/relaycron/src/sweep.ts");

describe("relaycron target-missing self-heal", () => {
  it("trips exactly on the configured consecutive 404 threshold", () => {
    let count = 0;
    for (let index = 1; index < TARGET_MISSING_PAUSE_THRESHOLD; index += 1) {
      const state = nextTargetMissingState(count, 404);
      count = state.count;
      assert.equal(state.pause, false, `fire ${index} must not pause before threshold`);
    }

    const thresholdState = nextTargetMissingState(count, 404);
    assert.equal(thresholdState.count, TARGET_MISSING_PAUSE_THRESHOLD);
    assert.equal(thresholdState.pause, true);
  });

  it("resets on 502, timeout, and null-status results instead of pausing", () => {
    let count = 0;
    for (let index = 1; index < TARGET_MISSING_PAUSE_THRESHOLD; index += 1) {
      count = nextTargetMissingState(count, 404).count;
    }
    assert.deepEqual(nextTargetMissingState(count, 502), { count: 0, pause: false });

    count = TARGET_MISSING_PAUSE_THRESHOLD - 1;
    assert.deepEqual(nextTargetMissingState(count, undefined), { count: 0, pause: false });

    count = TARGET_MISSING_PAUSE_THRESHOLD - 1;
    assert.deepEqual(nextTargetMissingState(count, null), { count: 0, pause: false });
  });

  it("resets the counter on a 202 success", () => {
    assert.deepEqual(
      nextTargetMissingState(TARGET_MISSING_PAUSE_THRESHOLD - 1, 202),
      { count: 0, pause: false },
    );
  });

  it("keeps paused schedules out of both sweep and execute paths", () => {
    const sweepSource = readFileSync(SWEEP_TS, "utf8");
    assert.match(
      sweepSource,
      /WHERE\s+status\s*=\s*'active'\s+AND\s+next_run_at\s+IS\s+NOT\s+NULL/s,
      "sweep must only poke active schedules, so paused schedules stay skipped",
    );

    const schedulerSource = readFileSync(SCHEDULER_DO_TS, "utf8");
    assert.match(
      schedulerSource,
      /TARGET_MISSING_PAUSE_THRESHOLD/,
      "SchedulerDO wiring must use the exported threshold const",
    );
    assert.match(
      schedulerSource,
      /nextTargetMissingState\(\s*previousTargetMissingCount,\s*result\.http_status,\s*\)/,
      "SchedulerDO must feed the recorded webhook result's http_status into the pure state machine",
    );

    const inactiveGuardStart = schedulerSource.indexOf('schedule.status !== "active"');
    const inactiveGuardEnd = schedulerSource.indexOf("const persistedNextRunAt", inactiveGuardStart);
    assert.notEqual(inactiveGuardStart, -1, "SchedulerDO must guard inactive schedules.");
    assert.notEqual(inactiveGuardEnd, -1, "SchedulerDO inactive guard block should be discoverable.");
    const inactiveGuard = schedulerSource.slice(inactiveGuardStart, inactiveGuardEnd);
    assert.match(
      inactiveGuard,
      /this\.ctx\.storage\.deleteAlarm\(\)/,
      "executeSchedule must self-delete alarms for paused schedules",
    );
    assert.match(
      schedulerSource,
      /await\s+this\.executeSchedule\(scheduleId,\s*"alarm"\)/,
      "alarm() must flow through executeSchedule and share target-missing counting",
    );
    assert.match(
      schedulerSource,
      /await\s+this\.executeSchedule\(scheduleId,\s*"poke"\)/,
      "/poke must flow through executeSchedule and share target-missing counting",
    );
  });
});

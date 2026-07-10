import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Sweep tick log presence test.
 *
 * The sweep cron worker (packages/relaycron/src/sweep.ts) used to only emit
 * a log line when overdue.length > 0, which made zero-row sweeps
 * indistinguishable from "the cron didn't run at all" when tailing the
 * worker. We added an unconditional `[relaycron] sweep tick at <iso>` log
 * at the start of the scheduled handler so future investigations don't
 * waste time on that question.
 *
 * Source-text assertion (not a behavioral unit test) because the sweep
 * handler depends on Cloudflare Workers' ScheduledEvent / DurableObject
 * runtime types that aren't worth standing up in a unit harness for a
 * one-line visibility log. The deletion of the log line is the only
 * regression we care about catching, and a string match in the source
 * file catches that just as well.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SWEEP_TS = resolve(
  __dirname,
  "../../packages/relaycron/src/sweep.ts",
);
const WORKER_TS = resolve(
  __dirname,
  "../../packages/relaycron/src/worker.ts",
);
const SCHEDULER_DO_TS = resolve(
  __dirname,
  "../../packages/relaycron/src/durable-objects/scheduler.ts",
);

describe("relaycron sweep tick log", () => {
  it("emits an unconditional [relaycron] sweep tick log line", () => {
    const source = readFileSync(SWEEP_TS, "utf8");
    assert.match(
      source,
      /console\.log\(\s*`\[relaycron\] sweep tick at \$\{[^}]+\}`/,
      "sweep.ts must contain an unconditional `[relaycron] sweep tick at ...` log so zero-row sweeps are distinguishable from non-running cron in tail.",
    );
  });

  it("runs the same overdue schedule sweep from the API worker cron handler", () => {
    const source = readFileSync(WORKER_TS, "utf8");
    assert.match(
      source,
      /import\s+\{\s*runRelaycronSweep\s*\}\s+from\s+"\.\/sweep\.js"/,
      "worker.ts must import runRelaycronSweep so the API worker cron is not an inert log-only handler.",
    );
    assert.match(
      source,
      /await\s+runRelaycronSweep\(env,\s*ctx\)/,
      "worker.ts scheduled() must invoke runRelaycronSweep(env, ctx) to poke overdue schedules.",
    );
  });

  it("logs when SchedulerDO fires a webhook schedule", () => {
    const source = readFileSync(SCHEDULER_DO_TS, "utf8");
    assert.match(
      source,
      /\[relaycron\] SchedulerDO \$\{source\} firing webhook schedule/,
      "SchedulerDO must log before webhook delivery so schedule-fire attempts are visible in worker tails.",
    );
  });

  it("executes overdue schedules directly when the sweep pokes a SchedulerDO", () => {
    const source = readFileSync(SCHEDULER_DO_TS, "utf8");
    const pokeStart = source.indexOf('url.pathname === "/poke"');
    const pokeEnd = source.indexOf('return Response.json({ ok: false, error: "not_found" }', pokeStart);
    assert.notEqual(pokeStart, -1, "SchedulerDO must define a /poke handler.");
    assert.notEqual(pokeEnd, -1, "SchedulerDO /poke handler block should be discoverable.");
    const pokeBlock = source.slice(pokeStart, pokeEnd);
    assert.match(
      pokeBlock,
      /await\s+this\.executeSchedule\(scheduleId,\s*"poke"\)/,
      "SchedulerDO /poke must execute due schedules directly; only re-arming an alarm can leave overdue schedules inert when DO alarms fail to deliver.",
    );
    assert.doesNotMatch(
      pokeBlock,
      /this\.ctx\.storage\.setAlarm/,
      "SchedulerDO /poke must not just set a near-term alarm.",
    );
  });

  it("does not execute a future schedule early from stale alarms or manual pokes", () => {
    const source = readFileSync(SCHEDULER_DO_TS, "utf8");
    assert.match(
      source,
      /scheduledRunAt\s*-\s*Date\.now\(\)\s*>\s*DUE_SKEW_MS/,
      "SchedulerDO must compare persisted next_run_at with now before delivering.",
    );
    assert.match(
      source,
      /skipped early schedule/,
      "SchedulerDO should log early skips so stale-alarm behavior is diagnosable.",
    );
  });

  it("does not execute schedules when no scheduled run timestamp is available", () => {
    const source = readFileSync(SCHEDULER_DO_TS, "utf8");
    assert.match(
      source,
      /scheduledRunAt\s*===\s*null\s*\|\|\s*scheduledRunAt\s*===\s*undefined/,
      "SchedulerDO must skip delivery when neither D1 next_run_at nor DO alarm storage provides a run timestamp.",
    );
    assert.match(
      source,
      /skipped execution for schedule \$\{scheduleId\} because no scheduled run time was found/,
      "SchedulerDO should log missing scheduled-run timestamp skips so repeated poke behavior is diagnosable.",
    );
  });
});

/**
 * Read-only per-step timing for cloud-agent box warm jobs (issue #1384).
 *
 * SELECT-only - never writes. Intended for the post-flip 50-run validation to
 * get empirical per-step splits once CLOUD_AGENT_WARM_VIA_QUEUE is ON. Run
 * inside `sst shell` so getDb() binds the deployed DB:
 *
 *   # post-hoc summary of recent warm jobs (totals + where each job ended):
 *   node ./node_modules/sst/bin/sst.mjs shell -- npx tsx scripts/cloud-agent-warm-timing.ts
 *
 *   # live sampler -> reconstructs per-step durations from row transitions:
 *   node ./node_modules/sst/bin/sst.mjs shell -- npx tsx scripts/cloud-agent-warm-timing.ts --watch
 *
 * Options:
 *   --watch                 Poll the rows and record currentStep transitions to
 *                           reconstruct per-step durations live (until Ctrl-C).
 *   --interval=<seconds>    Watch poll interval (default 2). Steps shorter than
 *                           the interval may be merged - see the resolution note.
 *   --window=<minutes>      Summary lookback / watch job-selection window
 *                           (default 60).
 *   --workspace=<uuid>      Restrict to a single workspace id.
 *
 * Per-step splits - IMPORTANT: the `cloud_agent_box_warm_jobs` row stores only
 * the LAST `current_step` + `updated_at` (no per-step history), so a post-hoc
 * read gives per-job totals + the terminal/stuck step, NOT per-step durations.
 * `--watch` samples the rows over wall-clock and records each `current_step`
 * TRANSITION (current_step = last COMPLETED step) to reconstruct per-step
 * durations directly from the rows; its resolution is the poll interval. The
 * high-resolution authoritative source is the structured
 * `[cloud-agent-warm] warm step complete` { step, durationMs } logs added in
 * warm-step-processor.ts - grep those from `wrangler tail` / CloudWatch.
 */
import { and, desc, gte, inArray } from "drizzle-orm";

import { getDb } from "../packages/web/lib/db/index.js";
import { cloudAgentBoxWarmJobs } from "@cloud/core/db/schema.js";

type Args = { watch: boolean; intervalMs: number; windowMs: number; workspaceId?: string };

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${k}=`))?.split("=", 2)[1];
  const intervalSec = Number(get("interval") ?? "2");
  const windowMin = Number(get("window") ?? "60");
  return {
    watch: argv.includes("--watch"),
    intervalMs: Math.max(1, Number.isFinite(intervalSec) ? intervalSec : 2) * 1000,
    windowMs: Math.max(1, Number.isFinite(windowMin) ? windowMin : 60) * 60_000,
    workspaceId: get("workspace"),
  };
}

const ms = (n: number): string => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

type JobRow = {
  id: string;
  status: string;
  currentStep: string | null;
  attemptCount: number;
  sandboxId: string | null;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const toMs = (d: Date | string | null): number | null =>
  d == null ? null : new Date(d).getTime();

async function selectRecentJobs(args: Args, since: Date): Promise<JobRow[]> {
  const filters = [gte(cloudAgentBoxWarmJobs.createdAt, since)];
  if (args.workspaceId) {
    // Narrow by workspace when provided; no-op otherwise.
    filters.push(inArray(cloudAgentBoxWarmJobs.workspaceId, [args.workspaceId]));
  }
  const rows = await getDb()
    .select({
      id: cloudAgentBoxWarmJobs.id,
      status: cloudAgentBoxWarmJobs.status,
      currentStep: cloudAgentBoxWarmJobs.currentStep,
      attemptCount: cloudAgentBoxWarmJobs.attemptCount,
      sandboxId: cloudAgentBoxWarmJobs.sandboxId,
      lastError: cloudAgentBoxWarmJobs.lastError,
      startedAt: cloudAgentBoxWarmJobs.startedAt,
      completedAt: cloudAgentBoxWarmJobs.completedAt,
      createdAt: cloudAgentBoxWarmJobs.createdAt,
      updatedAt: cloudAgentBoxWarmJobs.updatedAt,
    })
    .from(cloudAgentBoxWarmJobs)
    .where(filters.length === 1 ? filters[0] : and(...filters))
    .orderBy(desc(cloudAgentBoxWarmJobs.createdAt));
  return rows as JobRow[];
}

async function runSummary(args: Args): Promise<void> {
  const since = new Date(Date.now() - args.windowMs);
  const jobs = await selectRecentJobs(args, since);
  console.log(`\n=== warm-job summary - ${jobs.length} job(s) created in the last ${args.windowMs / 60_000}min ===`);
  if (jobs.length === 0) return;

  const byStatus = new Map<string, number>();
  const stuckStep = new Map<string, number>();
  const readyTotals: number[] = [];

  for (const j of jobs) {
    byStatus.set(j.status, (byStatus.get(j.status) ?? 0) + 1);
    const start = toMs(j.startedAt) ?? toMs(j.createdAt)!;
    const end = toMs(j.completedAt) ?? toMs(j.updatedAt)!;
    const total = Math.max(0, end - start);
    if (j.status === "ready") {
      readyTotals.push(total);
    } else if (j.status === "failed" || j.status === "running") {
      // where did it end / get stuck (current_step = last completed step)
      const key = j.currentStep ?? "<none>";
      stuckStep.set(key, (stuckStep.get(key) ?? 0) + 1);
    }
  }

  console.log("status:", Object.fromEntries(byStatus));
  if (readyTotals.length) {
    console.log(
      `ready total (start->complete): p50=${ms(percentile(readyTotals, 0.5))} ` +
        `p95=${ms(percentile(readyTotals, 0.95))} max=${ms(Math.max(...readyTotals))} (n=${readyTotals.length})`,
    );
  }
  if (stuckStep.size) {
    console.log("non-ready jobs by last-completed step (where it stuck/failed):");
    for (const [step, n] of [...stuckStep.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${step.padEnd(26)} ${n}`);
    }
    const failed = jobs.filter((j) => j.status === "failed" && j.lastError);
    if (failed.length) {
      console.log("\nfailure reasons (lastError):");
      for (const j of failed.slice(0, 20)) {
        console.log(`  [${(j.currentStep ?? "<none>").padEnd(20)}] ${j.id.slice(0, 8)} - ${j.lastError}`);
      }
    }
  }
  console.log(
    "\nNote: per-step DURATION splits are not in the rows (single current_step/updated_at).",
  );
  console.log(
    "      Use --watch for row-sampled splits, or grep the high-resolution",
  );
  console.log(
    '      "[cloud-agent-warm] warm step complete" { step, durationMs } logs.',
  );
}

type WatchState = {
  lastStep: string | null;
  lastChangeMs: number;
  perStepMs: Record<string, number>;
  terminal: boolean;
};

async function runWatch(args: Args): Promise<void> {
  console.log(
    `\n=== watch: sampling warm-job step transitions every ${args.intervalMs / 1000}s ` +
      `(window ${args.windowMs / 60_000}min). Ctrl-C to print aggregate. ===`,
  );
  console.log(
    "    (resolution = poll interval; steps faster than the interval may merge)\n",
  );
  const state = new Map<string, WatchState>();
  const completedPerStep: Record<string, number[]> = {};

  const recordTransition = (jobId: string, fromStep: string | null, toStep: string | null, nowMs: number) => {
    const st = state.get(jobId)!;
    // current_step = last COMPLETED step, so a transition X->Y means step Y just
    // completed; attribute (now - lastChange) to Y. The null->first transition
    // attributes the first step's duration from when the job was first seen.
    const completedStep = toStep;
    if (completedStep) {
      const dur = Math.max(0, nowMs - st.lastChangeMs);
      st.perStepMs[completedStep] = dur;
      (completedPerStep[completedStep] ??= []).push(dur);
      console.log(`  ${jobId.slice(0, 8)}  ${(fromStep ?? "<start>")} -> ${completedStep.padEnd(26)} ${ms(dur)}`);
    }
    st.lastStep = toStep;
    st.lastChangeMs = nowMs;
  };

  const poll = async () => {
    const since = new Date(Date.now() - args.windowMs);
    const jobs = await selectRecentJobs(args, since);
    const nowMs = Date.now();
    for (const j of jobs) {
      const existing = state.get(j.id);
      if (!existing) {
        state.set(j.id, { lastStep: null, lastChangeMs: toMs(j.createdAt) ?? nowMs, perStepMs: {}, terminal: false });
        // If we discover a job mid-flight, seed from its current_step without a
        // synthetic duration (we missed the earlier transitions).
        if (j.currentStep) {
          state.get(j.id)!.lastStep = j.currentStep;
          state.get(j.id)!.lastChangeMs = toMs(j.updatedAt) ?? nowMs;
        }
        continue;
      }
      if (existing.terminal) continue;
      if (j.currentStep !== existing.lastStep) {
        recordTransition(j.id, existing.lastStep, j.currentStep, toMs(j.updatedAt) ?? nowMs);
      }
      if (j.status === "ready" || j.status === "failed") {
        existing.terminal = true;
        const steps = Object.entries(existing.perStepMs);
        const total = steps.reduce((s, [, d]) => s + d, 0);
        console.log(
          `  ${j.id.slice(0, 8)}  TERMINAL=${j.status}  observed-total=${ms(total)}` +
            (j.lastError ? `  error=${j.lastError}` : ""),
        );
      }
    }
  };

  let stop = false;
  process.on("SIGINT", () => { stop = true; });
  await poll();
  while (!stop) {
    await new Promise((r) => setTimeout(r, args.intervalMs));
    await poll();
  }

  console.log("\n=== per-step aggregate (row-sampled; resolution = poll interval) ===");
  for (const [step, durs] of Object.entries(completedPerStep)) {
    console.log(
      `  ${step.padEnd(26)} n=${String(durs.length).padEnd(4)} ` +
        `p50=${ms(percentile(durs, 0.5))} p95=${ms(percentile(durs, 0.95))} max=${ms(Math.max(...durs))}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.watch) {
    await runWatch(args);
  } else {
    await runSummary(args);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[cloud-agent-warm-timing] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

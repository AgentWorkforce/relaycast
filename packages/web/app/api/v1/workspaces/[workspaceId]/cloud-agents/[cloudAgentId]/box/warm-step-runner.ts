import type { AppDb } from "@/lib/db";

import {
  buildRuntimeEnv,
  createOrAdoptStickySandbox,
  ensureBrokerReady,
  ensureSandboxStarted,
  finalizeBoxConnection,
  flushBoxRelayfileMount,
  mountBoxCredentials,
  prepareBoxGitOverlayRoots,
  startBoxRelayfileMount,
  syncBoxGitWorkspace,
  writeBoxEnvFile,
  backgroundErrorMessage,
  isRetryableDaytonaUpstreamError,
  type CloudAgentBoxDeps,
  type CloudAgentBoxInput,
  type CloudAgentBoxResponse,
  type DaytonaClient,
  type DaytonaSandbox,
  type ProviderCredentialRow,
} from "./box-manager";
import {
  CLOUD_AGENT_BOX_WARM_STEPS,
  advanceCloudAgentBoxWarmJob,
  claimCloudAgentBoxWarmJob,
  getCloudAgentBoxWarmJob,
  markCloudAgentBoxWarmJobFailed,
  markCloudAgentBoxWarmJobReady,
  releaseCloudAgentBoxWarmJobLease,
  type CloudAgentBoxWarmJobRow,
  type CloudAgentBoxWarmStep,
} from "./warm-job-store";

/**
 * Cloud-agent box warm step-runner skeleton (issue #1384, slice 2 — DORMANT).
 *
 * Maps each ordered warm step to its slice-1 step function and runs a single
 * step against a job context: claim-with-lease, execute, checkpoint
 * `currentStep` (or mark ready on the final step), and on terminal error apply
 * the failure-state contract (job failed + sandbox failed, error =
 * backgroundErrorMessage). Nothing calls this in slice 2 — slice 3 wires it to
 * a queue consumer + route enqueue. The live async warm path is untouched.
 *
 * Note: `WarmStepContext` materials (envVars/credentialSecret/sandbox/apiKey)
 * are threaded by the slice-3 consumer across continuations; this skeleton only
 * fixes the dispatch + lifecycle contract.
 */

const LAST_WARM_STEP = CLOUD_AGENT_BOX_WARM_STEPS[CLOUD_AGENT_BOX_WARM_STEPS.length - 1];

/** Mutable materials a step needs. Produced-values are written back as steps run. */
export interface WarmStepContext {
  deps: CloudAgentBoxDeps;
  daytona: DaytonaClient;
  input: CloudAgentBoxInput;
  credential: ProviderCredentialRow;
  mountPaths: string[];
  relayfileToken: string;
  apiKey: string;
  home: string;
  envVars: Record<string, string>;
  credentialSecret: string | null;
  sandbox: DaytonaSandbox | null;
  createdSandboxId: string | null;
  result: { response: CloudAgentBoxResponse; status: string } | null;
}

export type WarmStepExecutor = (ctx: WarmStepContext) => Promise<void>;

function requireSandbox(ctx: WarmStepContext): DaytonaSandbox {
  if (!ctx.sandbox) {
    throw new Error("Warm step requires a sandbox; ensure-sandbox has not run yet");
  }
  return ctx.sandbox;
}

/**
 * Dispatch table: warm step -> slice-1 step function. Keys are exactly the
 * ordered `CLOUD_AGENT_BOX_WARM_STEPS`, so the runner can drive any step by name.
 */
export const WARM_STEP_EXECUTORS: Record<CloudAgentBoxWarmStep, WarmStepExecutor> = {
  "ensure-sandbox": async (ctx) => {
    const { sandbox, createdSandboxId } = await createOrAdoptStickySandbox(
      ctx.deps,
      ctx.daytona,
      ctx.input,
      ctx.credential,
      ctx.envVars,
    );
    await ensureSandboxStarted(ctx.daytona, sandbox);
    ctx.sandbox = sandbox;
    ctx.createdSandboxId = createdSandboxId;
  },
  "build-env": async (ctx) => {
    const { envVars, credentialSecret } = await buildRuntimeEnv(
      ctx.deps,
      ctx.input,
      ctx.credential,
      ctx.relayfileToken,
      ctx.mountPaths,
    );
    ctx.envVars = envVars;
    ctx.credentialSecret = credentialSecret;
  },
  "mount-credentials": async (ctx) => {
    await mountBoxCredentials(ctx.deps, requireSandbox(ctx), ctx.home, ctx.credential, ctx.credentialSecret);
  },
  "flush-relayfile": async (ctx) => {
    await flushBoxRelayfileMount(ctx.deps, requireSandbox(ctx), ctx.home, ctx.input, ctx.credential);
  },
  "sync-git": async (ctx) => {
    await syncBoxGitWorkspace(ctx.deps, ctx.input, requireSandbox(ctx), ctx.home);
  },
  "prepare-git-overlay-roots": async (ctx) => {
    await prepareBoxGitOverlayRoots(ctx.input, requireSandbox(ctx), ctx.home, ctx.mountPaths);
  },
  "start-relayfile-mount": async (ctx) => {
    await startBoxRelayfileMount(
      ctx.deps,
      ctx.input,
      requireSandbox(ctx),
      ctx.home,
      ctx.credential,
      ctx.envVars,
      ctx.mountPaths,
    );
  },
  "write-env": async (ctx) => {
    await writeBoxEnvFile(requireSandbox(ctx), ctx.home, ctx.envVars);
  },
  "ensure-broker": async (ctx) => {
    await ensureBrokerReady(requireSandbox(ctx), ctx.home, ctx.envVars, ctx.apiKey);
  },
  "finalize": async (ctx) => {
    ctx.result = await finalizeBoxConnection(
      requireSandbox(ctx),
      ctx.apiKey,
      ctx.relayfileToken,
      ctx.mountPaths,
      ctx.input.workspaceSource,
    );
  },
};

export type RunWarmJobStepResult =
  | { outcome: "ran"; job: CloudAgentBoxWarmJobRow | null }
  | { outcome: "duplicate"; job: CloudAgentBoxWarmJobRow }
  | { outcome: "contended"; job: CloudAgentBoxWarmJobRow }
  | { outcome: "not_found"; job: null }
  | { outcome: "retryable"; job: CloudAgentBoxWarmJobRow | null; error: string }
  | { outcome: "failed"; job: CloudAgentBoxWarmJobRow | null; error: string };

export interface RunWarmJobStepArgs {
  db?: AppDb;
  jobId: string;
  step: CloudAgentBoxWarmStep;
  ctx: WarmStepContext;
  /** Override the dispatch table (tests inject spies/throwers). */
  executors?: Record<CloudAgentBoxWarmStep, WarmStepExecutor>;
}

/**
 * Run a single warm step for a job.
 *
 * - Claims the job for `step` (single-flight lease). A `duplicate` claim
 *   (terminal or already past `step`) is an idempotent no-op — returns without
 *   re-running. A `contended` claim returns immediately too.
 * - On success: checkpoints `currentStep` (or marks the job ready on the final
 *   step).
 * - On terminal error: marks the job failed AND the sandbox failed with
 *   `error = backgroundErrorMessage(err)`, then returns `failed` (does not
 *   rethrow — the failure is terminal and fully recorded).
 */
export async function runWarmJobStep(
  args: RunWarmJobStepArgs,
): Promise<RunWarmJobStepResult> {
  const { db, jobId, step, ctx } = args;
  const executors = args.executors ?? WARM_STEP_EXECUTORS;

  const claim = await claimCloudAgentBoxWarmJob(db, jobId, step);
  if (claim.outcome === "not_found") {
    return { outcome: "not_found", job: null };
  }
  if (claim.outcome === "duplicate") {
    return { outcome: "duplicate", job: claim.job };
  }
  if (claim.outcome === "contended") {
    return { outcome: "contended", job: claim.job };
  }

  try {
    await executors[step](ctx);
    if (step === LAST_WARM_STEP) {
      await markCloudAgentBoxWarmJobReady(db, jobId, ctx.sandbox?.id);
    } else {
      await advanceCloudAgentBoxWarmJob(db, jobId, step);
    }
    return { outcome: "ran", job: await getCloudAgentBoxWarmJob(db, jobId) };
  } catch (error) {
    const message = backgroundErrorMessage(error);
    // Transient Daytona upstream timeout (524 / proxy.app.daytona.io / 52x
    // timeout — same narrow predicate retryOnDaytonaUpstreamTimeout uses): do
    // NOT terminal-fail. Release the lease WITHOUT advancing currentStep so the
    // CF-Queue redelivery of the SAME step re-claims and re-runs it. CF-Queue
    // maxRetries bounds the attempts; the DLQ path then terminal-fails via
    // failExhausted. This makes the queue path strictly more resilient than the
    // old inline waitUntil path, which could not retry an upstream blip at all.
    if (isRetryableDaytonaUpstreamError(error)) {
      await releaseCloudAgentBoxWarmJobLease(db, jobId, message);
      return { outcome: "retryable", job: await getCloudAgentBoxWarmJob(db, jobId), error: message };
    }
    await markCloudAgentBoxWarmJobFailed(db, jobId, message);
    const sandboxId = ctx.sandbox?.id ?? claim.job.sandboxId;
    if (sandboxId) {
      await ctx.deps.updateSandbox({
        sandboxId,
        workspaceId: ctx.input.auth.workspaceId,
        status: "failed",
        error: message,
        expectedReadyBy: null,
      });
    }
    return { outcome: "failed", job: await getCloudAgentBoxWarmJob(db, jobId), error: message };
  }
}

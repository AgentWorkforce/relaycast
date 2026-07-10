import { optionalEnv } from "@/lib/env";

import {
  CloudAgentBoxError,
  etaMsUntil,
  loadCredentialOrThrow,
  mintRelayfileToken,
  normalizeMountPaths,
  primaryMountPath,
  readCloudAgentBox,
  type CloudAgentBoxDeps,
  type CloudAgentBoxInput,
  type CloudAgentBoxResponse,
  type CloudAgentBoxWarmPhase,
  type CloudAgentBoxWarmStartResult,
  type ProviderCredentialRow,
} from "./box-manager";
import { enqueueCloudAgentBoxWarm } from "./warm-queue";
import {
  createCloudAgentBoxWarmJob,
  getLatestCloudAgentBoxWarmJob,
  isCloudAgentBoxWarmJobPending,
  type CloudAgentBoxWarmJobRow,
  type CloudAgentBoxWarmStep,
} from "./warm-job-store";

/**
 * Producer-side route helpers for the queue-backed warm path (issue #1384,
 * slice 3b). Used by the route ONLY when CLOUD_AGENT_WARM_VIA_QUEUE is enabled.
 * The flag defaults OFF: with it off the route runs the unchanged
 * startCloudAgentBoxWarm / readCloudAgentBox path (byte-for-byte).
 */

export const CLOUD_AGENT_WARM_VIA_QUEUE_ENV = "CLOUD_AGENT_WARM_VIA_QUEUE";
const QUEUE_WARM_ETA_MS = 5 * 60_000;

export function isCloudAgentWarmViaQueueEnabled(): boolean {
  const raw = optionalEnv(CLOUD_AGENT_WARM_VIA_QUEUE_ENV)?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Flag-ON async warm: persist a warm-job row carrying the request params, then
 * enqueue its first step (the thin consumer drives the rest via cloud-web).
 * Returns the same 202 warming contract as legacy startCloudAgentBoxWarm, plus
 * optional phase/eta progress fields for clients that understand them.
 */
export async function startCloudAgentBoxWarmViaQueue(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
): Promise<CloudAgentBoxWarmStartResult> {
  const credential = await loadCredentialOrThrow(deps, input);
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);

  const job = await createCloudAgentBoxWarmJob(undefined, {
    workspaceId: input.auth.workspaceId,
    cloudAgentId: credential.id,
    userId: input.auth.userId,
    organizationId: input.auth.organizationId,
    request: {
      mountPaths: input.mountPaths,
      workspaceSource:
        (input.workspaceSource as Record<string, unknown> | undefined) ?? null,
      workspaceToken: input.workspaceToken,
      // #125: broker identity must survive the queue hop — each step rebuilds
      // its input from this row alone (see warmJobInput).
      ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      ...(input.brokerName ? { brokerName: input.brokerName } : {}),
    },
  });

  await enqueueCloudAgentBoxWarm({ jobId: job.id, expectedStep: "ensure-sandbox" });

  return {
    status: 202,
    response: {
      sandboxId: job.id,
      status: "warming",
      relayfileToken,
      relayfileMountPath: primaryMountPath(mountPaths, input.workspaceSource),
      phase: "queued",
      etaMs: QUEUE_WARM_ETA_MS,
    },
  };
}

/**
 * Flag-ON GET: while a warm job is queued/running, report `warming` (with the
 * checkpoint step). Once ready/failed (or no job), defer to the existing
 * readCloudAgentBox, which reads the sandboxes row the consumer maintains.
 */
export async function readCloudAgentBoxViaQueue(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
): Promise<CloudAgentBoxResponse> {
  const credential = await loadCredentialOrThrow(deps, input);
  const job = await getLatestCloudAgentBoxWarmJob(
    undefined,
    input.auth.workspaceId,
    credential.id,
  );
  if (job && isCloudAgentBoxWarmJobPending(job)) {
    const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
    const relayfileToken = await mintRelayfileToken(deps, input, credential, mountPaths);
    const etaMs = etaMsForWarmJob(deps, job);
    return {
      sandboxId: job.sandboxId ?? job.id,
      status: "warming",
      relayfileToken,
      relayfileMountPath: primaryMountPath(mountPaths, input.workspaceSource),
      ...(job.currentStep ? { currentStep: job.currentStep } : {}),
      phase: phaseForWarmJob(job),
      ...(etaMs !== undefined ? { etaMs } : {}),
    };
  }

  // Job is non-pending (ready/failed/DLQ) or absent: read the sandboxes row the
  // consumer maintains, but suppress the legacy warm-deadline. On the queue path
  // the job state + DLQ own failure detection, so a row still flagged `warming`
  // past the old heuristic must not be falsely timed out by GET.
  try {
    const response = await readCloudAgentBox(deps, input, { enforceWarmDeadline: false });
    if (
      job &&
      response.status === "warming" &&
      (!job.sandboxId || response.sandboxId === job.sandboxId)
    ) {
      return terminalWarmJobResponse(deps, input, credential, job, response);
    }
    return withTerminalQueueProgress(response);
  } catch (error) {
    if (
      job?.status === "failed" &&
      error instanceof CloudAgentBoxError &&
      error.code === "box_not_found"
    ) {
      return terminalWarmJobResponse(deps, input, credential, job);
    }
    throw error;
  }
}

async function terminalWarmJobResponse(
  deps: CloudAgentBoxDeps,
  input: CloudAgentBoxInput,
  credential: ProviderCredentialRow,
  job: CloudAgentBoxWarmJobRow,
  fallback?: CloudAgentBoxResponse,
): Promise<CloudAgentBoxResponse> {
  const mountPaths = normalizeMountPaths(input.mountPaths, input.workspaceSource);
  const relayfileToken = fallback?.relayfileToken
    ?? (await mintRelayfileToken(deps, input, credential, mountPaths));
  const relayfileMountPath = primaryMountPath(mountPaths, input.workspaceSource);
  const base = {
    sandboxId: job.sandboxId ?? fallback?.sandboxId ?? job.id,
    relayfileToken,
    relayfileMountPath: fallback?.relayfileMountPath ?? relayfileMountPath,
    ...(job.currentStep ? { currentStep: job.currentStep } : {}),
  };
  if (job.status === "ready") {
    return { ...base, status: "ready", phase: "ready", etaMs: 0 };
  }
  if (job.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: job.lastError ?? fallback?.error ?? "Cloud agent box warm failed",
    };
  }
  return fallback ?? {
    ...base,
    status: "warming",
  };
}

function withTerminalQueueProgress(response: CloudAgentBoxResponse): CloudAgentBoxResponse {
  return response.status === "ready"
    ? { ...response, phase: "ready", etaMs: 0 }
    : response;
}

function phaseForWarmJob(job: Pick<CloudAgentBoxWarmJobRow, "status" | "currentStep">): CloudAgentBoxWarmPhase {
  if (job.status === "queued") {
    return "queued";
  }
  if (job.status === "ready" || job.currentStep === "finalize") {
    return "ready";
  }
  return phaseAfterWarmStep(job.currentStep);
}

function phaseAfterWarmStep(step: CloudAgentBoxWarmStep | null): CloudAgentBoxWarmPhase {
  switch (step) {
    case null:
      return "pulling-image";
    case "ensure-sandbox":
    case "build-env":
    case "mount-credentials":
      return "starting";
    case "flush-relayfile":
      return "cloning";
    case "sync-git":
    case "prepare-git-overlay-roots":
    case "start-relayfile-mount":
    case "write-env":
    case "ensure-broker":
      return "mounting";
    case "finalize":
      return "ready";
  }
}

function etaMsForWarmJob(
  deps: CloudAgentBoxDeps,
  job: Pick<CloudAgentBoxWarmJobRow, "status" | "createdAt">,
): number | undefined {
  if (job.status === "ready") {
    return 0;
  }
  if (job.status === "failed") {
    return undefined;
  }
  return etaMsUntil(deps.now(), new Date(new Date(job.createdAt).getTime() + QUEUE_WARM_ETA_MS));
}

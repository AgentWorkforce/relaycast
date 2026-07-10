import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import { Nango } from "@nangohq/node";
import { RelayFileClient } from "@relayfile/sdk";
import { Resource } from "sst";
import { fromCloudflareEnv } from "sst/resource";
import { parseNangoSyncJob, type NangoSyncJob } from "./nango-sync-job.js";
import {
  processNangoSyncPage,
  NANGO_SYNC_DEFAULT_PAGE_SIZE,
  type NangoSyncDeltaEventHooks,
  type NangoSyncPageDeps,
} from "./nango-sync-runtime.js";
import { planProviderRecordWrites } from "./provider-write-planner.js";
import { writeBatchToRelayfile, WRITE_CONCURRENCY } from "./record-writer.js";
import { mintRelayfileToken } from "../relayfile/client.js";
import {
  markProviderInitialSyncRunning,
  markProviderInitialSyncComplete,
  markProviderInitialSyncFailed,
} from "../provider-readiness-worker.js";

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_RELAYFILE_URL = "https://api.relayfile.dev";
const DEFAULT_RELAYAUTH_URL = "https://api.relayauth.dev";

// Maximum page steps before spawning a continuation Workflow instance.
// CF Workflows cap replay journal size; 900 gives headroom below that limit.
const MAX_PAGE_STEPS = 900;

const PAGE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

const READINESS_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds" },
  timeout: "30 seconds",
};

// Workflow binding type for the continuation self-trigger
type WorkflowBinding = {
  create(opts?: { id?: string; params?: NangoSyncJob }): Promise<unknown>;
};

type ServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type NangoSyncWorkflowEnv = {
  NANGO_SYNC_WORKFLOW: WorkflowBinding;
  AGENT_GATEWAY?: ServiceBinding;
  // Raw env-var fallbacks for when Resource.X.value doesn't resolve inside
  // WorkflowEntrypoint (unverified at time of writing — play it safe).
  NANGO_SECRET_KEY?: string;
  WEB_RELAYAUTH_API_KEY?: string;
  RELAYFILE_INTERNAL_HMAC_SECRET?: string;
  RELAYFILE_URL?: string;
  NANGO_SYNC_RELAYAUTH_URL?: string;
  NANGO_HOST?: string;
};

// ---------------------------------------------------------------------------
// Secret resolution helpers — Resource first, env fallback
// ---------------------------------------------------------------------------

function resolveNangoSecretKey(env: NangoSyncWorkflowEnv): string {
  try {
    const val = Resource.NangoSecretKey?.value?.trim();
    if (val) return val;
  } catch {
    // Resource.X.value may not bind inside WorkflowEntrypoint — fall through
  }
  const via_env = env.NANGO_SECRET_KEY?.trim();
  if (via_env) return via_env;
  throw new Error("Nango secret key is not configured.");
}

function resolveRelayAuthApiKey(env: NangoSyncWorkflowEnv): string {
  try {
    const resources = Resource as unknown as {
      WebRelayauthApiKey?: { value?: string };
    };
    const val = resources.WebRelayauthApiKey?.value?.trim();
    if (val) return val;
  } catch {
    // fall through to env fallback
  }
  const via_env = env.WEB_RELAYAUTH_API_KEY?.trim();
  if (via_env) return via_env;
  throw new Error("NANGO_SYNC_RELAYAUTH_API_KEY is not configured.");
}

function resolveRelayfileInternalHmacSecret(env: NangoSyncWorkflowEnv): string {
  try {
    const resources = Resource as unknown as {
      RelayfileInternalHmacSecret?: { value?: string };
    };
    const val = resources.RelayfileInternalHmacSecret?.value?.trim();
    if (val) return val;
  } catch {
    // fall through to env fallback
  }
  const via_env = env.RELAYFILE_INTERNAL_HMAC_SECRET?.trim();
  if (via_env) return via_env;
  throw new Error("RELAYFILE_INTERNAL_HMAC_SECRET is not configured.");
}

function resolveNangoHost(env: NangoSyncWorkflowEnv): string {
  return (env.NANGO_HOST?.trim() || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
}

function resolveRelayfileUrl(env: NangoSyncWorkflowEnv): string {
  return env.RELAYFILE_URL?.trim() || DEFAULT_RELAYFILE_URL;
}

function resolveRelayAuthUrl(env: NangoSyncWorkflowEnv): string {
  return env.NANGO_SYNC_RELAYAUTH_URL?.trim() || DEFAULT_RELAYAUTH_URL;
}

function readResourceBinding(name: string): unknown {
  try {
    return (Resource as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function resourceValuePresent(name: string): boolean {
  const resource = readResourceBinding(name);
  const value = (resource as { value?: unknown } | undefined)?.value;
  return typeof value === "string" && value.trim().length > 0;
}

function hydrateWorkflowResourceBindings(
  env: NangoSyncWorkflowEnv,
  context: { instanceId: string; workspaceId: string; provider: string },
): void {
  // SST's Cloudflare fetch wrapper hydrates Resource from the request env, but
  // Cloudflare Workflow class exports do not pass through that wrapper.
  fromCloudflareEnv(env);

  const requiredResources = [
    "NeonDatabaseUrl",
    "NangoSecretKey",
    "RelayfileInternalHmacSecret",
    "WebRelayauthApiKey",
  ] as const;
  const resourcePresence = Object.fromEntries(
    requiredResources.map((name) => [name, resourceValuePresent(name)]),
  ) as Record<(typeof requiredResources)[number], boolean>;

  console.log(JSON.stringify({
    area: "diag/nango-worker-runtime",
    event: "workflow-resource-hydration",
    instanceId: context.instanceId,
    workspaceId: context.workspaceId,
    provider: context.provider,
    hasNeonDatabaseUrl: resourcePresence.NeonDatabaseUrl,
    hasNangoSecretKey: resourcePresence.NangoSecretKey,
    hasRelayfileInternalHmacSecret: resourcePresence.RelayfileInternalHmacSecret,
    hasWebRelayauthApiKey: resourcePresence.WebRelayauthApiKey,
  }));

  // Only enforce the Resource shape when this is an SST-linked runtime. Local
  // tests/dev can still use explicit env fallbacks for non-DB secrets.
  if (readResourceBinding("App") !== undefined) {
    const missing = requiredResources.filter((name) => !resourcePresence[name]);
    if (missing.length > 0) {
      throw new Error(
        `NangoSyncWorkflow Resource hydration failed: missing ${missing.join(", ")}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

function buildNangoClient(env: NangoSyncWorkflowEnv) {
  return new Nango({
    secretKey: resolveNangoSecretKey(env),
    host: resolveNangoHost(env),
  }) as unknown as NangoSyncPageDeps["nango"];
}

function buildRelayfileClient(
  workspaceId: string,
  env: NangoSyncWorkflowEnv,
): RelayFileClient {
  const relayAuthUrl = resolveRelayAuthUrl(env);
  const relayAuthApiKey = resolveRelayAuthApiKey(env);
  return new RelayFileClient({
    baseUrl: resolveRelayfileUrl(env),
    readCache: {},
    token: () =>
      mintRelayfileToken({
        workspaceId,
        relayAuthUrl,
        relayAuthApiKey,
        agentName: "nango-sync-workflow",
      }),
  });
}

type NeonAdapterModule = {
  normalizeNeonSyncDelta(
    modelName: string,
    records: readonly Record<string, unknown>[],
  ): NormalizedNeonSyncDelta[];
};

type NeonPathMapperModule = {
  normalizeNangoNeonModel(modelName: string): string;
  computeNeonPath(objectType: string, objectId: string): string;
};

type NormalizedNeonSyncDelta = {
  provider: "neon";
  eventType: string;
  objectType: string;
  objectId: string;
  path: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

const NEON_PROVIDER_CONFIG_KEYS = new Set(["neon-relay", "neon-composio-relay"]);

export function buildNeonSyncDeltaEventHooks(env: NangoSyncWorkflowEnv): NangoSyncDeltaEventHooks {
  return {
    async preparePage({ job, writeJob, records, relayfile, suppressEvents }) {
      if (suppressEvents || !isNeonSyncTriggerCandidate(job)) {
        return null;
      }

      const [normalizer, pathMapper] = await Promise.all([
        import("@relayfile/adapter-neon/webhook") as Promise<NeonAdapterModule>,
        import("@relayfile/adapter-neon/path-mapper") as Promise<NeonPathMapperModule>,
      ]);
      const model = pathMapper.normalizeNangoNeonModel(job.model);
      if (model !== "operation" && model !== "endpoint" && model !== "advisor-issue") {
        return null;
      }

      const enrichedRecords = await enrichNeonTransitionEvidence({
        pathMapper,
        model,
        records,
        relayfile,
        relayWorkspaceId: writeJob.workspaceId,
      });
      const events = normalizer.normalizeNeonSyncDelta(job.model, enrichedRecords);
      if (events.length === 0) {
        return null;
      }

      return {
        async dispatch() {
          await dispatchNeonSyncDeltaEvents(env, job, events);
        },
      };
    },
  };
}

function isNeonSyncTriggerCandidate(job: NangoSyncJob): boolean {
  return (
    job.provider === "neon" ||
    NEON_PROVIDER_CONFIG_KEYS.has(job.providerConfigKey)
  );
}

async function enrichNeonTransitionEvidence(input: {
  pathMapper: NeonPathMapperModule;
  model: "operation" | "endpoint" | "advisor-issue";
  records: readonly Record<string, unknown>[];
  relayfile: NangoSyncPageDeps["relayfile"];
  relayWorkspaceId: string;
}): Promise<Record<string, unknown>[]> {
  if (input.model === "advisor-issue") {
    return [...input.records];
  }

  const field = input.model === "operation" ? "status" : "current_state";
  const enriched: Record<string, unknown>[] = [];
  for (const record of input.records) {
    if (readNangoLastAction(record) !== "updated") {
      enriched.push(record);
      continue;
    }

    const objectId = readStringField(record, "id");
    const currentValue = readStringField(record, field);
    if (!objectId || !currentValue || !input.relayfile.readFile) {
      enriched.push(record);
      continue;
    }

    const path = input.pathMapper.computeNeonPath(input.model, objectId);
    const previous = await readPriorRelayfileJsonRecord(
      input.relayfile,
      input.relayWorkspaceId,
      path,
    );
    const previousValue = previous ? readStringField(previous, field) : undefined;
    enriched.push({
      ...record,
      _relayfile_transition: {
        previous: previous
          ? { [field]: previousValue }
          : undefined,
        current: { [field]: currentValue },
        changedFields:
          previousValue !== undefined && previousValue !== currentValue
            ? [field]
            : [],
      },
    });
  }
  return enriched;
}

async function readPriorRelayfileJsonRecord(
  relayfile: NangoSyncPageDeps["relayfile"],
  workspaceId: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  if (!relayfile.readFile) {
    return null;
  }
  try {
    const value = await relayfile.readFile(workspaceId, path);
    const content = typeof value === "string" ? value : value?.content;
    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (error) {
    if (isNotFoundLikeError(error)) {
      return null;
    }
    throw error;
  }
}

async function dispatchNeonSyncDeltaEvents(
  env: NangoSyncWorkflowEnv,
  job: NangoSyncJob,
  events: readonly NormalizedNeonSyncDelta[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  if (!env.AGENT_GATEWAY) {
    throw new Error("AGENT_GATEWAY service binding is not configured for Neon sync trigger dispatch.");
  }
  const secret = resolveRelayfileInternalHmacSecret(env);

  for (const event of events) {
    const body = JSON.stringify({
      workspaceId: job.workspaceId,
      path: event.path,
      writeId: neonSyncDeltaDeliveryId(job, event),
      occurredAt: event.occurredAt,
      provider: event.provider,
      eventType: event.eventType,
      connectionId: job.connectionId,
      payload: buildNeonAgentEventResource(event),
    });
    const timestamp = new Date().toISOString();
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}\n${body}`)
      .digest("hex");
    const response = await env.AGENT_GATEWAY.fetch(
      new Request("https://agent-gateway.internal/internal/vfs-watch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-relay-timestamp": timestamp,
          "x-relay-signature": signature,
        },
        body,
      }),
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Neon sync trigger dispatch failed with ${response.status}${text ? `: ${text}` : ""}`,
      );
    }
  }
}

function buildNeonAgentEventResource(
  event: NormalizedNeonSyncDelta,
): Record<string, unknown> {
  return {
    ...event.payload,
    provider: event.provider,
    eventType: event.eventType,
    objectType: event.objectType,
    id: event.objectId,
    objectId: event.objectId,
    path: event.path,
    occurredAt: event.occurredAt,
    payload: event.payload,
    metadata: event.metadata,
  };
}

function neonSyncDeltaDeliveryId(
  job: NangoSyncJob,
  event: NormalizedNeonSyncDelta,
): string {
  const cursor = typeof event.metadata.cursor === "string" ? event.metadata.cursor : "";
  return [
    "neon",
    job.connectionId,
    event.eventType,
    event.objectId,
    event.occurredAt,
    cursor,
  ].filter(Boolean).join(":");
}

function readNangoLastAction(record: Record<string, unknown>): string | null {
  const metadata = record._nango_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const action = (metadata as Record<string, unknown>).last_action;
  return typeof action === "string" && action.trim()
    ? action.trim().toLowerCase()
    : null;
}

function readStringField(record: Record<string, unknown>, field: string): string | undefined {
  const camelField = field.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
  for (const key of [field, camelField]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function isNotFoundLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { status?: unknown; code?: unknown; message?: unknown };
  return (
    record.status === 404 ||
    record.code === "not_found" ||
    (typeof record.message === "string" && /not[\s_-]?found|404/i.test(record.message))
  );
}

function buildPageDeps(job: NangoSyncJob, env: NangoSyncWorkflowEnv): NangoSyncPageDeps {
  const relayfileWorkspaceId = job.relayWorkspaceId?.trim() || job.workspaceId;
  const relayfileClient = buildRelayfileClient(relayfileWorkspaceId, env);
  return {
    nango: buildNangoClient(env),
    relayfile: {
      readFile(workspaceId, path) {
        return relayfileClient.readFile(workspaceId, path);
      },
      writeBatch(records, writeJob, options) {
        return writeBatchToRelayfile(relayfileClient, records, writeJob, {
          concurrency: WRITE_CONCURRENCY,
          ...options,
        });
      },
    },
    syncDeltaEvents: buildNeonSyncDeltaEventHooks(env),
    pageSize: NANGO_SYNC_DEFAULT_PAGE_SIZE,
    writeConcurrency: WRITE_CONCURRENCY,
  };
}

// A continuation child whose deterministic id already exists is the intended,
// idempotent outcome of a step replay — distinguish it from real failures.
function isInstanceAlreadyExistsError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /already exist|duplicate|exists/i.test(message);
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export class NangoSyncWorkflow extends WorkflowEntrypoint<
  NangoSyncWorkflowEnv,
  NangoSyncJob
> {
  async run(
    event: WorkflowEvent<NangoSyncJob>,
    step: WorkflowStep,
  ): Promise<void> {
    const job = parseNangoSyncJob(event.payload as unknown);
    hydrateWorkflowResourceBindings(this.env, {
      instanceId: event.instanceId,
      workspaceId: job.workspaceId,
      provider: job.provider,
    });

    // Fail fast before any side effects — runs on every Workflow replay.
    planProviderRecordWrites(job, [], undefined);

    let cursor: string | null =
      typeof job.cursor === "string" && job.cursor.trim()
        ? job.cursor.trim()
        : null;
    let recordOffset =
      Number.isInteger(job.recordOffset) && job.recordOffset! > 0
        ? job.recordOffset!
        : 0;
    let pageIndex = 0;

    try {
      await step.do("mark-running", READINESS_STEP_CONFIG, async () => {
        await markProviderInitialSyncRunning({
          workspaceId: job.workspaceId,
          provider: job.provider,
          providerConfigKey: job.providerConfigKey,
          syncName: job.syncName,
          model: job.model,
          modifiedAfter: job.modifiedAfter,
        });
        return null;
      });

      while (true) {
        // Near the step-count safety threshold: spawn a continuation instance
        // rather than adding more steps to the current replay journal.
        if (pageIndex >= MAX_PAGE_STEPS) {
          // Deterministic continuation id so a retry/replay of THIS step never
          // spawns a second child for the same cursor. step.do is at-least-once
          // and create() is a non-idempotent side effect, so without a pinned id
          // a replay (child created but step result not yet durably recorded)
          // would start a duplicate continuation — racing readiness and double-
          // writing Relayfile. Same parent instance + page boundary => same id
          // => Cloudflare dedups. (The INITIAL enqueue stays id-less so backfills
          // remain re-runnable; only continuations are pinned.)
          const continuationId = `${event.instanceId}-c${pageIndex}`;
          const continuationCursor = cursor;
          const continuationRecordOffset = recordOffset;
          const { recordOffset: _jobRecordOffset, ...continuationJob } = job;
          await step.do("continue", READINESS_STEP_CONFIG, async () => {
            try {
              await this.env.NANGO_SYNC_WORKFLOW.create({
                id: continuationId,
                params: {
                  ...continuationJob,
                  cursor: continuationCursor,
                  ...(continuationRecordOffset > 0
                    ? { recordOffset: continuationRecordOffset }
                    : {}),
                },
              });
            } catch (error) {
              // A replay may re-attempt creation of an already-created
              // continuation. CF rejects duplicate instance ids; that means the
              // child already exists — the intended outcome — so treat as success.
              if (!isInstanceAlreadyExistsError(error)) {
                throw error;
              }
            }
            return null;
          });
          return;
        }

        const stepName = `page-${pageIndex}`;
        // Capture cursor for use inside the step callback (closed over below).
        const stepCursor = cursor;
        const stepRecordOffset = recordOffset;
        const result = await step.do(
          stepName,
          PAGE_STEP_CONFIG,
          async () => {
            // globalThis.fetch is used by underlying HTTP clients per Workers rule.
            return processNangoSyncPage(
              job,
              { cursor: stepCursor, recordOffset: stepRecordOffset },
              buildPageDeps(job, this.env),
            );
          },
        );

        pageIndex++;
        if (result.nextRecordOffset !== undefined) {
          recordOffset = result.nextRecordOffset;
          continue;
        }
        cursor = result.nextCursor;
        recordOffset = 0;
        if (!cursor) break;
      }

      await step.do("mark-complete", READINESS_STEP_CONFIG, async () => {
        await markProviderInitialSyncComplete({
          workspaceId: job.workspaceId,
          provider: job.provider,
          providerConfigKey: job.providerConfigKey,
          syncName: job.syncName,
          model: job.model,
          modifiedAfter: job.modifiedAfter,
        });
        return null;
      });
    } catch (error) {
      await step.do("mark-failed", READINESS_STEP_CONFIG, async () => {
        await markProviderInitialSyncFailed({
          workspaceId: job.workspaceId,
          provider: job.provider,
          error: error instanceof Error ? error.message : String(error),
          providerConfigKey: job.providerConfigKey,
          syncName: job.syncName,
          model: job.model,
          modifiedAfter: job.modifiedAfter,
        });
        return null;
      });
      throw error;
    }
  }
}

// Workers entrypoint requirement — Workflow modules must export a fetch handler.
export default {
  fetch(_request: Request, _env: NangoSyncWorkflowEnv): Response {
    return new Response("NangoSyncWorkflow — not a fetch endpoint", {
      status: 404,
    });
  },
};

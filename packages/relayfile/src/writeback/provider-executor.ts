import { resolveRelayfileWritebackBridgeConfig, type AppEnv } from "../env.js";
import type {
  FileReadResponse,
  WritebackExecutionContextResponse,
  WritebackQueueMessage,
} from "../types.js";
import { fetchWorkspaceDOWithBackpressure } from "../workspace-do-backpressure.js";
import { getUnsupportedWritebackReason } from "./path-eligibility.js";
import { dispatchProviderWriteback } from "./providers/index.js";
import type {
  DispatchResult,
  IntegrationCredential,
  WritebackInput,
  WritebackProvider,
} from "./types.js";
import { readBoundedText } from "./nango.js";

type ExecutorOptions = {
  bridgeUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type WritebackBatchExecutionResult = {
  task: WritebackQueueMessage;
  success: boolean;
  error?: string;
};

const TERMINAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "dead_lettered",
  "canceled",
]);
const MAX_BRIDGE_BATCH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_RESPONSE_BODY_BYTES = 16 * 1024;
const MAX_WRITEBACK_CONTENT_BYTES = 25 * 1024 * 1024;

type BridgeBatchInput = {
  task: WritebackQueueMessage;
  input: ReturnType<typeof toBridgeInput>;
};

export async function executeProviderWriteback(
  task: WritebackQueueMessage,
  env: Pick<
    AppEnv["Bindings"],
    | "WORKSPACE_DO"
    | "RELAYFILE_WRITEBACK_BRIDGE_URL"
    | "INTERNAL_HMAC_SECRET"
    | "NANGO_SECRET_KEY"
    | "NANGO_BASE_URL"
    | "AUDIT_QUEUE"
  >,
  options: ExecutorOptions = {},
): Promise<void> {
  let context: WritebackExecutionContextResponse;
  try {
    context = await fetchWritebackContext(task, env);
  } catch (error) {
    if (error instanceof PermanentWritebackFailure) {
      logPermanentFailure(error.task, error.message);
      await acknowledgePermanentFailure(task, env, error.message);
      return;
    }
    throw error;
  }
  const provider = resolveProvider(
    context.operation.path,
    context.operation.provider,
  );
  logWritebackEvent("writeback.start", {
    opId: context.operation.opId,
    workspaceId: context.workspaceId,
    provider,
    path: context.operation.path,
  });

  if (TERMINAL_OPERATION_STATUSES.has(context.operation.status)) {
    logWritebackEvent(
      "writeback.adapter.resolved",
      resolveAdapterLogMetadata(
        provider,
        context.operation.path,
        context.operation.action,
      ),
    );
    if (context.operation.status === "dead_lettered") {
      console.error(
        JSON.stringify({
          event: "writeback.dead_lettered",
          opId: context.operation.opId,
          ...readDeadLetterLogMetadata(context),
        }),
      );
    }
    return;
  }

  try {
    logWritebackEvent(
      "writeback.adapter.resolved",
      resolveAdapterLogMetadata(
        provider,
        context.operation.path,
        context.operation.action,
      ),
    );
    const unsupportedReason = getUnsupportedWritebackReason(
      provider,
      context.operation.path,
      context.operation.action,
    );
    if (unsupportedReason) {
      logPermanentFailure(task, unsupportedReason, {
        provider,
        path: context.operation.path,
      });
      await acknowledgePermanentFailure(task, env, unsupportedReason);
      return;
    }

    const file =
      context.operation.action === "file_upsert"
        ? requireExactRevisionFile(context, task)
        : null;
    const providerCredential = isWritebackProvider(provider)
      ? await fetchIntegrationCredential(task, env, provider)
      : null;
    if (providerCredential?.writebackDispatchVia === "cf") {
      const input = toWritebackInput(
        context,
        task,
        providerCredential.provider,
        file,
      );
      const result = await dispatchProviderWriteback(
        input,
        providerCredential,
        env,
        { fetchImpl: options.fetchImpl },
      );
      await enqueueAuditEvent(env, input, result);
      if (result.outcome === "success") {
        await acknowledgeWritebackSuccess(task, env, result);
        return;
      }
      if (result.outcome === "permanent_failure") {
        logPermanentFailure(task, result.error, {
          provider,
          path: context.operation.path,
          metadata: result.metadata,
        });
        await acknowledgePermanentFailure(task, env, result.error);
        return;
      }
      throw new Error(result.error);
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const { bridgeUrl, internalHmacSecret } =
      resolveRelayfileWritebackBridgeConfig(env, {
        bridgeUrl: options.bridgeUrl,
      });
    // Backend-neutral workspace-integration alias for bridge dispatch.
    const requestBody = JSON.stringify({
      opId: context.operation.opId,
      workspaceId: context.workspaceId,
      path: context.operation.path,
      revision: context.operation.revision,
      correlationId:
        context.operation.correlationId || task.correlationId || "",
      provider,
      action: context.operation.action,
      content: file?.content ?? "",
      contentType: file?.contentType,
      encoding: file?.encoding ?? "utf-8",
    });
    const timestamp = (options.now?.() ?? new Date()).toISOString();
    const signature = await signInternalRequest(
      timestamp,
      requestBody,
      internalHmacSecret,
    );
    logWritebackEvent("writeback.provider.request", {
      url: bridgeUrl,
      method: "POST",
    });
    const response = await fetchImpl(bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Id": task.workspaceId,
        "X-Correlation-Id":
          context.operation.correlationId || task.correlationId || "",
        "X-Relay-Timestamp": timestamp,
        "X-Relay-Signature": signature,
      },
      body: requestBody,
    });
    logWritebackEvent("writeback.provider.response", {
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      const bodyText = sanitizeErrorMessage(await safeResponseText(response));
      console.error(
        JSON.stringify({
          event: "writeback.provider.error",
          opId: context.operation.opId,
          status: response.status,
          bodyText,
        }),
      );
      throw new Error(
        `provider writeback bridge returned ${response.status}: ${bodyText}`,
      );
    }
  } catch (error) {
    if (error instanceof PermanentWritebackFailure) {
      logPermanentFailure(error.task, error.message);
      await acknowledgePermanentFailure(task, env, error.message);
      return;
    }
    throw new Error(
      `provider writeback bridge request failed: ${sanitizeErrorMessage(error)}`,
    );
  }
}

export async function executeProviderWritebackBatch(
  tasks: WritebackQueueMessage[],
  env: Pick<
    AppEnv["Bindings"],
    | "WORKSPACE_DO"
    | "RELAYFILE_WRITEBACK_BRIDGE_URL"
    | "INTERNAL_HMAC_SECRET"
    | "NANGO_SECRET_KEY"
    | "NANGO_BASE_URL"
    | "AUDIT_QUEUE"
  >,
  options: ExecutorOptions = {},
): Promise<WritebackBatchExecutionResult[]> {
  const results: WritebackBatchExecutionResult[] = [];
  const bridgeInputs: BridgeBatchInput[] = [];

  for (const task of tasks) {
    try {
      const context = await fetchWritebackContext(task, env);
      const provider = resolveProvider(
        context.operation.path,
        context.operation.provider,
      );
      logWritebackEvent("writeback.start", {
        opId: context.operation.opId,
        workspaceId: context.workspaceId,
        provider,
        path: context.operation.path,
      });
      logWritebackEvent(
        "writeback.adapter.resolved",
        resolveAdapterLogMetadata(
          provider,
          context.operation.path,
          context.operation.action,
        ),
      );
      if (TERMINAL_OPERATION_STATUSES.has(context.operation.status)) {
        if (context.operation.status === "dead_lettered") {
          console.error(
            JSON.stringify({
              event: "writeback.dead_lettered",
              opId: context.operation.opId,
              ...readDeadLetterLogMetadata(context),
            }),
          );
        }
        results.push({ task, success: true });
        continue;
      }

      const unsupportedReason = getUnsupportedWritebackReason(
        provider,
        context.operation.path,
        context.operation.action,
      );
      if (unsupportedReason) {
        logPermanentFailure(task, unsupportedReason, {
          provider,
          path: context.operation.path,
        });
        await acknowledgePermanentFailure(task, env, unsupportedReason);
        results.push({ task, success: true });
        continue;
      }

      const file =
        context.operation.action === "file_upsert"
          ? requireExactRevisionFile(context, task)
          : null;
      const providerCredential = isWritebackProvider(provider)
        ? await fetchIntegrationCredential(task, env, provider)
        : null;
      if (providerCredential?.writebackDispatchVia === "cf") {
        const input = toWritebackInput(
          context,
          task,
          providerCredential.provider,
          file,
        );
        const result = await dispatchProviderWriteback(
          input,
          providerCredential,
          env,
          { fetchImpl: options.fetchImpl },
        );
        await enqueueAuditEvent(env, input, result);
        if (result.outcome === "success") {
          await acknowledgeWritebackSuccess(task, env, result);
          results.push({ task, success: true });
          continue;
        }
        if (result.outcome === "permanent_failure") {
          logPermanentFailure(task, result.error, {
            provider,
            path: context.operation.path,
            metadata: result.metadata,
          });
          await acknowledgePermanentFailure(task, env, result.error);
          results.push({ task, success: true });
          continue;
        }
        results.push({ task, success: false, error: result.error });
        continue;
      }

      const bridgeInput: BridgeBatchInput = {
        task,
        input: toBridgeInput(context, task, provider, file),
      };
      if (bridgePayloadBytes(bridgeInput.input) > MAX_BRIDGE_BATCH_BODY_BYTES) {
        results.push({
          task,
          success: false,
          error: `writeback bridge payload for opId ${task.opId} exceeds ${MAX_BRIDGE_BATCH_BODY_BYTES} bytes`,
        });
        continue;
      }
      bridgeInputs.push(bridgeInput);
    } catch (error) {
      if (error instanceof PermanentWritebackFailure) {
        logPermanentFailure(error.task, error.message);
        await acknowledgePermanentFailure(task, env, error.message);
        results.push({ task, success: true });
        continue;
      }
      results.push({
        task,
        success: false,
        error: sanitizeErrorMessage(error),
      });
    }
  }

  if (bridgeInputs.length === 0) {
    return results;
  }

  for (const batch of splitBridgeBatches(bridgeInputs)) {
    results.push(...(await dispatchBridgeBatch(batch, env, options)));
  }
  return results;
}

function splitBridgeBatches(inputs: BridgeBatchInput[]): BridgeBatchInput[][] {
  const batches: BridgeBatchInput[][] = [];
  let current: BridgeBatchInput[] = [];
  let currentBytes = JSON.stringify({ items: [] }).length;

  for (const input of inputs) {
    const singleBytes = bridgePayloadBytes(input.input);
    if (
      current.length > 0 &&
      currentBytes + singleBytes > MAX_BRIDGE_BATCH_BODY_BYTES
    ) {
      batches.push(current);
      current = [];
      currentBytes = JSON.stringify({ items: [] }).length;
    }
    current.push(input);
    currentBytes += singleBytes;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function bridgePayloadBytes(input: BridgeBatchInput["input"]): number {
  return new TextEncoder().encode(JSON.stringify({ items: [input] }))
    .byteLength;
}

async function dispatchBridgeBatch(
  bridgeInputs: BridgeBatchInput[],
  env: Pick<
    AppEnv["Bindings"],
    | "WORKSPACE_DO"
    | "RELAYFILE_WRITEBACK_BRIDGE_URL"
    | "INTERNAL_HMAC_SECRET"
    | "NANGO_SECRET_KEY"
    | "NANGO_BASE_URL"
    | "AUDIT_QUEUE"
  >,
  options: ExecutorOptions,
): Promise<WritebackBatchExecutionResult[]> {
  const results: WritebackBatchExecutionResult[] = [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const { bridgeUrl, internalHmacSecret } =
    resolveRelayfileWritebackBridgeConfig(env, {
      bridgeUrl: options.bridgeUrl,
    });
  const batchUrl = new URL(
    "batch",
    bridgeUrl.endsWith("/") ? bridgeUrl : `${bridgeUrl}/`,
  ).toString();
  const requestBody = JSON.stringify({
    items: bridgeInputs.map((item) => item.input),
  });
  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const signature = await signInternalRequest(
    timestamp,
    requestBody,
    internalHmacSecret,
  );
  logWritebackEvent("writeback.provider.request", {
    url: batchUrl,
    method: "POST",
    batchSize: bridgeInputs.length,
    opIds: bridgeInputs.map((item) => item.task.opId),
  });
  const response = await fetchImpl(batchUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Relay-Timestamp": timestamp,
      "X-Relay-Signature": signature,
    },
    body: requestBody,
  });
  logWritebackEvent("writeback.provider.response", {
    status: response.status,
    ok: response.ok,
    batchSize: bridgeInputs.length,
  });

  if (!response.ok) {
    const bodyText = sanitizeErrorMessage(await safeResponseText(response));
    console.error(
      JSON.stringify({
        event: "writeback.provider.error",
        status: response.status,
        bodyText,
        opIds: bridgeInputs.map((item) => item.task.opId),
      }),
    );
    for (const item of bridgeInputs) {
      results.push({
        task: item.task,
        success: false,
        error: `provider writeback batch bridge returned ${response.status}: ${bodyText}`,
      });
    }
    return results;
  }

  const body = (await response.json()) as {
    results?: Array<{
      opId?: string;
      outcome?: string;
      error?: { message?: string };
    }>;
  };
  const resultsByOpId = new Map<
    string,
    Array<{
      opId?: string;
      outcome?: string;
      error?: { message?: string };
    }>
  >();
  for (const result of body.results ?? []) {
    const opId = result.opId ?? "";
    const opResults = resultsByOpId.get(opId) ?? [];
    opResults.push(result);
    resultsByOpId.set(opId, opResults);
  }
  for (const item of bridgeInputs) {
    const result = resultsByOpId.get(item.task.opId)?.shift();
    if (!result) {
      results.push({
        task: item.task,
        success: false,
        error: `missing batch result for opId ${item.task.opId}`,
      });
      continue;
    }
    if (
      result.outcome !== "success" &&
      result.outcome !== "permanent_failure" &&
      result.outcome !== "retryable_failure"
    ) {
      results.push({
        task: item.task,
        success: false,
        error: `unexpected batch outcome for opId ${item.task.opId}`,
      });
      continue;
    }
    const retryable = result.outcome === "retryable_failure";
    if (retryable) {
      console.warn(
        JSON.stringify({
          event: "writeback.retryable_failure",
          opId: item.task.opId,
          provider: item.input.provider,
          error: sanitizeErrorMessage(
            result.error?.message ?? "retryable bridge failure",
          ),
        }),
      );
    } else if (result.outcome === "permanent_failure") {
      logPermanentFailure(
        item.task,
        result.error?.message ?? "permanent bridge failure",
        {
          provider: item.input.provider,
          path: item.input.path,
        },
      );
    } else {
      logWritebackEvent("writeback.complete", {
        opId: item.task.opId,
        provider: item.input.provider,
        path: item.input.path,
      });
    }
    results.push({
      task: item.task,
      success: !retryable,
      ...(retryable
        ? { error: result.error?.message ?? "retryable bridge failure" }
        : {}),
    });
  }
  return results;
}

async function fetchIntegrationCredential(
  task: WritebackQueueMessage,
  env: Pick<AppEnv["Bindings"], "WORKSPACE_DO">,
  provider: WritebackProvider,
): Promise<IntegrationCredential | null> {
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  let response: Response;
  try {
    response = await fetchWorkspaceDOWithBackpressure(
      stub,
      new Request(
        `https://workspace-do/v1/workspaces/${encodeURIComponent(task.workspaceId)}/integrations/${encodeURIComponent(provider)}`,
        {
          method: "GET",
          headers: {
            "X-Workspace-Id": task.workspaceId,
            "X-Correlation-Id": task.correlationId ?? "",
          },
        },
      ),
      { reason: "durable_object_overloaded" },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "writeback.integration_credential.unavailable",
        workspaceId: task.workspaceId,
        provider,
        error: sanitizeErrorMessage(error),
      }),
    );
    throw new Error(
      `integration credential lookup failed: ${sanitizeErrorMessage(error)}`,
    );
  }
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `integration credential returned ${response.status}: ${sanitizeErrorMessage(
        await safeResponseText(response),
      )}`,
    );
  }
  return (await response.json()) as IntegrationCredential;
}

function toWritebackInput(
  context: WritebackExecutionContextResponse,
  task: WritebackQueueMessage,
  provider: WritebackProvider,
  file: FileReadResponse | null,
): WritebackInput {
  return {
    opId: context.operation.opId,
    workspaceId: context.workspaceId,
    path: context.operation.path,
    revision: context.operation.revision,
    correlationId: context.operation.correlationId || task.correlationId || "",
    provider,
    action: context.operation.action,
    content: file?.content ?? "",
    contentType: file?.contentType,
    encoding: file?.encoding ?? "utf-8",
    // Parent-dependency: carry the parent op's delivered id from the queue item
    // to the provider, which uses it to reference the parent (e.g. thread_ts).
    ...(task.parentExternalId ? { parentExternalId: task.parentExternalId } : {}),
  };
}

function toBridgeInput(
  context: WritebackExecutionContextResponse,
  task: WritebackQueueMessage,
  provider: string,
  file: FileReadResponse | null,
): {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId: string;
  provider: string;
  action: string;
  content: string;
  contentType?: string;
  encoding: string;
} {
  return {
    opId: context.operation.opId,
    workspaceId: context.workspaceId,
    path: context.operation.path,
    revision: context.operation.revision,
    correlationId: context.operation.correlationId || task.correlationId || "",
    provider,
    action: context.operation.action,
    content: file?.content ?? "",
    contentType: file?.contentType,
    encoding: file?.encoding ?? "utf-8",
  };
}

async function acknowledgeWritebackSuccess(
  task: WritebackQueueMessage,
  env: Pick<AppEnv["Bindings"], "WORKSPACE_DO">,
  result: Extract<DispatchResult, { outcome: "success" }>,
): Promise<void> {
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request(
      `https://workspace-do/v1/workspaces/${encodeURIComponent(task.workspaceId)}/writeback/${encodeURIComponent(task.opId)}/ack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Id": task.workspaceId,
          "X-Correlation-Id": task.correlationId ?? "",
        },
        body: JSON.stringify({
          success: true,
          providerResult: {
            ...(result.providerObjectId
              ? { providerObjectId: result.providerObjectId }
              : {}),
            ...(result.metadata ? result.metadata : {}),
          },
        }),
      },
    ),
    { reason: "durable_object_overloaded" },
  );
  if (!response.ok) {
    throw new Error(
      `writeback ack returned ${response.status}: ${sanitizeErrorMessage(
        await safeResponseText(response),
      )}`,
    );
  }
}

async function enqueueAuditEvent(
  env: Pick<AppEnv["Bindings"], "AUDIT_QUEUE">,
  input: WritebackInput,
  result: DispatchResult,
): Promise<void> {
  if (!env.AUDIT_QUEUE) {
    console.warn(
      JSON.stringify({
        event: "writeback.audit.skipped",
        reason: "audit_queue_not_configured",
        opId: input.opId,
        provider: input.provider,
      }),
    );
    return;
  }
  try {
    await env.AUDIT_QUEUE.send({
      type: "relayfile.writeback",
      opId: input.opId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      path: input.path,
      revision: input.revision,
      correlationId: input.correlationId,
      outcome: result.outcome,
      metadata: "metadata" in result ? result.metadata : undefined,
      error: "error" in result ? result.error : undefined,
      emittedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "writeback.audit.enqueue_failed",
        opId: input.opId,
        provider: input.provider,
        error: sanitizeErrorMessage(error),
      }),
    );
  }
}

function isWritebackProvider(provider: string): provider is WritebackProvider {
  return (
    provider === "confluence" ||
    provider === "github" ||
    provider === "google-mail" ||
    provider === "jira" ||
    provider === "linear" ||
    provider === "notion" ||
    provider === "slack"
  );
}

async function fetchWritebackContext(
  task: WritebackQueueMessage,
  env: Pick<AppEnv["Bindings"], "WORKSPACE_DO">,
): Promise<WritebackExecutionContextResponse> {
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request("https://workspace-do/internal/writeback-context", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Id": task.workspaceId,
        "X-Correlation-Id": task.correlationId ?? "",
      },
      body: JSON.stringify(task),
    }),
    { reason: "durable_object_overloaded" },
  );

  if (!response.ok) {
    throw new Error(
      `writeback context returned ${response.status}: ${sanitizeErrorMessage(
        await safeResponseText(response),
      )}`,
    );
  }

  const context = (await response.json()) as WritebackExecutionContextResponse;

  // If the DO elided the body because it was larger than the inline
  // threshold, hydrate it out-of-band via the streaming content endpoint.
  // The DO never holds the body as a single JS string in this path — it
  // streams the R2 object body straight through — so the OOM vector of
  // returning multi-megabyte file content in a JSON envelope is gone.
  //
  // Detection: `contentInline === false` is the explicit signal; we also
  // hydrate when `file.content` is `null` defensively, because the May 2026
  // hardening changed the elided shape from `content: ""` to `content: null`
  // specifically so older daemons fail loudly when they miss the
  // `contentInline` flag.
  if (
    context.file &&
    (context.contentInline === false || context.file.content === null)
  ) {
    context.file = await hydrateWritebackContent(task, env, context);
  }

  return context;
}

async function hydrateWritebackContent(
  task: WritebackQueueMessage,
  env: Pick<AppEnv["Bindings"], "WORKSPACE_DO">,
  context: WritebackExecutionContextResponse,
): Promise<WritebackExecutionContextResponse["file"]> {
  if (!context.file) {
    return context.file;
  }
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request("https://workspace-do/internal/writeback-content", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Id": task.workspaceId,
        "X-Correlation-Id": task.correlationId ?? "",
      },
      body: JSON.stringify(task),
    }),
    { reason: "durable_object_overloaded" },
  );

  if (!response.ok) {
    throw new Error(
      `writeback content returned ${response.status}: ${sanitizeErrorMessage(
        await safeResponseText(response),
      )}`,
    );
  }

  const encoding =
    (response.headers.get("X-Relayfile-Encoding") as
      | "utf-8"
      | "base64"
      | null) ??
    context.file.encoding ??
    "utf-8";

  // The DO is streaming the raw R2 body. For utf-8 we read it as text; for
  // base64 we read the bytes and base64-encode them once here in the
  // executor (a single isolate, not the per-workspace DO).
  const bytes = await readWritebackContentBytes(response, task);
  let content: string;
  if (encoding === "base64") {
    content = bytesToBase64(bytes);
  } else {
    content = new TextDecoder().decode(bytes);
  }

  return {
    ...context.file,
    content,
    encoding,
  };
}

async function readWritebackContentBytes(
  response: Response,
  task: WritebackQueueMessage,
): Promise<Uint8Array> {
  const declaredLength = readContentLength(response.headers);
  if (declaredLength !== null && declaredLength > MAX_WRITEBACK_CONTENT_BYTES) {
    throwPermanentFailure(
      task,
      `writeback content for ${task.path} exceeds ${MAX_WRITEBACK_CONTENT_BYTES} bytes`,
    );
  }

  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (byteLength + value.byteLength > MAX_WRITEBACK_CONTENT_BYTES) {
        await reader.cancel().catch(() => {});
        throwPermanentFailure(
          task,
          `writeback content for ${task.path} exceeds ${MAX_WRITEBACK_CONTENT_BYTES} bytes`,
        );
      }

      chunks.push(value);
      byteLength += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readContentLength(headers: Headers): number | null {
  const value = headers.get("content-length");
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Process in chunks to avoid call-stack blowups on very large buffers.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

async function acknowledgePermanentFailure(
  task: WritebackQueueMessage,
  env: Pick<AppEnv["Bindings"], "WORKSPACE_DO">,
  error: string,
): Promise<void> {
  const stub = env.WORKSPACE_DO.get(
    env.WORKSPACE_DO.idFromName(task.workspaceId),
  );
  const response = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request(
      `https://workspace-do/v1/workspaces/${encodeURIComponent(task.workspaceId)}/writeback/${encodeURIComponent(task.opId)}/ack`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workspace-Id": task.workspaceId,
          "X-Correlation-Id": task.correlationId ?? "",
        },
        body: JSON.stringify({
          success: false,
          error: sanitizeErrorMessage(error),
        }),
      },
    ),
    { reason: "durable_object_overloaded" },
  );

  if (!response.ok) {
    throw new Error(
      `writeback ack returned ${response.status}: ${sanitizeErrorMessage(
        await safeResponseText(response),
      )}`,
    );
  }
}

function requireExactRevisionFile(
  context: WritebackExecutionContextResponse,
  task: WritebackQueueMessage,
): FileReadResponse {
  if (!context.file) {
    throwPermanentFailure(
      task,
      `writeback revision ${context.operation.revision} is unavailable for ${context.operation.path}`,
    );
  }
  if (context.file.revision !== context.operation.revision) {
    throwPermanentFailure(
      task,
      `writeback revision ${context.operation.revision} does not match current file revision ${context.file.revision} for ${context.operation.path}`,
    );
  }
  return context.file;
}

function throwPermanentFailure(
  task: WritebackQueueMessage,
  error: string,
): never {
  throw new PermanentWritebackFailure(task, error);
}

class PermanentWritebackFailure extends Error {
  readonly task: WritebackQueueMessage;

  constructor(task: WritebackQueueMessage, message: string) {
    super(message);
    this.name = "PermanentWritebackFailure";
    this.task = task;
  }
}

function resolveProvider(path: string, operationProvider: string): string {
  const firstSegment = normalizePath(path).split("/")[1]?.trim().toLowerCase();
  if (firstSegment) {
    return firstSegment;
  }
  return operationProvider.trim().toLowerCase();
}

function resolveAdapterLogMetadata(
  provider: string,
  path: string,
  action: string,
): { action: string; endpoint: string | null; method: string | null } {
  if (action !== "file_upsert") {
    return { action, endpoint: null, method: null };
  }

  switch (provider) {
    case "notion":
      return resolveNotionAdapterLogMetadata(path);
    case "github":
      return resolveGitHubAdapterLogMetadata(path);
    default:
      return { action, endpoint: null, method: null };
  }
}

function resolveNotionAdapterLogMetadata(path: string): {
  action: string;
  endpoint: string | null;
  method: string | null;
} {
  const databasePageMatch = path.match(
    /^\/notion\/databases\/[^/]+\/pages\/([^/]+)\.json$/,
  );
  const standalonePageMatch = path.match(/^\/notion\/pages\/([^/]+)\.json$/);
  const pageId = databasePageMatch?.[1] ?? standalonePageMatch?.[1];
  if (pageId) {
    return {
      action: "update_page_properties",
      endpoint: `/v1/pages/${encodeURIComponent(pageId)}`,
      method: "PATCH",
    };
  }

  const databaseContentMatch = path.match(
    /^\/notion\/databases\/[^/]+\/pages\/([^/]+)\/content\.md$/,
  );
  const standaloneContentMatch = path.match(
    /^\/notion\/pages\/([^/]+)\/content\.md$/,
  );
  const markdownPageId =
    databaseContentMatch?.[1] ?? standaloneContentMatch?.[1];
  if (markdownPageId) {
    return {
      action: "update_page_markdown",
      endpoint: `/v1/pages/${encodeURIComponent(markdownPageId)}/markdown`,
      method: "PATCH",
    };
  }

  const databaseCommentsMatch = path.match(
    /^\/notion\/databases\/[^/]+\/pages\/([^/]+)\/comments\.json$/,
  );
  const standaloneCommentsMatch = path.match(
    /^\/notion\/pages\/([^/]+)\/comments\.json$/,
  );
  if (databaseCommentsMatch?.[1] ?? standaloneCommentsMatch?.[1]) {
    return {
      action: "create_comment",
      endpoint: "/v1/comments",
      method: "POST",
    };
  }

  if (/^\/notion\/databases\/[^/]+\/pages\/?$/.test(path)) {
    return {
      action: "create_page",
      endpoint: "/v1/pages",
      method: "POST",
    };
  }

  return { action: "file_upsert", endpoint: null, method: null };
}

function resolveGitHubAdapterLogMetadata(path: string): {
  action: string;
  endpoint: string | null;
  method: string | null;
} {
  const reviewMatch = path.match(
    /^\/github\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)\/reviews\/[^/]+(?:\.json)?$/,
  );
  if (!reviewMatch) {
    return { action: "file_upsert", endpoint: null, method: null };
  }

  return {
    action: "create_review_comment",
    endpoint: `/repos/${encodeURIComponent(
      reviewMatch[1] ?? "",
    )}/${encodeURIComponent(reviewMatch[2] ?? "")}/pulls/${
      reviewMatch[3] ?? ""
    }/comments`,
    method: "POST",
  };
}

function logWritebackEvent(
  event: string,
  details: Record<string, unknown>,
): void {
  console.log(JSON.stringify({ event, ...details }));
}

function logPermanentFailure(
  task: WritebackQueueMessage,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event: "writeback.permanent_failure",
      opId: task.opId,
      workspaceId: task.workspaceId,
      error: sanitizeErrorMessage(error),
      ...details,
    }),
  );
}

function readDeadLetterLogMetadata(
  context: WritebackExecutionContextResponse,
): { attempts: number | null; lastError: string | null } {
  const operation =
    context.operation as WritebackExecutionContextResponse["operation"] & {
      attemptCount?: unknown;
      attempts?: unknown;
      lastError?: unknown;
    };
  const attemptCount =
    typeof operation.attemptCount === "number"
      ? operation.attemptCount
      : typeof operation.attempts === "number"
        ? operation.attempts
        : null;
  return {
    attempts: attemptCount,
    lastError:
      typeof operation.lastError === "string"
        ? sanitizeErrorMessage(operation.lastError)
        : null,
  };
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function sanitizeErrorMessage(error: unknown): string {
  const base =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);

  return base
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/nango[-_a-z0-9]*secret[^\s,;]*/gi, "[REDACTED]")
    .replace(/token[=:]\s*[^\s,;]+/gi, "token=[REDACTED]");
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await readBoundedText(response, MAX_DIAGNOSTIC_RESPONSE_BODY_BYTES))
      .text;
  } catch {
    return "unavailable response body";
  }
}

async function signInternalRequest(
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}\n${body}`),
  );
  return bytesToHex(new Uint8Array(signed));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

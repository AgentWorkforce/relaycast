import type { TelemetryMeta } from "./telemetry-meta.js";

export type CloudEvidenceSummary = {
  schemaVersion: "cloud-runtime-evidence/1";
  service: string;
  environment: string;
  version: string;
  deployId?: string;
  path: "webhook.queue.dlq" | "webhook.queue" | "webhook.fetch" | string;
  kind: "dlq_dead_letter" | "queue_processing_error" | "request_error" | "health";
  outcome: "ok" | "error" | "retry" | "dlq";
  severity: number;
  occurredAt: string;
  requestId?: string;
  correlationIds?: {
    dedupeId?: string;
    messageId?: string;
    provider?: string;
    ingress?: string;
  };
  summary: string;
  counts?: {
    errors?: number;
    messages?: number;
    attempts?: number;
  };
  errorCode?: string;
  errorMessage?: string;
  inspect?: {
    logQuery?: string;
    dlqQueue?: string;
    dashboardUrl?: string;
    traceHint?: string;
  };
};

type EvidenceEnv = {
  NIGHTCTO_EVIDENCE_URL?: string;
  NIGHTCTO_EVIDENCE_TOKEN?: string;
};

type WaitUntilContext = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

type EvidencePartial = Omit<
  CloudEvidenceSummary,
  "schemaVersion" | "service" | "environment" | "version" | "deployId" | "occurredAt"
> & {
  occurredAt?: string;
};

const TEXT_LIMIT = 300;
const BODY_LIMIT_BYTES = 16 * 1024;

function trimToLimit(value: string | undefined, limit = TEXT_LIMIT): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > limit ? singleLine.slice(0, limit) : singleLine;
}

function serializeCapped(summary: CloudEvidenceSummary): string | null {
  const capped: CloudEvidenceSummary = {
    ...summary,
    summary: trimToLimit(summary.summary) ?? "",
    ...(summary.errorMessage
      ? { errorMessage: trimToLimit(summary.errorMessage) }
      : {}),
  };

  let body = JSON.stringify(capped);
  if (new TextEncoder().encode(body).byteLength <= BODY_LIMIT_BYTES) {
    return body;
  }

  const reduced: CloudEvidenceSummary = {
    ...capped,
    summary: trimToLimit(capped.summary, 160) ?? "",
    ...(capped.errorMessage
      ? { errorMessage: trimToLimit(capped.errorMessage, 160) }
      : {}),
    ...(capped.inspect
      ? {
          inspect: {
            ...(capped.inspect.logQuery
              ? { logQuery: trimToLimit(capped.inspect.logQuery, 300) }
              : {}),
            ...(capped.inspect.dlqQueue
              ? { dlqQueue: trimToLimit(capped.inspect.dlqQueue, 160) }
              : {}),
            ...(capped.inspect.traceHint
              ? { traceHint: trimToLimit(capped.inspect.traceHint, 160) }
              : {}),
          },
        }
      : {}),
  };

  body = JSON.stringify(reduced);
  if (new TextEncoder().encode(body).byteLength <= BODY_LIMIT_BYTES) {
    return body;
  }

  return null;
}

function warnEvidenceEmit(message: string, extra: Record<string, unknown> = {}): void {
  console.warn("[cloud-evidence-emit] " + message, {
    area: "cloud-evidence-emit",
    ...extra,
  });
}

export function buildEvidenceFromHop(
  meta: TelemetryMeta,
  partial: EvidencePartial,
): CloudEvidenceSummary {
  const { occurredAt, ...rest } = partial;
  return {
    schemaVersion: "cloud-runtime-evidence/1",
    service: meta.service,
    environment: meta.environment,
    version: meta.version,
    ...(meta.deployId ? { deployId: meta.deployId } : {}),
    occurredAt: occurredAt ?? new Date().toISOString(),
    ...rest,
  };
}

export function emitCloudEvidence(
  env: EvidenceEnv,
  ctx: WaitUntilContext | null | undefined,
  summary: CloudEvidenceSummary,
): void {
  const url = env.NIGHTCTO_EVIDENCE_URL?.trim();
  if (!url) {
    return;
  }

  const body = serializeCapped(summary);
  if (!body) {
    warnEvidenceEmit("payload too large after truncation", {
      service: summary.service,
      path: summary.path,
      kind: summary.kind,
    });
    return;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = env.NIGHTCTO_EVIDENCE_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers["x-nightcto-evidence-token"] = token;
  }

  let send: Promise<void>;
  try {
    send = globalThis.fetch(url, {
      method: "POST",
      headers,
      body,
    }).then((response) => {
      if (!response.ok) {
        warnEvidenceEmit("post failed", {
          status: response.status,
          service: summary.service,
          path: summary.path,
          kind: summary.kind,
        });
      }
    }).catch((error) => {
      warnEvidenceEmit("post threw", {
        errorMessage: error instanceof Error ? error.message : String(error),
        service: summary.service,
        path: summary.path,
        kind: summary.kind,
      });
    });
  } catch (error) {
    warnEvidenceEmit("post setup threw", {
      errorMessage: error instanceof Error ? error.message : String(error),
      service: summary.service,
      path: summary.path,
      kind: summary.kind,
    });
    return;
  }

  if (typeof ctx?.waitUntil === "function") {
    try {
      ctx.waitUntil(send);
    } catch (error) {
      warnEvidenceEmit("waitUntil threw", {
        errorMessage: error instanceof Error ? error.message : String(error),
        service: summary.service,
        path: summary.path,
        kind: summary.kind,
      });
      void send;
    }
    return;
  }

  void send;
}

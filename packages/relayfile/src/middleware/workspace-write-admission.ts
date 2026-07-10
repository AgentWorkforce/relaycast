import type { AppContext } from "../env.js";
import {
  type WriteAdmissionClass,
  resolveWriteAdmissionClass,
} from "../durable-objects/write-admission.js";
import { isProviderSyncAgentName } from "./auth.js";

const DEFAULT_WRITE_ADMISSION_MAX_INFLIGHT = 4;
const DEFAULT_WRITE_ADMISSION_FOREGROUND_RESERVED = 1;
const DEFAULT_WRITE_ADMISSION_LEASE_TTL_MS = 120_000;
const DEFAULT_WRITE_ADMISSION_RETRY_AFTER_SECONDS = 5;
const CONTENT_WRITE_ADMISSION_ACQUIRE_ATTEMPTS = 2;
const MAX_WRITE_ADMISSION_RETRY_AFTER_MS = 30_000;

type WorkspaceWriteAdmissionOptions = {
  writeClass?: WriteAdmissionClass;
};

export async function withWorkspaceWriteAdmission<T extends Response>(
  c: AppContext,
  workspaceId: string,
  purpose: string,
  handler: () => Promise<T>,
  options: WorkspaceWriteAdmissionOptions = {},
): Promise<T | Response> {
  const limiterName = `${workspaceId}:write-admission`;
  const limiter = c.env.WORKSPACE_DO.get(
    c.env.WORKSPACE_DO.idFromName(limiterName),
  );
  const maxInflight = positiveInt(
    c.env.RELAYFILE_WRITE_ADMISSION_MAX_INFLIGHT,
    DEFAULT_WRITE_ADMISSION_MAX_INFLIGHT,
  );
  const foregroundReserved = clampInt(
    nonNegativeInt(
      c.env.RELAYFILE_WRITE_ADMISSION_FOREGROUND_RESERVED,
      DEFAULT_WRITE_ADMISSION_FOREGROUND_RESERVED,
    ),
    0,
    maxInflight,
  );
  const backgroundMax = clampInt(
    nonNegativeInt(
      c.env.RELAYFILE_WRITE_ADMISSION_BACKGROUND_MAX,
      maxInflight - foregroundReserved,
    ),
    0,
    maxInflight,
  );
  const writeClass = options.writeClass ?? classifyWriteAdmission(c, purpose);
  const correlationId =
    c.get("correlationId") ??
    c.req.header("X-Correlation-Id")?.trim() ??
    crypto.randomUUID();
  const acquireBody = {
    workspaceId,
    purpose,
    writeClass,
    maxInflight,
    foregroundReserved,
    backgroundMax,
    leaseTtlMs: positiveInt(
      c.env.RELAYFILE_WRITE_ADMISSION_LEASE_TTL_MS,
      DEFAULT_WRITE_ADMISSION_LEASE_TTL_MS,
    ),
    retryAfterSeconds: positiveInt(
      c.env.RELAYFILE_ROUTER_RETRY_AFTER_SECONDS ??
        c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS,
      DEFAULT_WRITE_ADMISSION_RETRY_AFTER_SECONDS,
    ),
  };
  let acquire = await acquireWriteAdmission(
    limiter,
    correlationId,
    acquireBody,
  );
  for (
    let attempt = 1;
    !acquire.ok &&
    writeClass === "foreground_content" &&
    attempt < CONTENT_WRITE_ADMISSION_ACQUIRE_ATTEMPTS &&
    (await isWriteAdmissionLimitResponse(acquire.clone()));
    attempt += 1
  ) {
    const retryAfterMs = parseRetryAfterMs(acquire.headers.get("Retry-After"));
    console.warn("write_admission.retry", {
      workspaceId,
      purpose,
      writeClass,
      attempt,
      retryAfterMs,
      correlationId,
    });
    await sleep(retryAfterMs);
    acquire = await acquireWriteAdmission(limiter, correlationId, acquireBody);
  }
  if (!acquire.ok) {
    return acquire;
  }

  const body = (await acquire.json().catch(() => ({}))) as {
    leaseId?: string;
  };
  const leaseId = body.leaseId;
  try {
    return await handler();
  } finally {
    if (leaseId) {
      c.executionCtx.waitUntil(
        limiter.fetch(
          new Request(
            "https://relayfile.internal/internal/write-admission/release",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Correlation-Id": correlationId,
              },
              body: JSON.stringify({ workspaceId, purpose, leaseId }),
            },
          ),
        ),
      );
    }
  }
}

async function acquireWriteAdmission(
  limiter: DurableObjectStub,
  correlationId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return limiter.fetch(
    new Request("https://relayfile.internal/internal/write-admission/acquire", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": correlationId,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function isWriteAdmissionLimitResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 429) {
    return false;
  }
  const body = (await response.json().catch(() => ({}))) as {
    reason?: unknown;
  };
  return body.reason === "write_admission_limit";
}

export function classifyWriteAdmission(
  c: AppContext,
  purpose: string,
): WriteAdmissionClass {
  const explicit = c.req.header("X-Relayfile-Write-Class")?.trim();
  if (explicit) {
    return resolveWriteAdmissionClass(explicit);
  }

  if (
    purpose === "webhook_envelope" ||
    purpose === "webhook_ingest" ||
    purpose === "github_tarball_import"
  ) {
    return purpose === "github_tarball_import"
      ? "foreground_control"
      : "background_integration";
  }

  const claims = c.get("authClaims");
  if (isProviderSyncAgentName(claims?.agentName)) {
    return "background_integration";
  }

  if (
    purpose === "fs_file_put" ||
    purpose === "fs_file_delete" ||
    purpose === "fs_bulk"
  ) {
    const path = c.req.query("path")?.trim() ?? "";
    if (isForegroundControlPath(path)) {
      return "foreground_control";
    }
    if (isMaintenancePath(path)) {
      return "maintenance";
    }
    return "foreground_content";
  }

  return "background_integration";
}

function isForegroundControlPath(path: string): boolean {
  return (
    path.includes("/dispatch-claims/") ||
    path.endsWith("/.relayfile/clone.json")
  );
}

function isMaintenancePath(path: string): boolean {
  return path.startsWith("/_agents/deployments/");
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) {
    return 0;
  }
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_WRITE_ADMISSION_RETRY_AFTER_MS);
  }
  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    return Math.min(
      Math.max(0, retryAt - Date.now()),
      MAX_WRITE_ADMISSION_RETRY_AFTER_MS,
    );
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type InflightAdmissionRejection = {
  admit: false;
  status: 429;
  code: "workspace_busy";
  reason: "inflight_limit" | "oldest_inflight_age";
  message: string;
  retryAfterSeconds: number;
  inflight: number;
  maxInflight: number;
  oldestInflightAgeMs: number;
  maxOldestInflightAgeMs: number;
};

export type InflightAdmissionResult =
  | { admit: true; release(): void }
  | InflightAdmissionRejection;

export type InflightAdmissionOptions = {
  maxInflightRequests: number;
  maxOldestInflightAgeMs: number;
  retryAfterSeconds: number;
  /**
   * Slots reserved for FOREGROUND ops (cloud#1261). Background admission is
   * capped at maxInflightRequests - reservedForeground, leaving this many slots
   * for foreground (clone-materialize) ops so they're never starved by the
   * background burst they're trying to survive. Optional; defaults to 0 (no
   * reserve) when omitted.
   */
  reservedForeground?: number;
};

export type InflightAdmissionHttpContract = {
  status: 429;
  headers: { "Retry-After": string };
  body: {
    code: "workspace_busy";
    message: string;
    correlationId: string;
    retryAfterSeconds: number;
    reason: InflightAdmissionRejection["reason"];
    inflight: number;
    maxInflight: number;
    oldestInflightAgeMs: number;
    maxOldestInflightAgeMs: number;
  };
};

// Lowered from 32 (cloud#1261): on a fat co-tenant WorkspaceDO, ~32 concurrent
// storage ops (ingestion writes + reads + writeback + manifest pages) saturate
// the serialized DO storage and trip "storage operation exceeded timeout →
// object reset". 12 bounds concurrent storage ops under that timeout threshold.
const DEFAULT_MAX_INFLIGHT_REQUESTS = 12;
const DEFAULT_MAX_INFLIGHT_AGE_MS = 30_000;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
// Reserved for foreground (clone-materialize) ops; background is capped at
// maxInflight - this so the clone's own export-manifest reads always get in.
const DEFAULT_RESERVED_FOREGROUND = 3;

export class InflightAdmissionController {
  private readonly starts = new Map<number, number>();
  private nextId = 1;

  constructor(private readonly options: InflightAdmissionOptions) {}

  tryAcquire(nowMs = Date.now(), foreground = false): InflightAdmissionResult {
    const oldestInflightAgeMs = this.oldestInflightAgeMs(nowMs);
    // Foreground (clone materialize) may use ALL slots; background is capped at
    // maxInflight - reservedForeground so it can't starve the clone's own
    // export-manifest reads (cloud#1261).
    const limit = foreground
      ? this.options.maxInflightRequests
      : Math.max(
          0,
          this.options.maxInflightRequests -
            (this.options.reservedForeground ?? 0),
        );
    if (this.starts.size >= limit) {
      return this.reject("inflight_limit", oldestInflightAgeMs);
    }
    // The stuck-op safety valve sheds background, but never rejects a foreground
    // op for a stuck BACKGROUND op — foreground keeps its reserved lane.
    if (
      !foreground &&
      oldestInflightAgeMs > this.options.maxOldestInflightAgeMs
    ) {
      return this.reject("oldest_inflight_age", oldestInflightAgeMs);
    }

    const id = this.nextId;
    this.nextId += 1;
    this.starts.set(id, nowMs);
    let released = false;
    return {
      admit: true,
      release: () => {
        if (released) return;
        released = true;
        this.starts.delete(id);
      },
    };
  }

  private reject(
    reason: InflightAdmissionRejection["reason"],
    oldestInflightAgeMs: number,
  ): InflightAdmissionRejection {
    return {
      admit: false,
      status: 429,
      code: "workspace_busy",
      reason,
      message:
        "workspace durable object is busy; retry after the advertised delay",
      retryAfterSeconds: this.options.retryAfterSeconds,
      inflight: this.starts.size,
      maxInflight: this.options.maxInflightRequests,
      oldestInflightAgeMs,
      maxOldestInflightAgeMs: this.options.maxOldestInflightAgeMs,
    };
  }

  private oldestInflightAgeMs(nowMs: number): number {
    let oldest: number | null = null;
    for (const startedAt of this.starts.values()) {
      oldest = oldest === null ? startedAt : Math.min(oldest, startedAt);
    }
    return oldest === null ? 0 : Math.max(0, nowMs - oldest);
  }
}

export function resolveInflightAdmissionOptions(
  bindings: Partial<
    Record<
      | "RELAYFILE_DO_MAX_INFLIGHT_REQUESTS"
      | "RELAYFILE_DO_MAX_INFLIGHT_AGE_MS"
      | "RELAYFILE_DO_RETRY_AFTER_SECONDS"
      | "RELAYFILE_DO_RESERVED_FOREGROUND",
      string
    >
  >,
): InflightAdmissionOptions {
  const maxInflightRequests = positiveInt(
    bindings.RELAYFILE_DO_MAX_INFLIGHT_REQUESTS,
    DEFAULT_MAX_INFLIGHT_REQUESTS,
  );
  // Clamp the reserve below the total so background always has ≥1 slot.
  const reservedForeground = Math.min(
    Math.max(0, maxInflightRequests - 1),
    positiveInt(
      bindings.RELAYFILE_DO_RESERVED_FOREGROUND,
      DEFAULT_RESERVED_FOREGROUND,
    ),
  );
  return {
    maxInflightRequests,
    maxOldestInflightAgeMs: positiveInt(
      bindings.RELAYFILE_DO_MAX_INFLIGHT_AGE_MS,
      DEFAULT_MAX_INFLIGHT_AGE_MS,
    ),
    retryAfterSeconds: positiveInt(
      bindings.RELAYFILE_DO_RETRY_AFTER_SECONDS,
      DEFAULT_RETRY_AFTER_SECONDS,
    ),
    reservedForeground,
  };
}

export function inflightAdmissionHttpContract(
  rejection: InflightAdmissionRejection,
  correlationId: string,
): InflightAdmissionHttpContract {
  return {
    status: rejection.status,
    headers: {
      "Retry-After": String(rejection.retryAfterSeconds),
    },
    body: {
      code: rejection.code,
      message: rejection.message,
      correlationId,
      retryAfterSeconds: rejection.retryAfterSeconds,
      reason: rejection.reason,
      inflight: rejection.inflight,
      maxInflight: rejection.maxInflight,
      oldestInflightAgeMs: rejection.oldestInflightAgeMs,
      maxOldestInflightAgeMs: rejection.maxOldestInflightAgeMs,
    },
  };
}

/**
 * Whether a request is a write-admission CONTROL-PLANE op that MUST bypass the
 * inflight admission gate (cloud#1261): a release FREES capacity — gating it
 * leaks the lease until its TTL and amplifies the very backpressure the limiter
 * exists to prevent — and acquire is the limiter's own control plane, which the
 * data-plane gate must not throttle. Scoped to POST so a GET on those paths is
 * still gated normally.
 */
export function isAdmissionControlPlaneRequest(
  method: string,
  pathname: string,
): boolean {
  return (
    method === "POST" &&
    (pathname === "/internal/write-admission/release" ||
      pathname === "/internal/write-admission/acquire")
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

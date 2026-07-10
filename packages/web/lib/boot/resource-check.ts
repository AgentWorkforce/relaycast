import { Resource } from "sst";

/**
 * Critical SST resources the cloud webapp lambda needs at runtime.
 *
 * The class of bug this guards: `link: [..., nangoSecretKey, ...]` in
 * `infra/web.ts` is supposed to materialize as a `SST_RESOURCE_*` env
 * var on the deployed lambda. When the link silently fails to attach
 * (deploy stage drift, OpenNext adapter quirk, infra/runtime version
 * mismatch), `Resource.X.value` throws at the first call site and the
 * surrounding code path catches the throw — usually treating it as a
 * runtime user-state error, not a deploy-config error. The bug stays
 * invisible until someone hits that code path and notices the
 * downstream feature is silently broken.
 *
 * A missing `NangoSecretKey` binding hid every multi-repo push-back
 * failure for >24h in production. This module makes the same class
 * of failure visible at lambda init: read each required resource,
 * log a structured `[boot]` warning per missing binding, return a
 * summary so callers (tests, future health endpoints) can assert.
 *
 * The list covers every `Resource.X` reference in `packages/web/lib`
 * and `packages/web/app` that's load-bearing for at least one route.
 * `kind` matters: `secret` resources are unhealthy when the value is
 * empty (this is the NangoSecretKey case — bound but unset). Bucket
 * and queue resources are unhealthy only when the binding itself is
 * missing — they don't have a `.value`, so we just verify the proxy
 * doesn't throw.
 *
 * Adding a resource? Add it here. Forgetting to update this list is
 * recoverable — the build still works, the boot check just doesn't
 * cover that resource until someone notices.
 *
 * The runtime split (Lambda vs CF Worker) matters. Phase 3 introduced
 * `infra/web-worker.ts` which deploys the same `packages/web` code to
 * a Cloudflare Worker with a different binding surface (ROUTER_CONFIG,
 * RATE_LIMIT_COUNTERS, WORKER_SELF_REFERENCE — none of which exist on
 * the Lambda). Running the Lambda list against the Worker would
 * false-flag those as missing; running the Worker list against the
 * Lambda would false-flag the Worker-only bindings.
 * `runBootResourceCheck()` detects which runtime it's in and picks the
 * right list — see `detectRuntime()` below.
 */
const SHARED_SST_SECRETS = [
  // Secrets — unhealthy when bound but empty (the NangoSecretKey case).
  // Listed once because the Worker `link:` array in
  // `infra/web-worker.ts` and the Lambda `link:` array in
  // `infra/web.ts` both bind the same SST secrets to the deployed
  // function. If one of these stops being linked on either runtime,
  // the corresponding boot check still checks for it and the missing
  // binding shows up as a `[boot] resource binding check FAILED` log
  // line in the runtime that lost it.
  { name: "AuthSessionSecret", kind: "secret" as const },
  // Worker-to-AWS bridge HMAC secret (PR #668, queue bridge follow-up) —
  // Worker signs broker/bridge requests, Lambda bridge functions verify
  // them. Linked to both runtimes via `infra/web-worker.ts` and
  // `infra/web.ts`.
  { name: "BrokerHmacSecret", kind: "secret" as const },
  { name: "BrokerKeySecret", kind: "secret" as const },
  { name: "CloudAgentSpawnQuotaDefault", kind: "secret" as const },
  { name: "CloudTeamLaunchN1Enabled", kind: "secret" as const },
  { name: "GithubInstallationCentric", kind: "secret" as const },
  { name: "SlackConversationRoutingEnabled", kind: "secret" as const },
  { name: "CredentialEncryptionKey", kind: "secret" as const },
  { name: "DaytonaApiKey", kind: "secret" as const },
  { name: "GoogleClientId", kind: "secret" as const },
  { name: "GoogleClientSecret", kind: "secret" as const },
  { name: "ComposioApiKey", kind: "secret" as const },
  { name: "DigestFunctionSigningKey", kind: "secret" as const },
  { name: "DropboxAppSecret", kind: "secret" as const },
  // Optional/dormant Linear webhook signature secret. Always seeded non-empty
  // (the "unset" placeholder until a real value is set), so the binding
  // presence is boot-checked even though the route treats the placeholder as
  // "not configured" and fails closed.
  { name: "LinearWebhookSecret", kind: "secret" as const },
  { name: "HookdeckSigningSecret", kind: "secret" as const },
  { name: "HouseAnthropicKey", kind: "secret" as const },
  { name: "HouseGoogleKey", kind: "secret" as const },
  { name: "HouseOpenaiKey", kind: "secret" as const },
  { name: "HouseOpenrouterKey", kind: "secret" as const },
  { name: "NangoSecretKey", kind: "secret" as const },
  // Neon Postgres connection string — read on both runtimes (Lambda via
  // node-postgres, Worker via the Neon serverless driver). Replaces the
  // Worker-only HYPERDRIVE CF binding that fronted Aurora.
  { name: "NeonDatabaseUrl", kind: "secret" as const },
  { name: "AgentGatewayInternalSecret", kind: "secret" as const },
  { name: "RelaycastInternalSecret", kind: "secret" as const },
  { name: "RelayfileInternalHmacSecret", kind: "secret" as const },
  { name: "RelaycronApiKey", kind: "secret" as const },
  { name: "WebRelayauthApiKey", kind: "secret" as const },
  { name: "RelayhistoryAssertionRelayauthApiKey", kind: "secret" as const },
  { name: "SageCloudApiToken", kind: "secret" as const },
  { name: "SageSupermemoryApiKey", kind: "secret" as const },
] as const;

const LAMBDA_RESOURCES = [
  ...SHARED_SST_SECRETS,
  // Non-secret linked resources — unhealthy only when the binding
  // itself isn't attached. No `.value`; reading the proxy is enough.
  //
  // The database is a shared SST secret (`NeonDatabaseUrl`, in
  // SHARED_SST_SECRETS above), not a non-secret binding, so it's covered on
  // both runtimes there.
  { name: "WorkflowStorage", kind: "binding" as const },
  { name: "GithubCloneQueue", kind: "binding" as const },
  { name: "WorkflowLaunchQueue", kind: "binding" as const },
] as const;

/**
 * Cloudflare Worker bindings that aren't SST resources but ARE
 * required for the Worker to function. These are wired in
 * `infra/web-worker.ts:transform.worker` via `appendWorkerBindings`,
 * not the SST `link:` array, so they're not visible through
 * `Resource.X` — they appear on the CF Worker `env` object and are
 * read here via the `__cloudflare-context__` symbol that
 * `@opennextjs/cloudflare` populates on every request.
 *
 * Each binding here is required for at least one route to function
 * on the Worker (ROUTER_CONFIG for the cutover routing logic,
 * RATE_LIMIT_COUNTERS for the rate limiter, WORKER_SELF_REFERENCE for
 * OpenNext-CF's revalidation/on-demand-ISR self-fetches,
 * PERSONA_COMPILE_WORKER for launch-agent live bundle compilation,
 * CLOUD_AGENT_WARM_QUEUE for queued cloud-agent box warming). The
 * database is no longer here — it's the `NeonDatabaseUrl` SST secret.
 */
const WORKER_CF_BINDINGS = [
  // NOTE: the database is no longer a CF binding. Since the move to Neon, the
  // Worker reads the `NeonDatabaseUrl` SST secret (checked via
  // SHARED_SST_SECRETS above) and connects with the Neon serverless driver —
  // there is no HYPERDRIVE binding to verify here anymore.
  { name: "ROUTER_CONFIG", kind: "cf-binding" as const },
  { name: "RATE_LIMIT_COUNTERS", kind: "cf-binding" as const },
  { name: "WORKFLOW_STORAGE_R2", kind: "cf-binding" as const },
  { name: "WORKER_SELF_REFERENCE", kind: "cf-binding" as const },
  { name: "AGENT_GATEWAY_DEDUPE_BROKER", kind: "cf-binding" as const },
  { name: "PERSONA_COMPILE_WORKER", kind: "cf-binding" as const },
  { name: "PROACTIVE_RUNTIME_WORKER", kind: "cf-binding" as const },
  { name: "CLOUD_AGENT_WARM_QUEUE", kind: "cf-binding" as const },
  // Producer binding for the webhook-events queue. Wired via
  // appendWorkerBindings in infra/web-worker.ts; the integration-watch
  // dispatcher (#2530) and the deployments-list health redrive (#2533) enqueue
  // durable delivery-drain jobs through it.
  { name: "WEBHOOK_QUEUE", kind: "cf-binding" as const },
  // CF Workflow binding. Wired via appendWorkerBindings in infra/web-worker.ts;
  // Nango sync traffic is routed through this binding.
  { name: "NANGO_SYNC_WORKFLOW", kind: "cf-binding" as const },
] as const;

const WORKER_ENV_BINDINGS = [
  { name: "WORKFLOW_STORAGE_BACKEND", kind: "worker-env" as const },
  { name: "WORKFLOW_STORAGE_R2_BUCKET", kind: "worker-env" as const },
  { name: "BROKER_URL", kind: "worker-env" as const },
  { name: "BROKER_HMAC_SECRET", kind: "worker-env" as const },
  { name: "QUEUE_BRIDGE_URL", kind: "worker-env" as const },
  { name: "QUEUE_BRIDGE_HMAC_SECRET", kind: "worker-env" as const },
  { name: "AGENT_GATEWAY_BASE_URL", kind: "worker-env" as const },
  { name: "AGENT_GATEWAY_INTERNAL_SECRET", kind: "worker-env" as const },
] as const;

const WORKER_RESOURCES = [
  ...SHARED_SST_SECRETS,
  // The same SST-linked, non-secret resources are bound on the
  // Worker too (see `link:` in `infra/web-worker.ts`).
  { name: "WorkflowStorage", kind: "binding" as const },
  { name: "GithubCloneQueue", kind: "binding" as const },
  { name: "WorkflowLaunchQueue", kind: "binding" as const },
] as const;

type ResourceSpec =
  | { name: string; kind: "secret" }
  | { name: string; kind: "binding" }
  | { name: string; kind: "cf-binding" }
  | { name: string; kind: "worker-env" };

export type ResourceCheckEntry =
  | { name: string; kind: ResourceSpec["kind"]; status: "ok" }
  | {
      name: string;
      kind: ResourceSpec["kind"];
      status: "missing";
      reason: string;
    };

export type ResourceCheckSummary = {
  runtime: "lambda" | "worker";
  ok: ResourceCheckEntry[];
  missing: ResourceCheckEntry[];
  // CF Worker bindings are request-scoped: OpenNext-CF only populates
  // `globalThis[__cloudflare-context__].env` inside
  // `runWithCloudflareRequestContext(...)`. The boot check runs from
  // Next's `instrumentation.ts register()` at cold-start init — OUTSIDE
  // any request — so those bindings are structurally invisible then and
  // must NOT be reported as "missing" (that false-negative is what failed
  // the Phase-3 cutover). They go here instead and are verified
  // per-request (see app/api/health/route.ts).
  deferred?: ResourceCheckEntry[];
};

function readSstResource(spec: { name: string; kind: "secret" | "binding" }): ResourceCheckEntry {
  // Using `as Record<...>` over `Resource[name]` because SST's typed
  // `Resource` proxy is generated at build time and isn't statically
  // indexable in tests. The runtime read still goes through the SST
  // SDK; we just bypass the type-time index check.
  const proxy = Resource as unknown as Record<string, unknown>;
  let bound: unknown;
  try {
    bound = proxy[spec.name];
  } catch (err) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (bound === undefined || bound === null) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason: "Resource binding not attached to this function",
    };
  }

  if (spec.kind === "secret") {
    // Secrets are usable only when their `.value` is a non-empty
    // string. The NangoSecretKey case: binding present but value
    // empty/undefined.
    const value = (bound as { value?: unknown }).value;
    if (value === undefined || value === null || value === "") {
      return {
        name: spec.name,
        kind: spec.kind,
        status: "missing",
        reason: "Secret binding attached but `.value` is empty",
      };
    }
  }

  return { name: spec.name, kind: spec.kind, status: "ok" };
}

function readCloudflareBinding(
  cfEnv: Record<string, unknown> | undefined,
  spec: { name: string; kind: "cf-binding" | "worker-env" },
): ResourceCheckEntry {
  if (!cfEnv) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason: "Cloudflare Worker `env` is not available on this runtime",
    };
  }
  const bound = cfEnv[spec.name];
  if (bound === undefined || bound === null || (spec.kind === "worker-env" && bound === "")) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason: spec.kind === "worker-env"
        ? "Worker environment binding not attached (check `environment` in infra/web-worker.ts)"
        : "CF Worker binding not attached (check `appendWorkerBindings` in infra/web-worker.ts)",
    };
  }
  return { name: spec.name, kind: spec.kind, status: "ok" };
}

/**
 * Detect whether we're running on the Cloudflare Worker or the AWS
 * Lambda. The detection is intentionally conservative: a missing CF
 * context is treated as Lambda. False positives (running the Worker
 * list on a Lambda) would surface as `[boot] resource binding check
 * FAILED` for the four Worker-only CF bindings on every cold start;
 * false negatives (running the Lambda list on a Worker) would miss
 * the CF binding checks. We accept the second over the first because
 * the deploy paths are distinct: a Lambda will never have the CF
 * context symbol set, and a Worker that's missing the CF context is
 * already broken in ways the boot check can't help with.
 *
 * The CF Worker symbol is populated by `@opennextjs/cloudflare`'s
 * init module before any request handler runs. See
 * `packages/web/lib/cloudflare-context.ts` for the same accessor used
 * by the runtime DB client.
 */
function detectRuntime(): "lambda" | "worker" {
  const cfSymbol = Symbol.for("__cloudflare-context__");
  const ctx = (globalThis as Record<symbol, unknown>)[cfSymbol];
  if (ctx && typeof ctx === "object") {
    return "worker";
  }
  // Secondary signal: the Workers runtime sets
  // `navigator.userAgent === "Cloudflare-Workers"`. If we somehow run
  // before OpenNext-CF sets the context symbol (unlikely but
  // defensive), fall back to this. Lambda's Node runtime has no
  // `navigator` global.
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (nav && typeof nav.userAgent === "string" && nav.userAgent.includes("Cloudflare-Workers")) {
    return "worker";
  }
  return "lambda";
}

function readCloudflareEnv(): Record<string, unknown> | undefined {
  const cfSymbol = Symbol.for("__cloudflare-context__");
  const ctx = (globalThis as Record<symbol, unknown>)[cfSymbol];
  if (ctx && typeof ctx === "object" && "env" in ctx) {
    const env = (ctx as { env?: unknown }).env;
    if (env && typeof env === "object") {
      return env as Record<string, unknown>;
    }
  }
  return undefined;
}

export function checkRequiredResources(): ResourceCheckSummary {
  const runtime = detectRuntime();
  const summary: ResourceCheckSummary = { runtime, ok: [], missing: [] };

  if (runtime === "worker") {
    for (const spec of WORKER_RESOURCES) {
      const entry = readSstResource(spec);
      (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
    }
    const cfEnv = readCloudflareEnv();
    if (cfEnv === undefined) {
      // No request-scoped CF context (boot/init scope). CF bindings can't
      // be evaluated here and are NOT missing — defer to per-request
      // verification rather than emit a false-negative.
      summary.deferred = [...WORKER_CF_BINDINGS, ...WORKER_ENV_BINDINGS].map((spec) => ({
        name: spec.name,
        kind: spec.kind,
        status: "missing" as const,
        reason: "Deferred: CF binding is request-scoped, not visible at boot",
      }));
      return summary;
    }
    for (const spec of WORKER_CF_BINDINGS) {
      const entry = readCloudflareBinding(cfEnv, spec);
      (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
    }
    for (const spec of WORKER_ENV_BINDINGS) {
      const entry = readCloudflareBinding(cfEnv, spec);
      (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
    }
    return summary;
  }

  for (const spec of LAMBDA_RESOURCES) {
    const entry = readSstResource(spec);
    (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
  }
  return summary;
}

let bootCheckRan = false;
let bootCheckSummary: ResourceCheckSummary | null = null;

/**
 * Run the boot-time resource check exactly once per cold start.
 * Logs a structured warning per missing binding. Never throws — a
 * missing resource shouldn't break unrelated route handlers that
 * don't read it. Surfaces the issue in CloudWatch (Lambda) or the
 * Workers tail log (CF Worker) on first invoke instead of waiting
 * for the first request that needs the missing binding.
 *
 * Subsequent calls return the cached first-run summary so callers
 * (tests, future health endpoints) see the actual boot result, not
 * an empty placeholder.
 */
export function runBootResourceCheck(): ResourceCheckSummary {
  if (bootCheckRan) {
    return bootCheckSummary ?? { runtime: detectRuntime(), ok: [], missing: [] };
  }
  bootCheckRan = true;

  const summary = checkRequiredResources();
  bootCheckSummary = summary;
  if (summary.missing.length === 0) {
    const deferred = summary.deferred ?? [];
    if (deferred.length > 0) {
      // Worker cold-start init scope: CF bindings are request-scoped and
      // cannot be seen here. This is EXPECTED and not a failure — verified
      // per-request via /cloud/api/health. Logging FAILED here was the
      // false-negative that rolled back the Phase-3 cutover.
      console.info(
        "[boot] resource binding check: CF bindings deferred to request scope (not a failure)",
        {
          runtime: summary.runtime,
          checked: summary.ok.map((entry) => entry.name),
          deferred: deferred.map((entry) => entry.name),
        },
      );
      return summary;
    }
    console.info("[boot] resource binding check passed", {
      runtime: summary.runtime,
      checked: summary.ok.map((entry) => entry.name),
    });
    return summary;
  }

  const hint =
    summary.runtime === "worker"
      ? "If you just deployed the CF Worker: confirm `link: [...]` and `appendWorkerBindings` in `infra/web-worker.ts` include each missing resource AND that the deploy actually updated this Worker (script version should change). " +
        "For SST-linked secrets (kind: \"secret\") that are missing because the value is empty: run `sst secret set <Name> ...` for this stage and redeploy. " +
        "For CF Worker bindings (kind: \"cf-binding\") that are missing: the binding lives in `transform.worker` / `appendWorkerBindings` in `infra/web-worker.ts`, not the SST `link:` array. " +
        "Check `wrangler deployments list` and `wrangler tail` for the deployed Worker."
      : "If you just deployed: confirm `link: [...]` in `infra/web.ts` includes each missing resource AND that the deploy actually updated this function (CodeSha256 should change). " +
        "If the link list is correct, check `aws lambda get-function-configuration --function-name <fn> --query Environment.Variables` for `SST_RESOURCE_<Name>` keys; missing keys mean SST didn't inject the binding even though the source says to. " +
        "For `kind: \"secret\"` entries marked missing because the value is empty: run `sst secret set <Name> ...` for this stage and redeploy.";

  console.error(
    `[boot] resource binding check FAILED — required resources are not attached to this ${summary.runtime}`,
    {
      runtime: summary.runtime,
      missing: summary.missing,
      ok: summary.ok.map((entry) => entry.name),
      hint,
    },
  );
  return summary;
}

/** Reset for tests so each test gets a fresh first-run. */
export function resetBootCheckForTests(): void {
  bootCheckRan = false;
  bootCheckSummary = null;
}

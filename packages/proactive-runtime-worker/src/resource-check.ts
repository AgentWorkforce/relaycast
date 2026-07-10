import { Resource } from "sst";

type ResourceSpec =
  | { name: string; kind: "secret" }
  | { name: string; kind: "binding" }
  | { name: string; kind: "cf-binding" }
  | { name: string; kind: "worker-env" };

type ResourceCheckEntry =
  | { name: string; kind: ResourceSpec["kind"]; status: "ok" }
  | {
      name: string;
      kind: ResourceSpec["kind"];
      status: "missing";
      reason: string;
    };

type ResourceCheckSummary = {
  ok: ResourceCheckEntry[];
  missing: ResourceCheckEntry[];
};

const PRW_SST_RESOURCES = [
  { name: "NeonDatabaseUrl", kind: "secret" as const },
  { name: "WorkflowStorage", kind: "binding" as const },
  { name: "RelaycronApiKey", kind: "secret" as const },
  { name: "AgentGatewayInternalSecret", kind: "secret" as const },
  { name: "CredentialEncryptionKey", kind: "secret" as const },
  { name: "BrokerHmacSecret", kind: "secret" as const },
  { name: "CredentialProxyJwtSecret", kind: "secret" as const },
  { name: "WebRelayauthApiKey", kind: "secret" as const },
  { name: "RelayfileInternalHmacSecret", kind: "secret" as const },
  { name: "DaytonaApiKey", kind: "secret" as const },
] as const;

const PRW_CF_BINDINGS = [
  { name: "WORKFLOW_STORAGE_R2", kind: "cf-binding" as const },
  // Producer binding for the webhook-events queue; the integration-watch
  // dispatcher enqueues durable delivery-drain jobs through it when dispatch
  // runs on this worker (GitHub/Linear webhook path, #2530).
  { name: "WEBHOOK_QUEUE", kind: "cf-binding" as const },
] as const;

const PRW_ENV_BINDINGS = [
  { name: "WORKFLOW_STORAGE_BACKEND", kind: "worker-env" as const },
  { name: "WORKFLOW_STORAGE_R2_BUCKET", kind: "worker-env" as const },
  { name: "BROKER_URL", kind: "worker-env" as const },
  { name: "BROKER_HMAC_SECRET", kind: "worker-env" as const },
  { name: "AGENT_GATEWAY_BASE_URL", kind: "worker-env" as const },
  { name: "AGENT_GATEWAY_INTERNAL_SECRET", kind: "worker-env" as const },
  { name: "RELAYCRON_URL", kind: "worker-env" as const },
  { name: "RELAYCRON_API_KEY", kind: "worker-env" as const },
  { name: "RELAYFILE_URL", kind: "worker-env" as const },
  { name: "RELAYAUTH_URL", kind: "worker-env" as const },
  { name: "WEB_RELAYAUTH_URL", kind: "worker-env" as const },
  { name: "CREDENTIAL_PROXY_URL", kind: "worker-env" as const },
  { name: "CREDENTIAL_PROXY_TOKEN", kind: "worker-env" as const },
  { name: "RELAY_LLM_PROXY_URL", kind: "worker-env" as const },
  { name: "RELAY_LLM_PROXY_TOKEN", kind: "worker-env" as const },
] as const;

function readSstResource(spec: { name: string; kind: "secret" | "binding" }): ResourceCheckEntry {
  const proxy = Resource as unknown as Record<string, unknown>;
  let bound: unknown;
  try {
    bound = proxy[spec.name];
  } catch (error) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (bound === undefined || bound === null) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason: "Resource binding not attached to this worker",
    };
  }

  if (spec.kind === "secret") {
    const value = (bound as { value?: unknown }).value;
    if (typeof value !== "string" || value.length === 0) {
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

function readEnvBinding(
  env: Record<string, unknown>,
  spec: { name: string; kind: "cf-binding" | "worker-env" },
): ResourceCheckEntry {
  const value = env[spec.name];
  if (value === undefined || value === null || (spec.kind === "worker-env" && value === "")) {
    return {
      name: spec.name,
      kind: spec.kind,
      status: "missing",
      reason:
        spec.kind === "worker-env"
          ? "Worker environment binding not attached"
          : "Cloudflare binding not attached",
    };
  }
  return { name: spec.name, kind: spec.kind, status: "ok" };
}

export function checkProactiveRuntimeWorkerResources(
  env: Record<string, unknown>,
): ResourceCheckSummary {
  const summary: ResourceCheckSummary = { ok: [], missing: [] };
  for (const spec of PRW_SST_RESOURCES) {
    const entry = readSstResource(spec);
    (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
  }
  for (const spec of PRW_CF_BINDINGS) {
    const entry = readEnvBinding(env, spec);
    (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
  }
  for (const spec of PRW_ENV_BINDINGS) {
    const entry = readEnvBinding(env, spec);
    (entry.status === "ok" ? summary.ok : summary.missing).push(entry);
  }
  return summary;
}

let loggedBootCheck = false;

export function logProactiveRuntimeWorkerBootCheck(env: Record<string, unknown>): void {
  if (loggedBootCheck) {
    return;
  }
  loggedBootCheck = true;
  const summary = checkProactiveRuntimeWorkerResources(env);
  if (summary.missing.length === 0) {
    console.info("[proactive-runtime-worker] resource binding check passed", {
      checked: summary.ok.map((entry) => entry.name),
    });
    return;
  }
  console.error("[proactive-runtime-worker] resource binding check FAILED", {
    missing: summary.missing,
    checked: summary.ok.map((entry) => entry.name),
  });
}

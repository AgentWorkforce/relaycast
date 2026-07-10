import type { EnqueueCloudAgentBoxWarmPayload } from "./warm-job-store";

/**
 * Cloud-agent box warm enqueue SEAM (issue #1384, slice 3) — TRANSPORT-AGNOSTIC.
 *
 * Resolution order: an explicitly registered transport (tests / a consumer that
 * passes its own enqueue), else the default Cloudflare Queue producer binding
 * `CLOUD_AGENT_WARM_QUEUE` read off the OpenNext-CF context (how cloud-web
 * enqueues). Throws if neither is available; never reached with
 * CLOUD_AGENT_WARM_VIA_QUEUE off (default).
 */

const CLOUDFLARE_CONTEXT_SYMBOL = Symbol.for("__cloudflare-context__");

interface CloudflareQueueBinding {
  send(body: unknown): Promise<void>;
}

function readCloudAgentWarmQueueBinding(): CloudflareQueueBinding | null {
  const ctx = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT_SYMBOL];
  const env =
    ctx && typeof ctx === "object" && "env" in ctx
      ? (ctx as { env?: Record<string, unknown> }).env
      : undefined;
  const binding = env?.CLOUD_AGENT_WARM_QUEUE;
  if (binding && typeof binding === "object" && typeof (binding as { send?: unknown }).send === "function") {
    return binding as CloudflareQueueBinding;
  }
  return null;
}

export interface EnqueueCloudAgentBoxWarmOptions {
  delaySeconds?: number;
}

export type CloudAgentBoxWarmTransport = (
  payload: EnqueueCloudAgentBoxWarmPayload,
  options?: EnqueueCloudAgentBoxWarmOptions,
) => Promise<void>;

let transport: CloudAgentBoxWarmTransport | null = null;

export function setCloudAgentBoxWarmTransport(next: CloudAgentBoxWarmTransport | null): void {
  transport = next;
}

export function resetCloudAgentBoxWarmTransportForTesting(): void {
  transport = null;
}

export async function enqueueCloudAgentBoxWarm(
  payload: EnqueueCloudAgentBoxWarmPayload,
  options?: EnqueueCloudAgentBoxWarmOptions,
): Promise<void> {
  if (transport) {
    await transport(payload, options);
    return;
  }
  const queue = readCloudAgentWarmQueueBinding();
  if (queue) {
    await queue.send(payload);
    return;
  }
  throw new Error(
    "[cloud-agent-warm] enqueue transport not configured and CLOUD_AGENT_WARM_QUEUE binding unavailable (issue #1384 slice 3)",
  );
}

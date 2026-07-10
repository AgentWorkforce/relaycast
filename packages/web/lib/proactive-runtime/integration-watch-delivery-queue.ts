import { getCloudflareContext } from "@/lib/cloudflare-context";
import { logger } from "@/lib/logger";

type CloudflareQueueBinding = {
  send(body: unknown): Promise<void> | void;
};

type IntegrationWatchDeliveryDrainMessage = {
  version: 2;
  provider: "internal";
  ingress: "integration-watch-delivery-drain";
  payload: {
    storage: "inline";
    body: string;
    sizeBytes: number;
    sha256: string;
  };
  headers: Record<string, string>;
  receivedAt: string;
  requestId: string;
  delivery: {
    workspaceId: string;
    agentId: string;
    deliveryId?: string;
    limit?: number;
  };
  dedupe: {
    kind: "integration-watch-delivery-drain";
    deliveryId: string;
  };
};

function readWebhookQueueBinding(): CloudflareQueueBinding | null {
  try {
    const env = getCloudflareContext({ async: false }).env;
    const binding = env?.WEBHOOK_QUEUE;
    if (
      binding &&
      typeof binding === "object" &&
      typeof (binding as { send?: unknown }).send === "function"
    ) {
      return binding as CloudflareQueueBinding;
    }
  } catch {
    // Lambda/local routes do not have the Cloudflare Queue producer binding.
  }
  return null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function enqueueIntegrationWatchDeliveryDrain(input: {
  workspaceId: string;
  agentId: string;
  deliveryId?: string;
  limit?: number;
}): Promise<"enqueued" | "unavailable"> {
  const queue = readWebhookQueueBinding();
  if (!queue) {
    await logger.warn("Integration watch durable delivery drain skipped without WEBHOOK_QUEUE binding", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId ?? null,
      limit: input.limit ?? null,
    });
    return "unavailable";
  }

  const body = JSON.stringify({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  });
  const dedupeDeliveryId = input.deliveryId ?? `backlog:${input.workspaceId}:${input.agentId}`;
  const message: IntegrationWatchDeliveryDrainMessage = {
    version: 2,
    provider: "internal",
    ingress: "integration-watch-delivery-drain",
    payload: {
      storage: "inline",
      body,
      sizeBytes: new TextEncoder().encode(body).byteLength,
      sha256: await sha256Hex(body),
    },
    headers: {
      "content-type": "application/json",
    },
    receivedAt: new Date().toISOString(),
    requestId: `integration-watch-drain:${dedupeDeliveryId}`,
    delivery: {
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    },
    dedupe: {
      kind: "integration-watch-delivery-drain",
      deliveryId: dedupeDeliveryId,
    },
  };

  try {
    await queue.send(message);
    return "enqueued";
  } catch (error) {
    await logger.warn("Integration watch durable delivery drain enqueue failed", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId ?? null,
      limit: input.limit ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
}

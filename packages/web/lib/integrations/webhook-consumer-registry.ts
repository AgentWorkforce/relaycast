import { getConfiguredConsumers } from "./webhook-consumers.config";
import { logger } from "../logger";
import { claimWebhookDelivery, releaseWebhookDelivery } from "@/lib/ricky/webhook-dedup";
import type {
  FanoutResult,
  NormalizedWebhook,
  WebhookConsumer,
  WebhookProvider,
} from "./webhook-consumer-types.js";

export {
  createRelayfilePrimaryConsumer,
  getConfiguredConsumers,
} from "./webhook-consumers.config";
export type {
  FanoutResult,
  NormalizedWebhook,
  WebhookConsumer,
  WebhookConsumerPredicate,
  WebhookProvider,
} from "./webhook-consumer-types.js";

const WEBHOOK_CONSUMERS_ENV = "WEBHOOK_CONSUMERS_JSON";
const DEFAULT_TIMEOUT_MS = 10_000;
const FANOUT_HEADER = "x-agent-relay-fanout";

type RegistryLogger = {
  info?: (message: string, context?: Record<string, unknown>) => void | Promise<void>;
  warn?: (message: string, context?: Record<string, unknown>) => void | Promise<void>;
  error?: (message: string, context?: Record<string, unknown>) => void | Promise<void>;
};

type WebhookConsumerRegistryOptions = {
  fetchImpl?: typeof fetch;
  logger?: RegistryLogger;
};

type ConsumerDispatchResult =
  | {
      id: string;
      status: "succeeded";
    }
  | {
      id: string;
      status: "skipped";
      reason: "predicate" | "dedupe";
    };

class WebhookConsumerError extends Error {
  constructor(
    readonly consumerId: string,
    error: unknown,
  ) {
    super(errorToMessage(error));
    this.name = "WebhookConsumerError";
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeId(id: string): string {
  return id.trim();
}

function consumerProviders(consumer: WebhookConsumer): readonly WebhookProvider[] {
  if (consumer.providers) {
    return consumer.providers;
  }

  return [consumer.provider];
}

function matchesProvider(consumer: WebhookConsumer, provider: WebhookProvider): boolean {
  return consumerProviders(consumer).includes(provider);
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return timeoutMs;
}

function shouldClaimHttpConsumerDelivery(
  consumer: WebhookConsumer,
): consumer is Extract<WebhookConsumer, { kind: "http" }> {
  return consumer.kind === "http" && consumer.id === "proactive-issue-resolver";
}

function httpConsumerDeliveryKey(
  consumer: Extract<WebhookConsumer, { kind: "http" }>,
  event: NormalizedWebhook,
): string | null {
  const deliveryId = event.deliveryId?.trim();
  if (!deliveryId) return null;
  return [
    event.workspaceId?.trim() || "global",
    event.provider,
    consumer.id,
    deliveryId,
  ].join(":");
}

// The registry only knows the HTTP consumer id. For
// proactive-issue-resolver that consumer is a service-level target which
// fans out to agents downstream, so cross-path hard dedup with the
// Nango/integration-watch path is intentionally deferred until the
// downstream resolver layer has the concrete agentId. That downstream
// fix should claim per (provider, GitHub delivery id, agentId). This
// registry claim suppresses same-delivery retries to the same HTTP
// consumer, which is the confirmed #1017 failure mode.

function normalizeHeaderMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      headers[key] = entry;
      continue;
    }

    if (typeof entry === "number" || typeof entry === "boolean") {
      headers[key] = String(entry);
    }
  }

  return headers;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readProvider(value: unknown): WebhookProvider | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readProviders(record: Record<string, unknown>): WebhookProvider[] {
  const provider = readProvider(record.provider);
  if (provider) {
    return [provider];
  }

  if (!Array.isArray(record.providers)) {
    return [];
  }

  return record.providers
    .map(readProvider)
    .filter((value): value is WebhookProvider => Boolean(value));
}

function parseTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseConsumerEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asObject(value);
  if (record && Array.isArray(record.consumers)) {
    return record.consumers;
  }

  return [];
}

function parseEnvConsumer(value: unknown): WebhookConsumer | null {
  const record = asObject(value);
  if (!record) {
    return null;
  }

  const id = readString(record, "id")?.trim();
  const url = readString(record, "url")?.trim();
  const kind = readString(record, "kind")?.trim() ?? "http";
  const providers = readProviders(record);

  if (!id || !url || kind !== "http" || providers.length === 0) {
    return null;
  }

  const selector =
    providers.length === 1
      ? { provider: providers[0] }
      : { providers };

  return {
    ...selector,
    id,
    kind: "http",
    url,
    headers: normalizeHeaderMap(record.headers),
    timeoutMs: parseTimeoutMs(record.timeoutMs),
  };
}

function emptyFanoutResult(): FanoutResult {
  return {
    total: 0,
    succeeded: [],
    failed: [],
    skipped: [],
  };
}

function eventTypeForLog(event: NormalizedWebhook): string | undefined {
  try {
    return typeof event.eventType === "string" ? event.eventType : undefined;
  } catch {
    return undefined;
  }
}

export class WebhookConsumerRegistry {
  private readonly consumers = new Map<string, WebhookConsumer>();
  private readonly fetchImpl: typeof fetch;
  private readonly log: RegistryLogger;

  constructor(options: WebhookConsumerRegistryOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.logger ?? logger;
  }

  register(consumer: WebhookConsumer): void {
    const id = normalizeId(consumer.id);
    if (!id) {
      throw new Error("Webhook consumer id is required");
    }

    const normalized = {
      ...consumer,
      id,
    } as WebhookConsumer;

    if (this.consumers.has(id)) {
      void this.log.warn?.("Webhook consumer id already registered; replacing", {
        area: "webhook-fanout",
        consumerId: id,
      });
    }

    this.consumers.set(id, normalized);
  }

  unregister(id: string): boolean {
    return this.consumers.delete(normalizeId(id));
  }

  clear(): void {
    this.consumers.clear();
  }

  get(id: string): WebhookConsumer | undefined {
    return this.consumers.get(normalizeId(id));
  }

  list(provider: WebhookProvider): WebhookConsumer[] {
    return Array.from(this.consumers.values()).filter((consumer) =>
      matchesProvider(consumer, provider),
    );
  }

  async fanout(
    provider: WebhookProvider,
    event: NormalizedWebhook,
  ): Promise<FanoutResult> {
    return this.fanoutInternal(provider, event, new Set());
  }

  async fanoutExcept(
    provider: WebhookProvider,
    event: NormalizedWebhook,
    excludedIds: Iterable<string>,
  ): Promise<FanoutResult> {
    return this.fanoutInternal(
      provider,
      event,
      new Set(Array.from(excludedIds, normalizeId)),
    );
  }

  private async fanoutInternal(
    provider: WebhookProvider,
    event: NormalizedWebhook,
    excludedIds: ReadonlySet<string>,
  ): Promise<FanoutResult> {
    const result = emptyFanoutResult();

    try {
      const consumers = this.list(provider).filter(
        (consumer) => !excludedIds.has(consumer.id),
      );
      result.total = consumers.length;

      const settled = await Promise.allSettled(
        consumers.map((consumer) => this.dispatchConsumer(consumer, event)),
      );

      for (const entry of settled) {
        if (entry.status === "fulfilled") {
          if (entry.value.status === "skipped") {
            result.skipped.push({
              id: entry.value.id,
              reason: entry.value.reason,
            });
          } else {
            result.succeeded.push(entry.value.id);
          }
          continue;
        }

        const failure = this.normalizeFailure(entry.reason);
        result.failed.push(failure);
        void this.log.error?.("Webhook consumer fanout failed", {
          area: "webhook-fanout",
          provider,
          consumerId: failure.id,
          eventType: eventTypeForLog(event),
          error: failure.error,
        });
      }

      void this.log.info?.("Webhook fanout completed", {
        area: "webhook-fanout",
        provider,
        eventType: eventTypeForLog(event),
        total: result.total,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
        skipped: result.skipped.length,
      });

      return result;
    } catch (error) {
      const message = errorToMessage(error);
      result.failed.push({
        id: "webhook-consumer-registry",
        error: message,
      });
      void this.log.error?.("Webhook fanout registry failed", {
        area: "webhook-fanout",
        provider,
        eventType: eventTypeForLog(event),
        error: message,
      });
      return result;
    }
  }

  private async dispatchConsumer(
    consumer: WebhookConsumer,
    event: NormalizedWebhook,
  ): Promise<ConsumerDispatchResult> {
    try {
      if (consumer.predicate && !(await consumer.predicate(event))) {
        return {
          id: consumer.id,
          status: "skipped",
          reason: "predicate",
        };
      }

      const deliveryKey = shouldClaimHttpConsumerDelivery(consumer)
        ? httpConsumerDeliveryKey(consumer, event)
        : null;
      const claimed = deliveryKey
        ? await claimWebhookDelivery({
            surface: "webhook-dispatch",
            deliveryId: deliveryKey,
          })
        : true;
      if (!claimed) {
        return {
          id: consumer.id,
          status: "skipped",
          reason: "dedupe",
        };
      }

      if (consumer.kind === "local") {
        await consumer.handler(event);
      } else {
        try {
          await this.dispatchHttpConsumer(consumer, event);
        } catch (error) {
          if (deliveryKey) {
            await releaseWebhookDelivery({
              surface: "webhook-dispatch",
              deliveryId: deliveryKey,
            }).catch((releaseError) => {
              void this.log.warn?.("Webhook HTTP consumer dedupe release failed", {
                area: "webhook-fanout",
                consumerId: consumer.id,
                provider: event.provider,
                eventType: eventTypeForLog(event),
                deliveryId: event.deliveryId ?? undefined,
                error: errorToMessage(releaseError),
              });
            });
          }
          throw error;
        }
      }

      return {
        id: consumer.id,
        status: "succeeded",
      };
    } catch (error) {
      throw new WebhookConsumerError(consumer.id, error);
    }
  }

  private async dispatchHttpConsumer(
    consumer: Extract<WebhookConsumer, { kind: "http" }>,
    event: NormalizedWebhook,
  ): Promise<void> {
    const timeoutMs = normalizeTimeoutMs(consumer.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.fetchImpl(consumer.url, {
        method: "POST",
        headers: {
          ...(consumer.headers ?? {}),
          "content-type": "application/json",
          [FANOUT_HEADER]: "1",
        },
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }
    } catch (error) {
      if (timedOut) {
        throw new Error(`Timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private normalizeFailure(error: unknown): { id: string; error: string } {
    if (error instanceof WebhookConsumerError) {
      return {
        id: error.consumerId,
        error: error.message,
      };
    }

    return {
      id: "unknown",
      error: errorToMessage(error),
    };
  }
}

export function bootstrapRegistryFromEnv(
  env: Record<string, string | undefined> = process.env,
  options?: WebhookConsumerRegistryOptions,
): WebhookConsumerRegistry {
  const registry = new WebhookConsumerRegistry(options);
  const configured = env[WEBHOOK_CONSUMERS_ENV];
  const typed = getConfiguredConsumers(env);

  for (const consumer of typed) {
    registry.register(consumer);
  }

  if (configured?.trim()) {
    try {
      const consumers = parseConsumerEntries(JSON.parse(configured)).flatMap((entry) => {
        const consumer = parseEnvConsumer(entry);
        return consumer ? [consumer] : [];
      });

      if (consumers.length > 0) {
        void logger.warn(
          "WEBHOOK_CONSUMERS_JSON is deprecated; migrate entries to typed SST secrets.",
        );

        for (const consumer of consumers) {
          registry.register(consumer);
        }
      }
    } catch (error) {
      void logger.warn("WEBHOOK_CONSUMERS_JSON could not be parsed; ignoring", {
        area: "webhook-fanout",
        env: WEBHOOK_CONSUMERS_ENV,
        error: errorToMessage(error),
      });
    }
  }

  return registry;
}

let registrySingleton: WebhookConsumerRegistry | null = null;

export function getRegistry(): WebhookConsumerRegistry {
  registrySingleton ??= bootstrapRegistryFromEnv();
  return registrySingleton;
}

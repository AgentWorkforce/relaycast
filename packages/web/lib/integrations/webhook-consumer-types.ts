export type WebhookProvider =
  | "slack"
  | "github"
  | "linear"
  | "notion"
  | (string & {});

export type NormalizedWebhook = {
  provider: WebhookProvider;
  connectionId?: string | null;
  workspaceId?: string | null;
  eventType: string;
  objectType?: string;
  objectId?: string;
  payload: Record<string, unknown>;
  path?: string;
  data?: Record<string, unknown> | Record<string, unknown>[];
  deliveryId?: string | null;
  headers?: Record<string, string>;
  timestamp?: string;
};

export type WebhookConsumerPredicate = (
  event: NormalizedWebhook,
) => boolean | Promise<boolean>;

type WebhookProviderSelector =
  | {
      provider: WebhookProvider;
      providers?: never;
    }
  | {
      provider?: never;
      providers: readonly WebhookProvider[];
    };

type WebhookConsumerBase = WebhookProviderSelector & {
  /** Stable id for logs, e.g. "sage", "nightcto", "relayfile-primary". */
  id: string;
  /** Optional predicate. Returning false records a skipped outcome. */
  predicate?: WebhookConsumerPredicate;
  /** Per-consumer timeout for HTTP fanout. Defaults to 10s. */
  timeoutMs?: number;
};

export type WebhookConsumer =
  | (WebhookConsumerBase & {
      kind: "http";
      url: string;
      headers?: Record<string, string>;
    })
  | (WebhookConsumerBase & {
      kind: "local";
      handler: (event: NormalizedWebhook) => Promise<void> | void;
    });

export interface FanoutResult {
  total: number;
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
  skipped: Array<{ id: string; reason: "predicate" | "dedupe" }>;
}

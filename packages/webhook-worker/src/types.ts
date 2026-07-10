export type WebhookProvider = "composio" | "github" | "hookdeck" | "internal" | "nango";

export type WebhookPayloadRef =
  | {
      storage: "inline";
      body: string;
      sizeBytes: number;
      sha256: string;
    }
  | {
      storage: "r2";
      bucket: "WEBHOOK_PAYLOADS";
      key: string;
      sizeBytes: number;
      sha256: string;
    };

type WebhookQueueMessageBase = {
  version: 2;
  provider: WebhookProvider;
  payload: WebhookPayloadRef;
  headers: Record<string, string>;
  receivedAt: string;
  requestId: string;
};

export type NangoSyncQueueMessage = WebhookQueueMessageBase & {
  provider: "nango";
  ingress: "nango-sync";
  nango: {
    envelopeType?: string;
    from?: string;
    connectionId?: string;
    providerConfigKey?: string;
    syncName?: string;
    model?: string;
    queryTimeStamp?: string;
    cursor?: string;
  };
  dedupe: {
    kind: "nango-sync";
    connectionId?: string;
    syncName?: string;
    model?: string;
    windowKey?: string;
    cursorKey?: string;
  };
};

export type NangoForwardQueueMessage = WebhookQueueMessageBase & {
  provider: "nango";
  ingress: "nango-forward";
  nango: {
    envelopeType: "forward";
    from?: string;
    connectionId?: string;
    providerConfigKey?: string;
  };
  dedupe: {
    kind: "nango-forward";
    connectionId?: string;
    deliveryId?: string;
  };
};

export type GitLabHookdeckQueueMessage = WebhookQueueMessageBase & {
  provider: "nango";
  ingress: "gitlab-hookdeck";
  gitlab: {
    event?: string;
    eventUuid?: string;
    token?: string;
    projectId?: string;
  };
  hookdeck: {
    signature?: string;
    signature2?: string;
  };
  dedupe: {
    kind: "gitlab-hookdeck-delivery";
    deliveryId?: string;
  };
};

export type GenericWebhookQueueMessage = WebhookQueueMessageBase & {
  provider: Exclude<WebhookProvider, "internal" | "nango">;
  ingress: "provider-webhook";
  dedupe: {
    kind: "provider-delivery";
    provider: Exclude<WebhookProvider, "internal" | "nango">;
    deliveryId?: string;
  };
};

export type IntegrationWatchDeliveryDrainQueueMessage = WebhookQueueMessageBase & {
  provider: "internal";
  ingress: "integration-watch-delivery-drain";
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

export type WebhookQueueMessage =
  | NangoForwardQueueMessage
  | NangoSyncQueueMessage
  | GitLabHookdeckQueueMessage
  | IntegrationWatchDeliveryDrainQueueMessage
  | GenericWebhookQueueMessage;

export type LegacyWebhookQueueMessage = {
  provider: WebhookProvider;
  body: string;
  headers: Record<string, string>;
  receivedAt: string;
  requestId: string;
};

export type QueueLike = {
  send(message: WebhookQueueMessage): Promise<void> | void;
};

export type Env = {
  ENVIRONMENT?: string;
  SST_STAGE?: string;
  NEXT_PUBLIC_SST_STAGE?: string;
  DEPLOY_VERSION?: string;
  DEPLOY_ID?: string;
  CF_VERSION_METADATA?: {
    id?: string;
    tag?: string;
    timestamp?: string;
  };
  NIGHTCTO_EVIDENCE_URL?: string;
  NIGHTCTO_EVIDENCE_TOKEN?: string;
  OTEL_SERVICE_NAME?: string;
  RELAY_OTEL_ENABLED?: string;
  RELAY_OTEL_EXPORTER?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string;
  WEBHOOK_QUEUE: QueueLike;
  WEBHOOK_PAYLOADS?: R2Bucket;
  NANGO_SYNC_DEDUP: D1Database;
  CLOUD_WEB_WEBHOOK_ORIGIN?: string;
  AGENT_GATEWAY_INTERNAL_SECRET?: string;
  COMPOSIO_WEBHOOK_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  HOOKDECK_WEBHOOK_SECRET?: string;
  NANGO_WEBHOOK_SECRET?: string;
};

const INTERNAL_METADATA_PREFIX = '__relaycast_';
const WEBHOOK_ORIGIN = 'inbound_webhook';
const LEGACY_WEBHOOK_AGENT_NAME = '__relay_webhook__';

export function sanitizeUserMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !key.startsWith(INTERNAL_METADATA_PREFIX)),
  );
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

/** Stable digest input for the exact public metadata persisted on a message. */
export function canonicalUserMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string {
  return JSON.stringify(canonicalJsonValue(sanitizeUserMessageMetadata(metadata)));
}

export function publicMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return sanitizeUserMessageMetadata(metadata);
}

export function inboundWebhookMessageMetadata(data: {
  webhookId: string;
  webhookName: string;
  source?: string | null;
  author: string;
}): Record<string, unknown> {
  return {
    __relaycast_origin: WEBHOOK_ORIGIN,
    __relaycast_webhook_id: data.webhookId,
    __relaycast_webhook_name: data.webhookName,
    __relaycast_webhook_source: data.source ?? null,
    __relaycast_display_author: data.author,
  };
}

export function displayAgentName(
  metadata: Record<string, unknown> | null | undefined,
  fallback: string | null | undefined,
): string {
  const origin = metadata?.__relaycast_origin;
  const webhookId = metadata?.__relaycast_webhook_id;
  const author = metadata?.__relaycast_display_author;
  if (
    origin === WEBHOOK_ORIGIN &&
    typeof webhookId === 'string' &&
    webhookId.length > 0 &&
    typeof author === 'string' &&
    author.length > 0
  ) {
    return author;
  }

  const legacyAuthor = metadata?.author;
  if (
    fallback === LEGACY_WEBHOOK_AGENT_NAME
    && typeof legacyAuthor === 'string'
    && legacyAuthor.length > 0
  ) {
    return legacyAuthor;
  }

  return fallback || 'unknown';
}

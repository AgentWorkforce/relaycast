export type GoogleMailStableModel = "message" | "thread";

const VOLATILE_GOOGLE_MAIL_KEYS = new Set([
  "_nango_metadata",
  "cursor",
  "fetchedAt",
  "fetched_at",
  "historyId",
  "history_id",
  "providerSyncTimestamp",
  "provider_sync_timestamp",
  "syncCursor",
  "syncToken",
  "sync_cursor",
  "syncedAt",
  "synced_at",
]);

const SORTED_ARRAY_KEYS = new Set([
  "attachments",
  "headers",
  "labelIds",
  "labels",
  "messageIds",
]);

export function isGoogleMailStableDedupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.GOOGLE_MAIL_STABLE_DEDUP_ENABLED;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value));
}

export function googleMailStableProjection(
  record: Record<string, unknown>,
  model: GoogleMailStableModel,
): unknown {
  if (model === "thread") {
    return normalizeGoogleMailStableObject(record, { sortMessages: true });
  }
  return normalizeGoogleMailStableObject(record, { sortMessages: false });
}

export function googleMailStableProjectionMatches(
  existingText: string | undefined,
  incomingRecord: Record<string, unknown>,
  model: GoogleMailStableModel,
): boolean {
  if (existingText === undefined) return false;
  let existing: unknown;
  try {
    existing = JSON.parse(existingText);
  } catch {
    return false;
  }
  if (!isObject(existing)) return false;
  return stableJson(googleMailStableProjection(existing, model)) ===
    stableJson(googleMailStableProjection(incomingRecord, model));
}

function normalizeGoogleMailStableObject(
  value: Record<string, unknown>,
  options: { sortMessages: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_GOOGLE_MAIL_KEYS.has(key)) continue;
    const raw = value[key];
    if (raw === undefined) continue;

    if (options.sortMessages && key === "messages" && Array.isArray(raw)) {
      const normalized = raw
        .filter((entry): entry is Record<string, unknown> => isObject(entry))
        .map((entry) =>
          normalizeGoogleMailStableObject(entry, { sortMessages: false }),
        );
      out[key] = normalized
        .map((item) => ({
          item,
          id: stableRecordId(item),
          json: JSON.stringify(item),
        }))
        .sort((left, right) => left.id.localeCompare(right.id) || left.json.localeCompare(right.json))
        .map(({ item }) => item);
      continue;
    }

    if (SORTED_ARRAY_KEYS.has(key) && Array.isArray(raw)) {
      const normalized = raw.map((entry) => normalizeStableValue(entry));
      out[key] = normalized
        .map((item) => ({
          item,
          json: JSON.stringify(item),
        }))
        .sort((left, right) => left.json.localeCompare(right.json))
        .map(({ item }) => item);
      continue;
    }

    out[key] = normalizeStableValue(raw);
  }
  return out;
}

function normalizeStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStableValue(entry));
  }
  if (!isObject(value)) {
    return value;
  }
  return normalizeGoogleMailStableObject(value, { sortMessages: false });
}

function stableRecordId(value: Record<string, unknown>): string {
  for (const key of ["id", "messageId", "threadId"]) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number") return String(raw);
  }
  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

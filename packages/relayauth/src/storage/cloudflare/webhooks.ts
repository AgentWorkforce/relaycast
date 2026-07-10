import type {
  AuditWebhookRecord,
  AuditWebhookStorage,
  CreateAuditWebhookInput,
} from "@relayauth/server/storage/interface";
import type { CloudflareStorageBindings } from "./types.js";

type AuditWebhookStorageBindings = Pick<CloudflareStorageBindings, "DB">;

type AuditWebhookRow = {
  id?: string;
  org_id?: string;
  url?: string;
  secret?: string;
  events_json?: string | null;
  created_at?: string;
  updated_at?: string;
};

/**
 * Manages audit webhook registrations in Cloudflare D1.
 */
export class CloudflareAuditWebhookStorage implements AuditWebhookStorage {
  constructor(private readonly bindings: AuditWebhookStorageBindings) {}

  async create(input: CreateAuditWebhookInput): Promise<AuditWebhookRecord> {
    const timestamp = new Date().toISOString();
    const record: AuditWebhookRecord = {
      id: `awh_${crypto.randomUUID()}`,
      orgId: input.orgId,
      url: input.url,
      secret: input.secret,
      events: input.events ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.bindings.DB
      .prepare(`
        INSERT INTO audit_webhooks (
          id,
          org_id,
          url,
          secret,
          events_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        record.id,
        record.orgId,
        record.url,
        record.secret,
        record.events ? JSON.stringify(record.events) : null,
        record.createdAt,
        record.updatedAt,
      )
      .run();

    return record;
  }

  async list(orgId: string): Promise<AuditWebhookRecord[]> {
    const result = await this.bindings.DB
      .prepare(`
        SELECT id, org_id, url, secret, events_json, created_at, updated_at
        FROM audit_webhooks
        WHERE org_id = ?
        ORDER BY created_at DESC, id DESC
      `)
      .bind(orgId)
      .all<AuditWebhookRow>();

    return (result.results ?? [])
      .map(toAuditWebhookRecord)
      .filter((record): record is AuditWebhookRecord => record !== null);
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.bindings.DB
      .prepare(`
        DELETE FROM audit_webhooks
        WHERE org_id = ? AND id = ?
      `)
      .bind(orgId, id)
      .run();
  }
}

function toAuditWebhookRecord(row: AuditWebhookRow | null): AuditWebhookRecord | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const orgId = normalizeOptionalString(row.org_id);
  const url = normalizeOptionalString(row.url);
  const secret = normalizeOptionalString(row.secret);
  if (!id || !orgId || !url || !secret) {
    return null;
  }

  const events = parseStoredEvents(row.events_json);
  return {
    id,
    orgId,
    url,
    secret,
    events: events ?? [],
    ...(normalizeOptionalString(row.created_at) ? { createdAt: normalizeOptionalString(row.created_at)! } : {}),
    ...(normalizeOptionalString(row.updated_at) ? { updatedAt: normalizeOptionalString(row.updated_at)! } : {}),
  };
}

function parseStoredEvents(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parseStoredEvents(parsed);
  } catch {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

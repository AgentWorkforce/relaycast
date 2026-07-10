import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export type RickyWebhookSurface =
  | "slack"
  | "linear"
  | "gitlab"
  | "daytona"
  | "recall"
  | "webhook-dispatch";

export const RICKY_WEBHOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_INLINE_DELIVERY_ID_LENGTH = 200;

function normalizeDeliveryId(deliveryId: string | null | undefined): string | null {
  const trimmed = deliveryId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function storageDeliveryId(deliveryId: string | null | undefined): Promise<string | null> {
  const normalized = normalizeDeliveryId(deliveryId);
  if (!normalized) return null;
  if (normalized.length <= MAX_INLINE_DELIVERY_ID_LENGTH) {
    return normalized;
  }
  return sha256Hex(normalized);
}

function asClaimedRowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const candidate = result as { rowCount?: unknown; rows?: unknown[] };
  if (typeof candidate.rowCount === "number") return candidate.rowCount;
  if (Array.isArray(candidate.rows)) return candidate.rows.length;
  return 0;
}

function rowsFromResult<T extends Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: unknown[] };
  return Array.isArray(candidate.rows) ? (candidate.rows as T[]) : [];
}

function timestampParam(date: Date): string {
  return date.toISOString();
}

export async function claimWebhookDelivery(input: {
  surface: RickyWebhookSurface;
  deliveryId: string | null | undefined;
  ttlMs?: number;
  now?: Date;
}): Promise<boolean> {
  const deliveryId = await storageDeliveryId(input.deliveryId);
  if (!deliveryId) return true;

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlMs ?? RICKY_WEBHOOK_DEDUP_TTL_MS));
  const claimedAtParam = timestampParam(now);
  const expiresAtParam = timestampParam(expiresAt);
  const db = getDb();

  // Keep claim latency bounded on webhook hot paths. Expired rows for the same
  // delivery are reclaimed below; global GC must run out-of-band so a slow
  // sweep cannot fail-closed dispatch.
  return db.transaction(async (tx) => {
    // Serialize claims for the same surface/delivery without depending on the
    // exact deployed unique-index shape. This keeps retry claims race-safe even
    // if a partially-applied migration left the table constraint drifted.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${input.surface}), hashtext(${deliveryId}))
    `);

    const existing = rowsFromResult<{ expires_at: Date | string }>(
      await tx.execute(sql`
        SELECT expires_at
        FROM ricky_webhook_dedup
        WHERE surface = ${input.surface} AND delivery_id = ${deliveryId}
        ORDER BY expires_at DESC
        LIMIT 1
      `),
    )[0];

    if (existing && new Date(existing.expires_at).getTime() > now.getTime()) {
      return false;
    }

    if (existing) {
      const result = await tx.execute(sql`
        UPDATE ricky_webhook_dedup
        SET claimed_at = ${claimedAtParam}, expires_at = ${expiresAtParam}
        WHERE surface = ${input.surface} AND delivery_id = ${deliveryId}
        RETURNING delivery_id
      `);
      return asClaimedRowCount(result) > 0;
    }

    const result = await tx.execute(sql`
      INSERT INTO ricky_webhook_dedup (surface, delivery_id, claimed_at, expires_at)
      VALUES (${input.surface}, ${deliveryId}, ${claimedAtParam}, ${expiresAtParam})
      RETURNING delivery_id
    `);
    return asClaimedRowCount(result) > 0;
  });
}

export async function releaseWebhookDelivery(input: {
  surface: RickyWebhookSurface;
  deliveryId: string | null | undefined;
}): Promise<void> {
  const deliveryId = await storageDeliveryId(input.deliveryId);
  if (!deliveryId) return;

  await getDb().execute(sql`
    DELETE FROM ricky_webhook_dedup
    WHERE surface = ${input.surface} AND delivery_id = ${deliveryId}
  `);
}

export async function resetWebhookDedupForTests(): Promise<void> {
  await getDb().execute(sql`DELETE FROM ricky_webhook_dedup`);
}

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { OwnerApprovalSchema, type OwnerApproval } from '@relaycast/types';
import type { getDb } from '../db/index.js';
import * as sqlx from '../db/sqlx.js';
import { messages } from '../db/tables.js';

type Db = ReturnType<typeof getDb>;

export type { OwnerApproval };

export const INVALID_OWNER_APPROVAL = 'invalid_owner_approval';

/**
 * Validate an optional `owner_approval` request field (owner-named trusted
 * delegates, wire contract v1). Relaycast only validates and stores it; the
 * recipient's node asks Cloud to attest it and never acts on this content.
 * `undefined` and `null` both mean "none"; any other value must match the v1
 * contract exactly.
 */
export function parseOwnerApproval(
  value: unknown,
): { ok: true; value: OwnerApproval | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const parsed = OwnerApprovalSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `owner_approval.${issue.path.join('.')}` : 'owner_approval';
  return { ok: false, message: `${path}: ${issue?.message ?? 'invalid'}` };
}

/**
 * Whether a message row carries an owner approval, without reading its
 * content. Recipient payloads use this; only the by-message proof route
 * returns the stored object. A function, not a constant: tables are bound to
 * the dialect at runtime (db/tables.ts). Postgres yields a boolean and SQLite
 * 0/1, so the value is normalised to a number.
 */
export function messageHasOwnerApproval() {
  return sql<number>`(${messages.ownerApproval} IS NOT NULL)`.mapWith((value: unknown) => (value === true || Number(value) === 1 ? 1 : 0));
}

/** The recipient-facing flag: `{ has_owner_approval: true }` or nothing. */
export function ownerApprovalFlag(has: unknown): { has_owner_approval?: true } {
  return has ? { has_owner_approval: true } : {};
}

/** What a successful quote redaction answers with. */
export interface OwnerApprovalQuoteRedaction {
  message_id: string;
  quote_redacted_at: string;
  already_redacted: boolean;
}

/**
 * Redact a stored approval's quote (§8): set `quote` to `null` and record
 * `quote_redacted_at`. This is the one change the immutability trigger lets
 * through, and only as exactly this edit, once. A second call answers with the
 * first redaction's time. `null` when the message is absent or has no approval.
 */
export async function redactOwnerApprovalQuote(
  db: Db,
  workspaceId: string,
  messageId: string,
  now = new Date(),
): Promise<OwnerApprovalQuoteRedaction | null> {
  const redactedAt = now.toISOString();
  const target = and(eq(messages.workspaceId, workspaceId), eq(messages.id, messageId), isNotNull(messages.ownerApproval));
  const redacted = sqlx.jsonSet(
    db,
    sqlx.jsonSet(db, messages.ownerApproval, '$.quote', sql`NULL`, 'json'),
    '$.quote_redacted_at',
    sql`${redactedAt}`,
    'text',
  );
  const updated = await db.update(messages)
    .set({ ownerApproval: redacted as unknown as Record<string, unknown> })
    .where(and(target, sql`${sqlx.jsonType(db, messages.ownerApproval, '$.quote_redacted_at')} IS NULL`))
    .returning({ id: messages.id });
  if (updated.length > 0) return { message_id: messageId, quote_redacted_at: redactedAt, already_redacted: false };
  const [row] = await db.select({ ownerApproval: messages.ownerApproval }).from(messages).where(target);
  const previous = (row?.ownerApproval as { quote_redacted_at?: unknown } | null | undefined)?.quote_redacted_at;
  return typeof previous === 'string'
    ? { message_id: messageId, quote_redacted_at: previous, already_redacted: true }
    : null;
}

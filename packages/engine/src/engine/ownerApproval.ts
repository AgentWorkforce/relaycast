import { sql } from 'drizzle-orm';
import { OwnerApprovalSchema, type OwnerApproval } from '@relaycast/types';
import { messages } from '../db/schema.js';

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
 * returns the stored object.
 */
export const messageHasOwnerApproval = sql<number>`(${messages.ownerApproval} IS NOT NULL)`
  .mapWith(Number);

/** The recipient-facing flag: `{ has_owner_approval: true }` or nothing. */
export function ownerApprovalFlag(has: unknown): { has_owner_approval?: true } {
  return has ? { has_owner_approval: true } : {};
}

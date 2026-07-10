import { eq, sql } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { waitlistEntries } from "@/lib/db/schema";
import { normalizeEmail } from "@/lib/auth/access";

// Cookie that lets the /waitlist page recognise a returning visitor and show
// them "you're number X of Y". Not security-sensitive, but it is PII, so keep
// it http-only and read it server-side only.
export const WAITLIST_EMAIL_COOKIE = "agent_relay_waitlist_email";
const WAITLIST_EMAIL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// Vanity inflation for the "#X of Y" counter (confirmed product behaviour):
//   X (your position) = real signup order + 1012
//   Y (total)         = 1012 + (real signups * 20)
// The shared 1012 base guarantees Y always exceeds X.
const POSITION_OFFSET = 1012;
const TOTAL_BASE = 1012;
const TOTAL_PER_SIGNUP = 20;

export type WaitlistStanding = {
  /** Inflated position to display ("you're number X"). */
  position: number;
  /** Inflated total to display ("of Y"). */
  total: number;
};

/** Pure inflation math, separated from the DB lookup so it can be tested. */
export function inflateStanding(realPosition: number, realTotal: number): WaitlistStanding {
  return {
    position: realPosition + POSITION_OFFSET,
    total: TOTAL_BASE + realTotal * TOTAL_PER_SIGNUP,
  };
}

/**
 * Add an email to the waitlist (idempotent). Called when a non-internal email
 * signs in via Google and gets routed to the waitlist.
 */
export async function addToWaitlist(email: string, source: string): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const timestamp = new Date();
  const db = getDb();
  await db
    .insert(waitlistEntries)
    .values({
      email: normalized,
      emailStatus: "unconfirmed",
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing({ target: waitlistEntries.email });
}

/**
 * Compute the inflated "#X of Y" standing for a waitlisted email. Returns null
 * if the email isn't on the waitlist.
 */
export async function getWaitlistStanding(
  email: string | null | undefined,
): Promise<WaitlistStanding | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const db = getDb();

  // Single round trip: look the row up by its PK (email) and compute both the
  // real position (entries that signed up no later than this one) and the real
  // total via correlated subqueries. Both subquery counts are backed by
  // idx_waitlist_entries_created_at / the email PK.
  const [row] = await db
    .select({
      position: sql<number>`(select count(*)::int from waitlist_entries w where w.created_at <= ${waitlistEntries.createdAt})`,
      total: sql<number>`(select count(*)::int from waitlist_entries)`,
    })
    .from(waitlistEntries)
    .where(eq(waitlistEntries.email, normalized))
    .limit(1);
  if (!row) return null;

  return inflateStanding(Number(row.position), Number(row.total));
}

export function setWaitlistEmailCookie(response: NextResponse, email: string): void {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  response.cookies.set(WAITLIST_EMAIL_COOKIE, normalized, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: WAITLIST_EMAIL_COOKIE_MAX_AGE,
  });
}

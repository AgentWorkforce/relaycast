import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { waitlistEntries } from "@/lib/db/schema";

const waitlistRequestSchema = z.object({
  email: z.string().email().max(320).transform((value: string) => value.trim().toLowerCase()),
  source: z.string().trim().max(128).optional().transform((value) => value || null),
});

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = waitlistRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body", details: parsed.error.flatten() }, { status: 400 });
  }

  const { email, source } = parsed.data;
  const timestamp = new Date();
  const db = getDb();

  await db
    .insert(waitlistEntries)
    .values({
      email,
      emailStatus: "unconfirmed",
      source,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing({ target: waitlistEntries.email });

  return NextResponse.json({ message: "Added to waitlist", email });
}


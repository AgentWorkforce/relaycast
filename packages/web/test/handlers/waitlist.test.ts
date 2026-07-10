// @handler /api/waitlist
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  waitlistEntries: {
    email: "waitlist_entries.email",
  },
}));

import { POST } from "../../app/api/waitlist/route";

describe("POST /api/waitlist", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    mocks.getDb.mockReturnValue({ insert });
  });

  it("returns 400 for malformed JSON bodies", async () => {
    const response = await POST(
      new Request("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Invalid request body" });
  });

  it("returns 400 for invalid waitlist payloads", async () => {
    const response = await POST(
      new Request("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bad" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    const body = await response.json() as { error?: string; details?: unknown };
    expect(body.error).toBe("Invalid request body");
    expect(body.details).toBeTruthy();
  });

  it("normalizes the email, upserts idempotently, and returns the accepted body", async () => {
    const response = await POST(
      new Request("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "User@Example.COM", source: "homepage" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      message: "Added to waitlist",
      email: "user@example.com",
    });

    const insert = mocks.getDb.mock.results[0]!.value.insert;
    const values = insert.mock.results[0]!.value.values;
    const onConflictDoNothing = values.mock.results[0]!.value.onConflictDoNothing;

    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        emailStatus: "unconfirmed",
        source: "homepage",
      }),
    );
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: "waitlist_entries.email",
    });
  });
});

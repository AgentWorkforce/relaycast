import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backfillRelayfileWritebackCf: vi.fn(),
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/integrations/relayfile-writeback-dispatch-backfill", () => ({
  backfillRelayfileWritebackCf: mocks.backfillRelayfileWritebackCf,
}));

const ROUTE_URL =
  "https://cloud.test/api/internal/relayfile/writeback/backfill-cf";

const SUMMARY = {
  dryRun: true,
  scanned: 1,
  activated: 1,
  resynced: 0,
  skipped: 0,
  failed: 0,
  results: [],
};

describe("relayfile writeback backfill-cf route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryResourceValue.mockReturnValue("relaycron-key");
    mocks.backfillRelayfileWritebackCf.mockResolvedValue(SUMMARY);
  });

  it("rejects requests without a valid Bearer key", async () => {
    const { POST } = await import("./route");

    const missing = await POST(
      new Request(ROUTE_URL, { method: "POST" }) as never,
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: { authorization: "Bearer nope" },
      }) as never,
    );
    expect(wrong.status).toBe(401);

    expect(mocks.backfillRelayfileWritebackCf).not.toHaveBeenCalled();
  });

  it("defaults to dryRun when no body is supplied", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: { authorization: "Bearer relaycron-key" },
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: SUMMARY });
    expect(mocks.backfillRelayfileWritebackCf).toHaveBeenCalledWith({
      dryRun: true,
    });
  });

  it("rejects apply mode without the typed confirmation and does not call the engine", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ dryRun: false }),
      }) as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
    expect(mocks.backfillRelayfileWritebackCf).not.toHaveBeenCalled();
  });

  it("runs apply mode with the typed confirmation", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          dryRun: false,
          confirm: "flip-writeback-bridge-to-cf",
          provider: "linear",
          workspaceId: "rw_test",
          limit: 5,
          timeoutMs: 10_000,
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.backfillRelayfileWritebackCf).toHaveBeenCalledWith({
      dryRun: false,
      provider: "linear",
      workspaceId: "rw_test",
      limit: 5,
      timeoutMs: 10_000,
    });
  });

  it("accepts stringified positive integer options from external callers", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new Request(ROUTE_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer relaycron-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          dryRun: true,
          limit: "5",
          timeoutMs: "10000",
        }),
      }) as never,
    );

    expect(response.status).toBe(200);
    expect(mocks.backfillRelayfileWritebackCf).toHaveBeenCalledWith({
      dryRun: true,
      limit: 5,
      timeoutMs: 10_000,
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkDaytonaConnected,
  fetchDaytonaStatus,
  isCliCapturedProvider,
  isDaytonaConnectedStatus,
} from "./daytona-status-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isCliCapturedProvider", () => {
  it("matches daytona and nothing else", () => {
    expect(isCliCapturedProvider("daytona")).toBe(true);
    expect(isCliCapturedProvider("slack")).toBe(false);
    expect(isCliCapturedProvider("github")).toBe(false);
  });
});

describe("isDaytonaConnectedStatus", () => {
  it("treats the cloud connected payload as connected", () => {
    expect(
      isDaytonaConnectedStatus({ ready: true, state: "ready", oauth: { connected: true } }),
    ).toBe(true);
  });

  it("accepts oauth.connected even before sync readiness", () => {
    expect(
      isDaytonaConnectedStatus({ ready: false, state: "pending", oauth: { connected: true } }),
    ).toBe(true);
  });

  it("treats the pending payload (no stored credential yet) as not connected", () => {
    expect(
      isDaytonaConnectedStatus({ ready: false, state: "pending", oauth: { connected: false } }),
    ).toBe(false);
  });

  it("rejects a connectionMatched:false poll", () => {
    expect(
      isDaytonaConnectedStatus({ ready: true, connectionMatched: false, oauth: { connected: true } }),
    ).toBe(false);
  });

  it("rejects non-object payloads", () => {
    expect(isDaytonaConnectedStatus(null)).toBe(false);
    expect(isDaytonaConnectedStatus("ready")).toBe(false);
    expect(isDaytonaConnectedStatus([{ ready: true }])).toBe(false);
  });
});

describe("fetchDaytonaStatus / checkDaytonaConnected", () => {
  it("polls the workspace-scoped daytona status route with scope=deployer_user", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ready: true, state: "ready", oauth: { connected: true } }), {
          status: 200,
        }),
      );

    const connected = await checkDaytonaConnected("rw_123");
    expect(connected).toBe(true);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/workspaces/rw_123/integrations/daytona/status");
    expect(url).toContain("scope=deployer_user");
  });

  it("returns false when the credential has not landed yet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ready: false, state: "pending", oauth: { connected: false } }), {
        status: 200,
      }),
    );
    expect(await checkDaytonaConnected("rw_123")).toBe(false);
  });

  it("throws when the status route errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(fetchDaytonaStatus("rw_123")).rejects.toThrow(/Daytona connection status/);
  });
});

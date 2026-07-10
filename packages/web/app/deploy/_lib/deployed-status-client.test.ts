import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAlreadyDeployedAgents,
  filterDeployedMatches,
  formatDeployedRelative,
} from "./deployed-status-client";

function agentEntry(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-1",
    personaId: null,
    deployedName: "hn-monitor",
    status: "ready",
    createdAt: "2026-06-03T10:00:00.000Z",
    lastUsedAt: null,
    lastFiredAt: "2026-06-03T17:00:00.000Z",
    runCount: 3,
    scheduleIds: [],
    inputValues: {},
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchAlreadyDeployedAgents", () => {
  it("queries the workspace deployments list by personaId and returns matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agents: [agentEntry()], nextCursor: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const matches = await fetchAlreadyDeployedAgents("rw_12345678", "hn-monitor");

    expect(matches).toHaveLength(1);
    expect(matches?.[0]).toMatchObject({ agentId: "agent-1", deployedName: "hn-monitor" });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/v1/workspaces/rw_12345678/deployments");
    expect(url).toContain("personaId=hn-monitor");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include", cache: "no-store" });
  });

  it("returns [] when the lookup succeeds and nothing matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agents: [], nextCursor: null }) }),
    );
    expect(await fetchAlreadyDeployedAgents("rw_12345678", "hn-monitor")).toEqual([]);
  });

  it("returns null (no banner, never an error) on non-ok responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await fetchAlreadyDeployedAgents("rw_12345678", "hn-monitor")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchAlreadyDeployedAgents("rw_12345678", "hn-monitor")).toBeNull();
  });

  it("returns null on a malformed payload wrapper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) }),
    );
    expect(await fetchAlreadyDeployedAgents("rw_12345678", "hn-monitor")).toBeNull();
  });

  it("returns null without fetching when inputs are empty", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchAlreadyDeployedAgents("", "hn-monitor")).toBeNull();
    expect(await fetchAlreadyDeployedAgents("rw_12345678", "")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("filterDeployedMatches", () => {
  it("matches by deployedName and excludes destroyed rows", () => {
    const matches = filterDeployedMatches(
      [
        agentEntry(),
        agentEntry({ agentId: "agent-2", status: "destroyed" }),
        agentEntry({ agentId: "agent-3", deployedName: "other-persona" }),
        agentEntry({ agentId: "agent-4", status: "starting" }),
      ],
      "hn-monitor",
    );
    expect(matches.map((m) => m.agentId)).toEqual(["agent-1", "agent-4"]);
  });

  it("drops malformed entries instead of throwing", () => {
    const matches = filterDeployedMatches(
      [null, 42, "x", { agentId: "agent-9" }, agentEntry()],
      "hn-monitor",
    );
    expect(matches.map((m) => m.agentId)).toEqual(["agent-1"]);
  });
});

describe("formatDeployedRelative", () => {
  it("renders compact relative buckets", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T18:00:00.000Z"));

    expect(formatDeployedRelative("2026-06-03T17:59:50.000Z")).toBe("just now");
    expect(formatDeployedRelative("2026-06-03T17:35:00.000Z")).toBe("25m ago");
    expect(formatDeployedRelative("2026-06-03T13:00:00.000Z")).toBe("5h ago");
    expect(formatDeployedRelative("2026-05-31T18:00:00.000Z")).toBe("3d ago");
    expect(formatDeployedRelative("not-a-date")).toBe("earlier");
  });
});

import { describe, expect, it } from "vitest";
import { getAgentsOverviewRenderState } from "./AgentsOverview";

describe("getAgentsOverviewRenderState", () => {
  it("shows loading before empty results while agents are still being fetched", () => {
    expect(getAgentsOverviewRenderState({
      loading: true,
      error: null,
      agentCount: 0,
    })).toBe("loading");
  });

  it("shows the empty state only after loading completes with no agents", () => {
    expect(getAgentsOverviewRenderState({
      loading: false,
      error: null,
      agentCount: 0,
    })).toBe("empty");
  });

  it("shows ready once agents are available", () => {
    expect(getAgentsOverviewRenderState({
      loading: false,
      error: null,
      agentCount: 2,
    })).toBe("ready");
  });

  it("shows error when an error is present and loading is complete", () => {
    expect(getAgentsOverviewRenderState({
      loading: false,
      error: "Failed to load",
      agentCount: 0,
    })).toBe("error");
  });

  it("prioritizes loading over error state", () => {
    expect(getAgentsOverviewRenderState({
      loading: true,
      error: "Failed to load",
      agentCount: 0,
    })).toBe("loading");
  });
});

import { describe, expect, it } from "vitest";

import {
  isAllowedSlackProxyRoute,
  slackProxyRequestSchema,
} from "../packages/web/lib/integrations/slack-proxy-schema";

const VALID_UUID = "11111111-1111-4111-8111-111111111111";
const VALID_RELAY_WORKSPACE_ID = "rw_517d60b6";
const VALID_SLACK_TEAM_ID = "T024BE91L";
const VALID_BODY_BASE = {
  endpoint: "/chat.postMessage",
  method: "POST" as const,
};

describe("slackProxyRequestSchema — workspaceId shape", () => {
  it("accepts a UUID workspaceId", () => {
    const result = slackProxyRequestSchema.safeParse({
      ...VALID_BODY_BASE,
      workspaceId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  // The whole point of PR #488: cloud's productized workspace registry
  // mints rw_<8hex> ids and stores them in workspace_integrations. The
  // resolver was loosened to accept them, but the Zod schema runs first
  // in route.ts:449 — so without this also accepting rw_, sage's second
  // proxy call (with the cached rw_ id) gets rejected as "Invalid request
  // body" before the resolver ever sees it.
  it("accepts a productized rw_<8hex> workspaceId", () => {
    const result = slackProxyRequestSchema.safeParse({
      ...VALID_BODY_BASE,
      workspaceId: VALID_RELAY_WORKSPACE_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID, non-rw_ workspaceId", () => {
    const result = slackProxyRequestSchema.safeParse({
      ...VALID_BODY_BASE,
      workspaceId: "not-a-workspace-id",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (entry) => entry.path[0] === "workspaceId",
      );
      expect(issue?.message).toContain("rw_");
    }
  });

  it("rejects an rw_ id with non-hex characters", () => {
    const result = slackProxyRequestSchema.safeParse({
      ...VALID_BODY_BASE,
      workspaceId: "rw_zzzzzzzz",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a slackTeamId without a workspaceId", () => {
    const result = slackProxyRequestSchema.safeParse({
      ...VALID_BODY_BASE,
      slackTeamId: VALID_SLACK_TEAM_ID,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a body with neither workspaceId nor slackTeamId", () => {
    const result = slackProxyRequestSchema.safeParse({ ...VALID_BODY_BASE });
    expect(result.success).toBe(true);
  });
});

describe("Slack proxy streaming routes", () => {
  it("allows Slack native streaming progress endpoints", () => {
    expect(isAllowedSlackProxyRoute("/chat.startStream", "POST")).toBe(true);
    expect(isAllowedSlackProxyRoute("/chat.appendStream", "POST")).toBe(true);
    expect(isAllowedSlackProxyRoute("/chat.stopStream", "POST")).toBe(true);
  });
});

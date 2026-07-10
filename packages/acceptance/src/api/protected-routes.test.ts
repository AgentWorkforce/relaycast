// @route GET /api/internal/cataloging/workspaces/[provider]
// @route POST /api/internal/relayfile/writeback
// @route POST /api/internal/relayfile/writeback/backfill-cf
// @route POST /api/internal/proactive-runtime/integration-watch-deliveries/sweep
// @route POST /api/internal/proactive-runtime/integration-watch-deliveries/drain
// @route POST /api/internal/proactive-runtime/deployment-tick-deliveries/sweep
// @route POST /api/internal/proactive-runtime/pr-sandbox/drain
// @route POST /api/internal/proactive-runtime/sandbox-reaper
// @route POST /api/internal/cloud-agent-box/keepalive-reaper
// @route POST /api/internal/proactive-runtime/vfs-watch/candidates
// @route POST /api/internal/proactive-runtime/vfs-watch/deliver
// @route POST /api/internal/proactive-runtime/inbox/candidates
// @route POST /api/internal/proactive-runtime/inbox/deliver
// @route POST /api/v1/credentials/refresh
// @route POST /api/v1/slack/post-message
// @route POST /api/v1/slack/relay-bridge
import { z } from "zod";
import { describe, expect, it } from "vitest";

import { request } from "../../helpers/server";
import { requestApi } from "../helpers/runtime";

const errorSchema = z.object({
  error: z.string().min(1),
}).passthrough();

const slackUnauthorizedSchema = z.object({
  ok: z.literal(false),
  code: z.literal("unauthorized"),
  error: z.string().min(1),
}).passthrough();

const RUNNING_AGAINST_PROD =
  process.env.ACCEPTANCE_BASE_URL?.replace(/\/+$/, "") ===
  "https://agentrelay.com/cloud";

async function expectJsonUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("content-type")).toContain("application/json");
  errorSchema.parse(await response.json());
}

async function expectJsonUnauthorizedOrProdNotFound(response: Response): Promise<void> {
  expect(RUNNING_AGAINST_PROD ? [401, 404] : [401]).toContain(response.status);
  if (response.status === 401) {
    expect(response.headers.get("content-type")).toContain("application/json");
    errorSchema.parse(await response.json());
  }
}

describe("protected API route contracts", () => {
  it("GET /api/internal/cataloging/workspaces/[provider] rejects unauthenticated requests", async () => {
    const response = await request("GET", "/api/internal/cataloging/workspaces/github");

    await expectJsonUnauthorized(response);
  });

  it("POST /api/internal/relayfile/writeback rejects unsigned requests", async () => {
    const response = await request("POST", "/api/internal/relayfile/writeback", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    await expectJsonUnauthorized(response);
  });

  it("POST /api/internal/relayfile/writeback/backfill-cf rejects unsigned requests", async () => {
    const response = await request("POST", "/api/internal/relayfile/writeback/backfill-cf", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/vfs-watch/candidates rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/vfs-watch/candidates", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_acceptance" }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/vfs-watch/deliver rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/vfs-watch/deliver", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_acceptance",
        agentId: "agent_acceptance",
        payload: {},
      }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/inbox/candidates rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/inbox/candidates", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws_acceptance", selector: "general" }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/inbox/deliver rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/inbox/deliver", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ws_acceptance",
        agentId: "agent_acceptance",
        payload: {},
      }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/integration-watch-deliveries/sweep rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/integration-watch-deliveries/sweep", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/integration-watch-deliveries/drain rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/integration-watch-deliveries/drain", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws", agentId: "agent", deliveryId: "delivery" }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/deployment-tick-deliveries/sweep rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/deployment-tick-deliveries/sweep", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/pr-sandbox/drain rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/pr-sandbox/drain", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clearLeases: true }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/proactive-runtime/sandbox-reaper rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/proactive-runtime/sandbox-reaper", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ minAgeHours: 4 }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/internal/cloud-agent-box/keepalive-reaper rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/internal/cloud-agent-box/keepalive-reaper", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1 }),
    });

    await expectJsonUnauthorizedOrProdNotFound(response);
  });

  it("POST /api/v1/credentials/refresh rejects unauthenticated requests", async () => {
    const response = await request("POST", "/api/v1/credentials/refresh", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        credentials: { apiKey: "sk-test" },
      }),
    });

    await expectJsonUnauthorized(response);
  });

  it("POST /api/v1/slack/post-message rejects unauthenticated requests", async () => {
    const response = await requestApi("/api/v1/slack/post-message", {
      method: "POST",
      json: {
        channel: "C12345678",
        text: "acceptance smoke",
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    slackUnauthorizedSchema.parse(await response.json());
  });

  it("POST /api/v1/slack/relay-bridge rejects unauthenticated requests", async () => {
    const response = await requestApi("/api/v1/slack/relay-bridge", {
      method: "POST",
      json: {
        workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        slackChannelId: "C12345678",
        relayChannelId: "engineering",
      },
    });

    expect(RUNNING_AGAINST_PROD ? [401, 404] : [401]).toContain(response.status);
    if (response.status === 401) {
      expect(response.headers.get("content-type")).toContain("application/json");
      errorSchema.parse(await response.json());
    }
  });
});

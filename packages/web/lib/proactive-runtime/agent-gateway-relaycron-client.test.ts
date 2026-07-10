import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listCronSchedules,
  registerCronSchedules,
  resolveAgentGatewayRelaycronEnv,
} from "./agent-gateway-relaycron-client";

const mocks = vi.hoisted(() => ({
  tryResourceValue: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

describe("cloud relaycron client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not require legacy agent-gateway env when resolving relaycron config", () => {
    mocks.tryResourceValue.mockReturnValue(undefined);
    vi.stubEnv("RELAYCRON_URL", " https://relaycron.test/base ");
    vi.stubEnv("RELAYCRON_API_KEY", " relaycron-key ");
    vi.stubEnv("AGENT_GATEWAY_BASE_URL", "");
    vi.stubEnv("AGENT_GATEWAY_INTERNAL_SECRET", "");

    expect(resolveAgentGatewayRelaycronEnv("https://cloud.test")).toEqual({
      RELAYCRON_URL: "https://relaycron.test/base",
      RELAYCRON_API_KEY: "relaycron-key",
    });
  });

  it("prefers the SST RelaycronApiKey secret over process env", () => {
    mocks.tryResourceValue.mockReturnValue("resource-relaycron-key");
    vi.stubEnv("RELAYCRON_API_KEY", "env-relaycron-key");

    expect(resolveAgentGatewayRelaycronEnv()).toMatchObject({
      RELAYCRON_API_KEY: "resource-relaycron-key",
    });
  });

  it("fails fast when the cloud-wide relaycron key is not configured", () => {
    mocks.tryResourceValue.mockReturnValue(undefined);
    vi.stubEnv("RELAYCRON_API_KEY", "");

    expect(() => resolveAgentGatewayRelaycronEnv()).toThrow(
      "RELAYCRON_API_KEY is required to manage persona schedules",
    );
  });

  it("registers persona schedules directly against cloud tick webhooks", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true, data: { id: "relaycron_sched_1" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await registerCronSchedules(
      { RELAYCRON_URL: "https://relaycron.test", RELAYCRON_API_KEY: "relaycron-key" },
      {
        workspace: "workspace-1",
        agentId: "agent-1",
        schedules: [{ cron: "0 9 * * *", tz: "Europe/Oslo" }],
        webhookSecret: "deployment-webhook-secret",
        cloudBaseUrl: "https://cloud.test/cloud",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://relaycron.test/v1/schedules");
    expect(init.headers).toEqual({
      authorization: "Bearer relaycron-key",
      "content-type": "application/json",
    });

    const body = JSON.parse(String(init.body)) as {
      schedule: { cron: string; tz: string };
      payload: Record<string, unknown>;
      delivery: { url: string; headers: Record<string, string> };
      metadata: { source: string };
    };
    expect(body.schedule).toEqual({ cron: "0 9 * * *", tz: "Europe/Oslo" });
    expect(body.payload).toMatchObject({
      workspace: "workspace-1",
      agentId: "agent-1",
      scheduleId: expect.any(String),
      gatewayScheduleId: expect.any(String),
      schedule: "0 9 * * *",
      scheduledFor: null,
    });
    expect(body.payload.scheduleId).toBe(body.payload.gatewayScheduleId);
    const deliveryUrl = new URL(body.delivery.url);
    expect(deliveryUrl.origin + deliveryUrl.pathname).toBe(
      "https://cloud.test/cloud/api/v1/workspaces/workspace-1/deployments/agent-1/ticks",
    );
    expect(deliveryUrl.searchParams.get("deployment_token")).toBe(
      "deployment-webhook-secret",
    );
    expect(body.delivery.headers).toEqual({
      "x-cloud-agent-deployment-token": "deployment-webhook-secret",
      "x-agentrelay-deployment-token": "deployment-webhook-secret",
    });
    expect(body.metadata.source).toBe("cloud");
  });

  it("updates existing relaycron schedules instead of minting replacement ids", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true, data: { id: "relaycron_sched_existing" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const registrations = await registerCronSchedules(
      { RELAYCRON_URL: "https://relaycron.test", RELAYCRON_API_KEY: "relaycron-key" },
      {
        workspace: "workspace-1",
        agentId: "agent-1",
        schedules: [{ cron: "*/5 * * * *", tz: "UTC" }],
        webhookSecret: "rotated-deployment-webhook-secret",
        cloudBaseUrl: "https://cloud.test",
        existingRelaycronScheduleIds: ["relaycron_sched_existing"],
      },
    );

    expect(registrations).toMatchObject([
      {
        relaycronScheduleId: "relaycron_sched_existing",
        gatewayScheduleId: "relaycron_sched_existing",
        created: false,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://relaycron.test/v1/schedules/relaycron_sched_existing");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as {
      cron_expression: string;
      timezone: string;
      payload: Record<string, unknown>;
      transport: { url: string; headers: Record<string, string> };
    };
    expect(body.cron_expression).toBe("*/5 * * * *");
    expect(body.timezone).toBe("UTC");
    expect(body.payload.scheduleId).toBe("relaycron_sched_existing");
    expect(body.transport.headers["x-cloud-agent-deployment-token"]).toBe(
      "rotated-deployment-webhook-secret",
    );
  });

  it("paginates relaycron schedule listings at the API maximum page size", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: [{ id: "relaycron_sched_1", status: "active", metadata: { source: "cloud" } }],
          cursor: "cursor-1",
          has_more: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: [{ id: "relaycron_sched_2", status: "active", metadata: null }],
          cursor: null,
          has_more: false,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listCronSchedules(
        { RELAYCRON_URL: "https://relaycron.test", RELAYCRON_API_KEY: "relaycron-key" },
        { status: "active" },
      ),
    ).resolves.toEqual([
      { id: "relaycron_sched_1", status: "active", metadata: { source: "cloud" } },
      { id: "relaycron_sched_2", status: "active", metadata: null },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://relaycron.test/v1/schedules?limit=100&status=active",
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://relaycron.test/v1/schedules?limit=100&status=active&cursor=cursor-1",
    );
  });

  it("filters paginated relaycron listings client-side without skipping later pages", async () => {
    const scannedPages: Array<{ count: number; cursor: string | null | undefined }> = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: [
            {
              id: "relaycron_sched_sibling",
              status: "active",
              metadata: { source: "cloud", workspace: "workspace-1", agentId: "agent-other" },
            },
          ],
          cursor: "cursor-1",
          has_more: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: [
            {
              id: "relaycron_sched_match",
              status: "active",
              metadata: { source: "cloud", workspace: "workspace-1", agentId: "agent-1" },
            },
            {
              id: "relaycron_sched_other_workspace",
              status: "active",
              metadata: { source: "cloud", workspace: "workspace-2", agentId: "agent-1" },
            },
            { id: "relaycron_sched_legacy_unknown", status: "active", metadata: null },
          ],
          cursor: null,
          has_more: false,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listCronSchedules(
        { RELAYCRON_URL: "https://relaycron.test", RELAYCRON_API_KEY: "relaycron-key" },
        {
          status: "active",
          filter: (schedule) =>
            schedule.metadata?.source === "cloud" &&
            schedule.metadata.workspace === "workspace-1" &&
            schedule.metadata.agentId === "agent-1",
          onPage: (page) => scannedPages.push(page),
        },
      ),
    ).resolves.toEqual([
      {
        id: "relaycron_sched_match",
        status: "active",
        metadata: { source: "cloud", workspace: "workspace-1", agentId: "agent-1" },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(scannedPages).toEqual([
      { count: 1, cursor: undefined },
      { count: 3, cursor: "cursor-1" },
    ]);
  });
});

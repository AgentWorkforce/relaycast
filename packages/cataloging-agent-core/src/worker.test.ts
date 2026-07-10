import { RelayFileApiError } from "@relayfile/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogingContext } from "./context.js";
import {
  createCloudWorkspaceList,
  type CatalogingAgentConfig,
  type CatalogingWorkerEnv,
} from "./config.js";
import type { InsightGenerator } from "./insight.js";
import { writeInsight } from "./insight.js";
import { buildCatalogingWorker } from "./worker.js";

describe("writeInsight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a stable Relayfile content identity to writeFile", async () => {
    const { input } = await writeTestInsight({ total: 2 });

    expect(input.contentIdentity).toEqual({
      kind: "insight",
      key: "linear:open-issues:workspace_123",
    });
  });

  it("passes serialized JSON as writeFile content", async () => {
    const generated = {
      total: 2,
      byAssignee: {
        alice: 1,
        bob: 1,
      },
    };
    const { input } = await writeTestInsight(generated);

    expect(input.content).toBe(`${JSON.stringify(generated, null, 2)}\n`);
  });
});

describe("createCloudWorkspaceList", () => {
  it("fetches the internal cloud route with the cataloging service token", async () => {
    const fetcher = vi.fn(async (_input: URL, _init?: RequestInit) =>
      Response.json({
        provider: "github",
        workspaces: ["workspace_123", "workspace_456"],
      }),
    );
    const workspaceList = createCloudWorkspaceList<CatalogingWorkerEnv>({
      provider: "github",
      fetcher: fetcher as unknown as typeof fetch,
    });

    await expect(
      workspaceList({
        CLOUD_API_URL: "https://agentrelay.com/cloud",
        CATALOGING_CLOUD_API_TOKEN: "cataloging-token",
      }),
    ).resolves.toEqual(["workspace_123", "workspace_456"]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [[url, init]] = fetcher.mock.calls as Array<[URL, RequestInit]>;
    expect(url.toString()).toBe(
      "https://agentrelay.com/cloud/api/internal/cataloging/workspaces/github",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer cataloging-token");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("fails loudly when the cloud response shape is invalid", async () => {
    const workspaceList = createCloudWorkspaceList<CatalogingWorkerEnv>({
      provider: "github",
      fetcher: vi.fn(async () =>
        Response.json({
          provider: "linear",
          workspaces: ["workspace_123"],
        }),
      ) as unknown as typeof fetch,
    });

    await expect(
      workspaceList({
        CLOUD_API_URL: "https://agentrelay.com/cloud",
        CATALOGING_CLOUD_API_TOKEN: "cataloging-token",
      }),
    ).rejects.toThrow("response provider mismatch");
  });
});

describe("buildCatalogingWorker", () => {
  it("exposes GET /health", async () => {
    const app = buildCatalogingWorker(createConfig());

    const response = await app.request("/health", {}, {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("POST /run/:insightId with a valid id calls through to the subscriber Durable Object", async () => {
    const namespace = createNamespace();
    const app = buildCatalogingWorker(createConfig(namespace));

    const response = await app.request(
      "/run/open-issues?workspaceId=workspace_123",
      { method: "POST" },
      { RELAYFILE_TOKEN: "relayfile-token" },
    );

    expect(response.status).toBe(202);
    expect(namespace.idFromName).toHaveBeenCalledWith("linear:workspace_123");
    expect(namespace.stub.fetch).toHaveBeenCalledTimes(1);
    const [[request]] = namespace.stub.fetch.mock.calls as Array<[Request]>;
    expect(new URL(request.url).pathname).toBe("/run/open-issues");
    expect(request.headers.get("x-workspace-id")).toBe("workspace_123");
    await expect(request.json()).resolves.toEqual({
      workspaceId: "workspace_123",
      domain: "linear",
      relayfileUrl: "https://relayfile.test",
    });
  });

  it("POST /run/:insightId with an unknown id returns 404 without calling the Durable Object", async () => {
    const namespace = createNamespace();
    const app = buildCatalogingWorker(createConfig(namespace));

    const response = await app.request(
      "/run/missing?workspaceId=workspace_123",
      { method: "POST" },
      { RELAYFILE_TOKEN: "relayfile-token" },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "unknown insight",
      insightId: "missing",
    });
    expect(namespace.stub.fetch).not.toHaveBeenCalled();
  });

  it("POST /ensure-subscriptions iterates the dynamic workspace list and ignores CATALOG_WORKSPACES", async () => {
    const namespace = createNamespace();
    const workspaceList = vi.fn(async () => ["workspace_123", "workspace_456"]);
    const app = buildCatalogingWorker(
      createConfig(namespace, {
        workspaceList,
      }),
    );

    const response = await app.request(
      "/ensure-subscriptions",
      { method: "POST" },
      {
        CATALOG_WORKSPACES: "workspace_static",
        RELAYFILE_TOKEN: "relayfile-token",
      },
    );

    expect(response.status).toBe(200);
    expect(workspaceList).toHaveBeenCalledTimes(1);
    expect(namespace.idFromName).toHaveBeenCalledWith("linear:workspace_123");
    expect(namespace.idFromName).toHaveBeenCalledWith("linear:workspace_456");
    expect(namespace.idFromName).not.toHaveBeenCalledWith("linear:workspace_static");
    expect(namespace.stub.fetch).toHaveBeenCalledTimes(2);
    const requests = (namespace.stub.fetch.mock.calls as Array<[Request]>).map(([request]) => request);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/subscribe", "/subscribe"]);
    await expect(Promise.all(requests.map((request) => request.json()))).resolves.toEqual([
      {
        workspaceId: "workspace_123",
        domain: "linear",
        relayfileUrl: "https://relayfile.test",
      },
      {
        workspaceId: "workspace_456",
        domain: "linear",
        relayfileUrl: "https://relayfile.test",
      },
    ]);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      domain: "linear",
      subscribed: 2,
    });
  });

  it("GET /status forwards to the workspace subscriber", async () => {
    const namespace = createNamespace();
    const app = buildCatalogingWorker(createConfig(namespace));

    const response = await app.request(
      "/status?workspaceId=workspace_123",
      { method: "GET" },
      { RELAYFILE_TOKEN: "relayfile-token" },
    );

    expect(response.status).toBe(202);
    expect(namespace.idFromName).toHaveBeenCalledWith("linear:workspace_123");
    const [[request]] = namespace.stub.fetch.mock.calls as Array<[Request]>;
    expect(new URL(request.url).pathname).toBe("/status");
  });

  it("returns a JSON error when workspace discovery fails", async () => {
    const app = buildCatalogingWorker(
      createConfig(createNamespace(), {
        workspaceList: async () => {
          throw new Error("discovery exploded");
        },
      }),
    );

    const response = await app.request(
      "/cron",
      { method: "POST" },
      { RELAYFILE_TOKEN: "relayfile-token" },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      status: "error",
      domain: "linear",
      error: "discovery exploded",
    });
  });
});

function createConfig(
  namespace = createNamespace(),
  options: {
    workspaceList?: CatalogingAgentConfig<CatalogingWorkerEnv>["workspaceList"];
  } = {},
): CatalogingAgentConfig<CatalogingWorkerEnv> {
  return {
    domain: "linear",
    insights: [createInsight("open-issues")],
    workspaceList: options.workspaceList,
    relayfileUrl: "https://relayfile.test",
    subscriberNamespace: () => namespace as unknown as DurableObjectNamespace,
  };
}

function createInsight(id: string): InsightGenerator<CatalogingWorkerEnv> {
  return {
    id,
    outputPath: `/insights/${id}.json`,
    triggerPaths: ["/linear/issues"],
    intervalSeconds: 60,
    debounceMs: 250,
    generate: async () => ({ ok: true }),
  };
}

async function writeTestInsight(generated: Record<string, unknown>) {
  const readFile = vi.fn(async (..._args: unknown[]) => {
    throw new RelayFileApiError(404, { message: "not found" });
  });
  const writeFile = vi.fn(async (_input: Record<string, unknown>) => ({
    opId: "op_1",
    status: "queued" as const,
    targetRevision: "1",
  }));
  const context = {
    workspaceId: "workspace_123",
    domain: "linear",
    relayfile: { readFile, writeFile },
    relayfileUrl: "https://relayfile.test",
    relayfileToken: "relayfile-token",
    env: {},
    now: new Date(),
  } as unknown as CatalogingContext<Record<string, never>>;

  await writeInsight(context, createInsight("open-issues"), generated);

  expect(writeFile).toHaveBeenCalledTimes(1);
  const [[input]] = writeFile.mock.calls as Array<[Record<string, unknown>]>;
  return { input, readFile, writeFile };
}

function createNamespace() {
  const stub = {
    fetch: vi.fn(async (_request: Request) =>
      Response.json(
        {
          status: "accepted",
        },
        { status: 202 },
      ),
    ),
  };
  return {
    stub,
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
  };
}

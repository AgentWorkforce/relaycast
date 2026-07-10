import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daytona } from "@daytonaio/sdk";
import axios from "axios";

import {
  configureDaytonaFetchFirstAdapter,
  preferFetchAdapterForAxiosInstance,
} from "@/lib/daytona-fetch-adapter";
import { createDeploymentSandboxRuntime } from "./sandbox-runtime";

describe("createDeploymentSandboxRuntime", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("forces Daytona Axios clients onto the concrete fetch adapter", () => {
    const instance = {
      defaults: {
        adapter: ["xhr", "http", "fetch"],
      },
    };

    preferFetchAdapterForAxiosInstance(instance);

    expect(instance.defaults.adapter).toBe(axios.getAdapter("fetch"));
  });

  it("leaves unknown custom Daytona Axios adapters untouched", () => {
    const adapter = () => Promise.resolve(new Response());
    const instance = {
      defaults: {
        adapter,
      },
    };

    preferFetchAdapterForAxiosInstance(instance);

    expect(instance.defaults.adapter).toBe(adapter);
  });

  it("patches the installed Daytona SDK Axios factory", () => {
    configureDaytonaFetchFirstAdapter();

    const instance = Daytona.createAxiosInstance();

    expect(instance.defaults.adapter).toBe(axios.getAdapter("fetch"));
    expect(axios.defaults.adapter).toBe(axios.getAdapter("fetch"));
  });

  it("routes local sandbox operations through LOCAL_SANDBOX_URL", async () => {
    process.env.SANDBOX_PROVIDER = "local";
    process.env.LOCAL_SANDBOX_URL = "http://127.0.0.1:3001/";

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = url instanceof URL ? url.href : String(url);
      calls.push({ url: href, init });
      if (href.endsWith("/sandboxes") && init?.method === "POST") {
        return Response.json({ sandboxId: "local-1", homeDir: "/home/local" });
      }
      if (href.endsWith("/sandboxes/local-1/files")) {
        return Response.json({ uploaded: 1 });
      }
      if (href.endsWith("/sandboxes/local-1/exec")) {
        return Response.json({ output: "ok", exitCode: 0 });
      }
      if (href.includes("/sandboxes?")) {
        return Response.json({
          items: [{ sandboxId: "local-existing", status: "running", homeDir: "/home/local" }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const runtime = createDeploymentSandboxRuntime();
    expect(runtime.id).toBe("local");
    await expect(runtime.findByLabels({ agentId: "agent-1" })).resolves.toMatchObject({
      id: "local-existing",
      homeDir: "/home/local",
    });

    const handle = await runtime.launch({
      name: "agent",
      env: { A: "B" },
      labels: { agentId: "agent-1" },
      createTimeoutSeconds: 120,
    });
    await runtime.uploadBundle(handle, {
      files: [{ source: Buffer.from("runner"), destination: "/workspace/runner.mjs" }],
    });
    await expect(runtime.runScript(handle, {
      command: "node runner.mjs",
      timeoutMs: 120_000,
    })).resolves.toEqual({ output: "ok", exitCode: 0 });

    expect(calls.map((call) => [call.url, call.init?.method ?? "GET"])).toEqual([
      [expect.stringContaining("/sandboxes?"), "GET"],
      ["http://127.0.0.1:3001/sandboxes", "POST"],
      ["http://127.0.0.1:3001/sandboxes/local-1/files", "PUT"],
      ["http://127.0.0.1:3001/sandboxes/local-1/exec", "POST"],
    ]);
  });

  it("follows local sandbox cursor pagination for findAllByLabels", async () => {
    process.env.SANDBOX_PROVIDER = "local";
    process.env.LOCAL_SANDBOX_URL = "http://127.0.0.1:3001/";

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = url instanceof URL ? url.href : String(url);
      calls.push(href);
      const parsed = new URL(href);
      if (parsed.searchParams.get("cursor") === "cursor-2") {
        return Response.json({
          items: [{ sandboxId: "local-2", status: "running", homeDir: "/home/local" }],
        });
      }
      return Response.json({
        items: [{ sandboxId: "local-1", status: "running", homeDir: "/home/local" }],
        nextCursor: "cursor-2",
      });
    }) as typeof fetch;

    const runtime = createDeploymentSandboxRuntime();
    await expect(runtime.findAllByLabels({ agentId: "agent-1" }, { limit: 1 })).resolves.toEqual([
      { id: "local-1", state: "running", homeDir: "/home/local" },
      { id: "local-2", state: "running", homeDir: "/home/local" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("limit=1");
    expect(calls[1]).toContain("cursor=cursor-2");
  });

  it("stops local sandbox pagination when a cursor repeats", async () => {
    process.env.SANDBOX_PROVIDER = "local";
    process.env.LOCAL_SANDBOX_URL = "http://127.0.0.1:3001/";

    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = url instanceof URL ? url.href : String(url);
      calls.push(href);
      return Response.json({
        items: [{ sandboxId: `local-${calls.length}`, status: "running", homeDir: "/home/local" }],
        nextCursor: "same-cursor",
      });
    }) as typeof fetch;

    const runtime = createDeploymentSandboxRuntime();
    await expect(runtime.findAllByLabels({ agentId: "agent-1" }, { limit: 1 })).resolves.toEqual([
      { id: "local-1", state: "running", homeDir: "/home/local" },
      { id: "local-2", state: "running", homeDir: "/home/local" },
    ]);
    expect(calls).toHaveLength(2);
  });
});

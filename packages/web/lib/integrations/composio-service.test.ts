import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveComposioToolkit } from "./composio-service";

vi.mock("sst", () => ({
  Resource: {
    ComposioApiKey: { value: undefined },
  },
}));

const ORIGINAL_COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

function restoreEnv(name: "COMPOSIO_API_KEY", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function requestPath(input: RequestInfo | URL): string {
  return new URL(String(input)).pathname;
}

describe("resolveComposioToolkit", () => {
  beforeEach(() => {
    process.env.COMPOSIO_API_KEY = "composio-test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv("COMPOSIO_API_KEY", ORIGINAL_COMPOSIO_API_KEY);
  });

  it("resolves Docker Hub's user-facing alias to Composio's snake_case toolkit slug", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/v3/toolkits/docker_hub") {
        return jsonResponse({ slug: "docker_hub", name: "Docker Hub" });
      }
      return jsonResponse({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveComposioToolkit("dockerhub")).resolves.toMatchObject({
      slug: "docker_hub",
      name: "Docker Hub",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/api/v3/toolkits/docker_hub",
      }),
      expect.any(Object),
    );
  });
});

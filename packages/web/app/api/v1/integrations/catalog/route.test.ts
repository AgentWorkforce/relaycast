import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ORIGINAL_NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;
const ORIGINAL_COMPOSIO_API_KEY = process.env.COMPOSIO_API_KEY;

function catalogRequest(dynamic = false): Request {
  return new Request(
    `https://cloud.test/api/v1/integrations/catalog${dynamic ? "?dynamic=true" : ""}`,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function restoreEnv(name: "NANGO_SECRET_KEY" | "COMPOSIO_API_KEY", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("GET /api/v1/integrations/catalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv("NANGO_SECRET_KEY", ORIGINAL_NANGO_SECRET_KEY);
    restoreEnv("COMPOSIO_API_KEY", ORIGINAL_COMPOSIO_API_KEY);
  });

  it("returns the provider catalog with display names, config keys, and roots", async () => {
    const response = await GET(catalogRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: "github",
          displayName: "GitHub",
          configKey: "github-relay",
          vfsRoot: "/github",
        }),
        expect.objectContaining({
          id: "notion",
          displayName: "Notion",
          configKey: "notion-relay",
          vfsRoot: "/notion",
        }),
        expect.objectContaining({
          id: "linear",
          displayName: "Linear",
          configKey: "linear-relay",
          vfsRoot: "/linear",
        }),
      ]),
      version: expect.stringMatching(/^[a-f0-9]{12}$/),
    });
  });

  it("merges dynamic Nango providers and Composio toolkits when requested", async () => {
    process.env.NANGO_SECRET_KEY = "nango-secret";
    process.env.COMPOSIO_API_KEY = "composio-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.hostname === "api.nango.dev" && url.pathname === "/providers") {
          return jsonResponse({
            data: [
              {
                name: "salesforce",
                display_name: "Salesforce",
                auth_mode: "OAUTH2",
                categories: ["crm"],
                docs: "https://nango.dev/docs/integrations/all/salesforce",
              },
              {
                name: "github",
                display_name: "GitHub",
                auth_mode: "OAUTH2",
              },
            ],
          });
        }
        if (
          url.hostname === "backend.composio.dev" &&
          url.pathname === "/api/v3/toolkits"
        ) {
          return jsonResponse({
            items: [
              { slug: "docker_hub", name: "Docker Hub" },
              { slug: "github", name: "GitHub" },
            ],
          });
        }
        return jsonResponse({ error: "unexpected" });
      }),
    );

    const response = await GET(catalogRequest(true));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: "salesforce",
          displayName: "Salesforce",
          backend: "nango",
          backends: ["nango"],
          sources: ["nango"],
          authMode: "OAUTH2",
          categories: ["crm"],
        }),
        expect.objectContaining({
          id: "docker_hub",
          displayName: "Docker Hub",
          backend: "composio",
          backends: ["composio"],
          sources: ["composio"],
          vfsRoot: "/docker_hub",
        }),
        expect.objectContaining({
          id: "github",
          displayName: "GitHub",
          backends: expect.arrayContaining(["composio", "nango"]),
          sources: expect.arrayContaining(["composio", "nango", "relayfile"]),
        }),
      ]),
    });
  });
});

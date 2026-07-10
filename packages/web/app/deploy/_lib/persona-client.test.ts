import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePersona } from "./persona-client";

function stubFetch(status: number, payload: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolvePersona — private repo auth failures", () => {
  it("surfaces the server's detailed reason as the fallback reason", async () => {
    stubFetch(403, {
      error: "No GitHub integration credential can read AgentWorkforce/private-repo.",
    });

    const result = await resolvePersona(
      "https://github.com/AgentWorkforce/private-repo/blob/main/persona.ts",
      "live",
    );

    expect(result.demo).toBe(true);
    expect(result.fallbackReason).toBe(
      "No GitHub integration credential can read AgentWorkforce/private-repo.",
    );
  });

  it("flags a 403 as a blocking no-access resolveError", async () => {
    stubFetch(403, {
      error: "No GitHub integration credential can read AgentWorkforce/private-repo.",
    });

    const result = await resolvePersona(
      "https://github.com/AgentWorkforce/private-repo/blob/main/persona.ts",
      "live",
    );

    expect(result.resolveError).toEqual({
      status: 403,
      kind: "no-access",
      message: "No GitHub integration credential can read AgentWorkforce/private-repo.",
    });
  });

  it("flags a 401 as a blocking auth-required resolveError", async () => {
    stubFetch(401, {
      error: "GitHub authentication is required to resolve AgentWorkforce/private-repo.",
    });

    const result = await resolvePersona(
      "https://github.com/AgentWorkforce/private-repo/blob/main/persona.ts",
      "live",
    );

    expect(result.resolveError).toEqual({
      status: 401,
      kind: "auth-required",
      message: "GitHub authentication is required to resolve AgentWorkforce/private-repo.",
    });
  });

  it("falls back to the status code when the error body has no message", async () => {
    stubFetch(401, {});

    const result = await resolvePersona(
      "https://github.com/AgentWorkforce/agents/blob/main/persona.ts",
      "live",
    );

    expect(result.demo).toBe(true);
    expect(result.fallbackReason).toBe("resolve failed: 401");
    expect(result.resolveError).toEqual({
      status: 401,
      kind: "auth-required",
      message: "resolve failed: 401",
    });
  });

  it("degrades softly (no resolveError) on a non-auth failure", async () => {
    stubFetch(500, { error: "compile worker exploded" });

    const result = await resolvePersona(
      "https://github.com/AgentWorkforce/agents/blob/main/persona.ts",
      "live",
    );

    expect(result.demo).toBe(true);
    expect(result.fallbackReason).toBe("compile worker exploded");
    expect(result.resolveError).toBeUndefined();
  });
});

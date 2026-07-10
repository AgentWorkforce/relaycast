import { describe, expect, test } from "vitest";
import { normalizeClaims } from "../src/middleware/auth.js";

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 60 * 60 * 24;

function baseClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    wks: "ws_1",
    sub: "agent_1",
    exp: FAR_FUTURE,
    aud: "relayfile",
    scopes: ["relayfile:fs:read:/"],
    ...overrides,
  };
}

describe("normalizeClaims", () => {
  test("accepts wks + sub", () => {
    const claims = normalizeClaims(baseClaims());
    expect(claims.workspaceId).toBe("ws_1");
    expect(claims.agentName).toBe("agent_1");
    expect(claims.scopes.has("relayfile:fs:read:/")).toBe(true);
  });

  test("prefers sponsorId over sub for agent name", () => {
    const claims = normalizeClaims(
      baseClaims({
        sponsorId: "cloud-workspace-admin",
        sub: "ident_abc123",
      }),
    );
    expect(claims.agentName).toBe("cloud-workspace-admin");
  });

  test("falls back to sub when sponsorId is missing", () => {
    const claims = normalizeClaims(baseClaims({ sub: "ident_abc123" }));
    expect(claims.agentName).toBe("ident_abc123");
  });

  test("ignores legacy workspace_id / agent_name claims", () => {
    expect(() =>
      normalizeClaims({
        workspace_id: "ws_legacy",
        agent_name: "legacy_agent",
        exp: FAR_FUTURE,
        aud: "relayfile",
        scopes: ["relayfile:fs:read:/"],
      }),
    ).toThrow(/missing workspace claim/);
  });

  test("rejects missing workspace claim", () => {
    const payload: Record<string, unknown> = {
      sub: "agent",
      exp: FAR_FUTURE,
      aud: "relayfile",
      scopes: ["relayfile:fs:read:/"],
    };
    expect(() => normalizeClaims(payload)).toThrow();
  });

  test("rejects missing subject claim", () => {
    const payload: Record<string, unknown> = {
      wks: "ws",
      exp: FAR_FUTURE,
      aud: "relayfile",
      scopes: ["relayfile:fs:read:/"],
    };
    expect(() => normalizeClaims(payload)).toThrow();
  });

  test("rejects expired tokens", () => {
    expect(() =>
      normalizeClaims(baseClaims({ exp: Math.floor(Date.now() / 1000) - 10 })),
    ).toThrow();
  });

  test("rejects wrong aud", () => {
    expect(() =>
      normalizeClaims(baseClaims({ aud: "something-else" })),
    ).toThrow();
  });

  test("accepts aud as array including relayfile", () => {
    const claims = normalizeClaims(
      baseClaims({ aud: ["something-else", "relayfile"] }),
    );
    expect(claims.workspaceId).toBe("ws_1");
  });

  test("rejects empty scopes", () => {
    expect(() => normalizeClaims(baseClaims({ scopes: [] }))).toThrow();
  });

  test("accepts scopes as whitespace-separated string", () => {
    const claims = normalizeClaims(
      baseClaims({ scopes: "relayfile:fs:read:/  relayfile:fs:write:/" }),
    );
    expect(claims.scopes.has("relayfile:fs:read:/")).toBe(true);
    expect(claims.scopes.has("relayfile:fs:write:/")).toBe(true);
  });

  test("carries optional product_id through", () => {
    const claims = normalizeClaims(baseClaims({ product_id: "prod_42" }));
    expect(claims.productId).toBe("prod_42");
  });

  test("treats blank product_id as undefined", () => {
    const claims = normalizeClaims(baseClaims({ product_id: "   " }));
    expect(claims.productId).toBeUndefined();
  });
});

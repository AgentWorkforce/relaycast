import { describe, expect, it, vi } from "vitest";

import { mintCatalogingToken, type CatalogingTokenClaims } from "./context.js";

describe("mintCatalogingToken default scopes", () => {
  it("issues tokens with scopes that satisfy relayfile's exact-match gate", async () => {
    let captured: CatalogingTokenClaims | null = null;
    const signer = vi.fn(async (claims: CatalogingTokenClaims) => {
      captured = claims;
      return "test.jwt.token";
    });

    await mintCatalogingToken(signer, "ws_1", { domain: "github" });

    // Relayfile's middleware does `claims.scopes.has("fs:read")` /
    // `has("fs:write")` (see packages/relayfile/src/middleware/auth.ts) — exact
    // string match, no prefix or path wildcard handling. Any other format
    // (e.g. "relayfile:fs:read:*") parses as an opaque scope string and 403s
    // the cron's first readFile call.
    expect(captured).not.toBeNull();
    expect(captured!.scopes).toEqual(["fs:read", "fs:write"]);
  });

  it("forwards explicit scopes verbatim", async () => {
    let captured: CatalogingTokenClaims | null = null;
    const signer = vi.fn(async (claims: CatalogingTokenClaims) => {
      captured = claims;
      return "test.jwt.token";
    });

    await mintCatalogingToken(signer, "ws_1", {
      domain: "github",
      scopes: ["fs:read"],
    });

    expect(captured!.scopes).toEqual(["fs:read"]);
  });
});

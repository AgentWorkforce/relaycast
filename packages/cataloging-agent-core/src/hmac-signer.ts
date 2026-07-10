import type {
  CatalogingTokenClaims,
  CatalogingTokenSigner,
} from "./context.js";

/**
 * Shared HMAC-SHA256 JWT signer for cataloging agents. Takes the same
 * secret relayauth + relayfile use to mint/verify tokens, and returns a
 * signer that the agent framework can pass to `mintCatalogingToken` so
 * each request gets a fresh per-workspace JWT instead of a static
 * CATALOG_RELAYFILE_TOKEN.
 *
 * Usage from a domain agent:
 *
 *   createCatalogingAgent({
 *     domain: "github",
 *     insights: [...],
 *     getRelayauthSigner: (env) =>
 *       createRelayauthHmacSigner(env.RELAYAUTH_JWT_SECRET),
 *   });
 */
export function createRelayauthHmacSigner(
  secret: string | undefined,
): CatalogingTokenSigner {
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "createRelayauthHmacSigner: RELAYAUTH_JWT_SECRET is required",
    );
  }
  const keyMaterial = new TextEncoder().encode(secret);

  return async (claims: CatalogingTokenClaims): Promise<string> => {
    const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64url(JSON.stringify(claims));
    const signingInput = `${header}.${payload}`;

    const key = await crypto.subtle.importKey(
      "raw",
      keyMaterial,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signingInput),
    );

    return `${signingInput}.${base64url(signature)}`;
  };
}

function base64url(input: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

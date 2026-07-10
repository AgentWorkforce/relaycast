// Shared environment + SST Resource shims for the runners that drive cloud code
// requiring config (writeback bridge, webhook router). Mirrors the wiring in
// tests/relayfile-provider-writeback.e2e.test.ts.

import { Resource } from "sst";

export const NANGO_SECRET = "nango-secret-for-conformance";
export const RELAYAUTH_URL = "https://relayauth.conformance.test";
export const RELAYAUTH_API_KEY = "relayauth-api-key-for-conformance";
export const RELAYFILE_INTERNAL_HMAC_SECRET = "relayfile-internal-conformance";
export const RELAY_JWT_SECRET = "relay-jwt-secret-for-conformance";

/** Stable test workspace id (uuid form for pglite uuid columns). */
export const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function setResource(key: string, value: string): void {
  (Resource as unknown as Record<string, unknown>)[key] = { value };
}

/**
 * Install base env + Resource values needed by the cloud integration code.
 * NANGO_HOST / RELAYFILE_URL are set separately by each runner once its mock
 * server has bound a port.
 */
export function installBaseEnv(): void {
  process.env.NANGO_SECRET_KEY = NANGO_SECRET;
  process.env.RELAY_JWT_SECRET = RELAY_JWT_SECRET;
  process.env.RELAYFILE_INTERNAL_HMAC_SECRET = RELAYFILE_INTERNAL_HMAC_SECRET;
  process.env.RELAYAUTH_URL = RELAYAUTH_URL;
  process.env.RELAYAUTH_API_KEY = RELAYAUTH_API_KEY;
  process.env.WEB_RELAYAUTH_URL = RELAYAUTH_URL;
  process.env.WEB_RELAYAUTH_API_KEY = RELAYAUTH_API_KEY;

  setResource("NangoSecretKey", NANGO_SECRET);
  setResource("RelayJwtSecret", RELAY_JWT_SECRET);
  setResource("RelayfileInternalHmacSecret", RELAYFILE_INTERNAL_HMAC_SECRET);
  setResource("RelayauthUrl", RELAYAUTH_URL);
  setResource("WebRelayauthApiKey", RELAYAUTH_API_KEY);
}

/** Remove the per-run env vars set by runners (best-effort cleanup). */
export function clearRunEnv(): void {
  delete process.env.NANGO_HOST;
  delete process.env.RELAYFILE_URL;
}

export async function resetNangoClient(): Promise<void> {
  const mod = (await import(
    new URL(
      "../../packages/web/lib/integrations/nango-service.ts",
      import.meta.url,
    ).href
  )) as { resetNangoClientForTests: () => void };
  mod.resetNangoClientForTests();
}

/**
 * Wrap globalThis.fetch so relayauth identity/token mint calls return canned
 * responses while everything else (the mock relayfile + nango HTTP servers)
 * goes through the original fetch. Returns a restore function.
 */
export function installRelayauthFetchStub(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${RELAYAUTH_URL}/v1/identities`) {
      return new Response(JSON.stringify({ id: "identity-conformance" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === `${RELAYAUTH_URL}/v1/tokens`) {
      return new Response(
        JSON.stringify({ accessToken: "relayfile-token-conformance" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

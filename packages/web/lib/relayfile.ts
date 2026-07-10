import { optionalEnv, tryResourceValue } from "./env";

function resolveRelayfileUrl(): string {
  const url = tryResourceValue("RelayfileUrl")
    ?? optionalEnv("RelayfileUrl")
    ?? optionalEnv("RELAYFILE_URL");
  if (!url) {
    throw new Error("RelayfileUrl not configured — check infra/web.ts environment");
  }
  return url;
}

function resolveRelayAuthUrl(): string {
  return tryResourceValue("RelayauthUrl")
    ?? optionalEnv("WEB_RELAYAUTH_URL")
    ?? optionalEnv("RELAYAUTH_URL")
    ?? optionalEnv("RelayauthUrl")
    ?? "https://api.relayauth.dev";
}

function resolveRelayAuthApiKey(): string {
  return tryResourceValue("WebRelayauthApiKey")
    ?? optionalEnv("WEB_RELAYAUTH_API_KEY")
    ?? optionalEnv("RELAYAUTH_API_KEY")
    ?? "";
}

export function resolveRelayfileConfig(): {
  relayfileUrl: string;
  relayAuthUrl: string;
  relayAuthApiKey: string;
} {
  return {
    relayfileUrl: resolveRelayfileUrl(),
    relayAuthUrl: resolveRelayAuthUrl(),
    relayAuthApiKey: resolveRelayAuthApiKey(),
  };
}

export function resolveRelayAuthConfig(): {
  relayAuthUrl: string;
  relayAuthApiKey: string;
} {
  return {
    relayAuthUrl: resolveRelayAuthUrl(),
    relayAuthApiKey: resolveRelayAuthApiKey(),
  };
}

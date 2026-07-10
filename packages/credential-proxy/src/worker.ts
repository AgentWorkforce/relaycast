import {
  createCredentialProxyApp,
  type CredentialStore,
  type ProxyTokenClaims,
} from "@agent-relay/credential-proxy";

import type { Bindings } from "./env.js";

type CredentialProxyApp = ReturnType<typeof createCredentialProxyApp>;

const PROVIDER_KEY_BINDING: Record<ProxyTokenClaims["provider"], keyof Bindings> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function createWorkerCredentialStore(env: Bindings): CredentialStore {
  return {
    async resolve(claims: ProxyTokenClaims): Promise<string> {
      const bindingName = PROVIDER_KEY_BINDING[claims.provider];
      const apiKey = env[bindingName];
      if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
        throw new Error(
          `credential-proxy: no upstream key bound for provider ${claims.provider}`,
        );
      }
      return apiKey;
    },
  };
}

// Construct per-request rather than caching: the CredentialStore closes over
// `env`, so a cached app would keep stale provider keys across invocations.
// Hono app assembly is cheap; the upstream fetch dominates. Tradeoff: the
// in-memory MeteringCollector resets each request — acceptable given the
// Cloudflare-isolate model already makes any in-memory budget
// per-instance-at-best. Cross-isolate enforcement is a follow-up (Durable
// Objects / KV-backed store).
function buildApp(env: Bindings): CredentialProxyApp {
  // No adminJwtSecret / adminAudience configured: relay's router leaves the
  // /usage admin endpoint unauthenticated-to-unusable (falls back to the
  // default audience and to the main JWT secret). Wire dedicated admin
  // options here when you actually need a dashboard hitting /usage.
  return createCredentialProxyApp({
    jwtSecret: env.CREDENTIAL_PROXY_JWT_SECRET,
    credentialStore: createWorkerCredentialStore(env),
    requestIdFactory: () => crypto.randomUUID(),
  });
}

export default {
  async fetch(
    request: Request,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return buildApp(env).fetch(request, env, ctx);
  },
};

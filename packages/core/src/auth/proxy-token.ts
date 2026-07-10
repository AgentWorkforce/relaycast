import {
  mintProxyToken,
  type ProxyTokenClaims as RelayProxyTokenClaims,
} from "@agent-relay/credential-proxy";

// Must match @agent-relay/credential-proxy's internal PROXY_TOKEN_AUDIENCE —
// the package doesn't re-export the constant, so we keep the literal here.
export const PROXY_TOKEN_AUDIENCE = "relay-llm-proxy" as const;
export const DEFAULT_PROXY_TOKEN_TTL_SECONDS = 15 * 60;

export type ProxyProvider = "openai" | "anthropic" | "openrouter";

export interface ProxyTokenClaims {
  sub: string;
  aud: typeof PROXY_TOKEN_AUDIENCE;
  provider: ProxyProvider;
  credentialId: string;
  budget?: number;
  exp?: number;
  iat?: number;
}

export interface MintCredentialProxyTokenOptions {
  subject: string;
  provider: ProxyProvider;
  credentialId: string;
  secret: string;
  budget?: number;
  ttlSeconds?: number;
}

export interface ProxyEnvBinding {
  baseUrlVar: string;
  apiKeyVar: string;
}

// Provider → env bindings the proxy-env runtime would apply. Used when the
// caller only knows the upstream provider (orchestrator-side credential
// provisioning), not the specific CLI. The CLI-based path goes through the
// SDK's resolveProxyEnv helper below. The duplicate OPENAI_BASE_URL / _API_BASE
// pair exists because some SDKs read the former and some read the latter.
const PROVIDER_BINDINGS: Record<ProxyProvider, readonly ProxyEnvBinding[]> = {
  openai: [
    { baseUrlVar: "OPENAI_BASE_URL", apiKeyVar: "OPENAI_API_KEY" },
    { baseUrlVar: "OPENAI_API_BASE", apiKeyVar: "OPENAI_API_KEY" },
  ],
  anthropic: [
    { baseUrlVar: "ANTHROPIC_BASE_URL", apiKeyVar: "ANTHROPIC_API_KEY" },
  ],
  openrouter: [
    { baseUrlVar: "OPENAI_BASE_URL", apiKeyVar: "OPENAI_API_KEY" },
    { baseUrlVar: "OPENAI_API_BASE", apiKeyVar: "OPENAI_API_KEY" },
    { baseUrlVar: "OPENAI_BASE_URL", apiKeyVar: "OPENROUTER_API_KEY" },
  ],
};

const OPENAI_COMPATIBLE_CLI_BINDINGS: readonly ProxyEnvBinding[] = [
  { baseUrlVar: "OPENAI_BASE_URL", apiKeyVar: "OPENAI_API_KEY" },
];

const ANTHROPIC_CLI_BINDINGS: readonly ProxyEnvBinding[] = [
  { baseUrlVar: "ANTHROPIC_BASE_URL", apiKeyVar: "ANTHROPIC_API_KEY" },
];

const AIDER_CLI_BINDINGS: readonly ProxyEnvBinding[] = [
  { baseUrlVar: "OPENAI_API_BASE", apiKeyVar: "OPENAI_API_KEY" },
];

const GEMINI_CLI_BINDINGS: readonly ProxyEnvBinding[] = [
  { baseUrlVar: "GOOGLE_API_BASE", apiKeyVar: "GOOGLE_API_KEY" },
];

const GENERIC_CLI_FALLBACK_BINDINGS: readonly ProxyEnvBinding[] = [
  ...OPENAI_COMPATIBLE_CLI_BINDINGS,
  ...ANTHROPIC_CLI_BINDINGS,
];

const CLI_PROXY_BINDINGS: Record<string, readonly ProxyEnvBinding[] | undefined> = {
  claude: ANTHROPIC_CLI_BINDINGS,
  codex: OPENAI_COMPATIBLE_CLI_BINDINGS,
  opencode: OPENAI_COMPATIBLE_CLI_BINDINGS,
  aider: AIDER_CLI_BINDINGS,
  gemini: GEMINI_CLI_BINDINGS,
  droid: OPENAI_COMPATIBLE_CLI_BINDINGS,
  cursor: OPENAI_COMPATIBLE_CLI_BINDINGS,
};

const CLI_TO_PROXY_PROVIDER: Record<string, ProxyProvider | undefined> = {
  claude: "anthropic",
  codex: "openai",
  aider: "openai",
  opencode: "openai",
  droid: "openai",
  cursor: "openai",
};

const PROVIDER_TO_PROXY_PROVIDER: Record<string, ProxyProvider | undefined> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
};

const CLI_ALIASES: Record<string, string> = {
  agent: "cursor",
  "cursor-agent": "cursor",
};

// Only providers whose upstream API key is actually bound on the proxy
// Worker should activate the proxy path. If a CLI or credential provider
// resolves to something outside this set, we return undefined and the
// orchestrator falls back to mounted credentials — the pre-proxy behavior
// claude / codex / opencode / gemini rely on today. Extend this set only
// when the corresponding secret is bound in infra/credential-proxy.ts
// (e.g. add "openai" once OPENAI_API_KEY is bound, "anthropic" once
// ANTHROPIC_API_KEY is bound).
const SUPPORTED_PROXY_PROVIDERS: ReadonlySet<ProxyProvider> = new Set([
  "openrouter",
]);

function gateProxyProvider(
  provider: ProxyProvider | undefined
): ProxyProvider | undefined {
  return provider && SUPPORTED_PROXY_PROVIDERS.has(provider) ? provider : undefined;
}

function normalizeCli(cli: string): string {
  const trimmed = cli.trim();
  const baseCli = trimmed.includes(":") ? trimmed.split(":")[0] : trimmed;
  return CLI_ALIASES[baseCli] ?? baseCli;
}

export function resolveProxyProviderFromCli(
  cli: string | undefined
): ProxyProvider | undefined {
  if (!cli) {
    return undefined;
  }
  return gateProxyProvider(CLI_TO_PROXY_PROVIDER[normalizeCli(cli)]);
}

export function resolveProxyProviderFromCredentialProvider(
  provider: string | undefined
): ProxyProvider | undefined {
  if (!provider) {
    return undefined;
  }
  return gateProxyProvider(PROVIDER_TO_PROXY_PROVIDER[provider.trim()]);
}

export function resolveProxyEnvForCli(
  cli: string,
  proxyUrl: string,
  proxyToken: string
): Record<string, string> {
  return buildProxyEnvForBindings(
    CLI_PROXY_BINDINGS[normalizeCli(cli)] ?? GENERIC_CLI_FALLBACK_BINDINGS,
    proxyUrl,
    proxyToken
  );
}

export function resolveProxyEnvForProvider(
  provider: ProxyProvider,
  proxyUrl: string,
  proxyToken: string
): Record<string, string> {
  return buildProxyEnvForBindings(PROVIDER_BINDINGS[provider], proxyUrl, proxyToken);
}

function buildProxyEnvForBindings(
  bindings: readonly ProxyEnvBinding[],
  proxyUrl: string,
  proxyToken: string
): Record<string, string> {
  return bindings.reduce<Record<string, string>>(
    (env, binding) => {
      env[binding.baseUrlVar] = proxyUrl;
      env[binding.apiKeyVar] = proxyToken;
      return env;
    },
    {}
  );
}

export function parseCredentialProxyTokens(
  serialized: string | undefined
): Partial<Record<ProxyProvider, string>> | undefined {
  if (!serialized?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const tokens = Object.entries(parsed).reduce<
      Partial<Record<ProxyProvider, string>>
    >((acc, [provider, token]) => {
      const resolvedProvider = resolveProxyProviderFromCredentialProvider(provider);
      if (resolvedProvider && typeof token === "string" && token.trim().length > 0) {
        acc[resolvedProvider] = token;
      }
      return acc;
    }, {});

    return Object.keys(tokens).length > 0 ? tokens : undefined;
  } catch {
    return undefined;
  }
}

export async function mintCredentialProxyToken(
  options: MintCredentialProxyTokenOptions
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const exp = issuedAt + (options.ttlSeconds ?? DEFAULT_PROXY_TOKEN_TTL_SECONDS);

  const claims: RelayProxyTokenClaims = {
    sub: options.subject,
    aud: PROXY_TOKEN_AUDIENCE,
    provider: options.provider,
    credentialId: options.credentialId,
    iat: issuedAt,
    exp,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  };

  return mintProxyToken(claims, options.secret);
}

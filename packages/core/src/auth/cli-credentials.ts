import type { Sandbox } from '@daytonaio/sdk';
import { CLI_AUTH_CONFIG } from '@agent-relay/config/cli-auth-config';
import {
  createCredentialStore,
  type CredentialStore,
  type DaytonaCredential,
} from './credential-store.js';
import { parseCredentialExpiry } from './credential-expiry.js';
import { refreshCredential } from './credential-refresher.js';
import { resolveProxyEnvForCli } from './proxy-token.js';

export const DIRECT_PROVIDER_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
] as const;

export const DAYTONA_CREDENTIAL_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Map from workflow agent CLI names to credential provider keys.
 * The provider key matches the keys in CLI_AUTH_CONFIG and the S3 credential path.
 */
export const CLI_TO_PROVIDER: Record<string, keyof typeof CLI_AUTH_CONFIG> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  opencode: 'opencode',
  droid: 'droid',
  agent: 'cursor',
  copilot: 'copilot',
  aider: 'openai',
  // Cast until the @agent-relay/config bump that adds the xai entry to
  // CLI_AUTH_CONFIG lands here; the runtime lookup is key-based either way.
  grok: 'xai' as keyof typeof CLI_AUTH_CONFIG,
};

/**
 * Resolve the credential provider for a workflow config string.
 * Parses the config JSON to find agents[].cli, maps to the provider key.
 * Defaults to "anthropic" if no agents are specified or the CLI is unknown.
 */
export function resolveCredentialProvider(workflowConfig: string): keyof typeof CLI_AUTH_CONFIG {
  try {
    const parsed = JSON.parse(workflowConfig) as { agents?: { cli?: string }[] };
    const firstCli = parsed.agents?.[0]?.cli;
    if (firstCli && CLI_TO_PROVIDER[firstCli]) {
      return CLI_TO_PROVIDER[firstCli];
    }
  } catch {
    // Not valid JSON or missing agents — use default
  }
  return 'anthropic';
}

/**
 * Resolve the credential provider for a workflow agent CLI.
 */
export function resolveCredentialProviderFromCli(cli: string | undefined): keyof typeof CLI_AUTH_CONFIG {
  if (cli && CLI_TO_PROVIDER[cli]) {
    return CLI_TO_PROVIDER[cli];
  }
  return 'anthropic';
}

/**
 * Resolve credentials for an explicitly declared persona/member harness.
 *
 * Unlike the legacy workflow resolver, this does not default missing or
 * unknown CLIs to Anthropic. Team members with no harness should provision no
 * CLI credentials, and unsupported harnesses should be handled by the caller.
 */
export function resolveDeclaredCliCredentialProvider(
  cli: string | null | undefined,
): keyof typeof CLI_AUTH_CONFIG | null {
  const normalizedCli = cli?.trim();
  if (!normalizedCli) {
    return null;
  }

  return CLI_TO_PROVIDER[normalizedCli] ?? null;
}

/**
 * Known credential file targets that should stay absent when a sandbox is using
 * proxy env wiring instead of direct credential mounts.
 */
export function getKnownCredentialMountPaths(home: string): string[] {
  const normalizedHome = home.replace(/\/+$/, '');
  const paths = new Set<string>();

  paths.add(`${normalizedHome}/.claude/.credentials.json`);
  paths.add(`${normalizedHome}/.claude.json`);
  paths.add(`${normalizedHome}/.codex/auth.json`);
  paths.add(`${normalizedHome}/.config/gemini/credentials.json`);

  for (const config of Object.values(CLI_AUTH_CONFIG)) {
    if (config.credentialPath) {
      paths.add(`${normalizedHome}/${config.credentialPath.replace('~/', '')}`);
    }
  }

  return [...paths];
}

/**
 * Check if a workflow config requires CLI credentials.
 * Returns false if the workflow has no agents or all agents lack a CLI field.
 */
export function workflowNeedsCliCredentials(workflowConfig: string): boolean {
  try {
    const parsed = JSON.parse(workflowConfig) as { agents?: { cli?: string }[] };
    if (!parsed.agents || parsed.agents.length === 0) {
      return false;
    }
    return parsed.agents.some((a) => !!a.cli);
  } catch {
    return false;
  }
}

/**
 * Get all unique credential providers needed by a workflow config.
 */
export function getAllProviders(workflowConfig: string): Array<keyof typeof CLI_AUTH_CONFIG> {
  try {
    const parsed = JSON.parse(workflowConfig) as { agents?: { cli?: string }[] };
    const providers = new Set<keyof typeof CLI_AUTH_CONFIG>();
    for (const agent of parsed.agents ?? []) {
      if (agent.cli && CLI_TO_PROVIDER[agent.cli]) {
        providers.add(CLI_TO_PROVIDER[agent.cli]);
      }
    }
    return [...providers];
  } catch {
    return ['anthropic'];
  }
}

/**
 * Get all unique CLI names used by a workflow config.
 */
export function getAllClis(workflowConfig: string): string[] {
  try {
    const parsed = JSON.parse(workflowConfig) as { agents?: { cli?: string }[] };
    const clis = new Set<string>();
    for (const agent of parsed.agents ?? []) {
      if (agent.cli) clis.add(agent.cli);
    }
    return [...clis];
  } catch {
    return [];
  }
}

/**
 * Extract the credential string for a specific provider from a credential bundle.
 *
 * The bundle may be:
 *   - A multi-provider JSON object: { anthropic: "...", openai: "..." }
 *   - A single-provider credential string (legacy)
 *
 * If the bundle is a multi-provider object and the provider key exists, returns
 * that provider's credentials. Otherwise returns the bundle as-is (legacy path).
 */
export function extractProviderCredentials(
  credentialBundle: string,
  provider: keyof typeof CLI_AUTH_CONFIG
): string {
  try {
    const parsed = JSON.parse(credentialBundle) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && typeof parsed[provider] === 'string') {
      return parsed[provider] as string;
    }
  } catch {
    // Not JSON — treat as a raw single-provider credential string
  }
  return credentialBundle;
}

/**
 * Detect the long-lived Anthropic setup-token credential shape
 * (`claude setup-token`, auth_type='oauth_token') and return the token.
 *
 * The credential is stored as `{ type: 'oauth_token', modelProvider:
 * 'anthropic', token: '<setup-token>' }`. When this shape is present the
 * genuine Claude binary authenticates from the `CLAUDE_CODE_OAUTH_TOKEN`
 * env var alone, so no `~/.claude/.credentials.json` mount is needed.
 *
 * Returns `null` for the legacy refreshable provider_oauth shape
 * (`{ claudeAiOauth: {...} }`) and for any non-matching / non-JSON input,
 * leaving the existing mount path untouched.
 */
export function extractAnthropicOauthToken(credentialJson: string): string | null {
  try {
    const parsed = JSON.parse(credentialJson) as {
      modelProvider?: unknown;
      type?: unknown;
      token?: unknown;
    };
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'oauth_token' &&
      (parsed.modelProvider === undefined || parsed.modelProvider === 'anthropic') &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return parsed.token;
    }
  } catch {
    // Not JSON — not a setup-token credential
  }
  return null;
}

/**
 * Extract the subscription access token from the refreshable provider_oauth
 * shape (`{ claudeAiOauth: { accessToken, ... } }` — Claude Pro/Max login).
 * Point-in-time: callers must ensure the blob is fresh (the credential sweep
 * + per-run refresh maintain it) since subscription access tokens expire in
 * hours, unlike long-lived setup-tokens.
 */
export function extractAnthropicSubscriptionAccessToken(credentialJson: string): string | null {
  try {
    const parsed = JSON.parse(credentialJson) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const accessToken = parsed?.claudeAiOauth?.accessToken;
    if (typeof accessToken === 'string' && accessToken.length > 0) {
      return accessToken;
    }
  } catch {
    // Not JSON — not a subscription credential
  }
  return null;
}

export function extractAnthropicOauthTokenFromBundle(credentialBundle: string): string | null {
  if (!credentialBundle) {
    return null;
  }
  return extractAnthropicOauthToken(
    extractProviderCredentials(credentialBundle, 'anthropic'),
  );
}

export function applyAnthropicOauthTokenEnv(
  envVars: Record<string, string>,
  credentialBundle: string,
): void {
  const setupToken = extractAnthropicOauthTokenFromBundle(credentialBundle);
  if (setupToken) {
    envVars.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
  }
}

/**
 * Retrieve CLI credentials for a provider from encrypted S3 storage.
 */
export async function getCliCredentials(
  userId: string,
  provider: string,
  encryptionKey: string
): Promise<string> {
  const store = createCredentialStore(encryptionKey);
  const credentials = await store.retrieve(userId, provider);

  if (!credentials) {
    throw new Error(
      `No ${provider} credentials found for user ${userId}. Run 'agent-relay cloud connect ${provider}' first.`,
    );
  }

  return credentials;
}

function parseDaytonaCredential(credentialJson: string): DaytonaCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credentialJson) as unknown;
  } catch {
    throw new Error("Stored daytona credentials are not valid JSON");
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { provider?: unknown }).provider !== "daytona" ||
    typeof (parsed as { accessToken?: unknown }).accessToken !== "string" ||
    typeof (parsed as { refreshToken?: unknown }).refreshToken !== "string" ||
    typeof (parsed as { expiresAt?: unknown }).expiresAt !== "string"
  ) {
    throw new Error("Stored daytona credentials have an unsupported shape");
  }

  const credential = parsed as DaytonaCredential;
  if (!credential.accessToken || !credential.refreshToken || !credential.expiresAt) {
    throw new Error("Stored daytona credentials are missing required token fields");
  }

  return credential;
}

function daytonaCredentialFreshEnough(credentialJson: string): boolean {
  const expiresAt = parseCredentialExpiry(credentialJson);
  return (
    expiresAt !== null &&
    expiresAt.getTime() - Date.now() > DAYTONA_CREDENTIAL_REFRESH_BUFFER_MS
  );
}

export async function getDaytonaCredentialFromStore(
  store: Pick<CredentialStore, "retrieve" | "store">,
  userId: string,
): Promise<DaytonaCredential> {
  const credentialJson = await store.retrieve(userId, "daytona");
  if (!credentialJson) {
    throw new Error(
      `No daytona credentials found for user ${userId}. Run 'agent-relay cloud connect daytona' first.`,
    );
  }

  if (daytonaCredentialFreshEnough(credentialJson)) {
    return parseDaytonaCredential(credentialJson);
  }

  const refreshed = await refreshCredential("daytona", credentialJson);
  await store.store(userId, "daytona", refreshed.credentialJson);
  return parseDaytonaCredential(refreshed.credentialJson);
}

export async function getDaytonaCredential(
  userId: string,
  encryptionKey: string,
): Promise<DaytonaCredential> {
  return getDaytonaCredentialFromStore(createCredentialStore(encryptionKey), userId);
}

export async function getDaytonaAccessToken(
  userId: string,
  encryptionKey: string,
): Promise<string> {
  return (await getDaytonaCredential(userId, encryptionKey)).accessToken;
}

/**
 * List all credential providers the user has connected.
 * Reads the credential store metadata and returns only providers
 * that are recognized in CLI_AUTH_CONFIG.
 */
export async function listConnectedProviders(
  userId: string,
  encryptionKey: string,
): Promise<Array<keyof typeof CLI_AUTH_CONFIG>> {
  const store = createCredentialStore(encryptionKey);
  const metadata = await store.getMetadata(userId);

  if (!metadata?.providers) {
    return [];
  }

  return Object.keys(metadata.providers).filter(
    (key): key is keyof typeof CLI_AUTH_CONFIG => key in CLI_AUTH_CONFIG,
  );
}

/**
 * Mount CLI credentials into a sandbox and bypass first-run setup.
 */
export async function mountCliCredentials(
  sandbox: Sandbox,
  home: string,
  credentialJson: string,
  provider: keyof typeof CLI_AUTH_CONFIG
): Promise<void> {
  const config = CLI_AUTH_CONFIG[provider];
  if (!config) {
    throw new Error(`Unsupported credential provider: ${provider}`);
  }

  switch (provider) {
    case 'anthropic': {
      const claudeDir = `${home}/.claude`;
      await sandbox.process.executeCommand(`mkdir -p ${claudeDir}`);
      // Setup-token (auth_type='oauth_token') credentials authenticate via the
      // CLAUDE_CODE_OAUTH_TOKEN env var injected by the launcher, so skip the
      // .credentials.json mount. Legacy refreshable provider_oauth
      // ({ claudeAiOauth: ... }) still mounts the credential file.
      if (extractAnthropicOauthToken(credentialJson) === null) {
        await sandbox.fs.uploadFile(
          Buffer.from(credentialJson),
          `${claudeDir}/.credentials.json`
        );
      }

      const claudeConfig = JSON.stringify({
        hasCompletedOnboarding: true,
        firstStartTime: new Date().toISOString(),
      });
      await sandbox.fs.uploadFile(Buffer.from(claudeConfig), `${home}/.claude.json`);
      break;
    }
    case 'openai': {
      await sandbox.process.executeCommand(`mkdir -p ${home}/.codex`);
      await sandbox.fs.uploadFile(Buffer.from(credentialJson), `${home}/.codex/auth.json`);
      break;
    }
    case 'google': {
      await sandbox.process.executeCommand(`mkdir -p ${home}/.config/gemini`);
      await sandbox.fs.uploadFile(
        Buffer.from(credentialJson),
        `${home}/.config/gemini/credentials.json`
      );
      break;
    }
    case 'opencode': {
      // OpenCode reads credentials from ~/.claude/.credentials.json (same as Claude).
      // Mount there so per-agent sandboxes match the orchestrator sandbox behavior.
      const ocClaudeDir = `${home}/.claude`;
      await sandbox.process.executeCommand(`mkdir -p ${ocClaudeDir}`);
      await sandbox.fs.uploadFile(
        Buffer.from(credentialJson),
        `${ocClaudeDir}/.credentials.json`
      );
      break;
    }
    default: {
      if (!config.credentialPath) {
        throw new Error(`No credential path configured for provider: ${provider}`);
      }

      const targetPath = `${home}/${config.credentialPath.replace('~/', '')}`;
      await sandbox.process.executeCommand(`mkdir -p $(dirname ${targetPath})`);
      await sandbox.fs.uploadFile(Buffer.from(credentialJson), targetPath);
      break;
    }
  }
}

export function resolveProxyCredentialEnv(
  cli: string,
  proxyUrl: string,
  token: string
): Record<string, string> {
  const normalizedUrl = proxyUrl.trim().replace(/\/+$/, '');
  const normalizedToken = token.trim();
  if (!normalizedUrl) {
    throw new Error('proxyUrl is required');
  }
  if (!normalizedToken) {
    throw new Error('proxyToken is required');
  }

  return {
    CREDENTIAL_PROXY_URL: normalizedUrl,
    CREDENTIAL_PROXY_TOKEN: normalizedToken,
    ...resolveProxyEnvForCli(cli, normalizedUrl, normalizedToken),
  };
}

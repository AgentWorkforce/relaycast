import { sql } from "drizzle-orm";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import {
  extractAnthropicOauthToken,
  extractAnthropicSubscriptionAccessToken,
  getDaytonaCredential,
} from "@cloud/core/auth/cli-credentials.js";
import { refreshHarnessCliCredentialIfStale } from "@/lib/proactive-runtime/harness-credential-refresh";
import { Resource } from "sst";
import { getDb } from "@/lib/db";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { createCredentialStoreS3Client } from "@/lib/storage";
import {
  normalizeModelProvider,
  resolveHouseKey,
} from "./house-keys";

type ProviderCredentialRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  model_provider: string;
  auth_type: string;
  status: string;
};

type ByokCredentialPayload = {
  type?: unknown;
  modelProvider?: unknown;
  key?: unknown;
};

type CodexOauthCredentialPayload = {
  account_id?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
};

type RuntimeCredential = {
  provider: string;
  providerCredentialId: string;
  authType: string;
  envVar: string;
};

type ResolveProviderCredentialRuntimeEnvInput = {
  workspaceId: string;
  userId: string;
  credentialSelections: Record<string, string>;
};

type ResolveProviderCredentialRuntimeEnvResult = {
  env: Record<string, string>;
  credentials: RuntimeCredential[];
};

type ResolveDaytonaCredentialRuntimeEnvInput = {
  userId: string;
};

type ResolveProviderCredentialByIdInput = {
  workspaceId: string;
  userId: string;
  providerCredentialId: string;
};

type ResolveProviderCredentialByIdResult = {
  env: Record<string, string>;
  credential: RuntimeCredential;
  modelProvider: string;
};

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray((result as RawRows<T>)?.rows) ? (result as RawRows<T>).rows! : [];
}

function resolveCredentialEncryptionKey(): string {
  const resourceValue = tryResourceValue("CredentialEncryptionKey")?.trim();
  if (resourceValue) {
    return resourceValue;
  }

  const fromEnv = optionalEnv("CREDENTIAL_ENCRYPTION_KEY")?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error("CredentialEncryptionKey is not configured");
}

function resolveWorkflowStorageBucket(): string {
  try {
    const bucket = (Resource as unknown as { WorkflowStorage?: { bucketName?: string } })
      .WorkflowStorage?.bucketName?.trim();
    if (bucket) {
      return bucket;
    }
  } catch {
    // local dev/test fallback below
  }

  const fromEnv = optionalEnv("WORKFLOW_STORAGE_BUCKET")?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error("WorkflowStorage bucket is not configured");
}

function normalizeSelections(
  selections: Record<string, string>,
): Array<{ provider: string; providerCredentialId: string }> {
  const normalized: Array<{ provider: string; providerCredentialId: string }> = [];
  for (const [rawProvider, rawCredentialId] of Object.entries(selections)) {
    const provider = normalizeModelProvider(rawProvider);
    const providerCredentialId = rawCredentialId.trim();
    if (!provider || !providerCredentialId) {
      throw new Error(`Invalid provider credential selection for ${rawProvider}`);
    }
    normalized.push({ provider, providerCredentialId });
  }
  return normalized;
}

function providerApiKeyEnv(provider: string): string {
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (!envVar) {
    throw new Error(`Unsupported provider credential selection for ${provider}`);
  }
  return envVar;
}

async function readProviderCredentialById(
  workspaceId: string,
  providerCredentialId: string,
): Promise<ProviderCredentialRow> {
  const result = await getDb().execute(sql`
    SELECT id, workspace_id, user_id, model_provider, auth_type, status
    FROM provider_credentials
    WHERE id = ${providerCredentialId}
      AND workspace_id = ${workspaceId}
    LIMIT 1
  `);
  const credential = rowsOf<ProviderCredentialRow>(result)[0];
  if (!credential) {
    throw new Error(`Provider credential ${providerCredentialId} was not found`);
  }
  if (credential.status !== "connected") {
    throw new Error(`Provider credential ${providerCredentialId} is not connected`);
  }
  return credential;
}

async function readProviderCredential(
  workspaceId: string,
  provider: string,
  providerCredentialId: string,
): Promise<ProviderCredentialRow> {
  const credential = await readProviderCredentialById(workspaceId, providerCredentialId);
  if (credential.model_provider !== provider) {
    throw new Error(`Provider credential ${providerCredentialId} does not match ${provider}`);
  }
  return credential;
}

function parseByokPayload(raw: string, provider: string): string {
  let parsed: ByokCredentialPayload;
  try {
    parsed = JSON.parse(raw) as ByokCredentialPayload;
  } catch {
    throw new Error(`Stored ${provider} BYOK credential is not valid JSON`);
  }

  if (parsed.type !== "api_key") {
    throw new Error(`Stored ${provider} BYOK credential has an unsupported type`);
  }
  if (parsed.modelProvider !== provider) {
    throw new Error(`Stored ${provider} BYOK credential provider mismatch`);
  }
  if (typeof parsed.key !== "string" || !parsed.key.trim()) {
    throw new Error(`Stored ${provider} BYOK credential is missing an API key`);
  }
  return parsed.key.trim();
}

function isUsableCodexOauthCredential(raw: string): boolean {
  let parsed: CodexOauthCredentialPayload;
  try {
    parsed = JSON.parse(raw) as CodexOauthCredentialPayload;
  } catch {
    return false;
  }
  if (typeof parsed.tokens?.access_token !== "string" || !parsed.tokens.access_token.trim()) {
    return false;
  }
  const accountId = parsed.account_id ?? parsed.tokens?.account_id;
  return typeof accountId === "string" && accountId.trim().length > 0;
}

function assertCodexOauthCredential(raw: string): void {
  let parsed: CodexOauthCredentialPayload;
  try {
    parsed = JSON.parse(raw) as CodexOauthCredentialPayload;
  } catch {
    throw new Error("Stored openai subscription credential is not valid JSON");
  }

  if (typeof parsed.tokens?.access_token !== "string" || !parsed.tokens.access_token.trim()) {
    throw new Error("Stored openai subscription credential carries no usable access token");
  }
  const accountId = parsed.account_id ?? parsed.tokens?.account_id;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error("Stored openai subscription credential is missing account_id");
  }
}

async function resolveCredentialValue(input: {
  provider: string;
  credential: ProviderCredentialRow;
  credentialStore: CredentialStore | null;
}): Promise<string> {
  if (input.credential.auth_type === "relay_managed") {
    const houseKey = resolveHouseKey(input.provider);
    if (!houseKey) {
      throw new Error(`Managed ${input.provider} credentials are not configured`);
    }
    return houseKey;
  }

  if (input.credential.auth_type === "byo_api_key") {
    const store = input.credentialStore;
    if (!store) {
      throw new Error("Credential store is not configured");
    }
    const stored = await store.retrieve(input.credential.user_id, input.credential.id);
    if (!stored) {
      throw new Error(`Stored ${input.provider} BYOK credential was not found`);
    }
    return parseByokPayload(stored, input.provider);
  }

  if (input.credential.auth_type === "oauth_token") {
    // `claude setup-token` credential. Stored under the provider-NAME key
    // (one per provider — see the setup-token route), as
    // `{type:'oauth_token', modelProvider, token}`. Anthropic-only today:
    // the runtime consumes it via the CLAUDE_CODE_OAUTH_TOKEN env var
    // (Authorization: Bearer + oauth beta header), which is meaningless for
    // other providers.
    if (input.provider !== "anthropic") {
      throw new Error(
        `Setup-token credentials are only supported for anthropic (got ${input.provider})`,
      );
    }
    const store = input.credentialStore;
    if (!store) {
      throw new Error("Credential store is not configured");
    }
    const stored = await store.retrieve(input.credential.user_id, input.provider);
    if (!stored) {
      throw new Error("Stored anthropic setup-token credential was not found");
    }
    const token = extractAnthropicOauthToken(stored);
    if (!token) {
      throw new Error("Stored anthropic credential is not a setup-token shape");
    }
    return token;
  }

  if (input.credential.auth_type === "provider_oauth") {
    // Subscription login (claude / codex CLI OAuth). OpenAI ChatGPT OAuth is
    // still NOT a platform API key, so it must never be emitted as
    // OPENAI_API_KEY. The runtime's codex-backend leg consumes the structured
    // CODEX_OAUTH_CREDENTIAL blob instead; the blob carries tokens.account_id,
    // which chatgpt.com/backend-api requires.
    if (input.provider !== "anthropic" && input.provider !== "openai") {
      throw new Error(
        `Subscription credentials for ${input.provider} cannot be used as a runtime env credential ` +
          "(ChatGPT OAuth tokens are not platform API keys); use a BYOK key for ctx.llm or the harness path",
      );
    }
    const store = input.credentialStore;
    if (!store) {
      throw new Error("Credential store is not configured");
    }
    const stored = await store.retrieve(input.credential.user_id, input.provider);
    if (!stored) {
      throw new Error(`Stored ${input.provider} subscription credential was not found`);
    }
    // Subscription access tokens expire in hours — reuse the per-run
    // refresh+persist seam (#1865) so the injected token outlives the run.
    const fresh = await refreshHarnessCliCredentialIfStale({
      store,
      userId: input.credential.user_id,
      provider: input.provider,
      credentialJson: stored,
    });
    if (input.provider === "openai") {
      assertCodexOauthCredential(fresh);
      return fresh;
    }
    const accessToken = extractAnthropicSubscriptionAccessToken(fresh)
      ?? extractAnthropicOauthToken(fresh);
    if (!accessToken) {
      throw new Error("Stored anthropic credential carries no usable access token");
    }
    return accessToken;
  }

  throw new Error(`Provider credential auth type ${input.credential.auth_type} is not supported at runtime`);
}

async function resolveCredentialRow(input: {
  userId: string;
  provider: string;
  credential: ProviderCredentialRow;
  credentialStoreRef: { current: CredentialStore | null };
}): Promise<{ env: Record<string, string>; runtimeCredential: RuntimeCredential }> {
  if (input.credential.user_id !== input.userId) {
    throw new Error(`Provider credential ${input.credential.id} is not owned by the deploying user`);
  }

  // Setup-tokens are OAuth bearers, NOT API keys: shipping one in
  // ANTHROPIC_API_KEY would 401 (x-api-key header). The runtime/llm path
  // reads them from CLAUDE_CODE_OAUTH_TOKEN instead.
  // OAuth bearers (setup-tokens AND anthropic subscription access tokens)
  // ship in CLAUDE_CODE_OAUTH_TOKEN — they are not API keys and would 401 in
  // ANTHROPIC_API_KEY's x-api-key header.
  const isCodexOauthCredential =
    input.credential.auth_type === "provider_oauth" && input.provider === "openai";
  const isOauthBearer =
    input.credential.auth_type === "oauth_token" ||
    (input.credential.auth_type === "provider_oauth" && input.provider === "anthropic");
  const envVar = isCodexOauthCredential
    ? "CODEX_OAUTH_CREDENTIAL"
    : isOauthBearer
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : providerApiKeyEnv(input.provider);
  const needsStore =
    input.credential.auth_type === "byo_api_key" ||
    input.credential.auth_type === "oauth_token" ||
    input.credential.auth_type === "provider_oauth";
  if (needsStore && input.credentialStoreRef.current === null) {
    const client = await createCredentialStoreS3Client({ userId: input.userId });
    input.credentialStoreRef.current = new CredentialStore({
      bucket: resolveWorkflowStorageBucket(),
      prefix: "credentials",
      encryptionKey: resolveCredentialEncryptionKey(),
      client,
    });
  }
  const value = await resolveCredentialValue({
    provider: input.provider,
    credential: input.credential,
    credentialStore: input.credentialStoreRef.current,
  });

  return {
    env: { [envVar]: value },
    runtimeCredential: {
      provider: input.provider,
      providerCredentialId: input.credential.id,
      authType: input.credential.auth_type,
      envVar,
    },
  };
}

export async function resolveProviderCredentialRuntimeEnv(
  input: ResolveProviderCredentialRuntimeEnvInput,
): Promise<ResolveProviderCredentialRuntimeEnvResult> {
  const selections = normalizeSelections(input.credentialSelections);
  if (selections.length === 0) {
    return { env: {}, credentials: [] };
  }

  const env: Record<string, string> = {};
  const credentials: RuntimeCredential[] = [];
  const credentialStoreRef: { current: CredentialStore | null } = { current: null };

  for (const selection of selections) {
    const credential = await readProviderCredential(
      input.workspaceId,
      selection.provider,
      selection.providerCredentialId,
    );
    const resolved = await resolveCredentialRow({
      userId: input.userId,
      provider: selection.provider,
      credential,
      credentialStoreRef,
    });
    Object.assign(env, resolved.env);
    credentials.push(resolved.runtimeCredential);
  }

  return { env, credentials };
}

export async function resolveDaytonaCredentialRuntimeEnv(
  input: ResolveDaytonaCredentialRuntimeEnvInput,
): Promise<Record<string, string>> {
  const credential = await getDaytonaCredential(
    input.userId,
    resolveCredentialEncryptionKey(),
  );
  return {
    DAYTONA_ACCESS_TOKEN: credential.accessToken,
    ...(credential.orgId ? { DAYTONA_ORG_ID: credential.orgId } : {}),
  };
}

type ResolveSubscriptionFallbackEnvInput = {
  workspaceId: string;
  userId: string;
  personaModel?: string | null;
  personaHarness?: string | null;
};

/**
 * Model-family hint from the persona's `model` string. Mirrors the runtime's
 * `personaModelFamily` (workforce cloud-llm) so the deploy-time pick agrees
 * with the run-time credential preference.
 */
function modelFamilyFromPersonaModel(model: string | null | undefined): string | null {
  const normalized = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!normalized) return null;
  if (normalized.startsWith("openrouter/")) return "openrouter";
  if (normalized.startsWith("opencode/")) return "opencode";
  if (normalized.startsWith("anthropic/") || normalized.includes("claude")) return "anthropic";
  if (
    normalized.startsWith("openai/")
    || normalized.startsWith("openai-codex/")
    || normalized.includes("gpt-")
    || normalized.startsWith("o1")
    || normalized.startsWith("o3")
    || normalized.startsWith("o4")
    || normalized.includes("codex")
  ) {
    return "openai";
  }
  if (normalized.startsWith("google/") || normalized.includes("gemini")) return "google";
  return null;
}

function modelFamilyFromPersonaHarness(harness: string | null | undefined): string | null {
  const normalized = typeof harness === "string" ? harness.trim().toLowerCase() : "";
  if (!normalized) return null;
  if (normalized === "claude" || normalized === "anthropic") return "anthropic";
  if (normalized === "codex" || normalized === "chatgpt" || normalized === "openai") return "openai";
  if (normalized === "gemini" || normalized === "google") return "google";
  if (normalized === "openrouter") return "openrouter";
  if (normalized === "opencode") return "opencode";
  return null;
}

/**
 * Shapes `resolveCredentialValue` can actually turn into a runtime env var.
 * OpenAI subscription credentials stay off OPENAI_API_KEY because those
 * bearers are not platform API keys (probe-verified 2026-06-04 — auth
 * accepted, platform API returned quota/scope walls). They are resolvable only
 * through CODEX_OAUTH_CREDENTIAL for the runtime's codex-backend leg.
 */
function isRuntimeResolvableShape(row: ProviderCredentialRow): boolean {
  const provider = normalizeModelProvider(row.model_provider);
  if (!provider || !PROVIDER_API_KEY_ENV[provider]) return false;
  if (row.auth_type === "oauth_token" && provider !== "anthropic") {
    return false;
  }
  if (row.auth_type === "provider_oauth" && provider !== "anthropic" && provider !== "openai") {
    return false;
  }
  return true;
}

/**
 * Implicit credential selection for `useSubscription: true` personas deployed
 * without explicit `credentialSelections` (e.g. pre-#197 CLI deploys, which
 * never stamped the oauth legs). The flag is the user's standing consent to
 * run this persona's inference on their connected subscription, so resolve
 * the deploying user's ACTIVE credential the same way the web wizard's
 * default would have: active+connected rows only, persona model family
 * preferred, anthropic next (the family the runtime falls back to), first
 * active row last. Resolution reuses `resolveCredentialRow`, so the refresh
 * seam and the CLAUDE_CODE_OAUTH_TOKEN env mapping apply unchanged.
 */
export async function resolveSubscriptionFallbackEnv(
  input: ResolveSubscriptionFallbackEnvInput,
): Promise<ResolveProviderCredentialRuntimeEnvResult> {
  const result = await getDb().execute(sql`
    SELECT id, workspace_id, user_id, model_provider, auth_type, status
    FROM provider_credentials
    WHERE workspace_id = ${input.workspaceId}
      AND user_id = ${input.userId}
      AND status = 'connected'
      AND is_active = true
    ORDER BY
      CASE lower(model_provider)
        WHEN 'anthropic' THEN 0
        WHEN 'claude' THEN 0
        WHEN 'openai' THEN 1
        WHEN 'codex' THEN 1
        WHEN 'google' THEN 2
        WHEN 'gemini' THEN 2
        WHEN 'openrouter' THEN 3
        WHEN 'opencode' THEN 4
        ELSE 4
      END ASC,
      model_provider ASC,
      updated_at DESC,
      created_at DESC,
      id ASC
  `);
  const rows = rowsOf<ProviderCredentialRow>(result).filter(isRuntimeResolvableShape);
  if (rows.length === 0) {
    return { env: {}, credentials: [] };
  }

  const preferred =
    modelFamilyFromPersonaModel(input.personaModel)
    ?? modelFamilyFromPersonaHarness(input.personaHarness);
  const pick =
    (preferred
      ? rows.find((row) => normalizeModelProvider(row.model_provider) === preferred)
      : undefined)
    ?? rows.find((row) => normalizeModelProvider(row.model_provider) === "anthropic")
    ?? rows[0];
  const provider = normalizeModelProvider(pick.model_provider);
  if (!provider) {
    return { env: {}, credentials: [] };
  }

  const resolved = await resolveCredentialRow({
    userId: input.userId,
    provider,
    credential: pick,
    credentialStoreRef: { current: null },
  });
  return { env: resolved.env, credentials: [resolved.runtimeCredential] };
}

export async function resolveProviderCredentialRuntimeEnvById(
  input: ResolveProviderCredentialByIdInput,
): Promise<ResolveProviderCredentialByIdResult> {
  const providerCredentialId = input.providerCredentialId.trim();
  if (!providerCredentialId) {
    throw new Error("Invalid provider credential id");
  }

  const credential = await readProviderCredentialById(input.workspaceId, providerCredentialId);
  const provider = normalizeModelProvider(credential.model_provider);
  if (!provider) {
    throw new Error(`Unsupported provider credential selection for ${credential.model_provider}`);
  }
  providerApiKeyEnv(provider);

  const resolved = await resolveCredentialRow({
    userId: input.userId,
    provider,
    credential,
    credentialStoreRef: { current: null },
  });

  return {
    env: resolved.env,
    credential: resolved.runtimeCredential,
    modelProvider: provider,
  };
}

/**
 * Derive the `ctx.llm` runtime env from the SAME harness CLI credential blob
 * that gets mounted into the sandbox auth file (`~/.claude/.credentials.json`
 * for anthropic, `~/.codex/auth.json` for openai/codex). The owner's design
 * intent: if the sandbox already carries the subscription auth the harness
 * uses, `ctx.llm` should be able to use that same in-sandbox credential rather
 * than requiring a separately-selected `provider_credentials` row.
 *
 * Mirrors the env mapping `resolveCredentialRow` produces:
 *   - anthropic subscription/setup-token  → CLAUDE_CODE_OAUTH_TOKEN (Bearer)
 *   - openai/codex OAuth blob             → CODEX_OAUTH_CREDENTIAL (structured)
 *
 * Security invariant preserved: a ChatGPT OAuth token is NEVER emitted as
 * OPENAI_API_KEY. The codex leg ships the structured blob (tokens.access_token
 * + account_id) so `ctx.llm`'s codex-backend path (chatgpt.com/backend-api +
 * chatgpt-account-id) authenticates exactly the way the codex harness does.
 *
 * `credentialJson` is expected to already be refreshed by the caller
 * (mountHarnessCliCredential goes through refreshHarnessCliCredentialIfStale).
 * Returns `{}` when the blob carries nothing usable for `ctx.llm` so callers
 * can treat it as a best-effort fallback that never fails a delivery.
 */
export function deriveCtxLlmEnvFromHarnessCredential(input: {
  provider: string;
  credentialJson: string;
}): Record<string, string> {
  const provider = normalizeModelProvider(input.provider);
  const credentialJson = input.credentialJson?.trim();
  if (!provider || !credentialJson) {
    return {};
  }

  if (provider === "anthropic") {
    const token =
      extractAnthropicSubscriptionAccessToken(credentialJson)
      ?? extractAnthropicOauthToken(credentialJson);
    return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
  }

  if (provider === "openai") {
    // Ship the structured codex blob verbatim — `ctx.llm` parses
    // tokens.access_token + account_id and calls the codex backend. Never an
    // OPENAI_API_KEY: a ChatGPT OAuth bearer is not a platform API key.
    return isUsableCodexOauthCredential(credentialJson)
      ? { CODEX_OAUTH_CREDENTIAL: credentialJson }
      : {};
  }

  return {};
}

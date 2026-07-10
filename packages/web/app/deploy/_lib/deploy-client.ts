import { toAppPath } from "@/lib/app-path";
import type { DeployMode, DeployResult, HarnessSource, PersonaSummary, ResolvedPersona } from "./types";

const CONNECT_PROVIDER_RE = /^[a-z0-9-]+$/;

function fakeAgentId(slug: string): string {
  // Deterministic-ish demo id so the success page has something stable to show.
  const suffix = Math.abs(
    Array.from(slug).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7),
  )
    .toString(16)
    .padStart(8, "0")
    .slice(0, 8);
  return `demo-${slug}-${suffix}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DeployArgs {
  mode: DeployMode;
  workspaceId: string;
  resolved: ResolvedPersona;
  inputs: Record<string, string>;
  credentialSelections: Record<string, string>;
  harnessSource: HarnessSource | null;
  onProgress?: (message: string) => void;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;

  try {
    const payload = JSON.parse(text) as { error?: string; message?: string };
    return payload.error || payload.message || fallback;
  } catch {
    return text;
  }
}

async function readCredentialId(response: Response, fallback: string): Promise<string> {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, fallback));
  }
  const payload = (await response.json()) as { providerCredentialId?: string; id?: string };
  const credentialId = payload.providerCredentialId ?? payload.id;
  if (!credentialId) throw new Error(fallback);
  return credentialId;
}

export function providerCredentialConnectCommand(modelProvider: string | null | undefined): string {
  const normalized = modelProvider?.trim().toLowerCase();
  const provider = normalized && CONNECT_PROVIDER_RE.test(normalized) ? normalized : "openai";
  return `npx agent-relay cloud connect ${provider}`;
}

export function subscriptionCredentialMissingMessage(modelProvider: string | null | undefined): string {
  if (modelProvider?.trim().toLowerCase() === "anthropic") {
    return "No active Claude subscription credential is connected. Return to the Claude subscription setup-token panel, run `claude setup-token` on your machine, and paste the token there.";
  }
  return `No active subscription credentials are connected. Run \`${providerCredentialConnectCommand(modelProvider)}\`, mark the credential Active, then deploy again.`;
}

const PROVIDER_OAUTH_AUTH_TYPES = new Set(["provider_oauth"]);
const ANTHROPIC_SUBSCRIPTION_AUTH_TYPES = new Set(["provider_oauth", "oauth_token"]);

function subscriptionAuthTypes(modelProvider: string): Set<string> {
  // oauth_token is the Claude setup-token shape. Keep every other provider on
  // provider_oauth so an API-key or unrelated token row cannot satisfy the
  // subscription readiness gate.
  return modelProvider === "anthropic"
    ? ANTHROPIC_SUBSCRIPTION_AUTH_TYPES
    : PROVIDER_OAUTH_AUTH_TYPES;
}

/**
 * Find the user's ACTIVE credential for a model provider (the radio
 * selection on the Cloud agents page). Returns null when none is active,
 * the active one isn't connected, or the lookup fails — callers fall back
 * to their endpoint-specific flow.
 */
async function findActiveProviderCredentialId(
  modelProvider: string,
  allowedAuthTypes?: Set<string>,
): Promise<string | null> {
  try {
    const response = await fetch(toAppPath("/api/v1/cloud-agents"), {
      credentials: "include",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      agents?: Array<{
        id: string;
        modelProvider?: string;
        authType?: string;
        isActive?: boolean;
        status?: string;
      }>;
    };
    const active = payload.agents?.find(
      (agent) =>
        agent.modelProvider === modelProvider &&
        (!allowedAuthTypes || allowedAuthTypes.has(agent.authType ?? "")) &&
        agent.isActive === true &&
        (agent.status ?? "").toLowerCase() === "connected",
    );
    return active?.id ?? null;
  } catch {
    return null;
  }
}

function personaForDeploy(persona: unknown, harnessSource: HarnessSource | null): unknown {
  if (harnessSource !== "managed" || !persona || typeof persona !== "object" || Array.isArray(persona)) {
    return persona;
  }
  // Web-only bridge: CLI rejects managed/plan deploys for subscription personas before launch.
  return {
    ...persona,
    useSubscription: false,
  };
}

export async function hasActiveSubscriptionCredential(modelProvider: string | null | undefined): Promise<boolean> {
  const provider = modelProvider?.trim().toLowerCase();
  if (!provider) return false;
  return Boolean(await findActiveProviderCredentialId(provider, subscriptionAuthTypes(provider)));
}

export async function connectAnthropicSetupToken(input: {
  workspaceId: string;
  token: string;
  label: string;
}): Promise<string> {
  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/provider-credentials/setup-token`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: input.token.trim(), label: input.label }),
    },
  );

  return readCredentialId(response, "Failed to connect Claude setup-token.");
}

export async function createModelCredentialSelection(input: {
  workspaceId: string;
  persona: PersonaSummary;
  harnessSource: HarnessSource | null;
  byokKey: string;
}): Promise<Record<string, string>> {
  const modelProvider = input.persona.modelProvider?.trim();
  if (!input.persona.harness || !modelProvider || !input.harnessSource) {
    return {};
  }

  // BYOK with a typed key and explicit managed-key selection both request
  // specific credential material — never silently substitute the active one.
  // Other sources default to the user's active credential when one is connected
  // (this is what the Cloud agents "Set active" radio controls), with oauth
  // narrowed to subscription credentials so a ChatGPT subscription pick cannot
  // reuse an active OpenAI API-key row.
  const wantsNewByok = input.harnessSource === "byok" && input.byokKey.trim().length > 0;
  if (!wantsNewByok && input.harnessSource !== "managed") {
    const activeId = await findActiveProviderCredentialId(
      modelProvider,
      input.harnessSource === "oauth" ? subscriptionAuthTypes(modelProvider) : undefined,
    );
    if (activeId) {
      return { [modelProvider]: activeId };
    }
  }

  if (input.harnessSource === "oauth") {
    // The inline provider flow must finish and activate its credential before
    // deployment reaches this point.
    throw new Error(subscriptionCredentialMissingMessage(modelProvider));
  }

  const endpoint = input.harnessSource === "byok" ? "byok" : "managed";
  const body = input.harnessSource === "byok"
    ? {
        modelProvider,
        key: input.byokKey,
        label: `${input.persona.name} BYOK`,
      }
    : { modelProvider };

  const response = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(input.workspaceId)}/provider-credentials/${endpoint}`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  const providerCredentialId = await readCredentialId(
    response,
    `Failed to prepare ${modelProvider} model credential.`,
  );
  return { [modelProvider]: providerCredentialId };
}

/**
 * Deploy the persona. Demo mode simulates the cloud round-trip with progress
 * messages so the wizard's deploy animation runs end-to-end. Live mode POSTs
 * the compiled bundle to the real deployments endpoint.
 */
export async function deployPersona(args: DeployArgs): Promise<DeployResult> {
  const { resolved, mode } = args;

  if (mode === "demo" || resolved.demo || !resolved.bundle) {
    args.onProgress?.("Staging persona bundle…");
    await sleep(700);
    args.onProgress?.("Provisioning runtime…");
    await sleep(800);
    args.onProgress?.("Registering triggers…");
    await sleep(600);
    args.onProgress?.("Agent is live.");
    return {
      agentId: fakeAgentId(resolved.summary.slug),
      deploymentId: `demo-deployment-${resolved.summary.slug}`,
      status: "ready",
      demo: true,
    };
  }

  args.onProgress?.("Uploading bundle to cloud…");
  const res = await fetch(
    toAppPath(`/api/v1/workspaces/${encodeURIComponent(args.workspaceId)}/deployments`),
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona: personaForDeploy(resolved.persona, args.harnessSource),
        agent: resolved.agent,
        summary: {
          imageUrl: resolved.summary.imageUrl,
        },
        bundle: resolved.bundle,
        inputs: args.inputs,
        credentialSelections: args.credentialSelections,
        credential_selections: args.credentialSelections,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Deploy failed (${res.status}). ${text.slice(0, 200)}`.trim());
  }
  const payload = (await res.json()) as {
    agentId?: string;
    deploymentId?: string;
    status?: string;
  };
  if (!payload.agentId || !payload.deploymentId) {
    throw new Error("Deploy response missing agentId/deploymentId.");
  }
  args.onProgress?.("Agent is live.");
  return {
    agentId: payload.agentId,
    deploymentId: payload.deploymentId,
    status: payload.status ?? "ready",
    demo: false,
  };
}

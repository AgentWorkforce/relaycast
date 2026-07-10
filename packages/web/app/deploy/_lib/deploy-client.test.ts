import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectAnthropicSetupToken,
  createModelCredentialSelection,
  deployPersona,
  hasActiveSubscriptionCredential,
  providerCredentialConnectCommand,
  subscriptionCredentialMissingMessage,
} from "./deploy-client";
import type { HarnessSource, PersonaSummary, ResolvedPersona } from "./types";

const persona = {
  name: "Test Persona",
  slug: "test-persona",
  harness: "claude",
  modelProvider: "anthropic",
} as unknown as PersonaSummary;

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(handler: (url: string) => { status?: number; payload?: unknown }) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const result = handler(url);
      return new Response(JSON.stringify(result.payload ?? {}), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

function selection(harnessSource: HarnessSource, byokKey = "") {
  return createModelCredentialSelection({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    persona,
    harnessSource,
    byokKey,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createModelCredentialSelection — active credential default", () => {
  it("uses the active connected credential instead of minting a managed one", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              { id: "cred-inactive", modelProvider: "anthropic", isActive: false, status: "connected" },
              { id: "cred-active", modelProvider: "anthropic", isActive: true, status: "connected" },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-active" });
    expect(calls).toHaveLength(1); // no POST to /provider-credentials/managed
  });

  it("falls back to the managed endpoint when no active credential exists", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return { payload: { agents: [] } };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-managed" });
    expect(calls.map((call) => call.url)).toHaveLength(2);
  });

  it("managed source mints relay-managed material without active credential reuse", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("managed")).resolves.toEqual({ anthropic: "cred-managed" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/provider-credentials/managed");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ modelProvider: "anthropic" }));
  });

  it("managed source ignores an active OpenAI subscription credential", async () => {
    const openaiPersona = {
      ...persona,
      harness: "codex",
      modelProvider: "openai",
      useSubscription: true,
    } as PersonaSummary;
    const calls = stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-oauth",
                modelProvider: "openai",
                authType: "provider_oauth",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-openai-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(createModelCredentialSelection({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      persona: openaiPersona,
      harnessSource: "managed",
      byokKey: "",
    })).resolves.toEqual({ openai: "cred-openai-managed" });
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => !call.url.includes("/api/v1/cloud-agents"))).toBe(true);
    expect(calls[0]?.url).toContain("/provider-credentials/managed");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ modelProvider: "openai" }));
  });

  it("ignores an active credential that is not connected", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{ id: "cred-dead", modelProvider: "anthropic", isActive: true, status: "failed" }],
          },
        };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-managed" });
  });

  it("byok with a typed key always mints new material, even with an active credential", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/provider-credentials/byok")) {
        return { status: 201, payload: { providerCredentialId: "cred-byok" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("byok", "sk-ant-explicit")).resolves.toEqual({ anthropic: "cred-byok" });
    // active lookup is skipped entirely for explicit byok material
    expect(calls.every((call) => !call.url.includes("/api/v1/cloud-agents"))).toBe(true);
  });

  it("oauth source uses the active credential when present", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-oauth",
              modelProvider: "anthropic",
              authType: "provider_oauth",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("oauth")).resolves.toEqual({ anthropic: "cred-oauth" });
  });

  it("oauth source recognizes an active Anthropic setup-token credential", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-setup-token",
              modelProvider: "anthropic",
              authType: "oauth_token",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("oauth")).resolves.toEqual({ anthropic: "cred-setup-token" });
  });

  it("oauth source ignores an active BYOK credential", async () => {
    const openaiPersona = {
      ...persona,
      harness: "codex",
      modelProvider: "openai",
      useSubscription: true,
    } as PersonaSummary;
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-byok",
                modelProvider: "openai",
                authType: "byo_api_key",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(createModelCredentialSelection({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      persona: openaiPersona,
      harnessSource: "oauth",
      byokKey: "",
    })).rejects.toThrow(/npx agent-relay cloud connect openai/);
  });

  it("oauth source stamps the active OpenAI subscription credential selection", async () => {
    const openaiPersona = {
      ...persona,
      harness: "codex",
      modelProvider: "openai",
      useSubscription: true,
    } as PersonaSummary;
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-oauth",
                modelProvider: "openai",
                authType: "provider_oauth",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(createModelCredentialSelection({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      persona: openaiPersona,
      harnessSource: "oauth",
      byokKey: "",
    })).resolves.toEqual({ openai: "cred-openai-oauth" });
  });

  it("does not treat an OpenAI oauth_token row as a subscription credential", async () => {
    const openaiPersona = {
      ...persona,
      harness: "codex",
      modelProvider: "openai",
      useSubscription: true,
    } as PersonaSummary;
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-openai-wrong-shape",
              modelProvider: "openai",
              authType: "oauth_token",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(createModelCredentialSelection({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      persona: openaiPersona,
      harnessSource: "oauth",
      byokKey: "",
    })).rejects.toThrow(/npx agent-relay cloud connect openai/);
  });

  it("does not treat an active Anthropic API-key row as a subscription credential", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-anthropic-byok",
              modelProvider: "anthropic",
              authType: "byo_api_key",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("oauth")).rejects.toThrow(/Claude subscription setup-token panel/);
  });

  it("oauth source without an active credential throws an actionable error", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return { payload: { agents: [] } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("oauth")).rejects.toThrow(/Claude subscription setup-token panel/);
  });

  it("reports whether an active subscription credential exists", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [
              {
                id: "cred-openai-oauth",
                modelProvider: "openai",
                authType: "provider_oauth",
                isActive: true,
                status: "connected",
              },
              {
                id: "cred-anthropic-setup-token",
                modelProvider: "anthropic",
                authType: "oauth_token",
                isActive: true,
                status: "connected",
              },
            ],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(hasActiveSubscriptionCredential("openai")).resolves.toBe(true);
    await expect(hasActiveSubscriptionCredential("anthropic")).resolves.toBe(true);
  });

  it("keeps oauth_token excluded from non-Anthropic readiness", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-openai-wrong-shape",
              modelProvider: "openai",
              authType: "oauth_token",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(hasActiveSubscriptionCredential("openai")).resolves.toBe(false);
  });

  it("does not let an active Anthropic API-key row satisfy subscription readiness", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return {
          payload: {
            agents: [{
              id: "cred-anthropic-byok",
              modelProvider: "anthropic",
              authType: "byo_api_key",
              isActive: true,
              status: "connected",
            }],
          },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(hasActiveSubscriptionCredential("anthropic")).resolves.toBe(false);
  });

  it("posts a Claude setup-token without logging it into the URL", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/provider-credentials/setup-token")) {
        return { status: 201, payload: { providerCredentialId: "cred-setup-token" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(connectAnthropicSetupToken({
      workspaceId: "workspace/one",
      token: "  setup-token-secret  ",
      label: "Test Persona Claude setup token",
    })).resolves.toBe("cred-setup-token");

    expect(calls[0]?.url).toContain("/workspaces/workspace%2Fone/provider-credentials/setup-token");
    expect(calls[0]?.url).not.toContain("setup-token-secret");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({
      token: "setup-token-secret",
      label: "Test Persona Claude setup token",
    }));
  });

  it("surfaces the setup_token_invalid route message", async () => {
    stubFetch((url) => {
      if (url.includes("/provider-credentials/setup-token")) {
        return {
          status: 400,
          payload: { error: "The Claude setup-token is invalid or expired.", code: "setup_token_invalid" },
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(connectAnthropicSetupToken({
      workspaceId: "workspace-1",
      token: "expired-token",
      label: "Claude setup token",
    })).rejects.toThrow("The Claude setup-token is invalid or expired.");
  });

  it("points Anthropic users at the inline setup-token panel", () => {
    expect(subscriptionCredentialMissingMessage("anthropic")).toContain("Claude subscription setup-token panel");
    expect(subscriptionCredentialMissingMessage("anthropic")).not.toContain("agent-relay cloud connect");
  });

  it("builds the cloud connect command with a safe provider fallback", () => {
    expect(providerCredentialConnectCommand("openai")).toBe("npx agent-relay cloud connect openai");
    expect(providerCredentialConnectCommand("Bad Provider!")).toBe("npx agent-relay cloud connect openai");
  });

  it("falls through to the endpoint flow when the active lookup fails", async () => {
    stubFetch((url) => {
      if (url.includes("/api/v1/cloud-agents")) {
        return { status: 500, payload: { error: "boom" } };
      }
      if (url.includes("/provider-credentials/managed")) {
        return { status: 201, payload: { providerCredentialId: "cred-managed" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await expect(selection("plan")).resolves.toEqual({ anthropic: "cred-managed" });
  });
});

describe("deployPersona", () => {
  function liveResolvedPersona(): ResolvedPersona {
    return {
      summary: {
        id: "repo-hygiene",
        name: "Repo Hygiene",
        description: "Keep repositories tidy.",
        slug: "repo-hygiene",
        harness: "codex",
        model: "gpt-5.5",
        modelProvider: "openai",
        useSubscription: true,
        integrations: [],
        inputs: [],
        triggers: [],
      },
      persona: {
        id: "repo-hygiene",
        name: "Repo Hygiene",
        harness: "codex",
        model: "gpt-5.5",
        useSubscription: true,
      },
      agent: { events: [] },
      bundle: {
        runner: "runner",
        agent: "agent",
        packageJson: {},
      },
      demo: false,
    };
  }

  it("clears useSubscription on the managed deploy request only", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/deployments")) {
        return { payload: { agentId: "agent-1", deploymentId: "deployment-1", status: "ready" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const resolved = liveResolvedPersona();

    await expect(deployPersona({
      mode: "live",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      resolved,
      inputs: {},
      credentialSelections: { openai: "cred-openai-managed" },
      harnessSource: "managed",
    })).resolves.toMatchObject({ agentId: "agent-1", deploymentId: "deployment-1" });

    const payload = JSON.parse(String(calls[0]?.init?.body)) as { persona?: { useSubscription?: boolean } };
    expect(payload.persona?.useSubscription).toBe(false);
    expect((resolved.persona as { useSubscription?: boolean }).useSubscription).toBe(true);
  });

  it("keeps useSubscription on the oauth deploy request", async () => {
    const calls = stubFetch((url) => {
      if (url.includes("/deployments")) {
        return { payload: { agentId: "agent-1", deploymentId: "deployment-1", status: "ready" } };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await deployPersona({
      mode: "live",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      resolved: liveResolvedPersona(),
      inputs: {},
      credentialSelections: { openai: "cred-openai-oauth" },
      harnessSource: "oauth",
    });

    const payload = JSON.parse(String(calls[0]?.init?.body)) as { persona?: { useSubscription?: boolean } };
    expect(payload.persona?.useSubscription).toBe(true);
  });
});

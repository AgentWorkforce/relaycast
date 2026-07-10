import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inferHostedProviderKind,
  resolveHostedProviderEnvironment,
} from "./hosted-provider";

const { readWorkspaceSecretMock } = vi.hoisted(() => ({
  readWorkspaceSecretMock: vi.fn(),
}));

vi.mock("@/lib/proactive-runtime/secret-store", async () => {
  const actual = await vi.importActual("@/lib/proactive-runtime/secret-store");
  return {
    ...actual,
    readWorkspaceSecret: (...args: unknown[]) => readWorkspaceSecretMock(...args),
  };
});

vi.mock("@/lib/env", () => ({
  tryResourceValue: vi.fn((name: string) =>
    name === "SpecialistOpenrouterApiKey" ? "sk-openrouter-resource" : undefined
  ),
}));

describe("hosted provider environment resolution", () => {
  beforeEach(() => {
    readWorkspaceSecretMock.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_BASE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_API_BASE;
  });

  it("infers provider kinds from model names and secret hints", () => {
    expect(inferHostedProviderKind("gpt-5")).toBe("openai");
    expect(inferHostedProviderKind("claude-sonnet-4-5")).toBe("anthropic");
    expect(inferHostedProviderKind("openrouter/auto")).toBe("openrouter");
    expect(inferHostedProviderKind("custom-model", "google-api-key")).toBe("google");
  });

  it("pulls managed credentials from the current environment", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.OPENAI_BASE_URL = "https://openai.example.test";

    await expect(resolveHostedProviderEnvironment({
      relayWorkspaceId: "rw_support",
      model: "gpt-5",
      provider: { mode: "managed" },
      managedResolutionSource: "web-deploy-manager",
    })).resolves.toEqual({
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_BASE_URL: "https://openai.example.test",
    });
  });

  it("prefers linked SST resources for managed provider credentials when available", async () => {
    process.env.OPENROUTER_API_KEY = "sk-openrouter-env";

    await expect(resolveHostedProviderEnvironment({
      relayWorkspaceId: "rw_support",
      model: "openrouter/auto",
      provider: { mode: "managed" },
      managedResolutionSource: "web-deploy-manager",
    })).resolves.toEqual({
      OPENROUTER_API_KEY: "sk-openrouter-resource",
    });
  });

  it("rejects managed resolution outside the web deploy-manager boundary", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";

    await expect(resolveHostedProviderEnvironment({
      relayWorkspaceId: "rw_support",
      model: "gpt-5",
      provider: { mode: "managed" },
    })).rejects.toThrow(
      "Managed provider credentials may only be resolved from the web deploy-manager runtime",
    );
  });

  it("hydrates BYOK credentials from the workspace secret store", async () => {
    readWorkspaceSecretMock.mockResolvedValue({
      name: "anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
      value: "sk-ant-test",
      maskedValue: "sk****st",
    });

    await expect(resolveHostedProviderEnvironment({
      relayWorkspaceId: "rw_support",
      model: "claude-sonnet-4-5",
      provider: {
        mode: "byok",
        secretRef: "anthropic-api-key",
      },
    })).resolves.toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test",
    });
  });
});

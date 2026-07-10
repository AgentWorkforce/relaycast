import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSst = vi.hoisted(() => ({
  resources: {} as Record<string, { value?: string }>,
}));

vi.mock("sst", () => ({
  Resource: mockSst.resources,
}));

const ENV_KEYS_TO_RESET = [
  "RelayfileUrl",
  "RELAYFILE_URL",
  "RelayauthUrl",
  "RELAYAUTH_URL",
  "WEB_RELAYAUTH_URL",
  "RELAYAUTH_API_KEY",
  "WEB_RELAYAUTH_API_KEY",
];

async function loadRelayfile() {
  vi.resetModules();
  return import("./relayfile");
}

describe("resolveRelayfileConfig", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS_TO_RESET) {
      delete process.env[key];
    }
    for (const key of Object.keys(mockSst.resources)) {
      delete mockSst.resources[key];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers SST Resource values over environment fallbacks", async () => {
    mockSst.resources.RelayfileUrl = { value: "https://relayfile.resource.test" };
    mockSst.resources.RelayauthUrl = { value: "https://relayauth.resource.test" };
    mockSst.resources.WebRelayauthApiKey = { value: "resource-api-key" };

    vi.stubEnv("RelayfileUrl", "https://relayfile.env.test");
    vi.stubEnv("WEB_RELAYAUTH_URL", "https://relayauth.env.test");
    vi.stubEnv("WEB_RELAYAUTH_API_KEY", "env-api-key");

    const { resolveRelayfileConfig } = await loadRelayfile();

    expect(resolveRelayfileConfig()).toEqual({
      relayfileUrl: "https://relayfile.resource.test",
      relayAuthUrl: "https://relayauth.resource.test",
      relayAuthApiKey: "resource-api-key",
    });
  });

  it("falls back to environment values when SST resources are unavailable", async () => {
    vi.stubEnv("RELAYFILE_URL", "https://relayfile.env.test");
    vi.stubEnv("RELAYAUTH_URL", "https://relayauth.env.test");
    vi.stubEnv("RELAYAUTH_API_KEY", "env-api-key");

    const { resolveRelayfileConfig } = await loadRelayfile();

    expect(resolveRelayfileConfig()).toEqual({
      relayfileUrl: "https://relayfile.env.test",
      relayAuthUrl: "https://relayauth.env.test",
      relayAuthApiKey: "env-api-key",
    });
  });

  it("uses the public RelayAuth default when only Relayfile is configured", async () => {
    vi.stubEnv("RELAYFILE_URL", "https://relayfile.env.test");

    const { resolveRelayfileConfig } = await loadRelayfile();

    expect(resolveRelayfileConfig()).toEqual({
      relayfileUrl: "https://relayfile.env.test",
      relayAuthUrl: "https://api.relayauth.dev",
      relayAuthApiKey: "",
    });
  });

  it("resolves RelayAuth config without requiring RelayfileUrl", async () => {
    mockSst.resources.RelayauthUrl = { value: "https://relayauth.resource.test" };
    mockSst.resources.WebRelayauthApiKey = { value: "resource-api-key" };

    const { resolveRelayAuthConfig } = await loadRelayfile();

    expect(resolveRelayAuthConfig()).toEqual({
      relayAuthUrl: "https://relayauth.resource.test",
      relayAuthApiKey: "resource-api-key",
    });
  });
});

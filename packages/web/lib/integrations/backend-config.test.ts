import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSst = vi.hoisted(() => ({
  composioApiKey: undefined as string | undefined,
  nangoSecretKey: undefined as string | undefined,
  throwComposioApiKey: true,
  throwNangoSecretKey: true,
}));

vi.mock("sst", () => ({
  Resource: {
    get ComposioApiKey() {
      if (mockSst.throwComposioApiKey) {
        throw new Error("missing ComposioApiKey binding");
      }

      return { value: mockSst.composioApiKey };
    },
    get NangoSecretKey() {
      if (mockSst.throwNangoSecretKey) {
        throw new Error("missing NangoSecretKey binding");
      }

      return { value: mockSst.nangoSecretKey };
    },
  },
}));

import {
  BackendNotConfiguredError,
  resolveProviderBackendConfig,
} from "./backend-config";

describe("resolveProviderBackendConfig", () => {
  beforeEach(() => {
    mockSst.composioApiKey = undefined;
    mockSst.nangoSecretKey = undefined;
    mockSst.throwComposioApiKey = true;
    mockSst.throwNangoSecretKey = true;
    delete process.env.NANGO_SECRET_KEY;
    delete process.env.NANGO_HOST;
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_BASE_URL;
    delete process.env.NEXT_PUBLIC_SST_STAGE;
    delete process.env.SST_STAGE;
  });

  it("resolves nango config from the SST resource", () => {
    mockSst.throwNangoSecretKey = false;
    mockSst.nangoSecretKey = " nango-resource-key ";

    expect(resolveProviderBackendConfig("nango")).toEqual({
      backend: "nango",
      apiKey: "nango-resource-key",
    });
  });

  it("falls back to local nango env when the SST resource is empty", () => {
    mockSst.throwNangoSecretKey = false;
    mockSst.nangoSecretKey = "   ";
    process.env.NANGO_SECRET_KEY = "nango-env-key";

    expect(resolveProviderBackendConfig("nango")).toEqual({
      backend: "nango",
      apiKey: "nango-env-key",
    });
  });

  it("falls back to local nango env and forwards the optional base URL", () => {
    process.env.NANGO_SECRET_KEY = "nango-env-key";
    process.env.NANGO_HOST = "https://nango.example.test";

    expect(resolveProviderBackendConfig("nango")).toEqual({
      backend: "nango",
      apiKey: "nango-env-key",
      baseUrl: "https://nango.example.test",
    });
  });

  it("throws a typed error when nango is not configured", () => {
    expect(() => resolveProviderBackendConfig("nango")).toThrow(
      BackendNotConfiguredError,
    );
  });

  it("does not fall back to env-only nango secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.NANGO_SECRET_KEY = "nango-env-key";

    try {
      expect(() => resolveProviderBackendConfig("nango")).toThrow(
        BackendNotConfiguredError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("resolves composio config from local env without an SST resource", () => {
    process.env.COMPOSIO_API_KEY = "composio-env-key";
    process.env.COMPOSIO_BASE_URL = "https://composio.example.test";

    expect(resolveProviderBackendConfig("composio")).toEqual({
      backend: "composio",
      apiKey: "composio-env-key",
      baseUrl: "https://composio.example.test",
    });
  });

  it("resolves composio config from the SST resource before local env", () => {
    mockSst.throwComposioApiKey = false;
    mockSst.composioApiKey = " composio-resource-key ";
    process.env.COMPOSIO_API_KEY = "composio-env-key";

    expect(resolveProviderBackendConfig("composio")).toEqual({
      backend: "composio",
      apiKey: "composio-resource-key",
    });
  });

  it("throws a typed error when composio is not configured", () => {
    expect(() => resolveProviderBackendConfig("composio")).toThrow(
      BackendNotConfiguredError,
    );
  });

  it("does not fall back to env-only composio secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.COMPOSIO_API_KEY = "composio-env-key";

    try {
      expect(() => resolveProviderBackendConfig("composio")).toThrow(
        BackendNotConfiguredError,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

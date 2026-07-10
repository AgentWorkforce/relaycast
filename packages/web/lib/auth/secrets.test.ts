import { afterEach, describe, expect, it, vi } from "vitest";

const originalAuthSessionSecret = process.env.AUTH_SESSION_SECRET;

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("sst");
  if (originalAuthSessionSecret === undefined) {
    delete process.env.AUTH_SESSION_SECRET;
  } else {
    process.env.AUTH_SESSION_SECRET = originalAuthSessionSecret;
  }
});

async function importSecretsWithResource(resourceValue: string) {
  vi.doMock("sst", () => ({
    Resource: {
      AuthSessionSecret: { value: resourceValue },
    },
  }));

  return import("./secrets");
}

async function importSecretsWithMissingResource() {
  vi.doMock("sst", () => ({
    Resource: {
      AuthSessionSecret: {
        get value(): string {
          throw new Error("SST Resource unavailable");
        },
      },
    },
  }));

  return import("./secrets");
}

describe("getAuthSessionSecret", () => {
  it("prefers the SST Resource secret over AUTH_SESSION_SECRET", async () => {
    process.env.AUTH_SESSION_SECRET = "env-secret";
    const { getAuthSessionSecret } = await importSecretsWithResource("resource-secret");

    expect(getAuthSessionSecret()).toBe("resource-secret");
  });

  it("falls back to AUTH_SESSION_SECRET when the SST Resource is unavailable", async () => {
    process.env.AUTH_SESSION_SECRET = "env-secret";
    const { getAuthSessionSecret } = await importSecretsWithMissingResource();

    expect(getAuthSessionSecret()).toBe("env-secret");
  });

  it("rethrows the SST Resource error when no fallback secret is configured", async () => {
    delete process.env.AUTH_SESSION_SECRET;
    const { getAuthSessionSecret } = await importSecretsWithMissingResource();

    expect(() => getAuthSessionSecret()).toThrow("SST Resource unavailable");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sst", () => ({
  Resource: {
    SomeSecret: { value: "resource-value" },
    EmptySecret: { value: "" },
    WhitespaceSecret: { value: "   " },
    NotASecret: { bucketName: "my-bucket" },
  },
}));

const ENV_KEYS_TO_RESET = ["RELAYFILE_TEST_VAR"];

describe("env helpers", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS_TO_RESET) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("optionalEnv returns the value when set", async () => {
    const { optionalEnv } = await import("./env");
    vi.stubEnv("RELAYFILE_TEST_VAR", "hello");
    expect(optionalEnv("RELAYFILE_TEST_VAR")).toBe("hello");
  });

  it("optionalEnv returns undefined when unset or empty", async () => {
    const { optionalEnv } = await import("./env");
    expect(optionalEnv("RELAYFILE_TEST_VAR")).toBeUndefined();
    vi.stubEnv("RELAYFILE_TEST_VAR", "");
    expect(optionalEnv("RELAYFILE_TEST_VAR")).toBeUndefined();
  });

  it("requiredEnv throws when missing", async () => {
    const { requiredEnv } = await import("./env");
    expect(() => requiredEnv("RELAYFILE_TEST_VAR")).toThrow(/Missing required env var/);
  });

  it("tryResourceValue returns the value for bound secrets", async () => {
    const { tryResourceValue } = await import("./env");
    expect(tryResourceValue("SomeSecret")).toBe("resource-value");
  });

  it("tryResourceValue returns undefined for empty values", async () => {
    const { tryResourceValue } = await import("./env");
    expect(tryResourceValue("EmptySecret")).toBeUndefined();
    expect(tryResourceValue("WhitespaceSecret")).toBeUndefined();
  });

  it("tryResourceValue returns undefined for non-string `.value`", async () => {
    const { tryResourceValue } = await import("./env");
    expect(tryResourceValue("NotASecret")).toBeUndefined();
  });

  it("tryResourceValue returns undefined for unknown resource names", async () => {
    const { tryResourceValue } = await import("./env");
    expect(tryResourceValue("NoSuchResource")).toBeUndefined();
  });
});

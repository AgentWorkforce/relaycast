import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runtime DB selection (Neon serverless on the Worker, node-postgres on the
// Lambda) lives in @cloud/core/db/client. The web entrypoint is now a thin
// delegating re-export.
const mocks = vi.hoisted(() => ({
  getCoreDb: vi.fn(() => ({ source: "core" })),
  setCoreDbForTesting: vi.fn(),
  readCoreDbRuntimeDiagnosticSnapshot: vi.fn(() => ({
    selectedDbClient: "node-postgres" as const,
  })),
}));

vi.mock("@cloud/core/db/client.js", () => ({
  getDb: mocks.getCoreDb,
  setDbForTesting: mocks.setCoreDbForTesting,
  readCoreDbRuntimeDiagnosticSnapshot: mocks.readCoreDbRuntimeDiagnosticSnapshot,
}));

vi.mock("./schema.js", () => ({}));

describe("web db entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates getDb() to the core client", async () => {
    const { getDb } = await import("./index");

    expect(getDb()).toEqual({ source: "core" });
    expect(mocks.getCoreDb).toHaveBeenCalledOnce();
  });

  it("forwards setDbForTesting to the core client", async () => {
    const { setDbForTesting } = await import("./index");

    setDbForTesting(null);

    expect(mocks.setCoreDbForTesting).toHaveBeenCalledWith(null);
  });

  it("exposes the core runtime diagnostic snapshot", async () => {
    const { readDbRuntimeDiagnosticSnapshot } = await import("./index");

    expect(readDbRuntimeDiagnosticSnapshot()).toMatchObject({
      selectedDbClient: "node-postgres",
    });
    expect(mocks.readCoreDbRuntimeDiagnosticSnapshot).toHaveBeenCalled();
  });
});

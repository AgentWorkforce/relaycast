import { afterEach, describe, expect, it, vi } from "vitest";

// The factory is now a thin shim over the core client: runtime selection and
// connection-string resolution live in client.ts / connection.ts.
vi.mock("./client.js", () => ({
  getDb: vi.fn(() => ({ _kind: "core-getDb" })),
  setDbForTesting: vi.fn(),
}));

vi.mock("./schema.js", () => ({}));

describe("selectDbClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to the core getDb()", async () => {
    const { selectDbClient } = await import("./factory.js");
    const { getDb } = await import("./client.js");

    const result = selectDbClient();

    expect(getDb).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ _kind: "core-getDb" });
  });

  it("re-exports setDbForTesting from the core client", async () => {
    const { setDbForTesting } = await import("./factory.js");
    const client = await import("./client.js");

    setDbForTesting(null as never);

    expect(client.setDbForTesting).toHaveBeenCalledWith(null);
  });
});

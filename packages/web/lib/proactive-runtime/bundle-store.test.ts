import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PersonaBundle } from "./persona-deploy";
import { loadBundle, storeBundle } from "./bundle-store";

const storage = vi.hoisted(() => ({
  createWorkflowStorageS3Client: vi.fn(),
  getWorkflowStorageObject: vi.fn(),
  putWorkflowStorageObject: vi.fn(),
  readWorkflowStorageBucket: vi.fn(),
}));

vi.mock("@/lib/storage", () => storage);

const bundle: PersonaBundle = {
  runner: "runner code",
  agent: "agent code",
  packageJson: { dependencies: { a: "1.0.0" }, scripts: { start: "node runner.mjs" } },
};

describe("persona bundle store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores bundles through WorkflowStorage by default", async () => {
    const result = await storeBundle(bundle);

    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(storage.putWorkflowStorageObject).toHaveBeenCalledWith({
      key: `persona-bundles/${result.sha256}.json`,
      body: JSON.stringify(bundle),
      contentType: "application/json",
    });
    expect(storage.createWorkflowStorageS3Client).not.toHaveBeenCalled();
  });

  it("loads bundles through WorkflowStorage by default", async () => {
    const text = JSON.stringify(bundle);
    storage.getWorkflowStorageObject.mockResolvedValue({
      body: new Response(text).body,
      size: text.length,
    });

    const loaded = await loadBundle("a".repeat(64));

    expect(loaded).toEqual(bundle);
    expect(storage.getWorkflowStorageObject).toHaveBeenCalledWith({
      key: `persona-bundles/${"a".repeat(64)}.json`,
    });
    expect(storage.createWorkflowStorageS3Client).not.toHaveBeenCalled();
  });
});

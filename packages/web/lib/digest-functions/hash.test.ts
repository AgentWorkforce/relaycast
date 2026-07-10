import { describe, expect, it } from "vitest";

import { contentHash } from "./hash";

describe("contentHash", () => {
  it("is deterministic", () => {
    const bundle = new Uint8Array([1, 2, 3, 4, 5]);
    expect(contentHash(bundle)).toBe(contentHash(bundle));
  });

  it("matches the sha256 hex prefix format", () => {
    const bundle = new Uint8Array([0]);
    expect(contentHash(bundle)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when a single byte changes", () => {
    const before = contentHash(new Uint8Array([1, 2, 3]));
    const after = contentHash(new Uint8Array([1, 2, 4]));
    expect(before).not.toBe(after);
  });
});

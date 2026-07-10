import { describe, expect, it } from "vitest";
import { applyMarkup, markupOnly } from "./markup";

describe("billing markup", () => {
  it("adds a flat 30 percent markup", () => {
    expect(markupOnly(1_000_000n)).toBe(300_000n);
    expect(applyMarkup(1_000_000n)).toBe(1_300_000n);
  });
});

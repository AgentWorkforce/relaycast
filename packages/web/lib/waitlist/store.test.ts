import { describe, expect, it } from "vitest";
import { inflateStanding } from "./store";

describe("inflateStanding", () => {
  it("offsets position by 1012 and grows total by 20 per signup over a 1012 base", () => {
    // signup #1 -> "#1013 of 1032"
    expect(inflateStanding(1, 1)).toEqual({ position: 1013, total: 1032 });
    // signup #2 -> "#1014 of 1052"
    expect(inflateStanding(2, 2)).toEqual({ position: 1014, total: 1052 });
    // signup #5 -> "#1017 of 1112"
    expect(inflateStanding(5, 5)).toEqual({ position: 1017, total: 1112 });
  });

  it("always keeps the displayed total above the displayed position", () => {
    for (let n = 1; n <= 500; n++) {
      const { position, total } = inflateStanding(n, n);
      expect(total).toBeGreaterThan(position);
    }
  });
});

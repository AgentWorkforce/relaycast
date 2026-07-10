import { describe, expect, it } from "vitest";

import { bundleSource } from "./bundle";
import {
  DigestFunctionSource,
  InvalidSourceError,
  QuotaExceededError,
} from "./types";

function src(overrides: Partial<DigestFunctionSource> = {}): DigestFunctionSource {
  return {
    runtime: "node20",
    entrypoint: "index.js",
    files: [
      { path: "index.js", contents: "export default () => 1;\n" },
      { path: "util.js", contents: "export const x = 1;\n" },
    ],
    ...overrides,
  };
}

describe("bundleSource", () => {
  it("is deterministic for identical input", () => {
    const a = bundleSource(src());
    const b = bundleSource(src());
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it("ignores input file order", () => {
    const ordered = bundleSource(src());
    const reversed = bundleSource(
      src({
        files: [
          { path: "util.js", contents: "export const x = 1;\n" },
          { path: "index.js", contents: "export default () => 1;\n" },
        ],
      }),
    );
    expect(Buffer.compare(Buffer.from(ordered), Buffer.from(reversed))).toBe(0);
  });

  it("changes when a single content byte changes", () => {
    const before = bundleSource(src());
    const after = bundleSource(
      src({
        files: [
          { path: "index.js", contents: "export default () => 2;\n" },
          { path: "util.js", contents: "export const x = 1;\n" },
        ],
      }),
    );
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).not.toBe(0);
  });

  it("changes when the entrypoint changes", () => {
    const before = bundleSource(src());
    const after = bundleSource(src({ entrypoint: "util.js" }));
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).not.toBe(0);
  });

  it("rejects empty files", () => {
    expect(() => bundleSource(src({ files: [] }))).toThrow(InvalidSourceError);
  });

  it("rejects missing entrypoint", () => {
    expect(() =>
      bundleSource(src({ entrypoint: "" } as unknown as DigestFunctionSource)),
    ).toThrow(InvalidSourceError);
  });

  it("rejects entrypoint not in files", () => {
    expect(() => bundleSource(src({ entrypoint: "missing.js" }))).toThrow(
      InvalidSourceError,
    );
  });

  it("rejects paths containing ..", () => {
    expect(() =>
      bundleSource(
        src({
          files: [
            { path: "index.js", contents: "export default () => 1;\n" },
            { path: "../escape.js", contents: "" },
          ],
        }),
      ),
    ).toThrow(InvalidSourceError);
  });

  it("rejects absolute paths", () => {
    expect(() =>
      bundleSource(
        src({
          files: [
            { path: "index.js", contents: "export default () => 1;\n" },
            { path: "/etc/passwd", contents: "" },
          ],
        }),
      ),
    ).toThrow(InvalidSourceError);
  });

  it("rejects duplicate paths", () => {
    expect(() =>
      bundleSource(
        src({
          files: [
            { path: "index.js", contents: "a" },
            { path: "index.js", contents: "b" },
          ],
        }),
      ),
    ).toThrow(InvalidSourceError);
  });

  it("rejects bundles that exceed the byte limit before concatenating", () => {
    expect(() => bundleSource(src(), 16)).toThrow(QuotaExceededError);
  });
});

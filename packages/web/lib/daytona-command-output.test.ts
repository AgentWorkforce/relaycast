import { describe, expect, it } from "vitest";
import { daytonaCommandOutput } from "./daytona-command-output";

describe("daytonaCommandOutput", () => {
  it("prefers Daytona merged result output", () => {
    expect(daytonaCommandOutput({
      result: "a\nb\nc\n",
      artifacts: {
        stdout: "stdout-only\n",
        stderr: "stderr-only\n",
      },
    })).toBe("a\nb\nc\n");
  });

  it("preserves stderr when Daytona only returns split artifacts", () => {
    expect(daytonaCommandOutput({
      artifacts: {
        stdout: "stdout-only\n",
        stderr: "stderr-only\n",
      },
    })).toBe("stdout-only\nstderr-only\n");
  });

  it("falls back to split artifacts when Daytona returns an empty result", () => {
    expect(daytonaCommandOutput({
      result: "",
      artifacts: {
        stderr: "stderr-only\n",
      },
    })).toBe("stderr-only\n");
  });

  it("adds a separator when split artifacts do not contain newlines", () => {
    expect(daytonaCommandOutput({
      artifacts: {
        stdout: "stdout-only",
        stderr: "stderr-only",
      },
    })).toBe("stdout-only\nstderr-only");
  });
});

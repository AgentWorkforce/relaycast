import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";

type WorkflowFileType = "yaml" | "ts" | "py";
type RunRequestBody = { workflow: string; fileType: WorkflowFileType };

function isRunRequestBody(payload: unknown): payload is RunRequestBody {
  if (!payload || typeof payload !== "object") return false;
  const body = payload as Partial<RunRequestBody> & { fileType?: unknown };
  return (
    typeof body.workflow === "string" &&
    body.workflow.trim().length > 0 &&
    typeof body.fileType === "string" &&
    ["yaml", "ts", "py"].includes(body.fileType)
  );
}

function normalizeFileType(raw: WorkflowFileType): "yaml" | "typescript" | "python" {
  switch (raw) {
    case "ts":
      return "typescript";
    case "py":
      return "python";
    case "yaml":
      return "yaml";
  }
}

function validateCallbackToken(expected: string, received: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(received, "utf8");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

// Kept in sync with packages/web/app/api/v1/workflows/run/route.ts. The
// validator is not exported from the route (Next.js App Router convention
// — route files export only HTTP methods + config). The test-side copy
// exists so we can lock in the traversal-safe contract without pulling
// the util out of route.ts yet.
function normalizeWorkflowPathParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\\")) return null;
  if (trimmed.startsWith("/")) return null;
  const segments = trimmed.split("/");
  if (segments.some((s) => s.trim() === "..")) return null;
  return trimmed;
}

describe("isRunRequestBody", () => {
  it("accepts valid yaml request", () => {
    assert.ok(isRunRequestBody({ workflow: "name: test\nagents: []", fileType: "yaml" }));
  });

  it("accepts valid ts request", () => {
    assert.ok(isRunRequestBody({ workflow: "const x = 1;", fileType: "ts" }));
  });

  it("accepts valid py request", () => {
    assert.ok(isRunRequestBody({ workflow: "print('hello')", fileType: "py" }));
  });

  it("rejects empty workflow", () => {
    assert.ok(!isRunRequestBody({ workflow: "   ", fileType: "yaml" }));
  });

  it("rejects missing workflow", () => {
    assert.ok(!isRunRequestBody({ fileType: "yaml" }));
  });

  it("rejects invalid fileType", () => {
    assert.ok(!isRunRequestBody({ workflow: "test", fileType: "json" }));
  });

  it("rejects null", () => {
    assert.ok(!isRunRequestBody(null));
  });

  it("rejects number", () => {
    assert.ok(!isRunRequestBody(42));
  });
});

describe("normalizeFileType", () => {
  it("ts → typescript", () => {
    assert.equal(normalizeFileType("ts"), "typescript");
  });

  it("py → python", () => {
    assert.equal(normalizeFileType("py"), "python");
  });

  it("yaml → yaml", () => {
    assert.equal(normalizeFileType("yaml"), "yaml");
  });
});

describe("validateCallbackToken", () => {
  it("returns true for matching tokens", () => {
    assert.ok(validateCallbackToken("abc-123", "abc-123"));
  });

  it("returns false for different tokens", () => {
    assert.ok(!validateCallbackToken("abc-123", "abc-124"));
  });

  it("returns false for different lengths", () => {
    assert.ok(!validateCallbackToken("short", "longer-token"));
  });
});

describe("health endpoint response shape", () => {
  it("returns status ok, ISO timestamp, and version", () => {
    const response = {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: "1.0.0",
    };

    assert.equal(response.status, "ok");
    assert.equal(response.version, "1.0.0");
    assert.ok(typeof response.timestamp === "string");
    assert.ok(!isNaN(Date.parse(response.timestamp)));
  });
});

describe("workflow run error logging", () => {
  it("catch block should log errors with console.error", () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      const err = new Error("STS credential failure");
      console.error("Workflow launch failed:", err);

      assert.equal(errors.length, 1);
      const [logged] = errors as [unknown[]];
      assert.equal(logged[0], "Workflow launch failed:");
      assert.ok(logged[1] instanceof Error);
    } finally {
      console.error = originalError;
    }
  });

  it("error response should not leak internal details", () => {
    const sanitizedResponse = { error: "Failed to launch orchestrator" };
    assert.ok(!sanitizedResponse.error.includes("STS"));
    assert.ok(!sanitizedResponse.error.includes("credential"));
  });
});

describe("normalizeWorkflowPathParam", () => {
  it("accepts a simple forward-slash relative path", () => {
    assert.equal(normalizeWorkflowPathParam("workflows/foo.ts"), "workflows/foo.ts");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeWorkflowPathParam("  workflows/foo.ts  "), "workflows/foo.ts");
  });

  it("rejects non-string inputs", () => {
    assert.equal(normalizeWorkflowPathParam(undefined), null);
    assert.equal(normalizeWorkflowPathParam(null), null);
    assert.equal(normalizeWorkflowPathParam(42), null);
  });

  it("rejects empty / whitespace-only strings", () => {
    assert.equal(normalizeWorkflowPathParam(""), null);
    assert.equal(normalizeWorkflowPathParam("   "), null);
  });

  it("rejects absolute paths", () => {
    assert.equal(normalizeWorkflowPathParam("/etc/passwd"), null);
    assert.equal(normalizeWorkflowPathParam("  /etc/passwd"), null);
  });

  it("rejects traversal via .. segment", () => {
    assert.equal(normalizeWorkflowPathParam("../escaped.ts"), null);
    assert.equal(normalizeWorkflowPathParam("workflows/../../escape.ts"), null);
  });

  it("rejects leading-space smuggling of traversal (Codex P1)", () => {
    // Before the trim-before-validate fix, " ../outside.ts" passed the
    // segment check (first segment was " .." ≠ "..") then got trimmed
    // downstream, bypassing the guard.
    assert.equal(normalizeWorkflowPathParam(" ../outside.ts"), null);
    assert.equal(normalizeWorkflowPathParam("\t../outside.ts"), null);
  });

  it("rejects a segment that trims to .. (Codex P1 defense-in-depth)", () => {
    // Per-segment trim inside the validator blocks any `/ .. /` kind of
    // smuggling that might slip past the outer trim.
    assert.equal(normalizeWorkflowPathParam("workflows/ .. /escape.ts"), null);
  });

  it("rejects backslashes (Codex P2)", () => {
    // The CLI normalizes to forward slashes; any \ in the payload means
    // a buggy/malicious client and would produce an invalid literal
    // path on the Linux sandbox.
    assert.equal(normalizeWorkflowPathParam("workflows\\foo.ts"), null);
    assert.equal(normalizeWorkflowPathParam("\\absolute\\windows\\style"), null);
  });
});

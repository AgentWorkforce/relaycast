import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as auditModule from "../packages/web/lib/integrations/github-clone-audit.ts";

const { recordGithubCloneCall } = auditModule;

type GithubCloneAuditEntry = {
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  httpStatus: number;
  outcome:
    | "ok"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "upstream_error"
    | "bad_request"
    | "partial_failure";
  filesWritten: number;
  durationMs: number;
  errorCount: number;
};

type CapturedCall = {
  level: "log" | "warn";
  args: unknown[];
};

const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalPosthogKey = process.env.POSTHOG_KEY;
const originalNextPublicPosthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

const capturedCalls: CapturedCall[] = [];

function createEntry(
  overrides: Partial<GithubCloneAuditEntry> = {},
): GithubCloneAuditEntry {
  return {
    workspaceId: "workspace-123",
    owner: "acme",
    repo: "demo",
    ref: "main",
    httpStatus: 200,
    outcome: "ok",
    filesWritten: 12,
    durationMs: 345,
    errorCount: 0,
    ...overrides,
  };
}

function serializeCall(call: CapturedCall): string {
  return call.args.map((value) => {
    if (typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  }).join(" ");
}

function getSingleCall(): CapturedCall {
  assert.equal(capturedCalls.length, 1);
  return capturedCalls[0]!;
}

function assertTypeBoundary(): void {
  // @ts-expect-error extra fields should be rejected on GithubCloneAuditEntry
  recordGithubCloneCall({ ...createEntry(), extraField: "not-allowed" });
}

void assertTypeBoundary;

beforeEach(() => {
  capturedCalls.length = 0;
  delete process.env.POSTHOG_KEY;
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;

  console.log = ((...args: unknown[]) => {
    capturedCalls.push({ level: "log", args });
  }) as typeof console.log;
  console.warn = ((...args: unknown[]) => {
    capturedCalls.push({ level: "warn", args });
  }) as typeof console.warn;
});

afterEach(() => {
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;

  if (originalPosthogKey === undefined) {
    delete process.env.POSTHOG_KEY;
  } else {
    process.env.POSTHOG_KEY = originalPosthogKey;
  }

  if (originalNextPublicPosthogKey === undefined) {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = originalNextPublicPosthogKey;
  }
});

describe("github clone audit", () => {
  it("records ok outcome with all fields", () => {
    const entry = createEntry();

    recordGithubCloneCall(entry);

    const call = getSingleCall();
    assert.equal(call.level, "log");
    assert.equal(call.args[0], "GitHub clone request completed");
    assert.deepEqual(call.args[1], {
      area: "github-clone",
      route: "/api/v1/github/clone",
      workspaceId: "workspace-123",
      owner: "acme",
      repo: "demo",
      ref: "main",
      httpStatus: 200,
      outcome: "ok",
      filesWritten: 12,
      durationMs: 345,
      errorCount: 0,
    });
  });

  it("records partial_failure with errorCount", () => {
    recordGithubCloneCall(createEntry({
      httpStatus: 207,
      outcome: "partial_failure",
      filesWritten: 9,
      errorCount: 3,
    }));

    const call = getSingleCall();
    assert.equal(call.level, "warn");
    assert.equal(call.args[0], "GitHub clone request failed");
    assert.equal((call.args[1] as GithubCloneAuditEntry & { area: string }).outcome, "partial_failure");
    assert.equal((call.args[1] as GithubCloneAuditEntry & { area: string }).errorCount, 3);
  });

  it("captured log line contains workspaceId and outcome", () => {
    recordGithubCloneCall(createEntry({
      outcome: "partial_failure",
      httpStatus: 207,
      errorCount: 1,
    }));

    const line = serializeCall(getSingleCall());
    assert.match(line, /workspace-123/);
    assert.match(line, /partial_failure/);
  });

  it("captured log line NEVER contains the string \"token\"", () => {
    recordGithubCloneCall(createEntry());

    const line = serializeCall(getSingleCall());
    assert.equal(line.includes("token"), false);
  });

  it("captured log line NEVER contains the string \"Authorization\"", () => {
    recordGithubCloneCall(createEntry({
      outcome: "partial_failure",
      httpStatus: 207,
      errorCount: 2,
    }));

    const line = serializeCall(getSingleCall());
    assert.equal(line.includes("Authorization"), false);
  });

  it("function rejects spread/extra fields at the type level", () => {
    assert.equal(typeof recordGithubCloneCall, "function");
  });
});

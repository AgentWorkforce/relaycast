import { describe, expect, it, vi } from "vitest";

const relayfileMock = vi.hoisted(() => {
  class RelayFileApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, payload: { message?: string; code?: string } = {}) {
      super(payload.message ?? `RelayFile API error: ${status}`);
      this.name = "RelayFileApiError";
      this.status = status;
      this.code = payload.code ?? "unknown_error";
    }
  }

  return { RelayFileApiError };
});

vi.mock("@relayfile/sdk", () => ({
  RelayFileApiError: relayfileMock.RelayFileApiError,
}));

const { RelayFileApiError } = relayfileMock;

import {
  CONVENTIONS_VFS_ROOT,
  conventionPath,
  fingerprintConventionFragment,
  writeConventionFragment,
  type VfsConventionFragment,
} from "./conventions.js";

const BASE_FRAGMENT: VfsConventionFragment = {
  provider: "github",
  version: "0.1.8",
  generatedAt: "2026-04-21T12:00:00.000Z",
  paths: [
    {
      pattern: "/github/repos/{owner}/{repo}/metadata.json",
      description: "Repository metadata",
      objectType: "repository",
    },
    {
      pattern: "/github/repos/{owner}/{repo}/pulls/{n}/metadata.json",
      description: "Pull request metadata",
      objectType: "pull_request",
    },
  ],
  typicalQueries: [
    {
      intent: "list open PRs",
      steps: ["step a", "step b"],
    },
  ],
};

describe("conventionPath", () => {
  it("composes <root>/<provider>.json", () => {
    expect(conventionPath("github")).toBe(`${CONVENTIONS_VFS_ROOT}/github.json`);
    expect(conventionPath("linear")).toBe(`${CONVENTIONS_VFS_ROOT}/linear.json`);
  });

  it("rejects empty providers", () => {
    expect(() => conventionPath("")).toThrow();
    expect(() => conventionPath("   ")).toThrow();
  });
});

describe("fingerprintConventionFragment", () => {
  it("returns identical fingerprints for fragments that differ only in generatedAt", async () => {
    const a = await fingerprintConventionFragment(BASE_FRAGMENT);
    const b = await fingerprintConventionFragment({
      ...BASE_FRAGMENT,
      generatedAt: "2099-01-01T00:00:00.000Z",
    });
    expect(a).toBe(b);
  });

  it("returns different fingerprints when paths change", async () => {
    const a = await fingerprintConventionFragment(BASE_FRAGMENT);
    const b = await fingerprintConventionFragment({
      ...BASE_FRAGMENT,
      paths: [
        ...BASE_FRAGMENT.paths,
        {
          pattern: "/github/repos/{owner}/{repo}/issues/{n}/metadata.json",
          description: "Issue metadata",
          objectType: "issue",
        },
      ],
    });
    expect(a).not.toBe(b);
  });

  it("returns different fingerprints when version changes", async () => {
    const a = await fingerprintConventionFragment(BASE_FRAGMENT);
    const b = await fingerprintConventionFragment({ ...BASE_FRAGMENT, version: "0.2.0" });
    expect(a).not.toBe(b);
  });

  it("is stable across path-array key ordering", async () => {
    // Reorder object keys inside a path entry — fingerprint should be identical
    const reordered: VfsConventionFragment = {
      ...BASE_FRAGMENT,
      paths: BASE_FRAGMENT.paths.map((p) => ({
        objectType: p.objectType,
        description: p.description,
        pattern: p.pattern,
      })),
    };
    expect(await fingerprintConventionFragment(reordered)).toBe(
      await fingerprintConventionFragment(BASE_FRAGMENT),
    );
  });
});

describe("writeConventionFragment", () => {
  it("writes when no existing fragment exists (404)", async () => {
    const writeFile = vi.fn(async (_input: Record<string, unknown>) => ({
      opId: "op_1",
      status: "queued",
      targetRevision: "1",
    }));
    const readFile = vi.fn(async () => {
      throw new RelayFileApiError(404);
    });
    const client = { writeFile, readFile } as never;

    const result = await writeConventionFragment({
      client,
      workspaceId: "ws_1",
      fragment: BASE_FRAGMENT,
    });

    expect(result.status).toBe("written");
    expect(result.path).toBe("/_conventions/github.json");
    expect(writeFile).toHaveBeenCalledTimes(1);
    const call = writeFile.mock.calls[0][0] as Record<string, unknown>;
    expect(call.path).toBe("/_conventions/github.json");
    expect(call.workspaceId).toBe("ws_1");
    expect(call.contentType).toBe("application/json");
    expect(call.baseRevision).toBe("0");
    expect((call.semantics as { properties: Record<string, string> }).properties[
      "cataloging.conventionFingerprint"
    ]).toBe(result.fingerprint);
  });

  it("skips the write when the existing fingerprint matches", async () => {
    const fingerprint = await fingerprintConventionFragment(BASE_FRAGMENT);
    const writeFile = vi.fn(async (_input: Record<string, unknown>) => ({
      opId: "op_unused",
      status: "queued",
      targetRevision: "0",
    }));
    const readFile = vi.fn(async () => ({
      path: "/_conventions/github.json",
      revision: "7",
      contentType: "application/json",
      content: JSON.stringify(BASE_FRAGMENT),
      encoding: "utf-8",
      semantics: {
        properties: {
          "cataloging.conventionFingerprint": fingerprint,
        },
      },
    }));
    const client = { writeFile, readFile } as never;

    const result = await writeConventionFragment({
      client,
      workspaceId: "ws_1",
      fragment: BASE_FRAGMENT,
    });

    expect(result.status).toBe("skipped");
    expect(writeFile).not.toHaveBeenCalled();
    expect(result.fingerprint).toBe(fingerprint);
  });

  it("emits exactly once when called repeatedly with the same fragment", async () => {
    const fingerprint = await fingerprintConventionFragment(BASE_FRAGMENT);
    let stored:
      | {
          revision: string;
          fingerprint: string;
        }
      | null = null;

    const readFile = vi.fn(async () => {
      if (!stored) {
        throw new RelayFileApiError(404);
      }
      return {
        path: "/_conventions/github.json",
        revision: stored.revision,
        contentType: "application/json",
        content: JSON.stringify(BASE_FRAGMENT),
        encoding: "utf-8",
        semantics: {
          properties: {
            "cataloging.conventionFingerprint": stored.fingerprint,
          },
        },
      };
    });
    const writeFile = vi.fn(async (_input: Record<string, unknown>) => {
      stored = { revision: "1", fingerprint };
      return { opId: "op_1", status: "queued", targetRevision: "1" };
    });
    const client = { writeFile, readFile } as never;

    const first = await writeConventionFragment({
      client,
      workspaceId: "ws_1",
      fragment: BASE_FRAGMENT,
    });
    const second = await writeConventionFragment({
      client,
      workspaceId: "ws_1",
      fragment: BASE_FRAGMENT,
    });
    const third = await writeConventionFragment({
      client,
      workspaceId: "ws_1",
      // Same content, different generatedAt — must still skip.
      fragment: { ...BASE_FRAGMENT, generatedAt: "2099-01-01T00:00:00.000Z" },
    });

    expect(first.status).toBe("written");
    expect(second.status).toBe("skipped");
    expect(third.status).toBe("skipped");
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("rewrites when the fragment paths change", async () => {
    const baselineFp = await fingerprintConventionFragment(BASE_FRAGMENT);
    const updated: VfsConventionFragment = {
      ...BASE_FRAGMENT,
      paths: [
        ...BASE_FRAGMENT.paths,
        {
          pattern: "/github/repos/{owner}/{repo}/issues/{n}/metadata.json",
          description: "Issue metadata",
          objectType: "issue",
        },
      ],
    };

    const readFile = vi.fn(async () => ({
      path: "/_conventions/github.json",
      revision: "3",
      contentType: "application/json",
      content: JSON.stringify(BASE_FRAGMENT),
      encoding: "utf-8",
      semantics: {
        properties: {
          "cataloging.conventionFingerprint": baselineFp,
        },
      },
    }));
    const writeFile = vi.fn(async (_input: Record<string, unknown>) => ({
      opId: "op_2",
      status: "queued",
      targetRevision: "4",
    }));
    const client = { writeFile, readFile } as never;

    const result = await writeConventionFragment({
      client,
      workspaceId: "ws_1",
      fragment: updated,
    });

    expect(result.status).toBe("written");
    expect(writeFile).toHaveBeenCalledTimes(1);
    const call = writeFile.mock.calls[0][0] as Record<string, unknown>;
    expect(call.baseRevision).toBe("3");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  handleDrainLegacyWritebackDrafts,
  LEGACY_DRAIN_CORRELATION_PREFIX,
} from "../src/durable-objects/handlers/drain-legacy-drafts.js";
import type { WorkspaceFsContext } from "../src/durable-objects/handlers/fs.js";

type FileRow = { path: string; revision: string; content_ref: string };
type OpRow = { status: string; revision: string; created_at: string };

// Minimal SQLite-GLOB → RegExp for the test mock so the files query reflects the
// REAL draft-name prefilter (supports `*` [matches any incl. /] and `[...]`
// char-classes — all the production GLOBs use). This is what makes the
// starvation test mutation-proof: drop the GLOB from the production query and
// the mock falls back to range+slice, starving the draft behind inbound rows.
function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      out += "[\\s\\S]*";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      out += glob.slice(i, close + 1);
      i = close;
    } else {
      out += ch.replace(/[.+?^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

function createDrainContext(seed: {
  files: FileRow[];
  opsByPath: Record<string, OpRow[]>;
  body: Record<string, unknown>;
}) {
  const files = new Map(seed.files.map((f) => [f.path, { ...f }]));
  const recordMutationCalls: Array<Record<string, unknown>> = [];
  const deletedContentRefs: string[] = [];
  let revCounter = 0;

  const context = {
    readJson: async <T>() => seed.body as T,
    resolveWorkspaceId: async () => "ws_test",
    correlationId: () => "run_test",
    nextId: (prefix: string) => `${prefix}_drain_${++revCounter}`,
    errors: {
      invalidInput: { status: 400, code: "invalid_input", message: "invalid" },
    },
    errorResponse: (_request: Request, status: number, code: string, message: string) =>
      new Response(JSON.stringify({ code, message }), { status }),
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status }),
    allRows: <T>(query: string, ...bindings: unknown[]): T[] => {
      if (query.includes("FROM files")) {
        const lo = String(bindings[0]);
        const hi = String(bindings[1]);
        const limit = Number(bindings[bindings.length - 1]);
        let pool = [...files.values()].filter((f) => f.path >= lo && f.path < hi);
        // Mirror the production SQL draft-name prefilter when present (the
        // GLOB bindings sit between hi and the trailing limit).
        if (query.includes("GLOB")) {
          const globs = bindings
            .slice(2, bindings.length - 1)
            .map((g) => globToRegExp(String(g)));
          pool = pool.filter((f) => globs.some((g) => g.test(f.path)));
        }
        return pool
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .slice(0, limit) as unknown as T[];
      }
      if (query.includes("FROM operations")) {
        const path = String(bindings[0]);
        return ((seed.opsByPath[path] ?? []) as unknown as T[]);
      }
      return [];
    },
    sqlExec: (query: string, ...bindings: unknown[]) => {
      if (query.startsWith("DELETE FROM files")) {
        files.delete(String(bindings[0]));
      }
    },
    recordMutation: async (input: Record<string, unknown>) => {
      recordMutationCalls.push(input);
      return { opId: "", status: "queued", targetRevision: String(input.revision) };
    },
    deleteContent: async (ref: string) => {
      deletedContentRefs.push(ref);
    },
  } as unknown as WorkspaceFsContext;

  return { context, files, recordMutationCalls, deletedContentRefs };
}

const ROOT = "/slack/channels/C0B8ZL2L9GC__x/messages";
const DRAFT = `${ROOT}/draft-abc.json`;

function request(): Request {
  return new Request("https://relayfile.test/internal/drain-legacy-writeback-drafts", {
    method: "POST",
  });
}

async function runDrain(seed: Parameters<typeof createDrainContext>[0]) {
  const harness = createDrainContext(seed);
  const response = await handleDrainLegacyWritebackDrafts(harness.context, request());
  const result = (await response.json()) as {
    dryRun: boolean;
    scanned: number;
    eligible: number;
    removed: number;
    leftByReason: Record<string, number>;
  };
  return { ...harness, response, result };
}

describe("legacy-draft drain (cloud#2029 #2)", () => {
  it("DRY-RUN (default): a succeeded+revision-matched draft is eligible but NOT removed", async () => {
    const { result, files, recordMutationCalls } = await runDrain({
      files: [{ path: DRAFT, revision: "rev_1", content_ref: "r2/abc" }],
      opsByPath: { [DRAFT]: [{ status: "succeeded", revision: "rev_1", created_at: "t2" }] },
      body: { commandRoots: [ROOT] }, // dryRun defaults true
    });
    expect(result.dryRun).toBe(true);
    expect(result.eligible).toBe(1);
    expect(result.removed).toBe(0);
    expect(files.has(DRAFT)).toBe(true);
    expect(recordMutationCalls).toEqual([]);
  });

  it("DESTRUCTIVE: removes a succeeded+revision-matched draft via a SYSTEM-origin tombstone with the drain marker, NEVER agent_write", async () => {
    const { result, files, recordMutationCalls, deletedContentRefs } = await runDrain({
      files: [{ path: DRAFT, revision: "rev_1", content_ref: "r2/abc" }],
      opsByPath: { [DRAFT]: [{ status: "succeeded", revision: "rev_1", created_at: "t2" }] },
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(result.removed).toBe(1);
    expect(files.has(DRAFT)).toBe(false);
    expect(deletedContentRefs).toEqual(["r2/abc"]);
    expect(recordMutationCalls).toHaveLength(1);
    const call = recordMutationCalls[0];
    // DATA-LOSS TRIPWIRE: removal must be a system-origin file.deleted with the
    // drain marker — never agent_write (which would dispatch a Slack chat.delete).
    expect(call.origin).toBe("system");
    expect(call.action).toBe("file_delete");
    expect(call.eventType).toBe("file.deleted");
    expect(String(call.correlationId).startsWith(LEGACY_DRAIN_CORRELATION_PREFIX)).toBe(true);
    expect(call.origin).not.toBe("agent_write");
  });

  it("PRESERVES a draft whose succeeded op is for a DIFFERENT revision (create.json reuse / rewritten-after-delivery)", async () => {
    const { result, files, recordMutationCalls } = await runDrain({
      files: [{ path: DRAFT, revision: "rev_2", content_ref: "r2/abc" }], // on-disk R2
      opsByPath: { [DRAFT]: [{ status: "succeeded", revision: "rev_1", created_at: "t2" }] }, // delivered R1
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(result.removed).toBe(0);
    expect(result.leftByReason.revision_mismatch).toBe(1);
    expect(files.has(DRAFT)).toBe(true);
    expect(recordMutationCalls).toEqual([]);
  });

  it.each(["failed", "dead_lettered", "canceled"])(
    "PRESERVES a draft whose latest op is terminal-but-undelivered (%s)",
    async (status) => {
      const { result, files } = await runDrain({
        files: [{ path: DRAFT, revision: "rev_1", content_ref: "r2/abc" }],
        opsByPath: { [DRAFT]: [{ status, revision: "rev_1", created_at: "t2" }] },
        body: { commandRoots: [ROOT], dryRun: false },
      });
      expect(result.removed).toBe(0);
      expect(result.leftByReason.not_succeeded).toBe(1);
      expect(files.has(DRAFT)).toBe(true);
    },
  );

  it("PRESERVES an orphan draft (no op)", async () => {
    const { result, files } = await runDrain({
      files: [{ path: DRAFT, revision: "rev_1", content_ref: "r2/abc" }],
      opsByPath: {},
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(result.removed).toBe(0);
    expect(result.leftByReason.no_op).toBe(1);
    expect(files.has(DRAFT)).toBe(true);
  });

  it("PRESERVES a draft with an in-flight (non-terminal) op even if an earlier op succeeded", async () => {
    const { result, files } = await runDrain({
      files: [{ path: DRAFT, revision: "rev_2", content_ref: "r2/abc" }],
      opsByPath: {
        [DRAFT]: [
          { status: "pending", revision: "rev_2", created_at: "t3" },
          { status: "succeeded", revision: "rev_1", created_at: "t2" },
        ],
      },
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(result.removed).toBe(0);
    expect(result.leftByReason.pending_op).toBe(1);
    expect(files.has(DRAFT)).toBe(true);
  });

  it("does NOT scan an inbound <ts>.json mirrored under the command root (narrow draft glob)", async () => {
    const inbound = `${ROOT}/1710000000.000001.json`;
    const { result, files } = await runDrain({
      files: [{ path: inbound, revision: "rev_1", content_ref: "r2/in" }],
      opsByPath: { [inbound]: [{ status: "succeeded", revision: "rev_1", created_at: "t2" }] },
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(result.scanned).toBe(0);
    expect(result.removed).toBe(0);
    expect(files.has(inbound)).toBe(true);
  });

  it("rejects an empty commandRoots array", async () => {
    const { context } = createDrainContext({ files: [], opsByPath: {}, body: { commandRoots: [] } });
    const response = await handleDrainLegacyWritebackDrafts(context, request());
    expect(response.status).toBe(400);
  });

  it("is idempotent: re-running after removal finds nothing", async () => {
    const first = await runDrain({
      files: [{ path: DRAFT, revision: "rev_1", content_ref: "r2/abc" }],
      opsByPath: { [DRAFT]: [{ status: "succeeded", revision: "rev_1", created_at: "t2" }] },
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(first.result.removed).toBe(1);
    // Second run against the now-empty file set.
    const second = await runDrain({
      files: [],
      opsByPath: {},
      body: { commandRoots: [ROOT], dryRun: false },
    });
    expect(second.result.scanned).toBe(0);
    expect(second.result.removed).toBe(0);
  });

  it("does NOT starve drafts behind a > limit inbound <ts>.json backlog (SQL draft-filter bounds LIMIT to drafts)", async () => {
    // cloud2029-shadow #2038: inbound `<ts>.json` (leading digit) sort BEFORE
    // `draft*`/`create.json` under ORDER BY path. Without the SQL draft-filter,
    // a LIMIT window on a busy root is ALL inbound → the draft is never fetched,
    // EVERY run → falsely-clean dry-run. Mutation guard: drop the GLOB from the
    // production query → the mock falls back to range+slice → this fails.
    const inbound: FileRow[] = Array.from({ length: 250 }, (_, i) => ({
      path: `${ROOT}/17000000${String(i).padStart(4, "0")}.000001.json`,
      revision: `rev_in_${i}`,
      content_ref: `r2/in_${i}`,
    }));
    const draft = { path: `${ROOT}/draft-zzz.json`, revision: "rev_d", content_ref: "r2/d" };
    const { result, files } = await runDrain({
      files: [...inbound, draft], // draft sorts AFTER all inbound
      opsByPath: { [draft.path]: [{ status: "succeeded", revision: "rev_d", created_at: "t2" }] },
      body: { commandRoots: [ROOT], dryRun: false, limit: 200 },
    });
    expect(result.scanned).toBe(1); // only the draft is scanned, not 200 inbound
    expect(result.eligible).toBe(1);
    expect(result.removed).toBe(1);
    expect(files.has(draft.path)).toBe(false);
  });

  it("SQL draft-filter is a SUPERSET of isDraftCommandFile (every JS-accepted name is scanned; no false-reject)", async () => {
    // Names the JS gate accepts MUST all be returned by the SQL GLOB filter,
    // else a legit draft is silently skipped. (JS-rejected names may be
    // over-matched by GLOB but are dropped by the in-code gate → not scanned.)
    const accepted = ["draft@abc.json", "draft-xyz.json", "draft@.json", "create.json"];
    const rejected = ["draft.json", "xdraft@y.json", "foocreate.json", "1700000000.1.json"];
    const mk = (name: string, i: number): [FileRow, [string, OpRow[]]] => {
      const path = `${ROOT}/${name}`;
      return [
        { path, revision: `rev_${i}`, content_ref: `r2/${i}` },
        [path, [{ status: "succeeded", revision: `rev_${i}`, created_at: "t" }]],
      ];
    };
    const all = [...accepted, ...rejected].map(mk);
    const { result } = await runDrain({
      files: all.map(([f]) => f),
      opsByPath: Object.fromEntries(all.map(([, op]) => op)),
      body: { commandRoots: [ROOT], dryRun: true },
    });
    // Exactly the JS-accepted set is scanned + eligible — no false-reject, no
    // false-accept leaking past the in-code gate.
    expect(result.scanned).toBe(accepted.length);
    expect(result.eligible).toBe(accepted.length);
  });

  it("LEGACY_DRAIN_CORRELATION_PREFIX matches the canonical literal (cross-package drift guard)", () => {
    // The agent-gateway suppression keys on this exact prefix; if the two copies
    // drift, drain tombstones silently un-suppress. Pin both to the literal.
    expect(LEGACY_DRAIN_CORRELATION_PREFIX).toBe("relayfile:legacy-draft-drain:");
  });
});

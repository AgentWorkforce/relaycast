import { describe, expect, it, vi } from "vitest";
import type { TokenClaims } from "../src/middleware/auth.js";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

const {
  deriveTeamSubtreePrefix,
  pathIsInsidePrefix,
  eventMatchesTeamSubtree,
  resolveSocketSubtreePrefix,
  shouldDeliverEventToSocket,
  resolveBearerAuthHeader,
  resolveWebSocketSubtreeAccess,
} = await import("../src/durable-objects/workspace.js");

function claimsWith(scopes: string[]): TokenClaims {
  return {
    workspaceId: "ws_test",
    agentName: "agent_test",
    scopes: new Set(scopes),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("deriveTeamSubtreePrefix", () => {
  it("derives a team subtree from path-scoped fs grants", () => {
    expect(
      deriveTeamSubtreePrefix(
        claimsWith([
          "relayfile:fs:read:/teams/team_alpha/*",
          "relayfile:fs:write:/teams/team_alpha/*",
        ]),
      ),
    ).toBe("/teams/team_alpha");
  });

  it("supports path-scoped fs grants without an explicit relayfile plane", () => {
    expect(
      deriveTeamSubtreePrefix(
        claimsWith(["fs:read:/teams/team_alpha", "fs:write:/teams/team_alpha"]),
      ),
    ).toBe("/teams/team_alpha");
  });

  it("preserves root visibility for coarse workspace fs grants", () => {
    expect(deriveTeamSubtreePrefix(claimsWith(["fs:read", "fs:write"]))).toBe(
      null,
    );
  });

  it("does not treat non-team path-scoped grants as team confinement", () => {
    expect(
      deriveTeamSubtreePrefix(
        claimsWith([
          "relayfile:fs:read:/github/*",
          "relayfile:fs:write:/github/*",
        ]),
      ),
    ).toBe(null);
  });

  it("does not infer a single prefix when fs grants span multiple teams", () => {
    expect(
      deriveTeamSubtreePrefix(
        claimsWith([
          "relayfile:fs:read:/teams/team_alpha/*",
          "relayfile:fs:write:/teams/team_beta/*",
        ]),
      ),
    ).toBe(null);
  });
});

describe("resolveWebSocketSubtreeAccess", () => {
  it("rejects unauthenticated websocket upgrades", () => {
    expect(resolveWebSocketSubtreeAccess(null)).toEqual({
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "unauthorized",
    });
  });

  it("rejects tokens without filesystem scopes", () => {
    expect(resolveWebSocketSubtreeAccess(claimsWith(["cli:auth"]))).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "missing filesystem scopes",
    });
  });

  it("allows coarse workspace filesystem scopes as root websocket access", () => {
    expect(resolveWebSocketSubtreeAccess(claimsWith(["fs:read"]))).toEqual({
      ok: true,
      teamSubtreePrefix: null,
    });
  });

  it("allows a single team-scoped filesystem subtree", () => {
    expect(
      resolveWebSocketSubtreeAccess(
        claimsWith([
          "relayfile:fs:read:/teams/team_alpha/*",
          "relayfile:fs:write:/teams/team_alpha/*",
        ]),
      ),
    ).toEqual({ ok: true, teamSubtreePrefix: "/teams/team_alpha" });
  });

  it("rejects unrelated path-scoped filesystem grants instead of treating them as root", () => {
    expect(
      resolveWebSocketSubtreeAccess(
        claimsWith(["relayfile:fs:read:/github/*"]),
      ),
    ).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "filesystem scope is not eligible for websocket subscription",
    });
  });

  it("rejects filesystem grants spanning multiple team subtrees", () => {
    expect(
      resolveWebSocketSubtreeAccess(
        claimsWith([
          "relayfile:fs:read:/teams/team_alpha/*",
          "relayfile:fs:write:/teams/team_beta/*",
        ]),
      ),
    ).toEqual({
      ok: false,
      status: 403,
      code: "forbidden",
      message: "filesystem scopes span multiple team subtrees",
    });
  });
});

// ---------------------------------------------------------------------------
// Finding 2: the realtime delivery boundary itself (not just prefix derivation)
// ---------------------------------------------------------------------------

describe("pathIsInsidePrefix (subtree containment guard)", () => {
  it("matches the subtree directory itself and descendants", () => {
    expect(pathIsInsidePrefix("/teams/team_alpha", "/teams/team_alpha")).toBe(
      true,
    );
    expect(
      pathIsInsidePrefix("/teams/team_alpha/board.md", "/teams/team_alpha"),
    ).toBe(true);
    expect(
      pathIsInsidePrefix("/teams/team_alpha/tasks/1.md", "/teams/team_alpha"),
    ).toBe(true);
  });

  it("guards against prefix confusion (team_alpha must not match team_alphabet)", () => {
    expect(
      pathIsInsidePrefix("/teams/team_alphabet/board.md", "/teams/team_alpha"),
    ).toBe(false);
    expect(
      pathIsInsidePrefix("/teams/team_alphaXYZ", "/teams/team_alpha"),
    ).toBe(false);
  });

  it("excludes workspace-root and sibling-team paths", () => {
    expect(pathIsInsidePrefix("/board.md", "/teams/team_alpha")).toBe(false);
    expect(
      pathIsInsidePrefix("/teams/team_beta/board.md", "/teams/team_alpha"),
    ).toBe(false);
  });

  it("normalizes trailing slashes on both sides", () => {
    expect(pathIsInsidePrefix("/teams/team_alpha/", "/teams/team_alpha")).toBe(
      true,
    );
    expect(
      pathIsInsidePrefix("/teams/team_alpha/x", "/teams/team_alpha/"),
    ).toBe(true);
  });
});

describe("eventMatchesTeamSubtree (delivery predicate)", () => {
  it("delivers everything to a null (root/parent) prefix", () => {
    expect(eventMatchesTeamSubtree("/board.md", null)).toBe(true);
    expect(eventMatchesTeamSubtree("/teams/team_beta/x.md", null)).toBe(true);
  });

  it("delivers only in-subtree events to a team prefix", () => {
    expect(
      eventMatchesTeamSubtree(
        "/teams/team_alpha/board.md",
        "/teams/team_alpha",
      ),
    ).toBe(true);
    expect(
      eventMatchesTeamSubtree("/teams/team_beta/board.md", "/teams/team_alpha"),
    ).toBe(false);
    expect(eventMatchesTeamSubtree("/board.md", "/teams/team_alpha")).toBe(
      false,
    );
  });

  it("fails closed for malformed string prefixes", () => {
    for (const malformed of ["", "   ", "/", "/teams", "/teams/team_alpha/x"]) {
      expect(eventMatchesTeamSubtree("/board.md", malformed)).toBe(false);
      expect(
        eventMatchesTeamSubtree("/teams/team_alpha/board.md", malformed),
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 1: hibernation-attachment isolation must fail CLOSED, not OPEN
// ---------------------------------------------------------------------------
//
// The WS upgrade path serializes `{ teamSubtreePrefix }` onto each socket
// AFTER acceptWebSocket (Cloudflare DO hibernation convention) so the
// attachment survives a hibernate/wake round-trip. The node/vitest harness
// has no Workers runtime (no WebSocketPair / live hibernation), so the
// ordering itself is verified by the typed source + the repo's accept-first
// precedent. What we CAN and MUST pin down deterministically is the read-side
// decision the broadcast loop makes from a (possibly lost) attachment — the
// place where a dropped attachment used to fail open.

describe("resolveSocketSubtreePrefix (attachment read)", () => {
  it("reads a team prefix from a well-formed attachment", () => {
    expect(
      resolveSocketSubtreePrefix({ teamSubtreePrefix: "/teams/team_alpha" }),
    ).toEqual({ evaluated: true, teamSubtreePrefix: "/teams/team_alpha" });
  });

  it("reads an explicit null (root/parent) prefix as evaluated", () => {
    expect(resolveSocketSubtreePrefix({ teamSubtreePrefix: null })).toEqual({
      evaluated: true,
      teamSubtreePrefix: null,
    });
  });

  it("reports a missing attachment as UNEVALUATED (not as root)", () => {
    expect(resolveSocketSubtreePrefix(undefined)).toEqual({ evaluated: false });
    expect(resolveSocketSubtreePrefix(null)).toEqual({ evaluated: false });
    expect(resolveSocketSubtreePrefix({})).toEqual({ evaluated: false });
    expect(resolveSocketSubtreePrefix({ teamSubtreePrefix: 42 })).toEqual({
      evaluated: false,
    });
  });

  it("reports malformed string prefixes as UNEVALUATED (not as root)", () => {
    for (const teamSubtreePrefix of [
      "",
      "   ",
      "/",
      "/teams",
      "/teams/team_alpha/x",
    ]) {
      expect(resolveSocketSubtreePrefix({ teamSubtreePrefix })).toEqual({
        evaluated: false,
      });
    }
  });
});

describe("shouldDeliverEventToSocket (realtime isolation, fail-closed)", () => {
  const teamAttachment = { teamSubtreePrefix: "/teams/team_alpha" };
  const rootAttachment = { teamSubtreePrefix: null };

  it("delivers in-subtree events to a team-scoped socket", () => {
    expect(
      shouldDeliverEventToSocket(teamAttachment, "/teams/team_alpha/board.md"),
    ).toBe(true);
    expect(
      shouldDeliverEventToSocket(teamAttachment, "/teams/team_alpha"),
    ).toBe(true);
  });

  it("does NOT deliver workspace-root or cross-team events to a team socket", () => {
    expect(shouldDeliverEventToSocket(teamAttachment, "/board.md")).toBe(false);
    expect(
      shouldDeliverEventToSocket(teamAttachment, "/teams/team_beta/board.md"),
    ).toBe(false);
    expect(
      shouldDeliverEventToSocket(
        teamAttachment,
        "/teams/team_alphabet/board.md",
      ),
    ).toBe(false);
  });

  it("delivers all events to a root/parent socket (null prefix)", () => {
    expect(shouldDeliverEventToSocket(rootAttachment, "/board.md")).toBe(true);
    expect(
      shouldDeliverEventToSocket(rootAttachment, "/teams/team_alpha/board.md"),
    ).toBe(true);
    expect(
      shouldDeliverEventToSocket(rootAttachment, "/teams/team_beta/board.md"),
    ).toBe(true);
  });

  it("fails CLOSED when the attachment was lost or is malformed", () => {
    // A socket whose isolation state cannot be read must receive NOTHING —
    // never the whole workspace. This is the read-side guard against the
    // fail-open hibernation risk in Finding 1.
    for (const lost of [
      undefined,
      null,
      {},
      { teamSubtreePrefix: 0 },
      { teamSubtreePrefix: "" },
      { teamSubtreePrefix: "   " },
      { teamSubtreePrefix: "/" },
      { teamSubtreePrefix: "/teams" },
      { teamSubtreePrefix: "/teams/team_alpha/x" },
    ]) {
      expect(shouldDeliverEventToSocket(lost, "/board.md")).toBe(false);
      expect(
        shouldDeliverEventToSocket(lost, "/teams/team_alpha/board.md"),
      ).toBe(false);
    }
  });

  it("models broadcast fan-out: each socket sees only its own slice", () => {
    // Mirrors broadcastToMatchingSockets: enumerate sockets, deliver per
    // attachment. Uses fake sockets exposing deserializeAttachment()/send().
    type FakeSocket = {
      deserializeAttachment: () => unknown;
      sent: string[];
    };
    const makeSocket = (attachment: unknown): FakeSocket => ({
      deserializeAttachment: () => attachment,
      sent: [],
    });
    const alpha = makeSocket({ teamSubtreePrefix: "/teams/team_alpha" });
    const beta = makeSocket({ teamSubtreePrefix: "/teams/team_beta" });
    const root = makeSocket({ teamSubtreePrefix: null });
    const lost = makeSocket(undefined);
    const sockets = [alpha, beta, root, lost];

    const event = { path: "/teams/team_alpha/board.md" };
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (
        shouldDeliverEventToSocket(socket.deserializeAttachment(), event.path)
      ) {
        socket.sent.push(payload);
      }
    }

    expect(alpha.sent).toEqual([payload]); // in-subtree → delivered
    expect(beta.sent).toEqual([]); // cross-team → excluded
    expect(root.sent).toEqual([payload]); // root → sees all
    expect(lost.sent).toEqual([]); // lost attachment → fail closed
  });
});

// ---------------------------------------------------------------------------
// Finding 3: `?token=` query credential is WS-upgrade-only, not workspace-wide
// ---------------------------------------------------------------------------

describe("resolveBearerAuthHeader (query-token surface)", () => {
  const url = "https://do/v1/workspaces/ws_test/fs/file?token=secret_tok";

  it("uses the Authorization header when present (header wins)", () => {
    const req = new Request(url, {
      headers: { Authorization: "Bearer header_tok" },
    });
    expect(resolveBearerAuthHeader(req, { allowQueryToken: true })).toBe(
      "Bearer header_tok",
    );
    expect(resolveBearerAuthHeader(req, { allowQueryToken: false })).toBe(
      "Bearer header_tok",
    );
  });

  it("honors ?token= ONLY when the caller opts in (WS upgrade path)", () => {
    const req = new Request(url);
    expect(resolveBearerAuthHeader(req, { allowQueryToken: true })).toBe(
      "Bearer secret_tok",
    );
  });

  it("ignores ?token= by default — fs/ops/sync routes do not leak via URL", () => {
    const req = new Request(url);
    expect(resolveBearerAuthHeader(req, { allowQueryToken: false })).toBe(null);
  });

  it("returns null when neither header nor opted-in query token is present", () => {
    const req = new Request("https://do/v1/workspaces/ws_test/fs/file");
    expect(resolveBearerAuthHeader(req, { allowQueryToken: true })).toBe(null);
    expect(resolveBearerAuthHeader(req, { allowQueryToken: false })).toBe(null);
  });
});

import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenRow: null as null | {
    id: string;
    tokenHash: string;
    workspaceId: string;
    relayWorkspaceId: string;
    requestedName: string | null;
    capabilities: string[];
    maxAgents: number;
    tags: string[];
    createdBy: string;
  },
  claimRows: [] as Array<null | {
    id: string;
    tokenHash: string;
    workspaceId: string;
    relayWorkspaceId: string;
    requestedName: string | null;
    capabilities: string[];
    maxAgents: number;
    tags: string[];
    createdBy: string;
  }>,
  updates: [] as Record<string, unknown>[],
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({ kind: "and" })),
  eq: vi.fn(() => ({ kind: "eq" })),
  gt: vi.fn(() => ({ kind: "gt" })),
  isNull: vi.fn(() => ({ kind: "isNull" })),
  lt: vi.fn((column: unknown, value: unknown) => ({ kind: "lt", column, value })),
  or: vi.fn((...conditions: unknown[]) => ({ kind: "or", conditions })),
}));

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mocks.tokenRow ? [mocks.tokenRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updates.push(values);
        return {
          where: () => ({
            returning: async () => {
              if (values.claimNonce && values.claimedAt) {
                const claimed = mocks.claimRows.length > 0 ? mocks.claimRows.shift() : mocks.tokenRow;
                return claimed ? [claimed] : [];
              }
              if (Object.prototype.hasOwnProperty.call(values, "usedAt")) {
                return [{ id: mocks.tokenRow?.id ?? "enr_1" }];
              }
              return [{ id: mocks.tokenRow?.id ?? "enr_1" }];
            },
            then: (resolve: (value: { rowCount: number }) => void, reject: (reason?: unknown) => void) =>
              Promise.resolve({ rowCount: 1 }).then(resolve, reject),
          }),
        };
      },
    }),
  }),
}));

vi.mock("@/lib/db/schema", () => ({
  nodeEnrollmentTokens: {
    id: "node_enrollment_tokens.id",
    tokenHash: "node_enrollment_tokens.token_hash",
    expiresAt: "node_enrollment_tokens.expires_at",
    usedAt: "node_enrollment_tokens.used_at",
    claimNonce: "node_enrollment_tokens.claim_nonce",
    claimedAt: "node_enrollment_tokens.claimed_at",
  },
  workspaces: {
    id: "workspaces.id",
    relayWorkspaceId: "workspaces.relay_workspace_id",
  },
}));

const {
  getRelayWorkspaceMock,
  resolveOrProvisionRelayWorkspaceMock,
  ensureRelaycastApiKeyForRelayWorkspaceMock,
} = vi.hoisted(() => ({
  getRelayWorkspaceMock: vi.fn(async () => ({
    id: "rw_test",
    relaycastApiKey: "rk_live_workspace",
  })),
  resolveOrProvisionRelayWorkspaceMock: vi.fn(),
  ensureRelaycastApiKeyForRelayWorkspaceMock: vi.fn(),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  getRelayWorkspace: getRelayWorkspaceMock,
}));

vi.mock("@/lib/workflows/relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: resolveOrProvisionRelayWorkspaceMock,
  ensureRelaycastApiKeyForRelayWorkspace: ensureRelaycastApiKeyForRelayWorkspaceMock,
}));

vi.mock("@/lib/workspace-registry", () => ({
  resolveRelaycastUrl: () => "https://relaycast.test/",
}));

function sha256Hex(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("fleet node enrollment helpers", () => {
  afterEach(() => {
    mocks.tokenRow = null;
    mocks.claimRows = [];
    mocks.updates = [];
    getRelayWorkspaceMock.mockReset();
    getRelayWorkspaceMock.mockImplementation(async () => ({
      id: "rw_test",
      relaycastApiKey: "rk_live_workspace",
    }));
    resolveOrProvisionRelayWorkspaceMock.mockReset();
    ensureRelaycastApiKeyForRelayWorkspaceMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("builds an agent-relay fleet serve command with shell-safe arguments", async () => {
    const { buildFleetEnrollCommand } = await import("./nodes");

    expect(buildFleetEnrollCommand({
      enrollmentToken: "ocl_node_enr_abc'123",
      enrollmentUrl: "https://cloud.test/api/v1/fleet/register",
      name: "daytona node",
    })).toBe(
      "agent-relay fleet serve --enrollment-token 'ocl_node_enr_abc'\\''123' --enrollment-url 'https://cloud.test/api/v1/fleet/register' --name 'daytona node'",
    );
  });

  it("redeems a one-time enrollment token into a relaycast node token", async () => {
    const enrollmentToken = "ocl_node_enr_testtoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "requested-node",
      capabilities: ["spawn"],
      maxAgents: 4,
      tags: ["daytona"],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://relaycast.test/v1/nodes");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rk_live_workspace");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "runtime-node",
        capabilities: ["spawn", "github.pr.review"],
        max_agents: 6,
        tags: ["sandbox"],
        version: "agent-relay-test",
      });
      return Response.json({
        ok: true,
        data: {
          id: "node_1",
          name: "runtime-node",
          token: "nt_live_node_token",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");

    await expect(redeemNodeEnrollmentToken({
      enrollmentToken,
      name: "runtime-node",
      capabilities: ["spawn", "github.pr.review"],
      maxAgents: 6,
      tags: ["sandbox"],
      version: "agent-relay-test",
      ip: "203.0.113.4",
    })).resolves.toEqual({
      nodeId: "node_1",
      nodeName: "runtime-node",
      nodeToken: "nt_live_node_token",
      relayWorkspaceId: "rw_test",
      relaycastUrl: "https://relaycast.test",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.updates[0]?.claimNonce).toEqual(expect.any(String));
    expect(mocks.updates[0]?.claimedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.usedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.usedFromIp).toBe("203.0.113.4");
    expect(mocks.updates.at(-1)?.claimNonce).toBeNull();
  });

  it("provisions a relaycast key when the workspace has none, then mints the node token", async () => {
    const enrollmentToken = "ocl_node_enr_provisiontoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "provision-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    // Workspace exists but has no minted relaycast key yet.
    getRelayWorkspaceMock.mockImplementation(async () => ({
      id: "rw_test",
      relaycastApiKey: "",
    }));
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
      id: "rw_test",
      relaycastApiKey: "rk_live_provisioned",
      provisioned: true,
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rk_live_provisioned");
      return Response.json({
        ok: true,
        data: { id: "node_1", name: "provision-node", token: "nt_live_node_token" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).resolves.toMatchObject({
      nodeToken: "nt_live_node_token",
      relayWorkspaceId: "rw_test",
    });

    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledWith({
      userId: "22222222-2222-4222-8222-222222222222",
      appWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The claim must be burned, not rolled back.
    expect(mocks.updates.at(-1)?.usedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.claimNonce).toBeNull();
  });

  it("heals a stale relaycast key on 401 when the current binding is still stale", async () => {
    const enrollmentToken = "ocl_node_enr_stalekeytoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_stale",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "stale-key-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: ["fleet"],
    };
    getRelayWorkspaceMock.mockImplementation(async () => ({
      id: "rw_stale",
      relaycastApiKey: "rk_live_stale",
    }));
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValueOnce({
      id: "rw_stale",
      relaycastApiKey: "rk_live_stale",
      provisioned: false,
    });
    ensureRelaycastApiKeyForRelayWorkspaceMock.mockResolvedValueOnce({
      id: "rw_stale",
      relaycastApiKey: "rk_live_stale",
      provisioned: false,
    });

    let staleAttempts = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe("Bearer rk_live_stale");
      staleAttempts += 1;
      if (staleAttempts === 1) {
        return new Response(JSON.stringify({ ok: false, code: "unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({
        ok: true,
        data: { id: "node_1", name: "stale-key-node", token: "nt_live_node_token" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).resolves.toMatchObject({
      nodeToken: "nt_live_node_token",
      relayWorkspaceId: "rw_stale",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledWith({
      userId: "22222222-2222-4222-8222-222222222222",
      appWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(resolveOrProvisionRelayWorkspaceMock).not.toHaveBeenCalledWith(expect.objectContaining({
      forceProvision: true,
    }));
    expect(ensureRelaycastApiKeyForRelayWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(ensureRelaycastApiKeyForRelayWorkspaceMock).toHaveBeenCalledWith({
      relayWorkspaceId: "rw_stale",
    });
    expect(mocks.updates.at(-1)?.usedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.claimNonce).toBeNull();
  });

  it("reuses a concurrently rebound relay workspace after a 401 instead of orphaning another node", async () => {
    const enrollmentToken = "ocl_node_enr_concurrentheal";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_stale",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "concurrent-heal-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: ["fleet"],
    };
    getRelayWorkspaceMock.mockImplementation(async () => ({
      id: "rw_stale",
      relaycastApiKey: "rk_live_stale",
    }));
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
      id: "rw_current",
      relaycastApiKey: "rk_live_current",
      provisioned: false,
    });

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer rk_live_stale") {
        return new Response(JSON.stringify({ ok: false, code: "unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "content-type": "application/json" },
        });
      }
      expect(authorization).toBe("Bearer rk_live_current");
      return Response.json({
        ok: true,
        data: {
          id: "node_1",
          name: "concurrent-heal-node",
          token: "nt_live_node_token",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).resolves.toMatchObject({
      nodeToken: "nt_live_node_token",
      relayWorkspaceId: "rw_current",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledWith({
      userId: "22222222-2222-4222-8222-222222222222",
      appWorkspaceId: "11111111-1111-4111-8111-111111111111",
    });
    expect(resolveOrProvisionRelayWorkspaceMock).not.toHaveBeenCalledWith(expect.objectContaining({
      forceProvision: true,
    }));
    expect(ensureRelaycastApiKeyForRelayWorkspaceMock).not.toHaveBeenCalled();
    expect(mocks.updates.at(-1)?.usedAt).toBeInstanceOf(Date);
    expect(mocks.updates.at(-1)?.claimNonce).toBeNull();
  });

  it("returns the relay workspace id that owns a provisioned node", async () => {
    const enrollmentToken = "ocl_node_enr_newworkspacetoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_stale",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "provision-new-workspace-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    getRelayWorkspaceMock.mockImplementation(async () => ({
      id: "rw_stale",
      relaycastApiKey: "",
    }));
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
      id: "rw_fresh",
      relaycastApiKey: "rk_live_fresh",
      provisioned: true,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer rk_live_fresh");
        return Response.json({
          ok: true,
          data: {
            id: "node_1",
            name: "provision-new-workspace-node",
            token: "nt_live_node_token",
          },
        });
      }),
    );

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).resolves.toMatchObject({
      nodeToken: "nt_live_node_token",
      relayWorkspaceId: "rw_fresh",
    });
  });

  it("rolls back the claim and throws when provisioning genuinely fails", async () => {
    const enrollmentToken = "ocl_node_enr_provisionfailtoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "provision-fail-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    getRelayWorkspaceMock.mockImplementation(async () => ({
      id: "rw_test",
      relaycastApiKey: "",
    }));
    resolveOrProvisionRelayWorkspaceMock.mockRejectedValue(new Error("registry mint failed"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).rejects.toThrow(
      "Relaycast API key is not configured",
    );
    // Never attempted node enrollment, and released the claim.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updates.at(-1)).toMatchObject({ claimNonce: null, claimedAt: null });
  });

  it("treats a null/undefined relaycastApiKey as missing and provisions instead of crashing", async () => {
    // Defensive: the DB-sourced relaycastApiKey is typed `string` but can drift
    // to null/undefined at runtime. Calling .trim() unguarded would throw a
    // TypeError; the optional-chaining guard must instead route to provisioning.
    const enrollmentToken = "ocl_node_enr_nullkeytoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "nullkey-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    // Workspace exists but its relaycast key is null (type-lie at runtime).
    getRelayWorkspaceMock.mockImplementation(
      async () => ({ id: "rw_test", relaycastApiKey: null }) as unknown as {
        id: string;
        relaycastApiKey: string;
      },
    );
    // Provisioner also returns a null key — must not crash; rolls back + throws.
    resolveOrProvisionRelayWorkspaceMock.mockResolvedValue({
      id: "rw_test",
      relaycastApiKey: null as unknown as string,
      provisioned: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).rejects.toThrow(
      "Relaycast API key is not configured",
    );
    // The null key routed into provisioning (didn't crash on .trim()).
    expect(resolveOrProvisionRelayWorkspaceMock).toHaveBeenCalledTimes(1);
    // Never attempted node enrollment, and released the claim.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.updates.at(-1)).toMatchObject({ claimNonce: null, claimedAt: null });
  });

  it("only lets one concurrent redeem claim and mint a node token", async () => {
    const enrollmentToken = "ocl_node_enr_racetoken";
    const tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "race-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    mocks.tokenRow = tokenRow;
    mocks.claimRows = [tokenRow, null];
    const fetchMock = vi.fn(async () =>
      Response.json({
        ok: true,
        data: { id: "node_1", name: "race-node", token: "nt_live_node_token" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { redeemNodeEnrollmentToken } = await import("./nodes");
    const results = await Promise.allSettled([
      redeemNodeEnrollmentToken({ enrollmentToken }),
      redeemNodeEnrollmentToken({ enrollmentToken }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the enrollment claim when relaycast minting fails", async () => {
    const enrollmentToken = "ocl_node_enr_retrytoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "retry-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503, statusText: "Unavailable" })));

    const { redeemNodeEnrollmentToken } = await import("./nodes");

    await expect(redeemNodeEnrollmentToken({ enrollmentToken })).rejects.toThrow("Relaycast node enrollment failed");
    expect(mocks.updates.at(-1)).toMatchObject({ claimNonce: null, claimedAt: null });
  });

  it("guards the claim with a TTL-based stale-reclaim condition so a crash mid-mint cannot brick the token", async () => {
    const enrollmentToken = "ocl_node_enr_staletoken";
    mocks.tokenRow = {
      id: "enr_1",
      tokenHash: sha256Hex(enrollmentToken),
      workspaceId: "11111111-1111-4111-8111-111111111111",
      relayWorkspaceId: "rw_test",
      createdBy: "22222222-2222-4222-8222-222222222222",
      requestedName: "stale-node",
      capabilities: ["spawn"],
      maxAgents: 1,
      tags: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ ok: true, data: { id: "node_1", name: "stale-node", token: "nt_live_node_token" } }),
      ),
    );

    const { lt, or, isNull } = await import("drizzle-orm");
    const { redeemNodeEnrollmentToken } = await import("./nodes");
    await redeemNodeEnrollmentToken({ enrollmentToken });

    // The claim CAS must allow EITHER an unclaimed token OR one whose prior claim
    // has gone stale — otherwise a redeemer that crashed after claiming but before
    // burning would brick the token permanently (claim_nonce stays set forever).
    expect(or).toHaveBeenCalled();
    expect(isNull).toHaveBeenCalledWith("node_enrollment_tokens.claim_nonce");
    expect(lt).toHaveBeenCalledWith("node_enrollment_tokens.claimed_at", expect.any(Date));
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  joinGithubInstallation,
  selectInheritableMatch,
} from "./github-installation-flow-client";

describe("github-installation-flow-client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects only non-suspended organization installations for inherit", () => {
    expect(selectInheritableMatch([
      {
        installationId: "1",
        accountLogin: "octocat",
        accountType: "User",
        suspended: false,
        alreadyConnected: false,
      },
      {
        installationId: "2",
        accountLogin: "Suspended",
        accountType: "Organization",
        suspended: true,
        alreadyConnected: false,
      },
      {
        installationId: "3",
        accountLogin: "Acme",
        accountType: "Organization",
        suspended: false,
        alreadyConnected: false,
      },
    ])).toMatchObject({ installationId: "3" });
  });

  it("treats active join responses with landingWorkspace as connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      action: "join",
      outcome: "joined",
      landingWorkspace: { id: "ws_1", slug: "default", name: "Default" },
    })));

    await expect(joinGithubInstallation({
      workspaceId: "rw_123",
      installationId: "9001",
      oauthConnectionId: "conn_oauth",
    })).resolves.toMatchObject({
      kind: "connected",
      landingWorkspace: { id: "ws_1" },
    });
  });

  it("does not treat pending approval as a connected landing outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      action: "join",
      outcome: "pending_approval",
      joinRequest: { id: "req_1", status: "pending" },
    })));

    await expect(joinGithubInstallation({
      workspaceId: "rw_123",
      installationId: "9001",
      oauthConnectionId: "conn_oauth",
    })).resolves.toMatchObject({
      kind: "pending",
      response: {
        outcome: "pending_approval",
      },
    });
  });

  it("treats active ambiguity without candidate workspaces as a no-workspace state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      action: "join",
      outcome: "already_member",
      landingWorkspace: null,
      workspaceSelection: { ambiguous: true, candidateWorkspaceIds: [] },
    })));

    await expect(joinGithubInstallation({
      workspaceId: "rw_123",
      installationId: "9001",
      oauthConnectionId: "conn_oauth",
    })).resolves.toMatchObject({
      kind: "no_workspace",
      message: "No destination workspace is available. Contact an organization admin.",
    });
  });
});

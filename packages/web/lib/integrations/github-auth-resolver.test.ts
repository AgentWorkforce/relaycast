import { describe, expect, it } from "vitest";
import {
  resolveGithubAuthShadowFromRows,
  type GithubAuthShadowLinkedInstallation,
} from "./github-auth-resolver";

const linked: GithubAuthShadowLinkedInstallation[] = [
  {
    installationId: "100",
    accountLogin: "AgentWorkforce",
    accountId: "987",
    accountType: "Organization",
    connectionId: "conn_org",
    providerConfigKey: "github-app-oauth",
  },
  {
    installationId: "200",
    accountLogin: "khaliqgant",
    accountId: "654",
    accountType: "User",
    connectionId: "conn_user",
    providerConfigKey: "github-app-oauth",
  },
];

describe("resolveGithubAuthShadowFromRows", () => {
  it("prefers the repository index and returns resolved install identity", () => {
    const result = resolveGithubAuthShadowFromRows(
      {
        workspaceId: "rw_12345678",
        owner: "AgentWorkforce",
        repo: "cloud",
        purpose: "repo_write",
      },
      linked,
      { installationId: "200", accessState: "active" },
    );

    expect(result).toEqual({
      ok: true,
      tokenType: "installation",
      authKind: "app_installation",
      installationId: "200",
      accountLogin: "khaliqgant",
      accountType: "User",
      matchedBy: "repository_index",
      connectionId: "conn_user",
      providerConfigKey: "github-app-oauth",
    });
  });

  it("reports repository access_removed from the repository index", () => {
    const result = resolveGithubAuthShadowFromRows(
      {
        workspaceId: "rw_12345678",
        owner: "AgentWorkforce",
        repo: "cloud",
        purpose: "clone",
      },
      linked,
      { installationId: "100", accessState: "access_removed" },
    );

    expect(result).toEqual({
      ok: false,
      reason: "repository_access_removed",
      tokenType: "installation",
      authKind: "app_installation",
      candidates: [
        {
          installationId: "100",
          accountLogin: "AgentWorkforce",
          accountType: "Organization",
          matchedBy: "repository_index",
        },
      ],
    });
  });

  it("falls back to owner-exact matching when no repository index exists", () => {
    const result = resolveGithubAuthShadowFromRows(
      {
        workspaceId: "rw_12345678",
        owner: "agentworkforce",
        repo: "cloud",
        purpose: "pull_request",
      },
      linked,
    );

    expect(result).toMatchObject({
      ok: true,
      installationId: "100",
      accountLogin: "AgentWorkforce",
      accountType: "Organization",
      matchedBy: "owner_exact",
    });
  });

  it("surfaces ambiguous owner matches instead of choosing a default row", () => {
    const result = resolveGithubAuthShadowFromRows(
      {
        workspaceId: "rw_12345678",
        owner: "AgentWorkforce",
        repo: "cloud",
        purpose: "repo_read",
      },
      [
        linked[0]!,
        {
          ...linked[0]!,
          installationId: "300",
          connectionId: "conn_org_2",
        },
      ],
    );

    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_installation",
      tokenType: "installation",
      authKind: "app_installation",
      candidates: [
        {
          installationId: "100",
          accountLogin: "AgentWorkforce",
          accountType: "Organization",
          matchedBy: "owner_exact",
        },
        {
          installationId: "300",
          accountLogin: "AgentWorkforce",
          accountType: "Organization",
          matchedBy: "owner_exact",
        },
      ],
    });
  });

  it("keeps identity-only purposes on user OAuth", () => {
    const result = resolveGithubAuthShadowFromRows(
      {
        workspaceId: "rw_12345678",
        purpose: "identity",
      },
      linked,
    );

    expect(result).toEqual({
      ok: false,
      reason: "user_oauth_required",
      tokenType: "user_oauth",
      authKind: "user_oauth",
    });
  });
});

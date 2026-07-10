import { describe, expect, it } from "vitest";

import { buildGitWorkspaceSyncShell } from "./git-workspace-sync-script";

describe("buildGitWorkspaceSyncShell", () => {
  it("fetches branch refs onto remote-tracking refs so re-warmed sandboxes can check them out", () => {
    const script = buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: "https://github.com/AgentWorkforce/cloud",
        targetDir: "/workspace",
        ref: "fix/initial-sync-probe-fail-fast",
        shallow: true,
      },
      askpassPath: "/tmp/askpass.sh",
    });

    // A bare ref-name refspec only updates FETCH_HEAD and leaves
    // refs/remotes/origin/<ref> missing, which breaks the
    // `checkout -B <ref> origin/<ref>` that follows on existing clones.
    expect(script).toContain(
      "fetch --depth 1 origin '+fix/initial-sync-probe-fail-fast:refs/remotes/origin/fix/initial-sync-probe-fail-fast'",
    );
    expect(script).toContain(
      "checkout -B 'fix/initial-sync-probe-fail-fast' 'refs/remotes/origin/fix/initial-sync-probe-fail-fast'",
    );
    // --prune must not accompany these targeted fetches: prune matches the
    // refspec source literally (no DWIM), so with an unqualified source it
    // deletes the tracking ref the same fetch just wrote.
    expect(script).not.toContain("--prune");
  });

  it("accepts legal branch names outside the ASCII safe-list", () => {
    for (const ref of ["feat/foo@bar", "feature/añadir", "topic/x+y"]) {
      const script = buildGitWorkspaceSyncShell({
        source: {
          remoteUrl: "https://github.com/AgentWorkforce/cloud",
          targetDir: "/workspace",
          ref,
          shallow: true,
        },
        askpassPath: "/tmp/askpass.sh",
      });
      expect(script).not.toContain("Invalid git workspace ref");
      expect(script).toContain(`+${ref}:refs/remotes/origin/${ref}`);
    }
  });

  it("leaves the refspec source unqualified so tags and custom refs resolve too", () => {
    const script = buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: "https://github.com/AgentWorkforce/cloud",
        targetDir: "/workspace",
        ref: "v1.0.0",
        shallow: true,
      },
      askpassPath: "/tmp/askpass.sh",
    });

    // Qualifying the source as refs/heads/<ref> would make the fetch fatal
    // for tags ("couldn't find remote ref refs/heads/v1.0.0").
    expect(script).toContain(
      "fetch --depth 1 origin '+v1.0.0:refs/remotes/origin/v1.0.0'",
    );
    expect(script).not.toContain("refs/heads/");
  });

  it("strips refs/heads from fully-qualified branch refs before checkout", () => {
    const script = buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: "https://github.com/AgentWorkforce/cloud",
        targetDir: "/workspace",
        ref: "refs/heads/main",
        shallow: true,
      },
      askpassPath: "/tmp/askpass.sh",
    });

    expect(script).toContain(
      "fetch --depth 1 origin '+refs/heads/main:refs/remotes/origin/main'",
    );
    expect(script).toContain(
      "checkout -B 'main' 'refs/remotes/origin/main'",
    );
  });

  it("detaches custom refs from the fetched remote-tracking ref", () => {
    const script = buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: "https://github.com/AgentWorkforce/cloud",
        targetDir: "/workspace",
        ref: "refs/pull/1927/head",
        shallow: true,
      },
      askpassPath: "/tmp/askpass.sh",
    });

    expect(script).toContain(
      "fetch --depth 1 origin '+refs/pull/1927/head:refs/remotes/origin/pull/1927/head'",
    );
    expect(script).toContain(
      "git clone --filter=blob:none --depth 1 --no-tags --no-checkout 'https://github.com/AgentWorkforce/cloud' '/workspace' && git -C '/workspace' fetch --depth 1 origin '+refs/pull/1927/head:refs/remotes/origin/pull/1927/head'",
    );
    expect(script).toContain(
      "checkout --detach 'refs/remotes/origin/pull/1927/head'",
    );
  });

  it("rejects unsafe refs before clone or fetch", () => {
    for (const ref of ["main:refs/heads/owned", "HEAD", "refs/heads/HEAD"]) {
      const script = buildGitWorkspaceSyncShell({
        source: {
          remoteUrl: "https://github.com/AgentWorkforce/cloud",
          targetDir: "/workspace",
          ref,
          shallow: true,
        },
        askpassPath: "/tmp/askpass.sh",
      });

      expect(script).toContain(`Invalid git workspace ref: ${ref}`);
      expect(script).not.toContain(`+${ref}:`);
    }
  });

  it("fetches HEAD when no ref is provided", () => {
    const script = buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: "https://github.com/AgentWorkforce/cloud",
        targetDir: "/workspace",
      },
      askpassPath: "/tmp/askpass.sh",
    });

    expect(script).toContain("fetch --depth 1 origin 'HEAD'");
  });

  it("detaches onto the pinned commit when one is provided", () => {
    const script = buildGitWorkspaceSyncShell({
      source: {
        remoteUrl: "https://github.com/AgentWorkforce/cloud",
        targetDir: "/workspace",
        ref: "main",
        commit: "abc123",
        shallow: true,
      },
      askpassPath: "/tmp/askpass.sh",
    });

    expect(script).toContain("fetch --depth 1 origin 'abc123'");
    expect(script).toContain("checkout --detach 'abc123'");
  });
});

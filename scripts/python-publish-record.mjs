#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Version files the Python publish workflow commits before tagging. The tag
// must point at this commit — the tree that was built and uploaded — and a
// later main must not be replayed onto it.
export const PYTHON_VERSION_PATHS = [
  "packages/sdk-python/pyproject.toml",
  "packages/sdk-python/uv.lock",
  "packages/sdk-python/src/relay_sdk/client.py",
];

const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:b[0-9]+)?$/;
const STEP_OUTCOMES = new Set(["success", "failure", "cancelled", "skipped"]);
const SUMMARY_STEPS = [
  ["publish", "PyPI publication"],
  ["tag", "Tag"],
  ["branch", "Main branch push"],
  ["release", "GitHub release"],
];

export function assertPythonVersion(version) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `version must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCHbN, got ${JSON.stringify(version)}`,
    );
  }
  return version;
}

export function pythonTagName(version) {
  return `sdk-python-v${assertPythonVersion(version)}`;
}

function assertRemote(remote) {
  if (
    typeof remote !== "string" ||
    remote.length === 0 ||
    remote.startsWith("-") ||
    /[\s\u0000]/.test(remote)
  ) {
    throw new Error("remote must be a non-empty name without whitespace");
  }
  return remote;
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result;
}

function stdout(result) {
  return (result.stdout || "").trim();
}

function ensureIdentity(cwd, run) {
  run(cwd, ["config", "--local", "user.name", "GitHub Actions"]);
  run(cwd, ["config", "--local", "user.email", "actions@github.com"]);
}

function headCommit(cwd, run) {
  return stdout(run(cwd, ["rev-parse", "HEAD"]));
}

function localTagCommit(cwd, tag, run) {
  const result = run(
    cwd,
    ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`],
    { allowFailure: true },
  );
  if (result.status !== 0) return null;
  return stdout(result);
}

function remoteTagCommit(cwd, remote, tag, run) {
  // The exact tag ref does not match the peeled `^{}` line. Ask for the
  // prefix, then keep only this tag so a longer version cannot alias it.
  const result = run(cwd, ["ls-remote", "--tags", remote, `refs/tags/${tag}*`]);
  const commits = new Map();
  for (const line of stdout(result).split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{40})\s+(refs\/tags\/\S+)$/);
    if (!match) continue;
    const [, sha, ref] = match;
    if (ref === `refs/tags/${tag}`) {
      commits.set("tag", sha);
    } else if (ref === `refs/tags/${tag}^{}`) {
      commits.set("commit", sha);
    }
  }
  if (commits.size === 0) return null;
  const sha = commits.get("commit") ?? commits.get("tag");
  if (!sha) throw new Error(`unexpected ls-remote output for ${tag}`);
  return sha;
}

function versionPathsDirty(cwd, paths, run) {
  const result = run(cwd, ["status", "--porcelain", "--", ...paths]);
  return stdout(result).length > 0;
}

function refuseToMove(tag, actual, expected) {
  throw new Error(
    `${tag} already points at ${actual ?? "nothing"}, not ${expected}; refusing to move the published tag`,
  );
}

/**
 * Commit the built version files when needed, tag that commit, and push the
 * tag. Does not update main and does not replay the commit onto a later main.
 */
export function tagPublishedCommit({
  cwd = process.cwd(),
  version,
  remote = "origin",
  paths = PYTHON_VERSION_PATHS,
  run = runGit,
} = {}) {
  const tag = pythonTagName(version);
  const remoteName = assertRemote(remote);
  const head = headCommit(cwd, run);
  const remoteCommit = remoteTagCommit(cwd, remoteName, tag, run);

  if (remoteCommit) {
    if (remoteCommit !== head) refuseToMove(tag, remoteCommit, head);
    if (versionPathsDirty(cwd, paths, run)) {
      throw new Error(
        `${tag} already records ${head}; refusing to commit more changes onto the published tag`,
      );
    }
    return { tag, commit: head, created: false };
  }

  const existing = localTagCommit(cwd, tag, run);
  if (existing && existing !== head) refuseToMove(tag, existing, head);

  if (versionPathsDirty(cwd, paths, run)) {
    if (existing) {
      throw new Error(
        `${tag} already records ${existing}; refusing to commit more changes onto the published tag`,
      );
    }
    ensureIdentity(cwd, run);
    run(cwd, ["add", "--", ...paths]);
    const staged = run(cwd, ["diff", "--staged", "--quiet"], {
      allowFailure: true,
    });
    if (staged.status === 1) {
      run(cwd, ["commit", "-m", `chore(sdk-python): v${version}`]);
    } else if (staged.status !== 0) {
      throw new Error(
        `git diff --staged --quiet failed: ${(staged.stderr || staged.stdout || "").trim()}`,
      );
    } else {
      throw new Error(
        "version files changed but were not staged; refusing to tag a commit that does not contain them",
      );
    }
  }

  const tagged = headCommit(cwd, run);
  const localCommit = localTagCommit(cwd, tag, run);
  if (localCommit && localCommit !== tagged) refuseToMove(tag, localCommit, tagged);
  if (!localCommit) {
    ensureIdentity(cwd, run);
    run(cwd, ["tag", "-a", tag, "-m", `sdk-python v${version}`]);
  } else {
    const type = stdout(run(cwd, ["cat-file", "-t", `refs/tags/${tag}`]));
    if (type !== "tag") {
      throw new Error(`${tag} is ${type}; refusing to replace it`);
    }
  }

  const pushed = run(cwd, ["push", remoteName, `refs/tags/${tag}`], {
    allowFailure: true,
  });
  if (pushed.status !== 0) {
    throw new Error(
      (pushed.stderr || pushed.stdout || `git push ${remoteName} refs/tags/${tag} failed`).trim(),
    );
  }
  return { tag, commit: tagged, created: !localCommit };
}

/** Push HEAD to main. A rejection leaves any existing tag where it is. */
export function pushMainBranch({
  cwd = process.cwd(),
  remote = "origin",
  run = runGit,
} = {}) {
  const remoteName = assertRemote(remote);
  const pushed = run(cwd, ["push", remoteName, "HEAD:main"], {
    allowFailure: true,
  });
  if (pushed.status !== 0) {
    throw new Error(
      (pushed.stderr || pushed.stdout || `git push ${remoteName} HEAD:main failed`).trim(),
    );
  }
}

function normalizeOutcome(name, value) {
  if (value === undefined || value === null || value === "") return "skipped";
  if (typeof value !== "string" || !STEP_OUTCOMES.has(value)) {
    throw new Error(
      `${name} outcome must be success, failure, cancelled, or skipped`,
    );
  }
  return value;
}

function shownField(label, value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  if (/[\r\n`]/.test(text)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return text;
}

/**
 * Job summary from the publish, tag, main-branch, and GitHub release step
 * outcomes. Never promotes a missing or failed tag into a success claim.
 */
export function formatPythonPublishSummary({
  version = "",
  dryRun = "",
  ref = "",
  publish,
  tag,
  branch,
  release,
} = {}) {
  const outcomes = {
    publish: normalizeOutcome("publish", publish),
    tag: normalizeOutcome("tag", tag),
    branch: normalizeOutcome("branch", branch),
    release: normalizeOutcome("release", release),
  };
  const lines = [
    "## Python SDK Publish Summary",
    "",
    `**Version**: \`${shownField("version", version)}\``,
    `**Dry Run**: \`${shownField("dry run", dryRun)}\``,
    "",
    "| Step | Outcome |",
    "|------|---------|",
    ...SUMMARY_STEPS.map(([key, label]) => `| ${label} | ${outcomes[key]} |`),
  ];
  const allSkipped = SUMMARY_STEPS.every(([key]) => outcomes[key] === "skipped");
  if (allSkipped && (dryRun === true || dryRun === "true")) {
    lines.push(
      "",
      "Dry run: PyPI publication, tag, main branch push, and GitHub release did not run.",
    );
  } else if (
    allSkipped &&
    typeof ref === "string" &&
    ref.length > 0 &&
    ref !== "refs/heads/main"
  ) {
    lines.push(
      "",
      "Non-main ref: PyPI publication, tag, main branch push, and GitHub release did not run.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const command = process.argv[2];
  try {
    if (command === "summary") {
      process.stdout.write(
        formatPythonPublishSummary({
          version: process.env.PUBLISH_VERSION ?? "",
          dryRun: process.env.PUBLISH_DRY_RUN ?? "",
          ref: process.env.PUBLISH_REF ?? "",
          publish: process.env.PUBLISH_OUTCOME,
          tag: process.env.TAG_OUTCOME,
          branch: process.env.BRANCH_OUTCOME,
          release: process.env.RELEASE_OUTCOME,
        }),
      );
    } else if (command === "tag") {
      if (!process.env.NEW_VERSION) throw new Error("NEW_VERSION is required");
      const result = tagPublishedCommit({ version: process.env.NEW_VERSION });
      process.stdout.write(`${result.tag} ${result.commit}\n`);
    } else if (command === "push-main") {
      pushMainBranch();
    } else {
      throw new Error("command must be summary, tag, or push-main");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

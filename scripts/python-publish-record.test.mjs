import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  PYTHON_VERSION_PATHS,
  formatPythonPublishSummary,
  pushMainBranch,
  tagPublishedCommit,
} from "./python-publish-record.mjs";

const scriptPath = fileURLToPath(new URL("./python-publish-record.mjs", import.meta.url));
const workflow = readFileSync(
  new URL("../.github/workflows/publish-python.yml", import.meta.url),
  "utf8",
);

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

function recordingRun(log) {
  return (cwd, args, options = {}) => {
    log.push(args.join(" "));
    return runGit(cwd, args, options);
  };
}

function writeVersionFiles(dir, version) {
  const root = path.join(dir, "packages/sdk-python");
  mkdirSync(path.join(root, "src/relay_sdk"), { recursive: true });
  writeFileSync(path.join(root, "pyproject.toml"), `version = "${version}"\n`);
  writeFileSync(path.join(root, "uv.lock"), `version = "${version}"\n`);
  writeFileSync(
    path.join(root, "src/relay_sdk/client.py"),
    `SDK_VERSION = "${version}"\n`,
  );
}

function gitText(cwd, args) {
  return runGit(cwd, args).stdout.trim();
}

function removeTemp(directory) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "python-publish-"));
  const bare = path.join(root, "origin.git");
  runGit(root, ["init", "--bare", "-b", "main", bare]);
  const seed = path.join(root, "seed");
  runGit(root, ["init", "-b", "main", seed]);
  runGit(seed, ["config", "user.name", "Seed"]);
  runGit(seed, ["config", "user.email", "seed@example.com"]);
  writeVersionFiles(seed, "1.0.0");
  writeFileSync(path.join(seed, "README"), "base\n");
  runGit(seed, ["add", "."]);
  runGit(seed, ["commit", "-m", "base"]);
  runGit(seed, ["remote", "add", "origin", bare]);
  runGit(seed, ["push", "origin", "HEAD:main"]);
  return { root, bare, base: gitText(seed, ["rev-parse", "HEAD"]) };
}

function clone(bare, name) {
  const dir = path.join(path.dirname(bare), name);
  runGit(path.dirname(bare), ["clone", bare, name]);
  runGit(dir, ["config", "user.name", name]);
  runGit(dir, ["config", "user.email", `${name}@example.com`]);
  return dir;
}

function summary(env) {
  return spawnSync(process.execPath, [scriptPath, "summary"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("python publish summary", () => {
  it("prints each step outcome instead of one success claim", () => {
    const text = formatPythonPublishSummary({
      version: "1.2.3",
      dryRun: "false",
      ref: "refs/heads/main",
      publish: "success",
      tag: "success",
      branch: "success",
      release: "success",
    });

    assert.match(text, /\| PyPI publication \| success \|/);
    assert.match(text, /\| Tag \| success \|/);
    assert.match(text, /\| Main branch push \| success \|/);
    assert.match(text, /\| GitHub release \| success \|/);
    assert.doesNotMatch(text, /Published to PyPI and created tag/);
    assert.doesNotMatch(text, /created tag/i);
  });

  it("does not claim a tag that was not pushed", () => {
    for (const tag of ["failure", "skipped", "cancelled", ""]) {
      const text = formatPythonPublishSummary({
        version: "1.2.3",
        dryRun: "false",
        ref: "refs/heads/main",
        publish: "success",
        tag,
        branch: "skipped",
        release: "skipped",
      });
      const expected = tag === "" ? "skipped" : tag;
      assert.match(text, new RegExp(`\\| Tag \\| ${expected} \\|`));
      assert.doesNotMatch(text, /\| Tag \| success \|/);
      assert.doesNotMatch(text, /created tag/i);
      assert.doesNotMatch(text, /Published to PyPI and created tag/);
    }
  });

  it("keeps a rejected main push visible when the tag succeeded", () => {
    const text = formatPythonPublishSummary({
      version: "1.2.3",
      dryRun: "false",
      ref: "refs/heads/main",
      publish: "success",
      tag: "success",
      branch: "failure",
      release: "success",
    });

    assert.match(text, /\| PyPI publication \| success \|/);
    assert.match(text, /\| Tag \| success \|/);
    assert.match(text, /\| Main branch push \| failure \|/);
    assert.match(text, /\| GitHub release \| success \|/);
    assert.doesNotMatch(text, /\| Main branch push \| success \|/);
    assert.doesNotMatch(text, /Published to PyPI and created tag/);
  });

  it("explains a dry run or non-main ref only when every step was skipped", () => {
    const dryRun = formatPythonPublishSummary({
      version: "1.2.3",
      dryRun: "true",
      ref: "refs/heads/main",
      publish: "skipped",
      tag: "skipped",
      branch: "skipped",
      release: "skipped",
    });
    assert.match(dryRun, /Dry run: PyPI publication, tag, main branch push, and GitHub release did not run\./);
    assert.doesNotMatch(dryRun, /created tag/i);

    const otherRef = formatPythonPublishSummary({
      version: "1.2.3",
      dryRun: "false",
      ref: "refs/heads/feature",
      publish: "",
      tag: "",
      branch: "",
      release: "",
    });
    assert.match(otherRef, /Non-main ref: PyPI publication, tag, main branch push, and GitHub release did not run\./);
    assert.match(otherRef, /\| Tag \| skipped \|/);

    const contradicted = formatPythonPublishSummary({
      version: "1.2.3",
      dryRun: "true",
      ref: "refs/heads/main",
      publish: "success",
      tag: "success",
      branch: "failure",
      release: "skipped",
    });
    assert.doesNotMatch(contradicted, /did not run/);
    assert.match(contradicted, /\| Main branch push \| failure \|/);
  });

  it("fails closed on an unknown outcome without printing a tag success", () => {
    assert.throws(
      () =>
        formatPythonPublishSummary({
          version: "1.2.3",
          dryRun: "false",
          ref: "refs/heads/main",
          publish: "success",
          tag: "yes",
          branch: "skipped",
          release: "skipped",
        }),
      /tag outcome must be success, failure, cancelled, or skipped/,
    );

    const result = summary({
      PUBLISH_VERSION: "1.2.3",
      PUBLISH_DRY_RUN: "false",
      PUBLISH_REF: "refs/heads/main",
      PUBLISH_OUTCOME: "success",
      TAG_OUTCOME: "yes",
      BRANCH_OUTCOME: "skipped",
      RELEASE_OUTCOME: "skipped",
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /\| Tag \| success \|/);
    assert.doesNotMatch(result.stdout, /created tag/i);
  });

  it("reads step outcomes from the environment the workflow sets", () => {
    const result = summary({
      PUBLISH_VERSION: "1.2.3",
      PUBLISH_DRY_RUN: "false",
      PUBLISH_REF: "refs/heads/main",
      PUBLISH_OUTCOME: "success",
      TAG_OUTCOME: "failure",
      BRANCH_OUTCOME: "skipped",
      RELEASE_OUTCOME: "skipped",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| PyPI publication \| success \|/);
    assert.match(result.stdout, /\| Tag \| failure \|/);
    assert.match(result.stdout, /\| Main branch push \| skipped \|/);
    assert.match(result.stdout, /\| GitHub release \| skipped \|/);
    assert.doesNotMatch(result.stdout, /created tag/i);
  });
});

describe("python publish git record", () => {
  it("rejects a version before touching git", () => {
    assert.throws(
      () =>
        tagPublishedCommit({
          cwd: "/tmp",
          version: "1.2.3-beta",
          run: () => {
            throw new Error("git should not run");
          },
        }),
      /MAJOR\.MINOR\.PATCH/,
    );
  });

  it("pushes main with one command and does not replay the published commit", () => {
    const calls = [];
    pushMainBranch({
      cwd: "/repo",
      remote: "origin",
      run: (cwd, args) => {
        calls.push(args);
        assert.equal(cwd, "/repo");
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(calls, [["push", "origin", "HEAD:main"]]);
  });

  it("keeps the tag on the uploaded commit when main advances", () => {
    const { root, bare, base } = createRepository();
    try {
      const published = clone(bare, "published");
      const advanced = clone(bare, "advanced");
      writeVersionFiles(published, "1.2.3");
      writeFileSync(path.join(published, "notes.txt"), "not part of the release\n");
      writeVersionFiles(advanced, "9.9.9");
      writeFileSync(path.join(advanced, "unrelated.txt"), "later main\n");
      runGit(advanced, ["add", "."]);
      runGit(advanced, ["commit", "-m", "unrelated and conflicting version advance"]);
      runGit(advanced, ["push", "origin", "HEAD:main"]);
      const advancedHead = gitText(advanced, ["rev-parse", "HEAD"]);

      const tagLog = [];
      const tagged = tagPublishedCommit({
        cwd: published,
        version: "1.2.3",
        run: recordingRun(tagLog),
      });
      const publishedHead = gitText(published, ["rev-parse", "HEAD"]);
      assert.equal(tagged.commit, publishedHead);
      assert.equal(gitText(published, ["rev-parse", "HEAD^"]), base);
      assert.equal(
        gitText(bare, ["rev-parse", "refs/tags/sdk-python-v1.2.3^{}"]),
        publishedHead,
      );
      assert.equal(gitText(bare, ["rev-parse", "refs/heads/main"]), advancedHead);
      assert.match(
        gitText(published, ["show", "HEAD:packages/sdk-python/pyproject.toml"]),
        /version = "1\.2\.3"/,
      );
      const taggedFiles = gitText(published, ["ls-tree", "-r", "--name-only", "HEAD"]);
      for (const versionPath of PYTHON_VERSION_PATHS) {
        assert.match(taggedFiles, new RegExp(versionPath.replaceAll(".", "\\.")));
      }
      assert.doesNotMatch(taggedFiles, /unrelated\.txt/);
      assert.doesNotMatch(taggedFiles, /notes\.txt/);
      assert.equal(gitText(bare, ["cat-file", "-t", "refs/tags/sdk-python-v1.2.3"]), "tag");
      assert.equal(
        runGit(bare, ["merge-base", "--is-ancestor", advancedHead, publishedHead], {
          allowFailure: true,
        }).status,
        1,
      );
      assert.ok(tagLog.some((line) => line === "push origin refs/tags/sdk-python-v1.2.3"));
      assert.ok(!tagLog.some((line) => /rebase|HEAD:main|\bfetch\b|\bpull\b|\bmerge\b/.test(line)));
      const commitAt = tagLog.findIndex((line) => line.startsWith("commit "));
      const tagAt = tagLog.findIndex((line) => line.startsWith("tag "));
      const pushAt = tagLog.findIndex((line) => line.startsWith("push "));
      assert.ok(commitAt >= 0 && commitAt < tagAt && tagAt < pushAt);

      const pushLog = [];
      assert.throws(
        () =>
          pushMainBranch({
            cwd: published,
            run: recordingRun(pushLog),
          }),
        /rejected|fetch first|non-fast-forward/,
      );
      assert.deepEqual(pushLog, ["push origin HEAD:main"]);
      assert.equal(gitText(published, ["rev-parse", "HEAD"]), publishedHead);
      assert.equal(
        gitText(bare, ["rev-parse", "refs/tags/sdk-python-v1.2.3^{}"]),
        publishedHead,
      );
      assert.equal(gitText(bare, ["rev-parse", "refs/heads/main"]), advancedHead);

      const rerunLog = [];
      const rerun = tagPublishedCommit({
        cwd: published,
        version: "1.2.3",
        run: recordingRun(rerunLog),
      });
      assert.equal(rerun.commit, publishedHead);
      assert.equal(rerun.created, false);
      assert.equal(gitText(published, ["rev-list", "--count", "HEAD"]), "2");
      assert.ok(!rerunLog.some((line) => line.startsWith("commit ") || line.startsWith("tag ")));
      assert.equal(
        gitText(bare, ["rev-parse", "refs/tags/sdk-python-v1.2.3^{}"]),
        publishedHead,
      );

      const later = clone(bare, "later");
      assert.equal(gitText(later, ["rev-parse", "HEAD"]), advancedHead);
      writeVersionFiles(later, "1.2.3");
      const laterLog = [];
      assert.throws(
        () =>
          tagPublishedCommit({
            cwd: later,
            version: "1.2.3",
            run: recordingRun(laterLog),
          }),
        /refusing to move the published tag/,
      );
      assert.equal(gitText(later, ["rev-parse", "HEAD"]), advancedHead);
      assert.match(gitText(later, ["status", "--porcelain"]), /pyproject\.toml/);
      assert.ok(!laterLog.some((line) => /^(commit |tag |push |rebase )/.test(line)));
      assert.equal(
        gitText(bare, ["rev-parse", "refs/tags/sdk-python-v1.2.3^{}"]),
        publishedHead,
      );
      assert.doesNotMatch(
        gitText(bare, ["ls-tree", "-r", "--name-only", "refs/tags/sdk-python-v1.2.3^{}"]),
        /unrelated\.txt/,
      );
      assert.match(
        gitText(bare, ["show", "refs/heads/main:packages/sdk-python/pyproject.toml"]),
        /version = "9\.9\.9"/,
      );
    } finally {
      removeTemp(root);
    }
  });

  it("fast-forwards main to the same commit the tag already records", () => {
    const { root, bare, base } = createRepository();
    try {
      const published = clone(bare, "published");
      writeVersionFiles(published, "1.2.4");
      const tagLog = [];
      const tagged = tagPublishedCommit({
        cwd: published,
        version: "1.2.4",
        run: recordingRun(tagLog),
      });
      pushMainBranch({ cwd: published, run: recordingRun([]) });
      const head = gitText(published, ["rev-parse", "HEAD"]);
      assert.equal(tagged.commit, head);
      assert.equal(gitText(published, ["rev-parse", "HEAD^"]), base);
      assert.equal(gitText(bare, ["rev-parse", "refs/heads/main"]), head);
      assert.equal(gitText(bare, ["rev-parse", "refs/tags/sdk-python-v1.2.4^{}"]), head);
      assert.ok(!tagLog.some((line) => /rebase|HEAD:main/.test(line)));
    } finally {
      removeTemp(root);
    }
  });
});

describe("python publish workflow contract", () => {
  it("tags the published commit before updating main and summarizes real step outcomes", () => {
    const tagAt = workflow.indexOf("python-publish-record.mjs tag");
    const branchAt = workflow.indexOf("python-publish-record.mjs push-main");
    const summaryAt = workflow.indexOf("python-publish-record.mjs summary");
    const publishGate = workflow.indexOf("steps.publish.outcome == 'success'");
    assert.ok(tagAt > 0 && branchAt > tagAt && summaryAt > branchAt);
    assert.ok(publishGate > 0 && publishGate < tagAt);
    assert.doesNotMatch(workflow, /git rebase/);
    assert.doesNotMatch(workflow, /HEAD:main/);
    assert.doesNotMatch(workflow, /Published to PyPI and created tag/);
    assert.match(workflow, /id: publish/);
    assert.match(workflow, /id: tag/);
    assert.match(workflow, /id: branch/);
    assert.match(workflow, /id: release/);
    assert.match(workflow, /steps\.tag\.outcome == 'success'/);
    assert.match(workflow, /!cancelled\(\)/);
    assert.match(workflow, /PUBLISH_OUTCOME: \$\{\{ steps\.publish\.outcome \}\}/);
    assert.match(workflow, /TAG_OUTCOME: \$\{\{ steps\.tag\.outcome \}\}/);
    assert.match(workflow, /BRANCH_OUTCOME: \$\{\{ steps\.branch\.outcome \}\}/);
    assert.match(workflow, /RELEASE_OUTCOME: \$\{\{ steps\.release\.outcome \}\}/);
  });
});

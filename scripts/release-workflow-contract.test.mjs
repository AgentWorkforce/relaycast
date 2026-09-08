import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { PUBLISHED_PACKAGE_DIRS } from "./release-contract.mjs";
import {
  assertPublishedIntegrity,
  assertReusableReleaseTag,
  readReleaseProvenance,
  assertSourceProvenance,
} from "./release-provenance.mjs";

const PROVENANCE = {
  schema: 1,
  sourceCommit: "a".repeat(40),
  sourceTree: "b".repeat(40),
  version: "8.6.0",
  distTag: "latest",
  packages: [
    {
      name: "@relaycast/types",
      version: "8.6.0",
      tarball: "release-artifacts/relaycast-types-8.6.0.tgz",
      integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
      shasum: "c".repeat(40),
    },
  ],
};

const workflow = readFileSync(
  new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  "utf8",
);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const validateReleaseTag = fileURLToPath(
  new URL("./validate-release-tag.mjs", import.meta.url),
);
const cutChangelog = fileURLToPath(
  new URL("./cut-changelog.mjs", import.meta.url),
);

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: options.input,
    ...options,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function archiveRevision(revision, target) {
  const archivePath = `${target}.tar`;
  const archived = spawnSync("git", ["archive", "-o", archivePath, revision], {
    cwd: repositoryRoot,
  });
  assert.equal(archived.status, 0, archived.stderr?.toString());
  const extracted = spawnSync("tar", ["-xf", "-", "-C", target], {
    input: readFileSync(archivePath),
  });
  rmSync(archivePath, { force: true });
  assert.equal(extracted.status, 0, extracted.stderr?.toString());
}

function releaseTagFixture({ alteredSource = false, mutateReleaseFile } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "relaycast-release-tag-"));
  archiveRevision("HEAD", root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "release-test@example.com"]);
  git(root, ["config", "user.name", "Release Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "source"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const sourceTree = git(root, ["rev-parse", "HEAD^{tree}"]);

  git(root, ["tag", "v8.5.4"]);
  const cut = spawnSync(
    process.execPath,
    [cutChangelog, "--version", "8.5.5", "--from-tag", "v8.5.4", "--date", "2026-09-09"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cut.status, 0, cut.stderr);
  if (mutateReleaseFile) {
    const filePath = path.join(root, mutateReleaseFile);
    if (mutateReleaseFile === "packages/engine/package.json") {
      const manifest = JSON.parse(readFileSync(filePath, "utf8"));
      manifest.scripts = { ...(manifest.scripts ?? {}), postinstall: "echo unauthorized" };
      writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (mutateReleaseFile === "package-lock.json") {
      const lock = JSON.parse(readFileSync(filePath, "utf8"));
      lock.packages["packages/engine"].license = "MIT";
      writeFileSync(filePath, `${JSON.stringify(lock, null, 2)}\n`);
    } else {
      writeFileSync(filePath, `${readFileSync(filePath, "utf8")}\nrelease fixture mutation\n`);
    }
  }
  if (alteredSource) {
    writeFileSync(path.join(root, "README.md"), "altered application source\n");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "chore(release): v8.5.5"], {
    env: {
      GIT_AUTHOR_DATE: "2026-09-09T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-09-09T12:00:00Z",
    },
  });
  const tagCommit = git(root, ["rev-parse", "HEAD"]);
  const message = [
    "Release v8.5.5",
    "",
    "Relaycast-NPM-Dist-Tag: latest",
    `Relaycast-Source-Commit: ${sourceCommit}`,
    `Relaycast-Source-Tree: ${sourceTree}`,
    "Relaycast-Package-Provenance-SHA256: fixture-digest",
  ].join("\n");
  git(root, ["tag", "-a", "v8.5.5", "-m", message]);
  const engineIntegrity = JSON.parse(
    readFileSync(path.join(root, "docker/package-lock.json"), "utf8"),
  ).packages["node_modules/@relaycast/engine"].integrity;
  return { root, sourceCommit, sourceTree, tagCommit, engineIntegrity };
}

function validateTag(fixture) {
  return spawnSync(
    process.execPath,
    [
      validateReleaseTag,
      "--tag",
      "v8.5.5",
      "--source-commit",
      fixture.sourceCommit,
      "--source-tree",
      fixture.sourceTree,
      "--version",
      "8.5.5",
      "--dist-tag",
      "latest",
      "--provenance-digest",
      "fixture-digest",
      "--engine-integrity",
      fixture.engineIntegrity,
    ],
    { cwd: fixture.root, encoding: "utf8" },
  );
}

describe("publish workflow safety contract", () => {
  it("offers lockstep publication only", () => {
    const packageInput = workflow.slice(
      workflow.indexOf("      package:"),
      workflow.indexOf("      version:"),
    );
    assert.match(packageInput, /options:\n\s+- all\n/);
    assert.doesNotMatch(
      packageInput,
      /- (?:a2a|types|engine|sdk-typescript|cli|mcp|react|openclaw)/,
    );
    assert.doesNotMatch(workflow, /^  publish-single:/m);
    assert.doesNotMatch(workflow, /needs\.publish-single/);
  });

  it("runs deterministic release checks before any publish job", () => {
    const tests = workflow.indexOf("npm run test:release");
    const validation = workflow.indexOf(
      'node scripts/check-release-contract.mjs --version "$NEW_VERSION" --allow-placeholder-docker-lock',
    );
    const publishJob = workflow.indexOf("  publish-packages:");
    assert.ok(tests > 0 && validation > tests && publishJob > validation);
    assert.match(
      jobBlock("create-release"),
      /Re-validate release contract with the refreshed lockfile[\s\S]*check-release-contract\.mjs --version/,
    );
  });

  it("carries generated source constants into the release commit", () => {
    for (const file of [
      "packages/sdk-typescript/src/version.ts",
      "packages/cli/src/version.ts",
    ]) {
      assert.match(
        workflow,
        new RegExp(`path: \\|[\\s\\S]*?${file.replace(/\//g, "\\/")}`),
        `${file} must be uploaded with build artifacts`,
      );
      assert.match(
        workflow,
        new RegExp(`git add [^\\n]*${file.replace(/\//g, "\\/")}`),
        `${file} must be staged in the release commit`,
      );
    }
  });

  it("publishes and releases only after the all-package matrix succeeds", () => {
    const matrixStart = workflow.indexOf("      matrix:\n        package:");
    const matrixEnd = workflow.indexOf("\n\n    steps:", matrixStart);
    const matrixPackages = [
      ...workflow
        .slice(matrixStart, matrixEnd)
        .matchAll(/^          - (\S+)$/gm),
    ].map((match) => match[1]);
    assert.deepEqual(matrixPackages, PUBLISHED_PACKAGE_DIRS);
    assert.match(workflow, /needs\.publish-packages\.result == 'success'/);
  });

  function jobBlock(name) {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.ok(start !== -1, `job "${name}" not found`);
    // The next line indented at exactly two spaces (a sibling top-level key
    // or a comment introducing the next job) ends this job's block; a
    // shallower indent-prefix match would also match every 4+-space step
    // line inside this same job.
    const nextMatch = /\n {2}\S/.exec(workflow.slice(start + 1));
    const next = nextMatch ? start + 1 + nextMatch.index : workflow.length;
    return workflow.slice(start, next);
  }

  it("independently reconciles the npm registry before releasing, and creates the release only after that succeeds", () => {
    const verify = jobBlock("verify-publish");
    assert.match(verify, /needs: \[build, publish-packages\]/);
    // Every published package name must actually be checked against the
    // registry, not just the matrix's own workspace directory names.
    for (const pkg of [
      "@relaycast/a2a",
      "@relaycast/types",
      "@relaycast/engine",
      "@relaycast/sdk",
      "relaycast",
      "@relaycast/mcp",
      "@relaycast/react",
      "@relaycast/openclaw",
    ]) {
      assert.match(verify, new RegExp(`"${pkg.replace(/[/]/g, "\\/")}"`));
    }
    assert.match(verify, /npm view "\$\{pkg\}@\$\{NEW_VERSION\}" version/);
    assert.match(verify, /exit 1/);

    const createRelease = jobBlock("create-release");
    assert.match(createRelease, /needs: \[build, publish-packages, verify-publish\]/);
    assert.match(createRelease, /needs\.verify-publish\.result == 'success'/);
  });

  it("never defaults a prerelease version's npm dist-tag to latest", () => {
    const build = jobBlock("build");
    assert.match(build, /IS_PRERELEASE=true/);
    assert.match(
      build,
      /IS_PRERELEASE" = "true" \] && \[ "\$REQUESTED_TAG" = "latest" \]/,
    );
    assert.match(build, /EFFECTIVE_TAG="next"/);
    assert.match(build, /effective_tag=\$EFFECTIVE_TAG/);

    const publishPackages = jobBlock("publish-packages");
    // The actual npm publish invocations must use the computed effective
    // tag, not the raw, unguarded workflow_dispatch input.
    assert.doesNotMatch(
      publishPackages,
      /npm publish[^\n]*--tag \$\{\{ github\.event\.inputs\.tag \}\}/,
    );
    assert.match(
      publishPackages,
      /npm publish[^\n]*--tag \$\{\{ needs\.build\.outputs\.effective_tag \}\}/,
    );
  });

  it("resumes a partially published matrix instead of hard-failing on an already-published package", () => {
    const publishPackages = jobBlock("publish-packages");
    const publishStep = publishPackages.slice(
      publishPackages.indexOf("- name: Publish to NPM"),
    );
    assert.match(publishStep, /npm view "\$\{PACKAGE_NAME\}@\$\{NEW_VERSION\}" version/);
    assert.match(publishStep, /dist\.integrity/);
    assert.match(publishStep, /already matches this build; skipping/);
  });

  it("publishes and reconciles exact build tarballs, never a version-only registry match", () => {
    const publishPackages = jobBlock("publish-packages");
    assert.match(publishPackages, /release-provenance\.json/);
    assert.match(publishPackages, /npm publish "\$GITHUB_WORKSPACE\/\$TARBALL"/);
    const verify = jobBlock("verify-publish");
    assert.match(verify, /release-provenance\.mjs published/);
    assert.match(verify, /dist\.integrity/);
  });

  it("reuses a matching tagged tree on rerun and tags before reconciling main", () => {
    const createRelease = jobBlock("create-release");
    // Rebasing a release commit after packages have already been published
    // from its pre-rebase tree would tag different code than what was
    // actually tested and published; this must never reappear.
    assert.doesNotMatch(createRelease, /git rebase/);

    const tagPush = createRelease.indexOf('git push origin "${TAG}"');
    const mainMerge = createRelease.indexOf("git merge --no-edit origin/main");
    assert.ok(tagPush !== -1, "tag push not found");
    assert.ok(mainMerge !== -1, "main merge reconciliation not found");
    assert.ok(
      tagPush < mainMerge,
      "the tag must be pushed before any attempt to reconcile the release commit with main",
    );
    assert.match(createRelease, /git reset --hard "\$\{TAG\}\^\{commit\}"/);
    assert.match(createRelease, /git checkout --theirs/);
  });

  it("validates and restores an existing tag before a cross-day changelog cut", () => {
    const createRelease = jobBlock("create-release");
    const reuse = createRelease.indexOf("Reuse an existing release tag before cutting changelogs");
    const cut = createRelease.indexOf("Cut changelogs");
    assert.ok(reuse !== -1, "pre-cut tag reuse step not found");
    assert.ok(cut !== -1 && reuse < cut, "tag reuse must precede the date-sensitive changelog cut");
    const reuseBlock = createRelease.slice(reuse, cut);
    assert.match(reuseBlock, /validate-release-tag\.mjs/);
    assert.match(reuseBlock, /git reset --hard "\$\{TAG\}\^\{commit\}"/);
    assert.match(reuseBlock, /REUSE_EXISTING_RELEASE_TAG=true/);
    assert.match(
      createRelease.slice(cut),
      /existing release tag restored; leaving its changelog tree unchanged/,
    );
    assert.match(
      createRelease.slice(cut),
      /existing release tag restored; leaving its lockfile tree unchanged/,
    );
  });

  it("escalates permissions per job instead of workflow-wide", () => {
    const topLevelPermissions = workflow.slice(
      workflow.indexOf("\npermissions:"),
      workflow.indexOf("\nenv:"),
    );
    assert.match(topLevelPermissions, /contents: read/);
    assert.doesNotMatch(topLevelPermissions, /contents: write/);
    assert.doesNotMatch(topLevelPermissions, /id-token: write/);

    assert.match(jobBlock("publish-packages"), /id-token: write/);
    assert.match(jobBlock("create-release"), /contents: write/);
  });
});

describe("release tag reuse execution", () => {
  it("rejects an annotated tag with correct metadata when its tree alters application source", () => {
    const fixture = releaseTagFixture({ alteredSource: true });
    try {
      const result = validateTag(fixture);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /non-release paths: README\.md/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reuses the exact valid tag tree across a simulated UTC-day retry", () => {
    const fixture = releaseTagFixture();
    try {
      const first = validateTag(fixture);
      assert.equal(first.status, 0, first.stderr);
      const taggedTree = git(fixture.root, ["rev-parse", "v8.5.5^{tree}"]);
      git(fixture.root, ["reset", "--hard", fixture.sourceCommit]);
      const retry = validateTag(fixture);
      assert.equal(retry.status, 0, retry.stderr);
      git(fixture.root, ["reset", "--hard", "v8.5.5^{commit}"]);
      assert.equal(git(fixture.root, ["rev-parse", "HEAD^{tree}"]), taggedTree);
      assert.equal(fixture.tagCommit, git(fixture.root, ["rev-parse", "HEAD"]));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const file of [
    "packages/engine/package.json",
    "package-lock.json",
    "Dockerfile",
    "RUNBOOK.md",
    "CHANGELOG.md",
  ]) {
    it(`rejects an arbitrary edit inside release-allowlisted ${file}`, () => {
      const fixture = releaseTagFixture({ mutateReleaseFile: file });
      try {
        const result = validateTag(fixture);
        assert.notEqual(result.status, 0);
        assert.match(
          `${result.stderr}${result.stdout}`,
          /outside its exact release transformation|unexpected release edits/,
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it("rejects a release merge commit even when its first parent is the source", () => {
    const fixture = releaseTagFixture();
    try {
      git(fixture.root, ["checkout", "-q", "-b", "release-side", fixture.sourceCommit]);
      git(fixture.root, ["commit", "--allow-empty", "-qm", "test: side parent"]);
      const sideCommit = git(fixture.root, ["rev-parse", "HEAD"]);
      const releaseTree = git(fixture.root, ["rev-parse", "v8.5.5^{tree}"]);
      const mergeCommit = git(fixture.root, [
        "commit-tree", releaseTree, "-p", fixture.sourceCommit, "-p", sideCommit,
      ], { input: "test: merge release\n" });
      git(fixture.root, ["reset", "--hard", mergeCommit]);
      git(fixture.root, ["tag", "-d", "v8.5.5"]);
      const message = [
        "Release v8.5.5", "", "Relaycast-NPM-Dist-Tag: latest",
        `Relaycast-Source-Commit: ${fixture.sourceCommit}`,
        `Relaycast-Source-Tree: ${fixture.sourceTree}`,
        "Relaycast-Package-Provenance-SHA256: fixture-digest",
      ].join("\n");
      git(fixture.root, ["tag", "-a", "v8.5.5", "-m", message]);
      const result = validateTag(fixture);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /exactly one parent/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("cuts a bare Unreleased block through the CLI fallback and updates comparison references", () => {
    const root = mkdtempSync(path.join(tmpdir(), "relaycast-cut-cli-"));
    try {
      mkdirSync(path.join(root, "packages"));
      writeFileSync(
        path.join(root, "CHANGELOG.md"),
        "# Changelog\n\n## [Unreleased]\n\n## [8.5.5] - 2026-09-08\n\n### Fixed\n\n- Previous\n",
      );
      git(root, ["init", "-q"]);
      git(root, ["config", "user.email", "release-test@example.com"]);
      git(root, ["config", "user.name", "Release Test"]);
      git(root, ["add", "."]);
      git(root, ["commit", "-qm", "chore: base"]);
      git(root, ["tag", "v8.5.5"]);
      writeFileSync(path.join(root, "release-note.txt"), "fallback\n");
      git(root, ["add", "."]);
      git(root, ["commit", "-qm", "fix: fallback release proof"]);

      const result = spawnSync(
        process.execPath,
        [cutChangelog, "--version", "8.6.0", "--from-tag", "v8.5.5", "--date", "2026-09-09"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
      assert.match(changelog, /## \[8\.6\.0\] - 2026-09-09/);
      assert.match(changelog, /- Fallback release proof/);
      assert.match(
        changelog,
        /\[Unreleased\]: https:\/\/github\.com\/AgentWorkforce\/relaycast\/compare\/v8\.6\.0\.\.\.HEAD/,
      );
      assert.match(
        changelog,
        /\[8\.6\.0\]: https:\/\/github\.com\/AgentWorkforce\/relaycast\/compare\/v8\.5\.5\.\.\.v8\.6\.0/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release provenance adversarial cases", () => {
  it("rejects stale or wrong-source packages instead of accepting a version-only match", () => {
    assert.throws(
      () => assertPublishedIntegrity(PROVENANCE, "@relaycast/types", "sha512-stale"),
      /different artifact integrity/,
    );
    assert.throws(
      () => assertPublishedIntegrity(PROVENANCE, "@relaycast/types", PROVENANCE.packages[0].integrity, "8.6.1"),
      /provenance version/,
    );
    assert.throws(
      () => assertSourceProvenance(PROVENANCE, "d".repeat(40), PROVENANCE.sourceTree),
      /immutable workflow source/,
    );
  });

  it("rejects lightweight and wrong-tree tag reuse while allowing a matching rerun tree", () => {
    const common = {
      tagTree: "e".repeat(40),
      releaseTree: "e".repeat(40),
      tagMessage: [
        "Release v8.6.0",
        "Relaycast-NPM-Dist-Tag: latest",
        `Relaycast-Source-Commit: ${PROVENANCE.sourceCommit}`,
        `Relaycast-Source-Tree: ${PROVENANCE.sourceTree}`,
        "Relaycast-Package-Provenance-SHA256: digest",
      ].join("\n"),
      version: PROVENANCE.version,
      distTag: PROVENANCE.distTag,
      sourceCommit: PROVENANCE.sourceCommit,
      sourceTree: PROVENANCE.sourceTree,
      packageProvenanceDigest: "digest",
    };
    assert.doesNotThrow(() => assertReusableReleaseTag({ tagType: "tag", ...common }));
    assert.throws(
      () => assertReusableReleaseTag({ tagType: "commit", ...common }),
      /annotated/,
    );
    assert.throws(
      () => assertReusableReleaseTag({ tagType: "tag", ...common, tagTree: "f".repeat(40) }),
      /tree differs/,
    );
  });

  it("rejects unsupported provenance schemas", () => {
    const manifestPath = new URL("../package.json", import.meta.url);
    assert.throws(() => readReleaseProvenance(manifestPath), /unsupported schema/);
  });

  it("rejects a bare optional provenance version instead of skipping its check", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "relaycast-provenance-"));
    const manifestPath = path.join(directory, "provenance.json");
    writeFileSync(manifestPath, JSON.stringify(PROVENANCE));
    try {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./release-provenance.mjs", import.meta.url)),
          "published",
          "--manifest",
          manifestPath,
          "--package",
          "@relaycast/types",
          "--integrity",
          PROVENANCE.packages[0].integrity,
          "--version",
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /--version requires a value/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

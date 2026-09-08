import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PUBLISHED_PACKAGE_DIRS } from "./release-contract.mjs";
import {
  assertPublishedIntegrity,
  assertReusableReleaseTag,
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
      'node scripts/check-release-contract.mjs --version "$NEW_VERSION"',
    );
    const publishJob = workflow.indexOf("  publish-packages:");
    assert.ok(tests > 0 && validation > tests && publishJob > validation);
  });

  it("carries generated source constants into the release commit", () => {
    for (const file of [
      "packages/sdk-typescript/src/version.ts",
      "packages/cli/src/version.ts",
    ]) {
      assert.equal(
        workflow.split(file).length - 1,
        2,
        `${file} must be uploaded and staged`,
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

  it("tags the exact built, published, and verified commit instead of rebasing onto a possibly-moved main", () => {
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

  it("rejects lightweight, wrong-commit, and wrong-tree tag reuse", () => {
    const common = {
      tagCommit: "d".repeat(40),
      releaseCommit: "d".repeat(40),
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
      () => assertReusableReleaseTag({ tagType: "tag", ...common, tagCommit: "f".repeat(40) }),
      /commit differs/,
    );
    assert.throws(
      () => assertReusableReleaseTag({ tagType: "tag", ...common, tagTree: "f".repeat(40) }),
      /tree differs/,
    );
  });
});

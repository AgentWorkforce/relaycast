import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  provenanceDigest,
  readReleaseProvenance,
  assertSourceProvenance,
} from "./release-provenance.mjs";

const DOCKER_PACKAGE_NAMES = [
  "@relaycast/a2a",
  "@relaycast/types",
  "@relaycast/engine",
];

// Captured from `npm view @relaycast/<package>@<version> dist.integrity`.
// These make the fixture reproduce a real registry-backed Docker lock refresh.
const NPM_REGISTRY_DOCKER_INTEGRITIES = {
  "8.5.4": {
    "@relaycast/a2a": "sha512-gCHYFmLJmug0Tf6H28NQLIFyCzMDNGScaX7qwp+540XvQ/4P0MGKp1hE8RBuUxeU/YINS/PMd569GFvY44P+JQ==",
    "@relaycast/types": "sha512-o4wfVaeQwA9epX4hJxmT3y3UKVmzH5iZgHlZPLYkLFIzyOu8mmYriK896WL/0qXfLz9ZvJivNHmf6W+6cgZCFw==",
    "@relaycast/engine": "sha512-VRG2HCRkHfl8kjLdDPo70SlH3EbzFGwFmKvA3w4z3/4qnXO7+6paPYHchTHe01qRkQtlOwNZqDE4yRvegs/6dA==",
  },
  "8.5.5": {
    "@relaycast/a2a": "sha512-jYey3emrze19XXF+hAI0nEuwicI6MOHOO8zugi1GZqsC8akhjYOgAKDZzIzSUl/Ug/wm6/g3cv9qtfGj7tCgSA==",
    "@relaycast/types": "sha512-36VPTinFLPmnt8dTIWoXNNkAgjL0gZSBJzUz29ludyqVqhJx2vdbqwFOQG3tRqQGDgmb2WM8IEZRl90sm+do5g==",
    "@relaycast/engine": "sha512-Ebny3qhkr3tr6Ghf1o+gwF6obvyr+e7HAOzYxNmX92zC6q/wkCwZEn4o16Ta1iyUHAX4ddDxGMAIB5aU0Ze61A==",
  },
};

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

function bumpFixtureVersion(root, version, dockerIntegrities) {
  const packageDirs = git(root, ["ls-files", "packages/*/package.json"])
    .split("\n")
    .filter(Boolean);
  for (const file of packageDirs) {
    const manifestPath = path.join(root, file);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = version;
    for (const type of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[type] ?? {})) {
        if (name.startsWith("@relaycast/")) manifest[type][name] = version;
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const rootLockPath = path.join(root, "package-lock.json");
  const rootLock = JSON.parse(readFileSync(rootLockPath, "utf8"));
  for (const [key, entry] of Object.entries(rootLock.packages ?? {})) {
    if (!/^packages\/[^/]+$/.test(key)) continue;
    entry.version = version;
    for (const type of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const name of Object.keys(entry[type] ?? {})) {
        if (name.startsWith("@relaycast/")) entry[type][name] = version;
      }
    }
  }
  writeFileSync(rootLockPath, `${JSON.stringify(rootLock, null, 2)}\n`);
  writeFileSync(path.join(root, "packages/sdk-typescript/src/version.ts"), `export const SDK_VERSION = ${JSON.stringify(version)} as const;\n`);
  writeFileSync(path.join(root, "packages/cli/src/version.ts"), `export const CLI_VERSION = ${JSON.stringify(version)} as const;\n`);

  const dockerfilePath = path.join(root, "Dockerfile");
  writeFileSync(
    dockerfilePath,
    readFileSync(dockerfilePath, "utf8").replace(/^ARG RELAYCAST_ENGINE_VERSION=\S+/m, `ARG RELAYCAST_ENGINE_VERSION=${version}`),
  );
  const dockerManifestPath = path.join(root, "docker/package.json");
  const dockerManifest = JSON.parse(readFileSync(dockerManifestPath, "utf8"));
  dockerManifest.version = version;
  dockerManifest.dependencies["@relaycast/engine"] = version;
  writeFileSync(dockerManifestPath, `${JSON.stringify(dockerManifest, null, 2)}\n`);

  const dockerLockPath = path.join(root, "docker/package-lock.json");
  const dockerLock = JSON.parse(readFileSync(dockerLockPath, "utf8"));
  dockerLock.version = version;
  dockerLock.packages[""].version = version;
  dockerLock.packages[""].dependencies["@relaycast/engine"] = version;
  for (const [key, entry] of Object.entries(dockerLock.packages)) {
    if (!key.startsWith("node_modules/@relaycast/")) continue;
    const name = key.slice("node_modules/".length);
    const shortName = name.slice("@relaycast/".length);
    assert.ok(dockerIntegrities[name], `missing registry integrity for ${name}@${version}`);
    entry.version = version;
    entry.resolved = `https://registry.npmjs.org/${name}/-/${shortName}-${version}.tgz`;
    entry.integrity = dockerIntegrities[name];
    for (const type of ["dependencies", "devDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(entry[type] ?? {})) {
        if (dependency.startsWith("@relaycast/")) entry[type][dependency] = version;
      }
    }
  }
  writeFileSync(dockerLockPath, `${JSON.stringify(dockerLock, null, 2)}\n`);
  const runbookPath = path.join(root, "RUNBOOK.md");
  let runbook = readFileSync(runbookPath, "utf8");
  for (const pattern of [
    /(`@relaycast\/engine`\s+\*\*)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(\*\*)/,
    /(version command must print `)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(`)/,
    /(from engine )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(\.)/,
    /(image is on )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?( or later)/,
    /(In engine )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(,)/,
  ]) runbook = runbook.replace(pattern, `$1${version}$2`);
  writeFileSync(runbookPath, runbook);
}

function releaseTagMessage(fixture) {
  return [
    `Release v${fixture.version}`,
    "",
    "Relaycast-NPM-Dist-Tag: latest",
    `Relaycast-Source-Commit: ${fixture.sourceCommit}`,
    `Relaycast-Source-Tree: ${fixture.sourceTree}`,
    `Relaycast-Package-Provenance-SHA256: ${fixture.provenanceDigest}`,
  ].join("\n");
}

function createFixtureTag(fixture) {
  git(fixture.root, ["tag", "-a", `v${fixture.version}`, "-m", releaseTagMessage(fixture)]);
}

function writeFixtureProvenance(fixture) {
  const lock = JSON.parse(
    readFileSync(path.join(fixture.root, "docker/package-lock.json"), "utf8"),
  );
  const provenance = {
    schema: 1,
    sourceCommit: fixture.sourceCommit,
    sourceTree: fixture.sourceTree,
    version: fixture.version,
    distTag: "latest",
    packages: DOCKER_PACKAGE_NAMES.map((name, index) => ({
      name,
      version: fixture.version,
      tarball: `release-artifacts/relaycast-${name.slice("@relaycast/".length)}-${fixture.version}.tgz`,
      integrity: lock.packages[`node_modules/${name}`].integrity,
      shasum: String(index + 1).repeat(40),
    })),
  };
  const provenancePath = path.join(fixture.root, "release-provenance.json");
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return { provenancePath, provenanceDigest: provenanceDigest(provenance) };
}

function releaseTagFixture({ alteredSource = false, mutateReleaseFile, versionBump = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "relaycast-release-tag-"));
  const version = "8.5.5";
  const fromTag = "v8.5.4";
  archiveRevision("HEAD", root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "release-test@example.com"]);
  git(root, ["config", "user.name", "Release Test"]);
  if (versionBump) {
    bumpFixtureVersion(root, "8.5.4", NPM_REGISTRY_DOCKER_INTEGRITIES["8.5.4"]);
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "source"]);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const sourceTree = git(root, ["rev-parse", "HEAD^{tree}"]);

  git(root, ["tag", fromTag]);
  if (versionBump) {
    bumpFixtureVersion(root, version, NPM_REGISTRY_DOCKER_INTEGRITIES[version]);
  }
  const cut = spawnSync(
    process.execPath,
    [cutChangelog, "--version", version, "--from-tag", fromTag, "--date", "2026-09-09"],
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
    } else if (mutateReleaseFile === "docker/package-lock.json") {
      const lock = JSON.parse(readFileSync(filePath, "utf8"));
      lock.packages[""].name = "unauthorized-image-name";
      writeFileSync(filePath, `${JSON.stringify(lock, null, 2)}\n`);
    } else {
      writeFileSync(filePath, `${readFileSync(filePath, "utf8")}\nrelease fixture mutation\n`);
    }
  }
  if (alteredSource) {
    writeFileSync(path.join(root, "README.md"), "altered application source\n");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", `chore(release): v${version}`], {
    env: {
      GIT_AUTHOR_DATE: "2026-09-09T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-09-09T12:00:00Z",
    },
  });
  const tagCommit = git(root, ["rev-parse", "HEAD"]);
  const fixture = { root, sourceCommit, sourceTree, tagCommit, version };
  Object.assign(fixture, writeFixtureProvenance(fixture));
  createFixtureTag(fixture);
  return fixture;
}

function validateTag(fixture) {
  return spawnSync(
    process.execPath,
    [
      validateReleaseTag,
      "--tag",
      `v${fixture.version}`,
      "--source-commit",
      fixture.sourceCommit,
      "--source-tree",
      fixture.sourceTree,
      "--version",
      fixture.version,
      "--dist-tag",
      "latest",
      "--provenance-digest",
      fixture.provenanceDigest,
      "--provenance-manifest",
      fixture.provenancePath,
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
    assert.match(reuseBlock, /--provenance-manifest release-provenance\.json/);
    assert.doesNotMatch(reuseBlock, /--engine-integrity/);
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

  it("accepts a real version-bumped Docker lockfile and reuses it across a retry", () => {
    const fixture = releaseTagFixture({ versionBump: true });
    try {
      const first = validateTag(fixture);
      assert.equal(first.status, 0, first.stderr);
      const lock = JSON.parse(readFileSync(path.join(fixture.root, "docker/package-lock.json"), "utf8"));
      const sourceLock = JSON.parse(
        git(fixture.root, ["show", `${fixture.sourceCommit}:docker/package-lock.json`]),
      );
      assert.equal(lock.version, fixture.version);
      assert.equal(lock.packages[""].version, fixture.version);
      assert.equal(lock.packages[""].dependencies["@relaycast/engine"], fixture.version);
      for (const name of DOCKER_PACKAGE_NAMES) {
        const entry = lock.packages[`node_modules/${name}`];
        const sourceEntry = sourceLock.packages[`node_modules/${name}`];
        assert.equal(entry.version, fixture.version);
        assert.equal(entry.integrity, NPM_REGISTRY_DOCKER_INTEGRITIES[fixture.version][name]);
        assert.equal(sourceEntry.integrity, NPM_REGISTRY_DOCKER_INTEGRITIES["8.5.4"][name]);
        assert.notEqual(entry.integrity, sourceEntry.integrity);
      }
      git(fixture.root, ["reset", "--hard", fixture.sourceCommit]);
      const retry = validateTag(fixture);
      assert.equal(retry.status, 0, retry.stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const name of DOCKER_PACKAGE_NAMES) {
    it(`rejects a valid but provenance-mismatched ${name} Docker integrity`, () => {
      const fixture = releaseTagFixture({ versionBump: true });
      try {
        const lockPath = path.join(fixture.root, "docker/package-lock.json");
        const lock = JSON.parse(readFileSync(lockPath, "utf8"));
        lock.packages[`node_modules/${name}`].integrity =
          NPM_REGISTRY_DOCKER_INTEGRITIES["8.5.4"][name];
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
        git(fixture.root, ["add", "docker/package-lock.json"]);
        git(fixture.root, ["commit", "--amend", "-qm", `test: wrong ${name} integrity`], {
          env: {
            GIT_AUTHOR_DATE: "2026-09-09T12:00:00Z",
            GIT_COMMITTER_DATE: "2026-09-09T12:00:00Z",
          },
        });
        git(fixture.root, ["tag", "-d", "v8.5.5"]);
        createFixtureTag(fixture);
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

  it("rejects a provenance manifest whose content does not match the annotated digest", () => {
    const fixture = releaseTagFixture();
    try {
      const provenance = JSON.parse(readFileSync(fixture.provenancePath, "utf8"));
      provenance.packages[0].integrity = NPM_REGISTRY_DOCKER_INTEGRITIES["8.5.4"]["@relaycast/a2a"];
      writeFileSync(fixture.provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
      const result = validateTag(fixture);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /provenance digest does not match/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  for (const file of [
    "packages/engine/package.json",
    "package-lock.json",
    "docker/package-lock.json",
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

  it("rejects a mode-only Dockerfile change", () => {
    const fixture = releaseTagFixture();
    try {
      git(fixture.root, ["checkout", "-q", fixture.sourceCommit]);
      const releasePatch = spawnSync(
        "git",
        ["diff", "--binary", fixture.sourceCommit, "v8.5.5"],
        { cwd: fixture.root, encoding: "utf8" },
      );
      assert.equal(releasePatch.status, 0, releasePatch.stderr);
      const applied = spawnSync("git", ["apply"], {
        cwd: fixture.root,
        input: releasePatch.stdout,
        encoding: "utf8",
      });
      assert.equal(applied.status, 0, applied.stderr);
      git(fixture.root, ["update-index", "--chmod=+x", "Dockerfile"]);
      git(fixture.root, ["commit", "-qm", "test: mode-only release mutation"]);
      git(fixture.root, ["tag", "-d", "v8.5.5"]);
      createFixtureTag(fixture);
      const result = validateTag(fixture);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /100644|non-regular/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an allowlisted release path changed to a symlink", () => {
    const fixture = releaseTagFixture();
    try {
      git(fixture.root, ["checkout", "-q", fixture.sourceCommit]);
      const releasePatch = spawnSync(
        "git",
        ["diff", "--binary", fixture.sourceCommit, "v8.5.5"],
        { cwd: fixture.root, encoding: "utf8" },
      );
      assert.equal(releasePatch.status, 0, releasePatch.stderr);
      const applied = spawnSync("git", ["apply"], {
        cwd: fixture.root,
        input: releasePatch.stdout,
        encoding: "utf8",
      });
      assert.equal(applied.status, 0, applied.stderr);
      git(fixture.root, ["rm", "-q", "Dockerfile"]);
      symlinkSync("RUNBOOK.md", path.join(fixture.root, "Dockerfile"));
      git(fixture.root, ["add", "Dockerfile"]);
      git(fixture.root, ["commit", "-qm", "test: symlink release mutation"]);
      git(fixture.root, ["tag", "-d", "v8.5.5"]);
      createFixtureTag(fixture);
      const result = validateTag(fixture);
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /non-regular|100644/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

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
      createFixtureTag(fixture);
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

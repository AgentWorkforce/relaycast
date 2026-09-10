import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  PUBLISHED_PACKAGE_DIRS,
  assertChangelogSemver,
  assertRepositoryChangelogSemver,
  assertRepositoryVersionParity,
  updateComparisonReferences,
} from "./release-contract.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function changelog(level = "Minor", body = "### Added\n\n- Feature") {
  const suffix = level ? ` - ${level}` : "";
  return `# Changelog\n\n## [Unreleased${suffix}]\n\n${body}\n\n## [8.5.3] - 2026-09-08\n\n### Fixed\n\n- Previous\n`;
}

function repositoryFixture(version = "8.6.0-beta.0") {
  const root = mkdtempSync(path.join(tmpdir(), "relaycast-release-contract-"));
  temporaryDirectories.push(root);
  const lock = { packages: {} };
  for (const dir of PUBLISHED_PACKAGE_DIRS) {
    const packageDir = path.join(root, "packages", dir);
    mkdirSync(packageDir, { recursive: true });
    const manifest = {
      name: dir === "cli" ? "relaycast" : `@relaycast/${dir}`,
      version,
      ...(dir === "engine"
        ? {
            dependencies: {
              "@relaycast/a2a": version,
              "@relaycast/types": version,
            },
          }
        : {}),
    };
    writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify(manifest)}\n`,
    );
    lock.packages[`packages/${dir}`] = manifest;
  }
  mkdirSync(path.join(root, "packages", "sdk-typescript", "src"));
  mkdirSync(path.join(root, "packages", "cli", "src"));
  writeFileSync(
    path.join(root, "packages", "sdk-typescript", "src", "version.ts"),
    `export const SDK_VERSION = '${version}' as const;\n`,
  );
  writeFileSync(
    path.join(root, "packages", "cli", "src", "version.ts"),
    `export const CLI_VERSION = '${version}' as const;\n`,
  );
  writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify(lock)}\n`,
  );

  writeFileSync(
    path.join(root, "Dockerfile"),
    `ARG RELAYCAST_ENGINE_VERSION=${version}\n`,
  );
  mkdirSync(path.join(root, "docker"), { recursive: true });
  writeFileSync(
    path.join(root, "docker", "package.json"),
    `${JSON.stringify({
      name: "relaycast-self-host-image",
      version,
      dependencies: { "@relaycast/engine": version },
    })}\n`,
  );
  writeFileSync(
    path.join(root, "docker", "package-lock.json"),
    `${JSON.stringify({
      packages: {
        "": {
          version,
          dependencies: { "@relaycast/engine": version },
        },
        "node_modules/@relaycast/a2a": {
          version,
          resolved: `https://registry.npmjs.org/@relaycast/a2a/-/a2a-${version}.tgz`,
          integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        },
        "node_modules/@relaycast/engine": {
          version,
          resolved: `https://registry.npmjs.org/@relaycast/engine/-/engine-${version}.tgz`,
          integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          dependencies: {
            "@relaycast/a2a": version,
            "@relaycast/types": version,
          },
        },
        "node_modules/@relaycast/types": {
          version,
          resolved: `https://registry.npmjs.org/@relaycast/types/-/types-${version}.tgz`,
          integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        },
      },
    })}\n`,
  );
  writeFileSync(
    path.join(root, "RUNBOOK.md"),
    [
      `The image contains \`@relaycast/engine\` **${version}** on Node 22.23.2 and stores all`,
      `The version command must print \`${version}\`, and Compose should eventually report`,
      `Agent-card discovery works on the standard path from engine ${version}. A`,
      `image is on ${version} or later before looking anywhere else.`,
      `In engine ${version}, \`POST /v1/workspaces\` is intentionally unauthenticated for`,
    ].join("\n"),
  );

  return root;
}

describe("release changelog contract", () => {
  it("accepts a minor prerelease for a pending Minor release", () => {
    assert.deepEqual(assertChangelogSemver(changelog(), "8.6.0-beta.0"), {
      latestVersion: "8.5.3",
      pendingLevel: "Minor",
      actualLevel: "Minor",
    });
  });

  it("rejects a patch target for a pending Minor release before publication", () => {
    assert.throws(
      () => assertChangelogSemver(changelog(), "8.5.4"),
      /requires a Minor release.*is Patch/,
    );
  });

  it("accepts the bare pending block left after cutting the target release", () => {
    const settled = changelog(null, "").replace(
      "## [8.5.3] - 2026-09-08",
      "## [8.6.0] - 2026-09-08",
    );
    assert.deepEqual(assertChangelogSemver(settled, "8.6.0"), {
      latestVersion: "8.6.0",
      pendingLevel: undefined,
      actualLevel: "Released",
    });
  });

  it("rejects an unclassified non-empty pending changelog", () => {
    assert.throws(
      () => assertChangelogSemver(changelog(null), "8.5.4"),
      /must declare Patch, Minor, or Major/,
    );
  });

  it("checks every changelog cut by the lockstep release", () => {
    const root = mkdtempSync(path.join(tmpdir(), "relaycast-changelogs-"));
    temporaryDirectories.push(root);
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog());
    for (const [dir, contents] of [
      ["engine", changelog("Minor")],
      ["sdk-swift", changelog(null, "")],
      ["sdk-rust", changelog("Major")],
    ]) {
      mkdirSync(path.join(root, "packages", dir), { recursive: true });
      writeFileSync(path.join(root, "packages", dir, "CHANGELOG.md"), contents);
    }
    assert.equal(assertRepositoryChangelogSemver(root, "8.6.0").length, 3);

    writeFileSync(
      path.join(root, "packages", "engine", "CHANGELOG.md"),
      changelog("Major"),
    );
    assert.throws(
      () => assertRepositoryChangelogSemver(root, "8.6.0"),
      /packages\/engine\/CHANGELOG\.md:.*requires a Major release/,
    );
  });
});

describe("release version parity", () => {
  it("accepts aligned manifests, internal dependencies, lockfile, and source constants", () => {
    assert.deepEqual(
      assertRepositoryVersionParity(repositoryFixture(), "8.6.0-beta.0"),
      {
        packageCount: PUBLISHED_PACKAGE_DIRS.length,
        publishedPackageCount: PUBLISHED_PACKAGE_DIRS.length,
      },
    );
  });

  it("rejects a stale generated source version", () => {
    const root = repositoryFixture();
    writeFileSync(
      path.join(root, "packages", "cli", "src", "version.ts"),
      "export const CLI_VERSION = '1.1.0' as const;\n",
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /CLI_VERSION is 1.1.0/,
    );
  });

  it("rejects an unaligned internal dependency", () => {
    const root = repositoryFixture();
    const enginePath = path.join(root, "packages", "engine", "package.json");
    writeFileSync(
      enginePath,
      JSON.stringify({
        name: "@relaycast/engine",
        version: "8.6.0-beta.0",
        dependencies: { "@relaycast/types": "8.5.3" },
      }),
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /expected 8.6.0-beta.0/,
    );
  });

  it("rejects a stale workspace version in the lockfile", () => {
    const root = repositoryFixture();
    const lockPath = path.join(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["packages/types"].version = "8.5.3";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /package-lock\.json packages\/types is 8\.5\.3/,
    );
  });

  it("rejects a stale Dockerfile ARG RELAYCAST_ENGINE_VERSION default", () => {
    const root = repositoryFixture();
    writeFileSync(
      path.join(root, "Dockerfile"),
      "ARG RELAYCAST_ENGINE_VERSION=8.5.3\n",
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /ARG RELAYCAST_ENGINE_VERSION is 8\.5\.3, expected 8\.6\.0-beta\.0/,
    );
  });

  it("rejects a stale self-host image manifest version", () => {
    const root = repositoryFixture();
    writeFileSync(
      path.join(root, "docker", "package.json"),
      JSON.stringify({
        name: "relaycast-self-host-image",
        version: "8.5.3",
        dependencies: { "@relaycast/engine": "8.5.3" },
      }),
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /docker\/package\.json is 8\.5\.3, expected 8\.6\.0-beta\.0/,
    );
  });

  it("rejects a stale self-host image manifest's engine dependency pin", () => {
    const root = repositoryFixture();
    writeFileSync(
      path.join(root, "docker", "package.json"),
      JSON.stringify({
        name: "relaycast-self-host-image",
        version: "8.6.0-beta.0",
        dependencies: { "@relaycast/engine": "8.5.3" },
      }),
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /dependencies\["@relaycast\/engine"\] is 8\.5\.3, expected 8\.6\.0-beta\.0/,
    );
  });

  it("rejects a stale self-host image lockfile", () => {
    const root = repositoryFixture();
    const lockPath = path.join(root, "docker", "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/@relaycast/engine"].version = "8.5.3";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /docker\/package-lock\.json node_modules\/@relaycast\/engine is 8\.5\.3/,
    );
  });

  it("rejects an engine lockfile entry that keeps a previous release artifact", () => {
    const root = repositoryFixture();
    const lockPath = path.join(root, "docker", "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/@relaycast/engine"].resolved =
      "https://registry.npmjs.org/@relaycast/engine/-/engine-8.5.3.tgz";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /resolves .*engine-8\.5\.3\.tgz.*engine-8\.6\.0-beta\.0\.tgz/,
    );
  });

  it("rejects Docker lock dependency topology drift", () => {
    for (const [description, manifestDependencies, lockDependencies] of [
      [
        "added dependency",
        { "@relaycast/types": "8.6.0-beta.0", hono: "^4.11.9" },
        { "@relaycast/types": "8.6.0-beta.0" },
      ],
      [
        "removed dependency",
        { "@relaycast/types": "8.6.0-beta.0" },
        { "@relaycast/types": "8.6.0-beta.0", hono: "^4.11.9" },
      ],
      [
        "changed non-@relaycast dependency",
        { "@relaycast/types": "8.6.0-beta.0", hono: "^4.12.0" },
        { "@relaycast/types": "8.6.0-beta.0", hono: "^4.11.9" },
      ],
    ]) {
      const root = repositoryFixture();
      const engineManifestPath = path.join(
        root,
        "packages",
        "engine",
        "package.json",
      );
      writeFileSync(
        engineManifestPath,
        JSON.stringify({
          name: "@relaycast/engine",
          version: "8.6.0-beta.0",
          dependencies: manifestDependencies,
        }),
      );
      const lockPath = path.join(root, "docker", "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.packages["node_modules/@relaycast/engine"].dependencies =
        lockDependencies;
      writeFileSync(lockPath, JSON.stringify(lock));
      assert.throws(
        () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
        /engine dependencies topology does not match/,
        description,
      );
    }
  });

  it("checks dependency topology for every Docker-installed Relaycast package", () => {
    for (const [packageDir, dependencyType, manifestDependencies, lockDependencies] of [
      ["a2a", "dependencies", { zod: "^4.3.6" }, {}],
      ["types", "optionalDependencies", { "@scope/optional": "^1.0.0" }, {}],
      ["types", "peerDependencies", { "@scope/peer": "^1.0.0" }, {}],
      ["a2a", "dependencies", {}, { zod: "^4.3.6" }],
      ["types", "optionalDependencies", {}, { "@scope/optional": "^1.0.0" }],
      ["types", "peerDependencies", {}, { "@scope/peer": "^1.0.0" }],
    ]) {
      const root = repositoryFixture();
      const manifestPath = path.join(
        root,
        "packages",
        packageDir,
        "package.json",
      );
      const packageManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      packageManifest[dependencyType] = manifestDependencies;
      writeFileSync(manifestPath, JSON.stringify(packageManifest));

      const lockPath = path.join(root, "docker", "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.packages[`node_modules/@relaycast/${packageDir}`][dependencyType] =
        lockDependencies;
      writeFileSync(lockPath, JSON.stringify(lock));

      assert.throws(
        () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
        new RegExp(
          `@relaycast/${packageDir} ${dependencyType} topology does not match`,
        ),
        `${packageDir} ${dependencyType}`,
      );
    }
  });

  it("rejects missing and stale top-level Docker Relaycast packages", () => {
    for (const [description, mutate, expectedError] of [
      [
        "missing package",
        (lock) => delete lock.packages["node_modules/@relaycast/a2a"],
        /is missing Docker package node_modules\/@relaycast\/a2a/,
      ],
      [
        "stale package",
        (lock) => {
          lock.packages["node_modules/@relaycast/observer-dashboard"] = {
            version: "8.6.0-beta.0",
            resolved:
              "https://registry.npmjs.org/@relaycast/observer-dashboard/-/observer-dashboard-8.6.0-beta.0.tgz",
            integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
          };
        },
        /contains stale Docker package @relaycast\/observer-dashboard/,
      ],
    ]) {
      const root = repositoryFixture();
      const lockPath = path.join(root, "docker", "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      mutate(lock);
      writeFileSync(lockPath, JSON.stringify(lock));

      assert.throws(
        () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
        expectedError,
        description,
      );
    }
  });

  it("permits the intentional pre-publish lockfile placeholder only when requested", () => {
    const root = repositoryFixture();
    const lockPath = path.join(root, "docker", "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.packages["node_modules/@relaycast/engine"].resolved =
      "https://registry.npmjs.org/@relaycast/engine/-/engine-8.5.3.tgz";
    writeFileSync(lockPath, JSON.stringify(lock));
    assert.doesNotThrow(() =>
      assertRepositoryVersionParity(root, "8.6.0-beta.0", {
        requireDockerResolvedArtifact: false,
      }),
    );
  });

  it("rejects a RUNBOOK.md engine-version mention that was not bumped", () => {
    const root = repositoryFixture();
    const runbookPath = path.join(root, "RUNBOOK.md");
    const runbook = readFileSync(runbookPath, "utf8");
    writeFileSync(
      runbookPath,
      runbook.replace(
        "image is on 8.6.0-beta.0 or later before looking anywhere else.",
        "image is on 8.5.3 or later before looking anywhere else.",
      ),
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /image is on 8\.5\.3 or later.*references 8\.5\.3, expected 8\.6\.0-beta\.0/,
    );
  });

  it("rejects RUNBOOK.md missing an expected engine-version anchor entirely", () => {
    const root = repositoryFixture();
    writeFileSync(
      path.join(root, "RUNBOOK.md"),
      "Nothing here mentions the engine version at all.",
    );
    assert.throws(
      () => assertRepositoryVersionParity(root, "8.6.0-beta.0"),
      /RUNBOOK\.md is missing the expected engine-version mention/,
    );
  });
});

describe("comparison references", () => {
  it("replaces stale pending references and adds the released comparison", () => {
    const input = `${changelog()}\n[Unreleased - Minor]: https://github.com/AgentWorkforce/relaycast/compare/v8.4.0...HEAD\n[6.0.3]: https://example.test/old\n`;
    const updated = updateComparisonReferences(input, {
      version: "8.6.0",
      previousVersion: "8.5.3",
    });
    assert.match(updated, /^\[Unreleased\]: .*\/compare\/v8\.6\.0\.\.\.HEAD$/m);
    assert.match(
      updated,
      /^\[8\.6\.0\]: .*\/compare\/v8\.5\.3\.\.\.v8\.6\.0$/m,
    );
    assert.doesNotMatch(updated, /^\[Unreleased - Minor\]:/m);
    assert.match(updated, /^\[6\.0\.3\]: https:\/\/example\.test\/old$/m);
    assert.ok(updated.endsWith("\n"));
  });

  it("adds comparison references to a changelog without existing links", () => {
    const updated = updateComparisonReferences(changelog(), {
      version: "8.6.0",
      previousVersion: "8.5.3",
    });
    assert.match(
      updated,
      /\n\[Unreleased\]: .*\/compare\/v8\.6\.0\.\.\.HEAD\n/,
    );
    assert.ok(updated.endsWith("\n"));
  });

  it("appends comparison references after the body when it removes every existing definition", () => {
    const input = `${changelog()}\n[Unreleased - Minor]: https://example.test/old\n[8.6.0]: https://example.test/old\n`;
    const updated = updateComparisonReferences(input, {
      version: "8.6.0",
      previousVersion: "8.5.3",
    });
    assert.ok(updated.indexOf("- Previous") < updated.indexOf("[Unreleased]:"));
    assert.match(updated, /\[Unreleased\]: .*\n\[8\.6\.0\]: .*\n$/);
  });
});

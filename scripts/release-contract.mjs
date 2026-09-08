import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const PUBLISHED_PACKAGE_DIRS = [
  "a2a",
  "types",
  "engine",
  "sdk-typescript",
  "cli",
  "mcp",
  "react",
  "openclaw",
];

const LEVEL_RANK = { Patch: 0, Minor: 1, Major: 2 };
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const UNRELEASED =
  /^## \[Unreleased(?: - (Patch|Minor|Major))?\][ \t]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m;

export function parseVersion(value) {
  const match = value.match(SEMVER);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

function compareCore(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function releaseLevel(fromVersion, toVersion) {
  const from = parseVersion(fromVersion);
  const to = parseVersion(toVersion);
  if (compareCore(to, from) <= 0) {
    throw new Error(
      `Release target ${toVersion} must be newer than ${fromVersion}`,
    );
  }
  if (to.major !== from.major) return "Major";
  if (to.minor !== from.minor) return "Minor";
  return "Patch";
}

export function assertChangelogSemver(changelog, targetVersion) {
  const pending = changelog.match(UNRELEASED);
  if (!pending) throw new Error("CHANGELOG.md has no [Unreleased] heading");

  const pendingLevel = pending[1];
  const pendingBody = pending[2].trim();
  if (pendingBody && !pendingLevel) {
    throw new Error(
      "Non-empty [Unreleased] must declare Patch, Minor, or Major",
    );
  }

  const latest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  if (!latest) throw new Error("CHANGELOG.md has no stable release heading");
  // create-release cuts changelogs before refreshing the image lockfile and
  // performing its final parity check. A successful cut deliberately leaves a
  // bare pending block above the target heading, so validate that settled
  // state instead of comparing a release to itself.
  if (latest === targetVersion) {
    if (pendingBody) {
      throw new Error(
        `CHANGELOG.md already contains ${targetVersion} but still has pending entries`,
      );
    }
    return { latestVersion: latest, pendingLevel, actualLevel: "Released" };
  }
  const actualLevel = releaseLevel(latest, targetVersion);
  if (pendingLevel && LEVEL_RANK[actualLevel] < LEVEL_RANK[pendingLevel]) {
    throw new Error(
      `CHANGELOG.md requires a ${pendingLevel} release, but ${latest} -> ${targetVersion} is ${actualLevel}`,
    );
  }
  return { latestVersion: latest, pendingLevel, actualLevel };
}

function packageDirectories(root) {
  return readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => {
      try {
        readFileSync(path.join(root, "packages", dir, "package.json"));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

function lockstepChangelogs(root) {
  const packageRoot = path.join(root, "packages");
  const packageChangelogs = readdirSync(packageRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "sdk-rust")
    .map((entry) => path.join(packageRoot, entry.name, "CHANGELOG.md"))
    .filter((file) => {
      try {
        readFileSync(file);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
  return [path.join(root, "CHANGELOG.md"), ...packageChangelogs];
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function assertInternalDependencies(owner, pkg, expectedVersion) {
  for (const dependencyType of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ]) {
    for (const [name, version] of Object.entries(pkg[dependencyType] ?? {})) {
      if (name.startsWith("@relaycast/") && version !== expectedVersion) {
        throw new Error(
          `${owner} ${dependencyType}.${name} is ${version}, expected ${expectedVersion}`,
        );
      }
    }
  }
}

function readVersionConstant(file, exportName) {
  const source = readFileSync(file, "utf8");
  const match = source.match(
    new RegExp(`export const ${exportName} = ['\"]([^'\"]+)['\"] as const;`),
  );
  if (!match)
    throw new Error(
      `${file} does not export ${exportName} as a string constant`,
    );
  return match[1];
}

// Anchored regexes for the self-host container's own version sources, none
// of which are package.json manifests: a build-time ARG, a second,
// independently-versioned npm manifest/lockfile pair the container image
// installs from (docker/), and the operator runbook's prose mentions of the
// shipped engine version. Each of these has drifted stale before -- the
// release-contract check that already covers every workspace package.json
// never looked at them -- so they are asserted here in lockstep with every
// other version source.
function assertDockerfileEngineVersion(root, expectedVersion) {
  const file = path.join(root, "Dockerfile");
  const source = readFileSync(file, "utf8");
  const match = source.match(/^ARG RELAYCAST_ENGINE_VERSION=(\S+)/m);
  if (!match) {
    throw new Error(`${file} has no ARG RELAYCAST_ENGINE_VERSION default`);
  }
  if (match[1] !== expectedVersion) {
    throw new Error(
      `${file} ARG RELAYCAST_ENGINE_VERSION is ${match[1]}, expected ${expectedVersion}`,
    );
  }
}

function assertDockerImageManifestVersion(
  root,
  expectedVersion,
  { requireResolvedArtifact = true } = {},
) {
  const manifestPath = path.join(root, "docker", "package.json");
  const manifest = readJson(manifestPath);
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `${manifestPath} is ${manifest.version}, expected ${expectedVersion}`,
    );
  }
  const enginePin = manifest.dependencies?.["@relaycast/engine"];
  if (enginePin !== expectedVersion) {
    throw new Error(
      `${manifestPath} dependencies["@relaycast/engine"] is ${enginePin}, expected ${expectedVersion}`,
    );
  }

  const lockPath = path.join(root, "docker", "package-lock.json");
  const lock = readJson(lockPath);
  const lockRoot = lock.packages?.[""];
  if (lockRoot?.version !== expectedVersion) {
    throw new Error(
      `${lockPath} root package version is ${lockRoot?.version}, expected ${expectedVersion}`,
    );
  }
  const lockedEngine = lock.packages?.["node_modules/@relaycast/engine"];
  if (lockedEngine?.version !== expectedVersion) {
    throw new Error(
      `${lockPath} node_modules/@relaycast/engine is ${lockedEngine?.version}, expected ${expectedVersion}`,
    );
  }
  if (requireResolvedArtifact) {
    const expectedTarball = `https://registry.npmjs.org/@relaycast/engine/-/engine-${expectedVersion}.tgz`;
    if (lockedEngine?.resolved !== expectedTarball) {
      throw new Error(
        `${lockPath} node_modules/@relaycast/engine resolves ${lockedEngine?.resolved}, expected ${expectedTarball}`,
      );
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(lockedEngine?.integrity ?? "")) {
      throw new Error(
        `${lockPath} node_modules/@relaycast/engine has no valid registry integrity`,
      );
    }
  }
}

// Each pattern's sole capture group is the engine version mentioned at that
// exact anchor. Deliberately specific rather than a general semver scan:
// RUNBOOK.md also mentions the pinned Node version and loopback IPv4
// addresses, both of which are also dot-separated digit triples and are not
// safely distinguishable from a version number by pattern alone.
const RUNBOOK_SEMVER = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const RUNBOOK_ENGINE_VERSION_ANCHORS = [
  new RegExp("`@relaycast/engine`\\s+\\*\\*(" + RUNBOOK_SEMVER + ")\\*\\*"),
  new RegExp("version command must print `(" + RUNBOOK_SEMVER + ")`"),
  new RegExp("from engine (" + RUNBOOK_SEMVER + ")\\."),
  new RegExp("image is on (" + RUNBOOK_SEMVER + ") or later"),
  new RegExp("In engine (" + RUNBOOK_SEMVER + "),"),
];

function assertRunbookEngineVersion(root, expectedVersion) {
  const file = path.join(root, "RUNBOOK.md");
  const source = readFileSync(file, "utf8");
  for (const pattern of RUNBOOK_ENGINE_VERSION_ANCHORS) {
    const match = source.match(pattern);
    if (!match) {
      throw new Error(
        `${file} is missing the expected engine-version mention matching ${pattern}`,
      );
    }
    if (match[1] !== expectedVersion) {
      throw new Error(
        `${file} "${match[0]}" references ${match[1]}, expected ${expectedVersion}`,
      );
    }
  }
}

export function assertRepositoryVersionParity(
  root,
  expectedVersion,
  { requireDockerResolvedArtifact = true } = {},
) {
  const directories = packageDirectories(root);
  for (const published of PUBLISHED_PACKAGE_DIRS) {
    if (!directories.includes(published)) {
      throw new Error(
        `Missing published workspace packages/${published}/package.json`,
      );
    }
  }

  const lock = readJson(path.join(root, "package-lock.json"));
  for (const dir of directories) {
    const manifestPath = path.join(root, "packages", dir, "package.json");
    const manifest = readJson(manifestPath);
    if (manifest.version !== expectedVersion) {
      throw new Error(
        `${manifestPath} is ${manifest.version}, expected ${expectedVersion}`,
      );
    }
    assertInternalDependencies(manifestPath, manifest, expectedVersion);

    const lockKey = `packages/${dir}`;
    const locked = lock.packages?.[lockKey];
    if (!locked)
      throw new Error(`package-lock.json has no ${lockKey} workspace entry`);
    if (locked.version !== expectedVersion) {
      throw new Error(
        `package-lock.json ${lockKey} is ${locked.version}, expected ${expectedVersion}`,
      );
    }
    assertInternalDependencies(
      `package-lock.json ${lockKey}`,
      locked,
      expectedVersion,
    );
  }

  const sdkVersion = readVersionConstant(
    path.join(root, "packages", "sdk-typescript", "src", "version.ts"),
    "SDK_VERSION",
  );
  if (sdkVersion !== expectedVersion) {
    throw new Error(
      `SDK_VERSION is ${sdkVersion}, expected ${expectedVersion}`,
    );
  }

  const cliVersion = readVersionConstant(
    path.join(root, "packages", "cli", "src", "version.ts"),
    "CLI_VERSION",
  );
  if (cliVersion !== expectedVersion) {
    throw new Error(
      `CLI_VERSION is ${cliVersion}, expected ${expectedVersion}`,
    );
  }

  assertDockerfileEngineVersion(root, expectedVersion);
  assertDockerImageManifestVersion(root, expectedVersion, {
    requireResolvedArtifact: requireDockerResolvedArtifact,
  });
  assertRunbookEngineVersion(root, expectedVersion);

  return {
    packageCount: directories.length,
    publishedPackageCount: PUBLISHED_PACKAGE_DIRS.length,
  };
}

export function assertRepositoryChangelogSemver(root, targetVersion) {
  const results = [];
  for (const file of lockstepChangelogs(root)) {
    try {
      results.push({
        file,
        ...assertChangelogSemver(readFileSync(file, "utf8"), targetVersion),
      });
    } catch (error) {
      throw new Error(`${file}: ${error.message}`, { cause: error });
    }
  }
  return results;
}

export function updateComparisonReferences(
  changelog,
  { version, previousVersion },
) {
  parseVersion(version);
  parseVersion(previousVersion);
  const repository = "https://github.com/AgentWorkforce/relaycast";
  const currentVersionPattern = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const definitions = [
    `[Unreleased]: ${repository}/compare/v${version}...HEAD`,
    `[${version}]: ${repository}/compare/v${previousVersion}...v${version}`,
  ];

  const lines = changelog.split("\n");
  const kept = lines.filter((line) => {
    if (/^\[Unreleased(?: - (?:Patch|Minor|Major))?\]:/.test(line))
      return false;
    return !new RegExp(`^\\[${currentVersionPattern}\\]:`).test(line);
  });
  const firstKeptDefinition = kept.findIndex((line) =>
    /^\[[^\]]+\]:\s+\S+/.test(line),
  );
  const insertion = firstKeptDefinition === -1 ? kept.length : firstKeptDefinition;
  kept.splice(insertion, 0, ...definitions);
  return `${kept.join("\n").replace(/\n*$/, "")}\n`;
}

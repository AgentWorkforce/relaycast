import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { prepareRelease, restorePreparedRelease } from "./prepared-release.mjs";
import { PUBLISHED_PACKAGE_DIRS } from "./release-contract.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const version = "12.9.0";
const date = "2026-11-08";
const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const json = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "relaycast-prepared-"));
  const source = path.join(directory, "source");
  const receiver = path.join(directory, "receiver");
  mkdirSync(source);
  const metadata =
    /^(?:package(?:-lock)?\.json|Dockerfile|RUNBOOK\.md|CHANGELOG\.md|docker\/package(?:-lock)?\.json|packages\/[^/]+\/(?:package\.json|CHANGELOG\.md)|packages\/(?:sdk-typescript|cli)\/src\/version\.ts)$/;
  const files = git(repository, ["ls-files"])
    .split("\n")
    .filter((file) => metadata.test(file));
  files.push(
    "scripts/check-release-contract.mjs",
    "scripts/release-contract.mjs",
    "scripts/cut-changelog.mjs",
  );
  for (const file of files) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(
      target,
      readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n"),
    );
  }
  writeFileSync(path.join(source, "README.md"), "immutable source\n");
  const bump = (releaseVersion = version) => {
    for (const file of files.filter((file) =>
      /^packages\/[^/]+\/package\.json$/.test(file),
    )) {
      const target = path.join(source, file);
      const value = JSON.parse(readFileSync(target, "utf8"));
      value.version = releaseVersion;
      dependencies(value, releaseVersion);
      json(target, value);
    }
    const rootLock = JSON.parse(
      readFileSync(path.join(source, "package-lock.json"), "utf8"),
    );
    for (const [key, entry] of Object.entries(rootLock.packages)) {
      if (!/^packages\/[^/]+$/.test(key)) continue;
      if (entry.version !== undefined) entry.version = releaseVersion;
      dependencies(entry, releaseVersion);
    }
    json(path.join(source, "package-lock.json"), rootLock);
    const image = JSON.parse(
      readFileSync(path.join(source, "docker/package.json"), "utf8"),
    );
    image.version = releaseVersion;
    image.dependencies["@relaycast/engine"] = releaseVersion;
    json(path.join(source, "docker/package.json"), image);
    const lock = JSON.parse(
      readFileSync(path.join(source, "docker/package-lock.json"), "utf8"),
    );
    lock.version = releaseVersion;
    lock.packages[""].version = releaseVersion;
    lock.packages[""].dependencies["@relaycast/engine"] = releaseVersion;
    json(path.join(source, "docker/package-lock.json"), lock);
    const dockerfile = path.join(source, "Dockerfile");
    writeFileSync(
      dockerfile,
      readFileSync(dockerfile, "utf8").replace(
        /^ARG RELAYCAST_ENGINE_VERSION=\S+/m,
        `ARG RELAYCAST_ENGINE_VERSION=${releaseVersion}`,
      ),
    );
    for (const [dir, symbol] of [
      ["sdk-typescript", "SDK"],
      ["cli", "CLI"],
    ]) {
      writeFileSync(
        path.join(source, `packages/${dir}/src/version.ts`),
        `export const ${symbol}_VERSION = "${releaseVersion}" as const;\n`,
      );
    }
    const runbook = path.join(source, "RUNBOOK.md");
    let text = readFileSync(runbook, "utf8");
    for (const pattern of [
      /(`@relaycast\/engine`\s+\*\*)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(\*\*)/,
      /(version command must print `)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(`)/,
      /(from engine )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(\.)/,
      /(image is on )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?( or later)/,
      /(In engine )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(,)/,
    ])
      text = text.replace(pattern, `$1${releaseVersion}$2`);
    writeFileSync(runbook, text);
  };
  // Pin source metadata so future real releases cannot age these fixtures.
  bump("12.8.0");
  for (const file of files.filter((file) => file.endsWith("CHANGELOG.md"))) {
    writeFileSync(
      path.join(source, file),
      `# Changelog\n\n## [Unreleased${file === "CHANGELOG.md" ? " - Minor" : ""}]\n\n${file === "CHANGELOG.md" ? "### Fixed\n\n- Fixture change.\n\n" : ""}## [12.8.0] - 2026-11-07\n\n- Prior release.\n`,
    );
  }
  const initialLock = JSON.parse(
    readFileSync(path.join(source, "package-lock.json"), "utf8"),
  );
  initialLock.packages["node_modules/tsx/node_modules/@esbuild/linux-x64"] = {
    version: "0.28.0",
    dev: true,
    optional: true,
    resolved: "https://registry.example.test/esbuild.tgz",
    integrity: "sha512-fixture",
  };
  json(path.join(source, "package-lock.json"), initialLock);
  git(source, ["init", "-q", "-b", "main"]);
  git(source, ["config", "core.autocrlf", "false"]);
  git(source, ["config", "user.email", "fixture@example.test"]);
  git(source, ["config", "user.name", "Release fixture"]);
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "source"]);
  git(source, ["tag", "v12.8.0"]);
  const sourceCommit = git(source, ["rev-parse", "HEAD"]);
  const sourceTree = git(source, ["rev-parse", "HEAD^{tree}"]);
  // A real depth-one clone exercises the bundle prerequisite used by Actions.
  git(directory, [
    "clone",
    "-q",
    "--no-tags",
    "--depth=1",
    pathToFileURL(source).href,
    receiver,
  ]);
  git(receiver, ["config", "core.autocrlf", "false"]);
  git(receiver, ["config", "user.email", "fixture@example.test"]);
  git(receiver, ["config", "user.name", "Release fixture"]);
  bump();
  json(path.join(source, "release-provenance.json"), {
    schema: 1,
    sourceCommit,
    sourceTree,
    version,
    distTag: "latest",
    packages: PUBLISHED_PACKAGE_DIRS.map((dir, index) => ({
      name: JSON.parse(
        readFileSync(path.join(source, `packages/${dir}/package.json`), "utf8"),
      ).name,
      version,
      tarball: `release-artifacts/${dir}.tgz`,
      integrity: `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`,
      shasum: String(index + 1).repeat(40),
    })),
  });
  return {
    directory,
    source,
    receiver,
    sourceCommit,
    bump,
    options: {
      manifestPath: "release-provenance.json",
      version,
      distTag: "latest",
      releaseDate: date,
      bundlePath: "prepared-release.bundle",
      recordPath: "prepared-release.json",
    },
  };
}

function dependencies(value, releaseVersion) {
  for (const type of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const name of Object.keys(value[type] ?? {}))
      if (name.startsWith("@relaycast/")) value[type][name] = releaseVersion;
  }
}

function cleanup(f) {
  const target = path.resolve(f.directory);
  assert.equal(path.dirname(target), path.resolve(tmpdir()));
  assert.ok(path.basename(target).startsWith("relaycast-prepared-"));
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

function deliver(f, prepared) {
  for (const file of [
    "release-provenance.json",
    f.options.bundlePath,
    f.options.recordPath,
  ]) {
    copyFileSync(path.join(f.source, file), path.join(f.receiver, file));
  }
  return {
    ...f.options,
    cwd: f.receiver,
    expectedRecordSha256: prepared.recordSha256,
  };
}

describe("prevalidated release handoff", () => {
  it("restores the exact validated commit and annotated tag into a shallow checkout", () => {
    const f = fixture();
    try {
      assert.equal(
        git(f.receiver, ["rev-parse", "--is-shallow-repository"]),
        "true",
      );
      const cli = path.join(repository, "scripts/prepared-release.mjs");
      const common = [
        "--manifest",
        f.options.manifestPath,
        "--version",
        version,
        "--dist-tag",
        "latest",
        "--bundle",
        f.options.bundlePath,
        "--record",
        f.options.recordPath,
      ];
      const outputPath = path.join(f.directory, "github-output");
      execFileSync(
        process.execPath,
        [
          cli,
          "prepare",
          ...common,
          "--date",
          date,
          "--github-output",
          outputPath,
        ],
        { cwd: f.source },
      );
      const output = readFileSync(outputPath, "utf8");
      const recordSha256 = /^record_sha256=([0-9a-f]{64})$/m.exec(output)?.[1];
      assert.ok(recordSha256);
      assert.match(output, new RegExp(`^release_date=${date}$`, "m"));
      const prepared = {
        record: JSON.parse(
          readFileSync(path.join(f.source, f.options.recordPath), "utf8"),
        ),
        recordSha256,
      };
      deliver(f, prepared);
      const envPath = path.join(f.directory, "github-env");
      execFileSync(
        process.execPath,
        [
          cli,
          "restore",
          ...common,
          "--expected-record-sha256",
          recordSha256,
          "--github-env",
          envPath,
        ],
        { cwd: f.receiver },
      );
      assert.equal(
        git(f.receiver, ["rev-parse", "HEAD"]),
        prepared.record.releaseCommit,
      );
      assert.equal(
        git(f.receiver, ["rev-parse", "HEAD^{tree}"]),
        prepared.record.releaseTree,
      );
      assert.equal(
        git(f.receiver, ["rev-parse", `refs/tags/${prepared.record.tag}`]),
        prepared.record.tagObject,
      );
      assert.equal(readFileSync(envPath, "utf8"), `RELEASE_DATE=${date}\n`);
      assert.match(
        readFileSync(path.join(f.receiver, "CHANGELOG.md"), "utf8"),
        /## \[12\.9\.0\] - 2026-11-08/,
      );
    } finally {
      cleanup(f);
    }
  });

  it("rejects the missing dev flag before publishing or producing a handoff record", () => {
    const f = fixture();
    try {
      const file = path.join(f.source, "package-lock.json");
      const lock = JSON.parse(readFileSync(file, "utf8"));
      delete lock.packages["node_modules/tsx/node_modules/@esbuild/linux-x64"]
        .dev;
      json(file, lock);
      assert.throws(
        () => prepareRelease({ ...f.options, cwd: f.source }),
        /unexpected release edits.*@esbuild\/linux-x64\.dev/,
      );
      assert.equal(
        existsSync(path.join(f.source, f.options.recordPath)),
        false,
      );
      assert.equal(git(f.source, ["tag", "-l", "v12.9.0"]), "");
    } finally {
      cleanup(f);
    }
  });

  it("rejects unrelated tracked source changes before producing a candidate", () => {
    const f = fixture();
    try {
      writeFileSync(
        path.join(f.source, "README.md"),
        "unexpected source edit\n",
      );
      assert.throws(
        () => prepareRelease({ ...f.options, cwd: f.source }),
        /non-release paths: README.md/,
      );
      assert.equal(
        existsSync(path.join(f.source, f.options.bundlePath)),
        false,
      );
    } finally {
      cleanup(f);
    }
  });

  it("reuses the identical existing tag, commit and date on a retry after midnight", () => {
    const f = fixture();
    try {
      const first = prepareRelease({ ...f.options, cwd: f.source });
      git(f.source, ["reset", "--hard", f.sourceCommit]);
      f.bump();
      const next = prepareRelease({
        ...f.options,
        cwd: f.source,
        releaseDate: "2026-11-09",
        bundlePath: "retry.bundle",
        recordPath: "retry.json",
      });
      assert.equal(next.record.tagObject, first.record.tagObject);
      assert.equal(next.record.releaseCommit, first.record.releaseCommit);
      assert.equal(next.record.releaseTree, first.record.releaseTree);
      assert.equal(next.record.releaseDate, date);
    } finally {
      cleanup(f);
    }
  });

  it("keeps pending changelogs intact for a prerelease candidate", () => {
    const f = fixture();
    try {
      const prerelease = "12.9.0-beta.0";
      f.bump(prerelease);
      const manifestFile = path.join(f.source, "release-provenance.json");
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
      manifest.version = prerelease;
      manifest.distTag = "next";
      for (const entry of manifest.packages) entry.version = prerelease;
      json(manifestFile, manifest);
      const before = readFileSync(path.join(f.source, "CHANGELOG.md"), "utf8");
      const prepared = prepareRelease({
        ...f.options,
        cwd: f.source,
        version: prerelease,
        distTag: "next",
      });
      assert.equal(prepared.record.tag, "v12.9.0-beta.0");
      assert.equal(
        readFileSync(path.join(f.source, "CHANGELOG.md"), "utf8"),
        before,
      );
    } finally {
      cleanup(f);
    }
  });

  it("rejects coordinated record/bundle replacement against the independent build output", () => {
    const f = fixture();
    try {
      const prepared = prepareRelease({ ...f.options, cwd: f.source });
      const options = deliver(f, prepared);
      const record = { ...prepared.record, releaseTree: "a".repeat(40) };
      json(path.join(f.receiver, f.options.recordPath), record);
      writeFileSync(
        path.join(f.receiver, f.options.bundlePath),
        "replacement bundle",
      );
      assert.throws(
        () => restorePreparedRelease(options),
        /trusted build output/,
      );
      assert.equal(git(f.receiver, ["rev-parse", "HEAD"]), f.sourceCommit);
      assert.equal(git(f.receiver, ["tag", "-l", "v12.9.0"]), "");
    } finally {
      cleanup(f);
    }
  });

  it("rejects a corrupt bundle before importing tag refs", () => {
    const f = fixture();
    try {
      const prepared = prepareRelease({ ...f.options, cwd: f.source });
      const options = deliver(f, prepared);
      writeFileSync(path.join(f.receiver, f.options.bundlePath), "corrupt");
      assert.throws(
        () => restorePreparedRelease(options),
        /bundle does not match/,
      );
      assert.equal(git(f.receiver, ["tag", "-l", "v12.9.0"]), "");
    } finally {
      cleanup(f);
    }
  });

  it("refuses to replace a different existing canonical tag", () => {
    const f = fixture();
    try {
      const prepared = prepareRelease({ ...f.options, cwd: f.source });
      const options = deliver(f, prepared);
      git(f.receiver, ["tag", "-a", "v12.9.0", "-m", "unrelated tag"]);
      const original = git(f.receiver, ["rev-parse", "refs/tags/v12.9.0"]);
      assert.throws(
        () => restorePreparedRelease(options),
        /existing release tag differs/,
      );
      assert.equal(
        git(f.receiver, ["rev-parse", "refs/tags/v12.9.0"]),
        original,
      );
      assert.equal(git(f.receiver, ["rev-parse", "HEAD"]), f.sourceCommit);
    } finally {
      cleanup(f);
    }
  });
});

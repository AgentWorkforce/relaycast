import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { projectReleaseLock } from "./project-release-lock.mjs";

const script = fileURLToPath(
  new URL("./project-release-lock.mjs", import.meta.url),
);
function sourceLock() {
  return {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { version: "1.0.0", devDependencies: { tool: "^3.0.0" } },
      "packages/engine": {
        version: "1.0.0",
        peer: false,
        dev: false,
        dependencies: { "@relaycast/types": "1.0.0", zod: "^4.0.0" },
        devDependencies: { "@relaycast/sdk": "1.0.0" },
        optionalDependencies: { "@relaycast/a2a": "1.0.0" },
        peerDependencies: { "@relaycast/react": "^1.0.0" },
      },
      "packages/no-version": { dependencies: { "@relaycast/types": "1.0.0" } },
      "node_modules/@relaycast/engine": {
        resolved: "packages/engine",
        link: true,
      },
      "node_modules/tsx/node_modules/@esbuild/linux-x64": {
        version: "0.28.0",
        dev: true,
        optional: true,
        resolved: "https://registry.example.test/esbuild.tgz",
        integrity: "sha512-fixture",
      },
      "node_modules/production": { version: "3.0.0", peer: true },
    },
  };
}

describe("release lock projection", () => {
  it("updates only existing workspace versions and internal pins with all metadata intact", () => {
    const source = sourceLock();
    const before = structuredClone(source);
    const expected = structuredClone(source);
    expected.packages["packages/engine"].version = "2.0.0";
    for (const type of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const name of Object.keys(
        expected.packages["packages/engine"][type],
      )) {
        if (name.startsWith("@relaycast/"))
          expected.packages["packages/engine"][type][name] = "2.0.0";
      }
    }
    expected.packages["packages/no-version"].dependencies["@relaycast/types"] =
      "2.0.0";
    assert.equal(
      JSON.stringify(projectReleaseLock(source, "2.0.0")),
      JSON.stringify(expected),
    );
    assert.deepEqual(source, before);
    assert.equal(
      Object.hasOwn(expected.packages["node_modules/production"], "dev"),
      false,
    );
  });

  it("rejects malformed versions and lock structures", () => {
    assert.throws(
      () => projectReleaseLock(sourceLock(), "bad version"),
      /Invalid release version/,
    );
    assert.throws(() => projectReleaseLock({}, "2.0.0"), /packages object/);
    assert.throws(
      () =>
        projectReleaseLock({ packages: { "packages/engine": null } }, "2.0.0"),
      /invalid workspace/,
    );
  });

  it("writes the exact source projection and refuses to overwrite dependency drift", () => {
    const root = mkdtempSync(path.join(tmpdir(), "relaycast-projection-"));
    const file = path.join(root, "package-lock.json");
    const source = sourceLock();
    const bytes = `${JSON.stringify(source, null, 2)}\n`;
    try {
      writeFileSync(file, bytes);
      const git = (args) =>
        execFileSync("git", args, { cwd: root, stdio: "pipe" });
      git(["init", "-q"]);
      git(["config", "core.autocrlf", "false"]);
      git(["config", "user.name", "Projection fixture"]);
      git(["config", "user.email", "fixture@example.test"]);
      git(["add", "package-lock.json"]);
      git(["commit", "-qm", "source"]);
      const run = () =>
        spawnSync(process.execPath, [script, "--version", "2.0.0"], {
          cwd: root,
          encoding: "utf8",
        });
      const drift = structuredClone(source);
      delete drift.packages["node_modules/tsx/node_modules/@esbuild/linux-x64"]
        .dev;
      const changed = `${JSON.stringify(drift, null, 2)}\n`;
      writeFileSync(file, changed);
      const rejected = run();
      assert.notEqual(rejected.status, 0);
      assert.match(
        rejected.stderr,
        /lockfile changed before release projection/,
      );
      assert.equal(readFileSync(file, "utf8"), changed);
      writeFileSync(file, bytes);
      const accepted = run();
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.equal(
        readFileSync(file, "utf8"),
        `${JSON.stringify(projectReleaseLock(source, "2.0.0"), null, 2)}\n`,
      );
    } finally {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith("relaycast-projection-"));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

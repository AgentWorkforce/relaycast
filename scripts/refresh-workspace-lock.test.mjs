import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refreshWorkspaceLock } from "./refresh-workspace-lock.mjs";

describe("workspace lock refresh", () => {
  it("updates workspace versions and leaves unrelated lock metadata in place", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "relaycast" },
        "node_modules/lightningcss-darwin-arm64": {
          version: "1.32.0",
          resolved: "https://registry.npmjs.org/lightningcss-darwin-arm64/-/lightningcss-darwin-arm64-1.32.0.tgz",
          integrity: "sha512-platform=",
          cpu: ["arm64"],
          os: ["darwin"],
          optional: true,
          peer: true,
        },
        "node_modules/zod": {
          version: "4.6.1",
          resolved: "https://registry.npmjs.org/zod/-/zod-4.6.1.tgz",
          integrity: "sha512-unrelated=",
        },
        "packages/engine": {
          version: "10.1.1",
          dependencies: {
            "@relaycast/types": "10.1.1",
            zod: "^4.3.6",
          },
          peerDependencies: {
            "@relaycast/a2a": "10.1.1",
            react: "^19.0.0",
          },
        },
        "packages/engine/node_modules/zod": {
          version: "4.6.1",
          integrity: "sha512-nested=",
        },
      },
    };
    const platform = structuredClone(lock.packages["node_modules/lightningcss-darwin-arm64"]);
    const unrelated = structuredClone(lock.packages["node_modules/zod"]);
    const nested = structuredClone(lock.packages["packages/engine/node_modules/zod"]);

    refreshWorkspaceLock(lock, "10.1.2");

    assert.equal(lock.packages["packages/engine"].version, "10.1.2");
    assert.equal(lock.packages["packages/engine"].dependencies["@relaycast/types"], "10.1.2");
    assert.equal(lock.packages["packages/engine"].dependencies.zod, "^4.3.6");
    assert.equal(lock.packages["packages/engine"].peerDependencies["@relaycast/a2a"], "10.1.2");
    assert.equal(lock.packages["packages/engine"].peerDependencies.react, "^19.0.0");
    assert.deepEqual(lock.packages["node_modules/lightningcss-darwin-arm64"], platform);
    assert.deepEqual(lock.packages["node_modules/zod"], unrelated);
    assert.deepEqual(lock.packages["packages/engine/node_modules/zod"], nested);
    assert.equal(lock.packages[""].name, "relaycast");
  });

  it("fails closed on a lockfile without packages or a non-release version", () => {
    assert.throws(
      () => refreshWorkspaceLock({ lockfileVersion: 3 }, "10.1.2"),
      /packages object/,
    );
    assert.throws(
      () => refreshWorkspaceLock({ packages: {} }, "latest"),
      /invalid release version/,
    );
  });
});

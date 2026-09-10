import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refreshDockerLock } from "./refresh-docker-lock.mjs";

const manifest = {
  version: "8.8.0",
  packages: [
    {
      name: "@relaycast/engine",
      version: "8.8.0",
      integrity: "sha512-engine=",
    },
    {
      name: "@relaycast/types",
      version: "8.8.0",
      integrity: "sha512-types=",
    },
  ],
};

describe("Docker lock refresh", () => {
  it("updates only release-owned packages and preserves unrelated resolution", () => {
    const lock = {
      name: "relaycast-self-host-image",
      version: "8.7.0",
      lockfileVersion: 3,
      packages: {
        "": {
          version: "8.7.0",
          dependencies: { "@relaycast/engine": "8.7.0" },
        },
        "node_modules/@relaycast/engine": {
          version: "8.7.0",
          resolved: "https://registry.npmjs.org/@relaycast/engine/-/engine-8.7.0.tgz",
          integrity: "sha512-old-engine=",
          dependencies: { "@relaycast/types": "8.7.0", zod: "^4.3.6" },
        },
        "node_modules/@relaycast/types": {
          version: "8.7.0",
          resolved: "https://registry.npmjs.org/@relaycast/types/-/types-8.7.0.tgz",
          integrity: "sha512-old-types=",
        },
        "node_modules/@relaycast/engine/node_modules/zod": {
          version: "4.6.1",
          resolved: "https://registry.npmjs.org/zod/-/zod-4.6.1.tgz",
          integrity: "sha512-nested=",
        },
        "node_modules/zod": {
          version: "4.6.1",
          resolved: "https://registry.npmjs.org/zod/-/zod-4.6.1.tgz",
          integrity: "sha512-unrelated=",
        },
      },
    };
    const unrelated = structuredClone(lock.packages["node_modules/zod"]);

    refreshDockerLock(lock, manifest, "8.8.0");

    assert.equal(lock.version, "8.8.0");
    assert.equal(lock.packages[""].version, "8.8.0");
    assert.equal(lock.packages[""].dependencies["@relaycast/engine"], "8.8.0");
    assert.equal(lock.packages["node_modules/@relaycast/engine"].version, "8.8.0");
    assert.equal(lock.packages["node_modules/@relaycast/engine"].dependencies["@relaycast/types"], "8.8.0");
    assert.equal(lock.packages["node_modules/@relaycast/engine"].integrity, "sha512-engine=");
    assert.equal(lock.packages["node_modules/@relaycast/engine/node_modules/zod"].version, "4.6.1");
    assert.equal(lock.packages["node_modules/@relaycast/engine/node_modules/zod"].integrity, "sha512-nested=");
    assert.deepEqual(lock.packages["node_modules/zod"], unrelated);
  });

  it("fails closed when a lockfile package has no matching release provenance", () => {
    const lock = {
      version: "8.7.0",
      packages: {
        "": { version: "8.7.0" },
        "node_modules/@relaycast/unknown": { version: "8.7.0" },
      },
    };
    assert.throws(
      () => refreshDockerLock(lock, manifest, "8.8.0"),
      /release provenance must contain exactly one @relaycast\/unknown/,
    );
  });
});

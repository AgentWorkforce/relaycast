import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureNpmDistTag,
  parseNpmDistTagOutput,
  parseNpmDistTagsOutput,
  readNpmDistTag,
} from "./npm-dist-tag.mjs";

describe("npm dist-tag reconciliation", () => {
  it("allows bounded missing/stale registry propagation to converge", async () => {
    const observations = [
      { kind: "missing" },
      { kind: "value", value: "8.5.4" },
      { kind: "value", value: "8.5.5" },
    ];
    let sleeps = 0;
    const result = await ensureNpmDistTag({
      packageName: "@relaycast/engine",
      version: "8.5.5",
      distTag: "latest",
      attempts: 3,
      delayMs: 0,
      readTag: () => observations.shift(),
      sleep: async () => {
        sleeps += 1;
      },
    });

    assert.equal(sleeps, 2);
    assert.equal(result.attempts, 3);
  });

  it("fails closed when the requested tag remains absent", async () => {
    await assert.rejects(
      ensureNpmDistTag({
        packageName: "@relaycast/types",
        version: "8.5.5",
        distTag: "next",
        attempts: 2,
        delayMs: 0,
        readTag: () => ({ kind: "missing" }),
        sleep: async () => {},
      }),
      /dist-tag next is absent after 2 attempts/,
    );
  });

  it("fails closed when a stale tag never converges", async () => {
    await assert.rejects(
      ensureNpmDistTag({
        packageName: "@relaycast/a2a",
        version: "8.5.5",
        distTag: "beta",
        attempts: 2,
        delayMs: 0,
        readTag: () => ({ kind: "value", value: "8.5.4" }),
        sleep: async () => {},
      }),
      /dist-tag beta points to 8\.5\.4, expected 8\.5\.5/,
    );
  });

  it("fails immediately on an ambiguous registry response", async () => {
    let reads = 0;
    let sleeps = 0;
    await assert.rejects(
      ensureNpmDistTag({
        packageName: "@relaycast/a2a",
        version: "8.5.5",
        distTag: "alpha",
        attempts: 5,
        delayMs: 0,
        readTag: () => {
          reads += 1;
          return { kind: "ambiguous" };
        },
        sleep: async () => {
          sleeps += 1;
        },
      }),
      /ambiguous/,
    );
    assert.equal(reads, 1);
    assert.equal(sleeps, 0);
  });

  it("fails closed when registry reads remain unavailable", async () => {
    await assert.rejects(
      ensureNpmDistTag({
        packageName: "@relaycast/engine",
        version: "8.5.5",
        distTag: "latest",
        attempts: 2,
        delayMs: 0,
        readTag: () => ({ kind: "unavailable", exitCode: 1 }),
        sleep: async () => {},
      }),
      /could not verify.*after 2 attempts/,
    );
  });

  for (const distTag of ["next", "alpha"]) {
    it(`allows ${distTag} propagation to converge without moving latest`, async () => {
      const registry = new Map([
        ["latest", "8.5.4"],
        [distTag, "8.5.3"],
      ]);
      const observedTags = [];
      let read = 0;
      await ensureNpmDistTag({
        packageName: "@relaycast/engine",
        version: "8.5.5",
        distTag,
        attempts: 3,
        delayMs: 0,
        readTag: (_packageName, requestedTag) => {
          observedTags.push(requestedTag);
          read += 1;
          if (read === 1) return { kind: "missing" };
          if (read === 2)
            return { kind: "value", value: registry.get(requestedTag) };
          registry.set(requestedTag, "8.5.5"); // registry propagation, not the verifier
          return { kind: "value", value: registry.get(requestedTag) };
        },
        sleep: async () => {},
      });

      assert.deepEqual(observedTags, [distTag, distTag, distTag]);
      assert.equal(registry.get(distTag), "8.5.5");
      assert.equal(registry.get("latest"), "8.5.4");
    });
  }
});

describe("npm dist-tag registry response parsing", () => {
  it("queries the complete dist-tag object before selecting an exact dotted key", () => {
    let invocation;
    const result = readNpmDistTag("@relaycast/engine", "preview.v2", {
      npmCommand: "npm-test",
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return {
          status: 0,
          stdout: '{"preview.v2":"8.5.5","preview":{"v2":"8.5.4"}}',
        };
      },
    });
    assert.deepEqual(invocation.args, [
      "view",
      "@relaycast/engine",
      "dist-tags",
      "--json",
      "--prefer-online",
    ]);
    assert.equal(invocation.command, "npm-test");
    assert.equal(invocation.options.encoding, "utf8");
    assert.deepEqual(result, { kind: "value", value: "8.5.5" });
  });

  it("reads dotted dist-tags as exact object keys", () => {
    assert.deepEqual(
      parseNpmDistTagsOutput(
        '{"preview.v2":"8.5.5","preview":{"v2":"8.5.4"}}',
        "preview.v2",
      ),
      {
        kind: "value",
        value: "8.5.5",
      },
    );
    assert.deepEqual(
      parseNpmDistTagsOutput('{"preview":{"v2":"8.5.4"}}', "preview.v2"),
      { kind: "missing" },
    );
  });

  it("accepts exactly one JSON string version", () => {
    assert.deepEqual(parseNpmDistTagOutput('"8.5.5"\n'), {
      kind: "value",
      value: "8.5.5",
    });
  });

  it("classifies absent output without accepting it", () => {
    assert.deepEqual(parseNpmDistTagOutput(""), { kind: "missing" });
    assert.deepEqual(parseNpmDistTagOutput("null\n"), { kind: "missing" });
  });

  for (const output of [
    "not-json",
    "{}",
    '[\"8.5.5\",\"8.5.4\"]',
    '" 8.5.5"',
  ]) {
    it(`rejects ambiguous output ${JSON.stringify(output)}`, () => {
      assert.deepEqual(parseNpmDistTagOutput(output), { kind: "ambiguous" });
    });
  }
});

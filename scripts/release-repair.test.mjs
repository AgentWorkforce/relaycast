import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import {
  RELAYCAST_8_8_0_REPAIR,
  assertRepairInputs,
  assertRepairSource,
} from "./release-repair.mjs";

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

describe("8.8.0 release repair fixture", () => {
  it("accepts the immutable source that produced the published artifacts", () => {
    assert.deepEqual(
      assertRepairInputs({
        ...RELAYCAST_8_8_0_REPAIR,
        packageProvenanceDigest: RELAYCAST_8_8_0_REPAIR.provenanceDigest,
        currentMainCommit: "e79efa732b24b4de134b4cd6c2b1346862e88443",
      }),
      RELAYCAST_8_8_0_REPAIR,
    );
    assert.doesNotThrow(() =>
      assertRepairSource({
        workspace: repositoryRoot,
        sourceCommit: RELAYCAST_8_8_0_REPAIR.sourceCommit,
        sourceTree: RELAYCAST_8_8_0_REPAIR.sourceTree,
      }),
    );
  });

  it("rejects current main as the source of the already-published artifacts", () => {
    assert.throws(
      () =>
        assertRepairInputs({
          ...RELAYCAST_8_8_0_REPAIR,
          sourceCommit: "e79efa732b24b4de134b4cd6c2b1346862e88443",
          currentMainCommit: "e79efa732b24b4de134b4cd6c2b1346862e88443",
          packageProvenanceDigest: RELAYCAST_8_8_0_REPAIR.provenanceDigest,
        }),
      /sourceCommit is not the allow-listed 8\.8\.0 repair value/,
    );
    assert.throws(
      () =>
        assertRepairSource({
          workspace: repositoryRoot,
          sourceCommit: "e79efa732b24b4de134b4cd6c2b1346862e88443",
          sourceTree: RELAYCAST_8_8_0_REPAIR.sourceTree,
        }),
      /repair source tree does not match/,
    );
  });

  it("rejects a mismatched run or provenance digest", () => {
    for (const [field, value] of [
      ["runId", "34436785435"],
      ["packageProvenanceDigest", "0".repeat(64)],
    ]) {
      assert.throws(
        () =>
          assertRepairInputs({
            ...RELAYCAST_8_8_0_REPAIR,
            packageProvenanceDigest: RELAYCAST_8_8_0_REPAIR.provenanceDigest,
            [field]: value,
          }),
        new RegExp(`${field} is not the allow-listed`),
      );
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RELAYCAST_8_8_0_REPAIR,
  assertRepairInputs,
  assertRepairSource,
} from "./release-repair.mjs";

const CURRENT_MAIN = "e79efa732b24b4de134b4cd6c2b1346862e88443";
const CURRENT_MAIN_TREE = "0f04fb3d5337ecc84c00a85c83253090eb020c3b";

function fixtureGit(_workspace, args) {
  const revision = args.at(-1);
  if (revision === `${RELAYCAST_8_8_0_REPAIR.sourceCommit}^{commit}`) {
    return RELAYCAST_8_8_0_REPAIR.sourceCommit;
  }
  if (revision === `${RELAYCAST_8_8_0_REPAIR.sourceCommit}^{tree}`) {
    return RELAYCAST_8_8_0_REPAIR.sourceTree;
  }
  if (revision === `${CURRENT_MAIN}^{commit}`) return CURRENT_MAIN;
  if (revision === `${CURRENT_MAIN}^{tree}`) return CURRENT_MAIN_TREE;
  throw new Error(`unexpected fixture revision: ${revision}`);
}

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
        workspace: "/fixture",
        sourceCommit: RELAYCAST_8_8_0_REPAIR.sourceCommit,
        sourceTree: RELAYCAST_8_8_0_REPAIR.sourceTree,
        gitCommand: fixtureGit,
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
          workspace: "/fixture",
          sourceCommit: CURRENT_MAIN,
          sourceTree: RELAYCAST_8_8_0_REPAIR.sourceTree,
          gitCommand: fixtureGit,
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCredentialSweepDisabled } from "../../packages/core/src/auth/credential-sweep-config.js";

describe("isCredentialSweepDisabled", () => {
  it("returns true for true values regardless of case or whitespace", () => {
    assert.equal(isCredentialSweepDisabled("true"), true);
    assert.equal(isCredentialSweepDisabled(" TRUE "), true);
    assert.equal(isCredentialSweepDisabled("TrUe"), true);
  });

  it("returns false for falsey or non-true values", () => {
    assert.equal(isCredentialSweepDisabled(undefined), false);
    assert.equal(isCredentialSweepDisabled(""), false);
    assert.equal(isCredentialSweepDisabled("false"), false);
    assert.equal(isCredentialSweepDisabled("1"), false);
  });
});

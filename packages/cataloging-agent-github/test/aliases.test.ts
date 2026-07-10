import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BY_ID_SEGMENT,
  BY_NAME_SEGMENT,
  BY_STATE_SEGMENT,
  BY_TITLE_SEGMENT,
  slugForAlias,
} from "../src/aliases.js";

describe("github alias helpers", () => {
  it("exports stable segment constants", () => {
    assert.equal(BY_TITLE_SEGMENT, "by-title");
    assert.equal(BY_ID_SEGMENT, "by-id");
    assert.equal(BY_NAME_SEGMENT, "by-name");
    assert.equal(BY_STATE_SEGMENT, "by-state");
  });

  it("slugifies titles using the relayfile alias rule", () => {
    assert.equal(slugForAlias("Fix Login Bug — production"), "fix-login-bug-production");
    assert.equal(slugForAlias("Release Notes / API"), "release-notes-api");
  });

  it("folds accented latin characters to ascii", () => {
    assert.equal(slugForAlias("Café déjà vu"), "cafe-deja-vu");
  });

  it("collapses emoji and cjk-only titles to the untitled fallback", () => {
    assert.equal(slugForAlias("🚀 Release 你好"), "release");
    assert.equal(slugForAlias("🚀🔥"), "untitled");
  });

  it("documents case-collision behavior so by-id remains the fallback", () => {
    assert.equal(slugForAlias("Fix Login Bug"), slugForAlias("fix login bug"));
  });

  it("truncates very long titles to 80 chars and trims trailing separators", () => {
    const slug = slugForAlias(`Alpha ${"beta ".repeat(20)}!!!`);
    assert.ok(slug.length <= 80);
    assert.equal(
      slug,
      "alpha-beta-beta-beta-beta-beta-beta-beta-beta-beta-beta-beta-beta-beta-beta-beta",
    );
  });

  it("falls back to untitled for empty, whitespace, and all-symbol input", () => {
    assert.equal(slugForAlias(""), "untitled");
    assert.equal(slugForAlias("   "), "untitled");
    assert.equal(slugForAlias("!!! ???"), "untitled");
  });
});

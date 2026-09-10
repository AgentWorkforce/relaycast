import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/repair-npm-release.yml", import.meta.url),
  "utf8",
);

describe("NPM release repair workflow safety contract", () => {
  it("downloads and validates one immutable audited artifact", () => {
    assert.match(workflow, /actions\/download-artifact@v4/);
    assert.match(workflow, /run-id: \$\{\{ inputs\.run_id \}\}/);
    assert.match(workflow, /name: build-output/);
    assert.match(workflow, /release-repair\.mjs validate/);
    assert.match(workflow, /--source-commit "\$REPAIR_SOURCE_COMMIT"/);
    assert.match(workflow, /--source-tree "\$REPAIR_SOURCE_TREE"/);
    assert.match(workflow, /--provenance-digest "\$REPAIR_PROVENANCE_DIGEST"/);
    assert.match(workflow, /--current-main "\$CURRENT_MAIN"/);
    assert.match(workflow, /--artifact-root "\$INPUT_ROOT"/);
  });

  it("verifies exact registry bytes and all dist-tags without mutation", () => {
    assert.match(workflow, /release-provenance\.mjs published/);
    assert.match(workflow, /npm-dist-tag\.mjs "\$\{TAG_ARGS\[@\]\}"/);
    assert.doesNotMatch(workflow, /npm publish/);
    assert.doesNotMatch(workflow, /npm dist-tag\s/);
    assert.match(workflow, /NPM_TAG_VERIFY_ATTEMPTS: 30/);
    assert.match(workflow, /NPM_TAG_VERIFY_DELAY_MS: 10000/);
  });

  it("validates and pushes the historical tag before the separate main merge", () => {
    const tagPush = workflow.indexOf('git -C "$RELEASE_ROOT" push origin "$TAG"');
    const mainPush = workflow.indexOf('git -C "$RELEASE_ROOT" push origin HEAD:main');
    assert.ok(tagPush >= 0 && mainPush > tagPush);
    assert.match(workflow, /validate-release-tag\.mjs/);
    assert.match(workflow, /git worktree add --detach "\$RELEASE_ROOT" "\$REPAIR_SOURCE_COMMIT"/);
    assert.match(workflow, /git -C "\$RELEASE_ROOT" merge --no-edit origin\/main/);
    assert.match(workflow, /contents: write/);
    assert.match(workflow, /softprops\/action-gh-release@v2/);
  });

  it("configures git identity before an existing-tag rerun can merge main", () => {
    const identity = workflow.indexOf('git config user.name "GitHub Actions"');
    const existingTagBranch = workflow.indexOf('if git show-ref --verify --quiet "refs/tags/$TAG"');
    const mainMerge = workflow.indexOf('git -C "$RELEASE_ROOT" merge --no-edit origin/main');
    assert.ok(identity >= 0 && identity < existingTagBranch);
    assert.ok(mainMerge > existingTagBranch);
    assert.match(workflow, /git config user.email "actions@github\.com"/);
  });

  it("does not use the dispatch checkout SHA as release provenance", () => {
    assert.doesNotMatch(workflow, /GITHUB_SHA/);
    assert.match(workflow, /source_commit:/);
    assert.match(workflow, /provenance_digest:/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateBootstrapScript } from "../../packages/core/src/bootstrap/script-generator.js";

function generateInnerScript(
  ...args: Parameters<typeof generateBootstrapScript>
): string {
  const result = generateBootstrapScript(...args);
  assert.equal(typeof result.inner, "string");
  return result.inner;
}

describe("cloud sync manifest diff bootstrap", () => {
  it("creates the baseline manifest before the relayfile-required guard", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    const gitCmdIdx = script.indexOf("const gitCmd = 'GIT_DIR=' + gitDir + ' GIT_WORK_TREE=' + brokerCwd;");
    const baselineIdx = script.indexOf("console.log('[bootstrap] Creating file manifest for baseline...');", gitCmdIdx);
    const relayfileRequiredIdx = script.indexOf("throw new Error('Relayfile is required for executor-based workflows');", baselineIdx);

    assert.notEqual(gitCmdIdx, -1, "git baseline command should be present");
    assert.notEqual(baselineIdx, -1, "baseline manifest creation should be present");
    assert.notEqual(relayfileRequiredIdx, -1, "relayfile-required guard should remain present");
    assert.ok(gitCmdIdx < baselineIdx);
    assert.ok(baselineIdx < relayfileRequiredIdx);
    assert.ok(
      !script.includes(
        "const gitCmd = 'GIT_DIR=' + gitDir + ' GIT_WORK_TREE=' + brokerCwd;\n  if (!relayfileEnabled) {\n    try {",
      ),
      "baseline manifest creation must not be guarded by !relayfileEnabled",
    );
  });

  it("flushes relayfile before running the shared local manifest diff", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    const patchSectionIdx = script.indexOf("// Generate and upload a patch of all changes made by agents.");
    const relayfileBranchIdx = script.indexOf("if (relayfileEnabled) {\n        stopRelayfileMountDaemon", patchSectionIdx);
    const flushIdx = script.indexOf("await flushRelayfileMountOnce(relayfileRoot);", relayfileBranchIdx);
    const patchGitCmdIdx = script.indexOf("const patchGitCmd = 'GIT_DIR=' + gitDir + ' GIT_WORK_TREE=' + brokerCwd;", flushIdx);
    const diffIdx = script.indexOf("git diff --cached", patchGitCmdIdx);
    const uploadIdx = script.indexOf("await s3.putObject('changes.patch', patchContent, 'text/plain');", diffIdx);

    assert.notEqual(patchSectionIdx, -1, "patch upload section should be present");
    assert.notEqual(relayfileBranchIdx, -1, "relayfile branch should still stop the mount");
    assert.notEqual(flushIdx, -1, "relayfile branch should flush before diffing");
    assert.notEqual(patchGitCmdIdx, -1, "shared manifest diff path should be present");
    assert.notEqual(diffIdx, -1, "shared path should produce /tmp/changes.patch");
    assert.notEqual(uploadIdx, -1, "shared path should upload changes.patch to S3");
    assert.ok(relayfileBranchIdx < flushIdx);
    assert.ok(flushIdx < patchGitCmdIdx);
    assert.ok(patchGitCmdIdx < diffIdx);
    assert.ok(diffIdx < uploadIdx);
  });

  it("does not use the relayfile workspace-export patch as changes.patch", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    assert.ok(!script.includes("async function uploadRelayfilePatch"));
    assert.ok(!script.includes("uploadRelayfilePatch(s3)"));
    assert.ok(!script.includes("fs/export?format=patch"));
  });

  it("excludes volatile workflow files from generated cloud sync patches", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    assert.ok(script.includes("function shouldIgnorePatchPath(rel)"));
    assert.ok(script.includes("rel === '.relayfile.acl'"));
    assert.ok(script.includes("rel.startsWith('.agent-bin/')"));
    assert.ok(script.includes("rel.startsWith('.trajectories/')"));
    assert.ok(script.includes("rel.startsWith('.workflow-context/')"));
    assert.ok(script.includes("if (shouldIgnorePatchPath(rel) || shouldIgnorePatchPath(rel + '/')) continue;"));
    assert.ok(script.includes("if (shouldIgnorePatchPath(manifestPath)) continue;"));
  });
});

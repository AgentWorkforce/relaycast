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

describe("standalone TS executor bootstrap", () => {
  it("keeps local bun fallback and wraps cloud runs with the sandbox executor", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    const fallbackIdx = script.indexOf("let standaloneWorkflowFile = workflowFile;");
    const daytonaBranchIdx = script.indexOf("if (env.DAYTONA_SANDBOX_ID)", fallbackIdx);
    const wrapperWriteIdx = script.indexOf(
      "writeFileSync(standaloneWorkflowFile, buildStandaloneWorkflowWrapperSource(workflowFile))",
      daytonaBranchIdx,
    );
    const bunRunIdx = script.indexOf(
      "execFileSync('bun', ['run', standaloneWorkflowFile]",
      wrapperWriteIdx,
    );

    assert.notEqual(fallbackIdx, -1, "standalone fallback should start with the original workflow file");
    assert.notEqual(daytonaBranchIdx, -1, "standalone fallback should branch on DAYTONA_SANDBOX_ID");
    assert.notEqual(wrapperWriteIdx, -1, "cloud branch should write the wrapper file");
    assert.notEqual(bunRunIdx, -1, "standalone fallback should still run through bun");
    assert.ok(fallbackIdx < daytonaBranchIdx);
    assert.ok(daytonaBranchIdx < wrapperWriteIdx);
    assert.ok(wrapperWriteIdx < bunRunIdx);
  });

  it("patches WorkflowBuilder.run to inject executor and processBackend", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    assert.ok(script.includes("import { WorkflowBuilder } from '@relayflows/core';"));
    assert.ok(script.includes("WorkflowBuilder.prototype.run = function patchedCloudRun(options = {})"));
    assert.ok(script.includes("executor: options.executor ?? executor"));
    assert.ok(script.includes("processBackend: options.processBackend ?? executor"));
    assert.ok(script.includes("return originalRun.call(this, patchedOptions);"));
    assert.ok(script.includes("runtime.attachSandbox(orchestratorSandbox"));
  });

  it("preserves the escaped config-export regex in the generated bootstrap", () => {
    const script = generateInnerScript({
      fileType: "typescript",
      interactive: true,
    });

    assert.ok(
      script.includes("hasConfigExport = /^export\\s+(?:const\\s+config\\b|default\\b)/m.test(sourceText);"),
    );
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

function exportedFunction<T extends (...args: never[]) => unknown>(module: unknown, key: string): T {
  let current = module;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      if (typeof record[key] === "function") {
        return record[key] as T;
      }
      current = record.default;
      continue;
    }
    break;
  }
  throw new TypeError(`Missing function export: ${key}`);
}

const parserModule = await import(new URL("../../packages/web/lib/ricky/slack/parser.ts", import.meta.url).href);
const blocksModule = await import(new URL("../../packages/web/lib/ricky/slack/blocks.ts", import.meta.url).href);

const parseRickySlackCommand = exportedFunction<
  typeof import("../../packages/web/lib/ricky/slack/parser.ts").parseRickySlackCommand
>(parserModule, "parseRickySlackCommand");
const buildRickyGateBlocks = exportedFunction<
  typeof import("../../packages/web/lib/ricky/slack/blocks.ts").buildRickyGateBlocks
>(blocksModule, "buildRickyGateBlocks");
const buildRickyRunStartedBlocks = exportedFunction<
  typeof import("../../packages/web/lib/ricky/slack/blocks.ts").buildRickyRunStartedBlocks
>(blocksModule, "buildRickyRunStartedBlocks");
const buildRickyRunTerminalBlocks = exportedFunction<
  typeof import("../../packages/web/lib/ricky/slack/blocks.ts").buildRickyRunTerminalBlocks
>(blocksModule, "buildRickyRunTerminalBlocks");
const parseRickyGateActionValue = exportedFunction<
  typeof import("../../packages/web/lib/ricky/slack/blocks.ts").parseRickyGateActionValue
>(blocksModule, "parseRickyGateActionValue");

describe("Ricky Slack command parser", () => {
  it("parses run, status, approve, deny, connect, and help commands", () => {
    assert.deepEqual(parseRickySlackCommand("run workflows/deploy.ts"), {
      kind: "run",
      request: {
        workflow: "workflows/deploy.ts",
        fileType: "ts",
        workflowPath: "workflows/deploy.ts",
      },
    });
    assert.deepEqual(parseRickySlackCommand("status ricky-1"), {
      kind: "status",
      rickyRunId: "ricky-1",
    });
    assert.equal(parseRickySlackCommand("approve gate-1").kind, "approve");
    assert.equal(parseRickySlackCommand("deny gate-1").kind, "deny");
    assert.deepEqual(parseRickySlackCommand("connect"), { kind: "connect" });
    assert.deepEqual(parseRickySlackCommand(""), { kind: "help" });
  });
});

describe("Ricky Slack run progress blocks", () => {
  it("uses native plan/task cards for start and terminal states", () => {
    const started = buildRickyRunStartedBlocks({
      rickyRunId: "run-1",
      rootRunId: "root-1",
      status: "running",
      cloudUrl: "https://agentrelay.com/cloud/dashboard/ricky/run-1",
    });
    assert.equal(started[0]?.type, "plan");
    assert.equal(started[0]?.title, "Ricky is working");
    assert.match(JSON.stringify(started), new RegExp("Watch progress"));
    assert.match(JSON.stringify(started), new RegExp("Open in Cloud"));

    const terminal = buildRickyRunTerminalBlocks({
      rickyRunId: "run-1",
      status: "succeeded",
      cloudUrl: "https://agentrelay.com/cloud/dashboard/ricky/run-1",
    });
    assert.equal(terminal[0]?.type, "plan");
    assert.equal(terminal[0]?.title, "Run completed");
    assert.match(JSON.stringify(terminal), new RegExp("Run completed"));
    assert.match(JSON.stringify(terminal), new RegExp("\"status\":\"complete\""));
  });
});

describe("Ricky Slack gate blocks", () => {
  it("include required gate details and action payloads", () => {
    const blocks = buildRickyGateBlocks({
      run: {
        id: "run-1",
        workspaceId: "workspace-1",
        currentAttempt: 2,
        latestDiagnosis: { summary: "Tests failed", failedStep: "verify" },
      } as never,
      gate: {
        id: "gate-1",
        prompt: "Approve repair?",
        reason: "repo_mutation",
        gateType: "approval_required",
        proposedAction: { summary: "Patch the failing test setup." },
      } as never,
      attempt: { attempt: 2, diagnosis: { summary: "Attempt failed", failedStep: "verify" } } as never,
      slackTeamId: "T1234567",
      channelId: "C1234567",
      messageTs: "1710000000.000100",
      slackUserId: "U1234567",
      cloudUrl: "https://agentrelay.com/cloud/dashboard/ricky/run-1",
    });

    const text = JSON.stringify(blocks);
    assert.match(text, new RegExp("Run id"));
    assert.match(text, new RegExp("Attempt"));
    assert.match(text, new RegExp("Failed step"));
    assert.match(text, new RegExp("Diagnosis summary"));
    assert.match(text, new RegExp("Proposed repair/action"));
    assert.match(text, new RegExp("Risk reason"));
    assert.match(text, new RegExp("Approve"));
    assert.match(text, new RegExp("Deny"));
    assert.match(text, new RegExp("Edit instruction"));
    assert.match(text, new RegExp("Open in Cloud"));

    const actions = blocks.find((block: { type?: string }) => block.type === "actions") as {
      elements: Array<{ value?: string }>;
    };
    const parsed = parseRickyGateActionValue(actions.elements[0]!.value!);
    assert.deepEqual(parsed?.action, "approve");
    assert.deepEqual(parsed?.gateId, "gate-1");
  });
});

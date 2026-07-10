import { describe, expect, it, vi } from "vitest";
import golden from "./__fixtures__/workflow-b64-golden.json";

vi.mock("@agentworkforce/runtime", () => ({
  defineAgent: (spec: Record<string, unknown>) => spec,
  handler: (fn: unknown) => fn,
}));

const { workflowSource: smallWorkflowSource } = await import("../../cloud-small-issue-codex/agent");
const { workflowSource: complexWorkflowSource } = await import("../../cloud-complex-issue-workflow/agent");

type PersonaId = "cloud-small-issue-codex" | "cloud-complex-issue-workflow";

type GoldenCase = {
  name: string;
  persona: PersonaId;
  repoOwner: string;
  repoName: string;
  archiveLeaseEnabled: boolean;
  materializeScriptB64: string;
  createProxyPrScriptB64: string;
};

const workflowSources: Record<PersonaId, typeof smallWorkflowSource> = {
  "cloud-small-issue-codex": smallWorkflowSource,
  "cloud-complex-issue-workflow": complexWorkflowSource,
};

const issueFixture = {
  issueNumber: 1569,
  issueTitle: "Extract issue resolver substrate",
  issueBody: [
    "Refactor the duplicated resolver substrate.",
    "Keep generated helper scripts byte-identical.",
    "Cover owner/name input surface: AgentWorkforce/cloud.",
  ].join("\n\n"),
  issueUrl: "https://github.com/AgentWorkforce/cloud/issues/1569",
};

describe("issue resolver workflow helper script B64 golden", () => {
  for (const testCase of golden.cases as GoldenCase[]) {
    it(`preserves ${testCase.name}`, () => {
      const source = workflowSources[testCase.persona]({
        ...issueFixture,
        archiveLeaseMaterializeEnabled: testCase.archiveLeaseEnabled,
      });
      const encoded = extractEncodedScripts(source);

      expect(testCase.repoOwner).toBe("AgentWorkforce");
      expect(testCase.repoName).toBe("cloud");
      expect(encoded.materializeScriptB64).toBe(testCase.materializeScriptB64);
      expect(encoded.createProxyPrScriptB64).toBe(testCase.createProxyPrScriptB64);
    });
  }
});

function extractEncodedScripts(source: string): {
  materializeScriptB64: string;
  createProxyPrScriptB64: string;
} {
  const legacyMaterializeScript = extractRawScript(source, "LEGACY_MATERIALIZE_SCRIPT");
  const archiveLeaseMaterializeScript = extractRawScript(source, "ARCHIVE_LEASE_MATERIALIZE_SCRIPT");
  const createProxyPrScript = extractRawScript(source, "CREATE_PROXY_PR_SCRIPT");
  const selectedMaterializer = source.includes("const MATERIALIZE_SCRIPT = ARCHIVE_LEASE_MATERIALIZE_SCRIPT;")
    ? archiveLeaseMaterializeScript
    : legacyMaterializeScript;

  return {
    materializeScriptB64: Buffer.from(selectedMaterializer, "utf8").toString("base64"),
    createProxyPrScriptB64: Buffer.from(createProxyPrScript, "utf8").toString("base64"),
  };
}

function extractRawScript(source: string, constName: string): string {
  const needle = `const ${constName} = String.raw` + "`";
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`missing ${constName}`);
  const bodyStart = start + needle.length;
  const end = source.indexOf("`;", bodyStart);
  if (end < 0) throw new Error(`unterminated ${constName}`);
  return source.slice(bodyStart, end);
}

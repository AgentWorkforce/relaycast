import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as availabilityModule from "../../packages/web/lib/ricky/agent-availability-snapshot.ts";
import * as redactionModule from "../../packages/web/lib/ricky/redaction.ts";

const { extractRequestedClisFromWorkflow: extractRequestedClis } = availabilityModule as {
  extractRequestedClisFromWorkflow: typeof import("../../packages/web/lib/ricky/agent-availability-snapshot.ts").extractRequestedClisFromWorkflow;
};
const { redactForRicky, redactText } = redactionModule as {
  redactForRicky: typeof import("../../packages/web/lib/ricky/redaction.ts").redactForRicky;
  redactText: typeof import("../../packages/web/lib/ricky/redaction.ts").redactText;
};

describe("Ricky redaction", () => {
  it("redacts credential-shaped object keys recursively", () => {
    const redacted = redactForRicky({
      nested: {
        accessToken: "secret-token",
        harmless: "visible",
      },
      payload: "OPENAI_API_KEY=sk-test",
    });

    assert.deepEqual(redacted, {
      nested: {
        accessToken: "[REDACTED]",
        harmless: "visible",
      },
      payload: "OPENAI_API_KEY=[REDACTED]",
    });
  });

  it("redacts bearer tokens from text snapshots", () => {
    assert.equal(redactText("Authorization: Bearer abc.def.ghi"), "Authorization: [REDACTED]");
  });

  it("redacts provider credential bundle values without hiding provider names", () => {
    assert.deepEqual(
      redactForRicky({
        cliCredentials: {
          anthropic: '{"access_token":"anthropic-token"}',
          openai: "sk-openai-token",
        },
        selectedAgent: {
          provider: "openrouter",
        },
      }),
      {
        cliCredentials: "[REDACTED]",
        selectedAgent: {
          provider: "openrouter",
        },
      },
    );
    assert.equal(
      redactText('CLI_CREDENTIALS={"anthropic":"anthropic-token","openai":"sk-openai-token"}'),
      'CLI_CREDENTIALS={"anthropic":[REDACTED],"openai":[REDACTED]}',
    );
  });

  it("redacts raw credential JSON from text evidence snapshots", () => {
    const raw = [
      "failed to parse provider payload",
      '"credential_json":{"type":"service_account","project_id":"prod","private_key":"-----BEGIN PRIVATE KEY-----abc","client_email":"bot@example.com"}',
      '"next":"visible"',
    ].join(" ");

    const redacted = redactText(raw);

    assert.equal(redacted.includes("-----BEGIN PRIVATE KEY-----abc"), false);
    assert.equal(redacted.includes("bot@example.com"), false);
    assert.equal(redacted.includes('"credential_json":[REDACTED]'), true);
    assert.equal(redacted.includes('"next":"visible"'), true);
    assert.equal(
      redactText('"credential_json":"{\\"private_key\\":\\"escaped-key\\",\\"client_email\\":\\"bot@example.com\\"}"'),
      '"credential_json":[REDACTED]',
    );
  });
});

describe("Ricky requested CLI extraction", () => {
  it("extracts declared script CLIs without requiring credentials", () => {
    const clis = extractRequestedClis({
      fileType: "ts",
      workflow: "agent({ cli: 'codex' }); agent({ cli: \"claude\" });",
    });

    assert.deepEqual(clis.sort(), ["claude", "codex"]);
  });
});

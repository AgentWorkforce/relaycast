import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.$app = { stage: "dev" };

const { defaultRelayfileUrl } = await import("../infra/relayfile-url.ts");
const { relayfileUrl } = await import("../infra/relayfile.ts");
const { configuredRelayfileUrl } = await import("../infra/service-config.ts");

test("relayfile defaults route production, staging, and dev to their tier hosts", () => {
  assert.equal(defaultRelayfileUrl("production"), "https://file.agentrelay.com");
  assert.equal(
    defaultRelayfileUrl("staging"),
    "https://staging.file.agentrelay.com",
  );
  assert.equal(defaultRelayfileUrl("dev"), "https://dev.file.agentrelay.com");
  assert.equal(defaultRelayfileUrl("pr-123"), "https://dev.file.agentrelay.com");
});

test("relayfile infra and service config share the same default URL helper", () => {
  assert.equal(relayfileUrl, "https://dev.file.agentrelay.com");
  assert.equal(configuredRelayfileUrl, "https://dev.file.agentrelay.com");
});

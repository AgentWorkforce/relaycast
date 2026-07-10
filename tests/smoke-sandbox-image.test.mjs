import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProactiveRuntimeCommand,
  buildRelayfileHelpProbeCommand,
  buildRuntimeClosureCommand,
  buildSnapshotBrokerRegisterCommand,
  buildSnapshotLocalRunCommand,
  buildSnapshotVersionAssertionsCommand,
  readArg,
  relayfileVersionFromSnapshot,
  sdkVersionFromSnapshot,
} from "../scripts/smoke-sandbox-image.mjs";

test("smoke script parses relayfile version from snapshot names", () => {
  assert.equal(
    relayfileVersionFromSnapshot("relay-orchestrator-sdk-6.3.5-relayfile-v0.8.9-runtime-3.0.39"),
    "v0.8.9",
  );
  assert.equal(
    relayfileVersionFromSnapshot("relay-orchestrator-sdk-latest-relayfile-0.9.0-rc.1-runtime-3.0.40"),
    "0.9.0-rc.1",
  );
  assert.throws(
    () => relayfileVersionFromSnapshot("relay-orchestrator-sdk-6.3.5-runtime-3.0.39"),
    /Could not parse relayfile version/,
  );
});

test("smoke script reads flag values without consuming following flags", () => {
  const argv = ["node", "scripts/smoke-sandbox-image.mjs", "--snapshot", "snap-1", "--require-mount-probe"];
  assert.equal(readArg(argv, "--snapshot"), "snap-1");
  assert.equal(readArg(argv, "--missing"), null);
});

test("relayfile help probe tolerates expected token-related exit codes", () => {
  const command = buildRelayfileHelpProbeCommand();
  assert.match(command, /out=\$\(relayfile-mount --help 2>&1\)/);
  assert.match(command, /0\|1\|2\)/);
  assert.doesNotMatch(command, /^set -e/m);
});

test("runtime closure probe matches paths and packages baked by create-snapshot", () => {
  const command = buildRuntimeClosureCommand();
  assert.match(command, /cd \/home\/daytona/);
  assert.match(command, /'@agent-relay\/sdk'/);
  assert.match(command, /'@agent-relay\/config'/);
  assert.match(command, /'@agent-relay\/credential-proxy'/);
  assert.match(command, /'@relayflows\/core'/);
  assert.match(command, /agent-relay-broker-\$\{process\.platform\}-\$\{process\.arch\}/);
  // 8.x-safe walk-up (no fixed ../bin depth assumption).
  assert.match(command, /for \(let i = 0; i < 10 && !broker; i\+\+\)/);
  assert.doesNotMatch(command, /'\.\.',\s*\n?\s*'bin'/);
  assert.match(command, /npx --no-install tsx --version/);
});

test("sdk version parses from snapshot names and throws on malformed", () => {
  assert.equal(
    sdkVersionFromSnapshot("relay-orchestrator-sdk-8.7.1-relayfile-v0.8.23-runtime-4.0.1"),
    "8.7.1",
  );
  assert.equal(
    sdkVersionFromSnapshot("relay-orchestrator-sdk-8.3.1-beta.0-relayfile-v0.8.9-runtime-4.0.1"),
    "8.3.1-beta.0",
  );
  assert.throws(
    () => sdkVersionFromSnapshot("relay-orchestrator-relayfile-v0.8.9-runtime-4.0.1"),
    /Could not parse sdk version/,
  );
});

test("snapshot version assertions pin SDK line and guard the 7.x protocol line", () => {
  const command = buildSnapshotVersionAssertionsCommand("8.7.1", "1.0.1");
  assert.match(command, /npm', \['ls'/);
  assert.match(command, /"8\.7\.1"/); // expected SDK interpolated as argv
  assert.match(command, /"1\.0\.1"/); // expected @relayflows/core interpolated as argv
  assert.match(command, /@agent-relay\/sdk \$\{sdk\} != expected/);
  // exact @relayflows/core check (derived from packages/core), with ^/~ tolerance.
  assert.match(command, /expectedRelayflows && relayflows !== expectedRelayflows/);
  assert.match(command, /\.replace\(\/\^\[\^0-9\]\*\//); // strip ^/~ ranges
  // protocol-line skew guard: anything 8.x on agent/events/credential-proxy fails.
  assert.match(command, /must stay on the 7\.x protocol line/);
});

test("snapshot broker check resolves via walk-up and asserts --register", () => {
  const command = buildSnapshotBrokerRegisterCommand();
  assert.match(command, /for \(let i = 0; i < 10 && !p; i\+\+\)/);
  assert.match(command, /mcp-args --help/);
  assert.match(command, /grep -q -- '--register'/);
  assert.match(command, /AGENT_RELAY_TELEMETRY_DISABLED=1/);
});

test("snapshot local run asserts CLI version and runs a workflow", () => {
  const command = buildSnapshotLocalRunCommand("8.7.1");
  assert.match(command, /agent-relay --version/);
  assert.match(command, /EXPECTED_SDK="8\.7\.1"/);
  assert.match(command, /grep -oE '\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\(\[-\+\]\[0-9A-Za-z\.-\]\+\)\?'/);
  assert.match(command, /agent-relay local run --json snapshot-localrun\.yaml/);
  assert.match(command, /run\.runId/);
  assert.match(command, /agent-relay local logs "\$RUN_ID" --follow --poll-interval 1/);
  assert.match(command, /AR_SNAPSHOT_LOCALRUN_MARKER_OK/);
});

test("snapshot local run preserves prerelease SDK versions", () => {
  const command = buildSnapshotLocalRunCommand("8.3.1-beta.0");
  assert.match(command, /EXPECTED_SDK="8\.3\.1-beta\.0"/);
});

test("proactive runtime probe matches the baked runtime directory", () => {
  const command = buildProactiveRuntimeCommand();
  assert.match(command, /cd \/home\/daytona\/workforce-runtime/);
  assert.match(command, /'@agentworkforce\/runtime'/);
});

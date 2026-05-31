import { workflow, ClaudeModels, CodexModels } from '@agent-relay/sdk/workflows';

const dryRun = process.argv.includes('--dry-run');
const specCoverageAuditCommand = String.raw`/bin/bash <<'BASH'
set -euo pipefail
fail=0

need_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "CHANGES_REQUIRED: missing file $file"
    fail=1
  fi
}

need_fixed() {
  local needle="$1"
  local file="$2"
  if ! rg -F "$needle" "$file" >/dev/null 2>&1; then
    echo "CHANGES_REQUIRED: $file missing literal marker: $needle"
    fail=1
  fi
}

need_regex() {
  local pattern="$1"
  local file="$2"
  if ! rg "$pattern" "$file" >/dev/null 2>&1; then
    echo "CHANGES_REQUIRED: $file missing regex marker: $pattern"
    fail=1
  fi
}

reject_fixed() {
  local needle="$1"
  local file="$2"
  if rg -F "$needle" "$file" >/dev/null 2>&1; then
    echo "CHANGES_REQUIRED: $file contains forbidden marker: $needle"
    fail=1
  fi
}

need_file docs/sdk-setup-client.md
need_file docs/sdk-setup-client-acceptance.md
need_file packages/sdk-typescript/src/setup.ts
need_file packages/sdk-typescript/src/setup-types.ts
need_file packages/sdk-typescript/src/setup-errors.ts
need_file packages/sdk-typescript/src/communicate/types.ts
need_file packages/sdk-typescript/src/communicate/relay.ts
need_file packages/sdk-typescript/src/communicate/index.ts
need_file packages/sdk-typescript/src/index.ts
need_file packages/sdk-typescript/src/__tests__/setup.test.ts
need_file packages/sdk-typescript/src/__tests__/communicate.test.ts
need_file scripts/e2e-sdk-setup-client.ts

need_fixed "export { RelaycastSetup" packages/sdk-typescript/src/index.ts
need_fixed "from './setup.js'" packages/sdk-typescript/src/index.ts
need_fixed "from './setup-types.js'" packages/sdk-typescript/src/index.ts
need_fixed "from './setup-errors.js'" packages/sdk-typescript/src/index.ts
need_fixed "export { Relay } from './communicate/relay.js'" packages/sdk-typescript/src/index.ts
need_fixed "MessageCallback" packages/sdk-typescript/src/index.ts
need_fixed "RelayConfig" packages/sdk-typescript/src/index.ts
reject_fixed "RelayCast as Relay" packages/sdk-typescript/src/index.ts
need_fixed "\"./communicate\"" packages/sdk-typescript/package.json

need_regex "class RelaycastSetup" packages/sdk-typescript/src/setup.ts
need_regex "class WorkspaceHandle" packages/sdk-typescript/src/setup.ts
need_regex "createWorkspace\\(" packages/sdk-typescript/src/setup.ts
need_regex "joinWorkspace\\(" packages/sdk-typescript/src/setup.ts
need_regex "lookupWorkspace\\(" packages/sdk-typescript/src/setup.ts
need_regex "registerAgent\\(" packages/sdk-typescript/src/setup.ts
need_fixed "https://gateway.relaycast.dev" packages/sdk-typescript/src/setup.ts
need_fixed "CreateWorkspaceResponseSchema" packages/sdk-typescript/src/setup.ts
need_fixed "WorkspaceLookupSchema" packages/sdk-typescript/src/setup.ts
need_fixed "camelizeKeys" packages/sdk-typescript/src/setup.ts
need_fixed "X-SDK-Version" packages/sdk-typescript/src/setup.ts
need_fixed "SDK_ORIGIN" packages/sdk-typescript/src/setup.ts
need_fixed "Retry-After" packages/sdk-typescript/src/setup.ts
need_fixed "AbortSignal.timeout" packages/sdk-typescript/src/setup.ts

for symbol in RelaycastSetupOptions CreateWorkspaceOptions JoinWorkspaceOptions WorkspaceInfo RegisterAgentOptions AgentRecord; do
  need_regex "interface $symbol" packages/sdk-typescript/src/setup-types.ts
done
for symbol in RelaycastSetupError RelaycastApiError MalformedApiResponseError WorkspaceNotFoundError AgentNotRegisteredError MissingApiKeyError; do
  need_regex "class $symbol" packages/sdk-typescript/src/setup-errors.ts
done
for marker in "api_error" "malformed_api_response" "workspace_not_found" "agent_not_registered" "missing_api_key"; do
  need_fixed "$marker" packages/sdk-typescript/src/setup-errors.ts
done

need_regex "interface RelayConfig" packages/sdk-typescript/src/communicate/types.ts
need_regex "type MessageCallback|interface MessageCallback" packages/sdk-typescript/src/communicate/types.ts
need_regex "class Relay" packages/sdk-typescript/src/communicate/relay.ts
for marker in "post(" "send(" "reply(" "inbox(" "onMessage("; do
  need_fixed "$marker" packages/sdk-typescript/src/communicate/relay.ts
done

for marker in "createWorkspace" "joinWorkspace" "lookupWorkspace" "registerAgent" "AgentNotRegisteredError" "RelaycastApiError" "MalformedApiResponseError" "Retry-After" "requestTimeoutMs" "local mode" "listRegisteredAgents" "X-SDK-Version"; do
  need_fixed "$marker" packages/sdk-typescript/src/__tests__/setup.test.ts
done
for marker in "post()" "send()" "reply()" "inbox()" "onMessage()" "connect"; do
  need_fixed "$marker" packages/sdk-typescript/src/__tests__/communicate.test.ts
done
for marker in "RelaycastSetup" "createWorkspace" "joinWorkspace" "lookupWorkspace" "registerAgent" ".as(" ".relay(" "relayCast()" "onMessage" "mkdtemp"; do
  need_fixed "$marker" scripts/e2e-sdk-setup-client.ts
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "APPROVED: spec coverage markers, SDK exports, unit coverage, and local E2E coverage are present."
BASH`;

async function runWorkflow() {
  const result = await workflow('sdk-setup-client-80-100')
    .description(
      'Implement docs/sdk-setup-client.md for @relaycast/sdk and drive it from 80 percent code-complete to 100 percent locally verified.',
    )
  .pattern('supervisor')
  .channel('wf-sdk-setup-client')
  .maxConcurrency(5)
  .timeout(7_200_000)
  .idleNudge({ nudgeAfterMs: 120_000, escalateAfterMs: 180_000, maxNudges: 2 })
  .trajectories({ enabled: true, reflectOnBarriers: true, reflectOnConverge: true, autoDecisions: true })

  .agent('lead', {
    cli: 'claude',
    model: ClaudeModels.OPUS,
    preset: 'lead',
    role: 'Implementation lead. Resolve spec conflicts, coordinate workers, and require evidence before merge.',
    retries: 1,
  })
  .agent('types-worker', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    preset: 'worker',
    role: 'Owns setup types and setup-specific errors only.',
    retries: 2,
  })
  .agent('communicate-worker', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    preset: 'worker',
    role: 'Owns the communicate-style Relay adapter files only.',
    retries: 2,
  })
  .agent('setup-worker', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    preset: 'worker',
    role: 'Owns RelaycastSetup and WorkspaceHandle implementation only.',
    retries: 2,
  })
  .agent('test-worker', {
    cli: 'codex',
    model: CodexModels.GPT_5_4,
    preset: 'worker',
    role: 'Owns unit tests and the local end-to-end setup client script.',
    retries: 2,
  })
  .agent('reviewer', {
    cli: 'claude',
    model: ClaudeModels.SONNET,
    preset: 'reviewer',
    role: 'Reviews spec coverage, snake_case wire behavior, and the 80-to-100 validation evidence.',
    retries: 1,
  })

  .step('read-spec-and-surface', {
    type: 'deterministic',
    command: String.raw`/bin/bash -lc '
set -euo pipefail
printf "===== docs/sdk-setup-client.md =====\n"
sed -n "1,980p" docs/sdk-setup-client.md
printf "\n===== sdk index =====\n"
sed -n "1,220p" packages/sdk-typescript/src/index.ts
printf "\n===== relay client surface =====\n"
sed -n "1,620p" packages/sdk-typescript/src/relay.ts
printf "\n===== agent client surface =====\n"
sed -n "1,620p" packages/sdk-typescript/src/agent.ts
printf "\n===== http client retry surface =====\n"
sed -n "1,260p" packages/sdk-typescript/src/client.ts
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('lead-acceptance-contract', {
    agent: 'lead',
    dependsOn: ['read-spec-and-surface'],
    task: `Create docs/sdk-setup-client-acceptance.md as the acceptance contract from docs/sdk-setup-client.md.
Call out any spec contradictions before implementation.
Prefer existing SDK naming and snake_case HTTP wire behavior.
Require zod or existing typed schemas where validation is practical.
Define every path that must be proven by unit tests and local E2E.
Post concise file ownership assignments for the workers.
Workers are not alone in the codebase; coordinate before editing shared files.

Context:
{{steps.read-spec-and-surface.output}}`,
    verification: { type: 'exit_code', value: '0' },
    retries: 1,
  })

  .step('implement-setup-types', {
    agent: 'types-worker',
    dependsOn: ['lead-acceptance-contract'],
    task: `Create packages/sdk-typescript/src/setup-types.ts.
Define RelaycastSetupOptions, CreateWorkspaceOptions, JoinWorkspaceOptions.
Define WorkspaceInfo, RegisterAgentOptions, and AgentRecord.
Use camelCase TypeScript fields and match the accepted contract below.
Import existing SDK types only when it reduces duplication.
Do not edit other files in this step.
Report the exported type names and any spec ambiguity.

Accepted contract:
{{steps.lead-acceptance-contract.output}}`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('verify-setup-types', {
    type: 'deterministic',
    dependsOn: ['implement-setup-types'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
test -f packages/sdk-typescript/src/setup-types.ts
rg "interface RelaycastSetupOptions" packages/sdk-typescript/src/setup-types.ts
rg "interface CreateWorkspaceOptions" packages/sdk-typescript/src/setup-types.ts
rg "interface JoinWorkspaceOptions" packages/sdk-typescript/src/setup-types.ts
rg "interface WorkspaceInfo" packages/sdk-typescript/src/setup-types.ts
rg "interface RegisterAgentOptions" packages/sdk-typescript/src/setup-types.ts
rg "interface AgentRecord" packages/sdk-typescript/src/setup-types.ts
echo "setup-types.ts contract present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('implement-setup-errors', {
    agent: 'types-worker',
    dependsOn: ['verify-setup-types'],
    task: `Create packages/sdk-typescript/src/setup-errors.ts.
Implement RelaycastSetupError plus every subclass from the accepted contract.
Each error must expose the documented readonly code and metadata fields.
Use small constructors with useful messages.
Do not add mixed-case compatibility fallbacks.
Do not edit other files in this step.

Accepted contract:
{{steps.lead-acceptance-contract.output}}`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('verify-setup-errors', {
    type: 'deterministic',
    dependsOn: ['implement-setup-errors'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
test -f packages/sdk-typescript/src/setup-errors.ts
for symbol in RelaycastSetupError RelaycastApiError MalformedApiResponseError WorkspaceNotFoundError AgentNotRegisteredError MissingApiKeyError; do
  rg "class $symbol" packages/sdk-typescript/src/setup-errors.ts >/dev/null
done
rg "readonly code = '\''api_error'\''" packages/sdk-typescript/src/setup-errors.ts
rg "readonly code = '\''malformed_api_response'\''" packages/sdk-typescript/src/setup-errors.ts
rg "readonly code = '\''agent_not_registered'\''" packages/sdk-typescript/src/setup-errors.ts
echo "setup-errors.ts contract present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('implement-communicate-relay', {
    agent: 'communicate-worker',
    dependsOn: ['lead-acceptance-contract'],
    task: `Create packages/sdk-typescript/src/communicate/types.ts, relay.ts, and index.ts.
Implement the simple Relay wrapper from the accepted contract: send, post, reply, inbox, onMessage, and the documented communicate types such as Message, MessageCallback, and RelayConfig.
Build on AgentClient instead of duplicating HTTP logic.
Preserve channel hash ergonomics and existing AgentClient event behavior.
Keep files focused on communicate-style convenience only.
Do not edit setup.ts or index.ts in this step.

Accepted contract:
{{steps.lead-acceptance-contract.output}}`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('verify-communicate-relay', {
    type: 'deterministic',
    dependsOn: ['implement-communicate-relay'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
for f in packages/sdk-typescript/src/communicate/types.ts packages/sdk-typescript/src/communicate/relay.ts packages/sdk-typescript/src/communicate/index.ts; do
  test -f "$f" || { echo "Missing $f"; exit 1; }
done
rg "class Relay" packages/sdk-typescript/src/communicate/relay.ts
rg "RelayConfig" packages/sdk-typescript/src/communicate/types.ts
rg "send\\(" packages/sdk-typescript/src/communicate/relay.ts
rg "post\\(" packages/sdk-typescript/src/communicate/relay.ts
rg "onMessage\\(" packages/sdk-typescript/src/communicate/relay.ts
echo "communicate Relay contract present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('implement-setup-client', {
    agent: 'setup-worker',
    dependsOn: ['verify-setup-types', 'verify-setup-errors', 'verify-communicate-relay'],
    task: `Create packages/sdk-typescript/src/setup.ts.
Implement RelaycastSetup and WorkspaceHandle exactly as the accepted contract states.
Default cloud base URL is https://gateway.relaycast.dev (the hosted engine); a self-hosted engine is reached by passing baseUrl (e.g. http://localhost:8787).
Use fetch with JSON headers, X-SDK-Version, optional Authorization, timeout, retry, Retry-After, and jitter.
Wrap non-2xx API envelopes in RelaycastApiError and validate required fields.
WorkspaceHandle must manage agent tokens for registerAgent(), relay(), getAgentToken(), and listRegisteredAgents().
Use RelayCast, AgentClient, HttpClient, and Relay instead of reimplementing existing clients.
Only edit setup.ts in this step.

Accepted contract:
{{steps.lead-acceptance-contract.output}}`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('verify-setup-client', {
    type: 'deterministic',
    dependsOn: ['implement-setup-client'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
test -f packages/sdk-typescript/src/setup.ts
rg "class RelaycastSetup" packages/sdk-typescript/src/setup.ts
rg "class WorkspaceHandle" packages/sdk-typescript/src/setup.ts
rg "createWorkspace\\(" packages/sdk-typescript/src/setup.ts
rg "joinWorkspace\\(" packages/sdk-typescript/src/setup.ts
rg "lookupWorkspace\\(" packages/sdk-typescript/src/setup.ts
rg "registerAgent\\(" packages/sdk-typescript/src/setup.ts
rg "AgentNotRegisteredError" packages/sdk-typescript/src/setup.ts
rg "Retry-After" packages/sdk-typescript/src/setup.ts
rg "AbortSignal.timeout" packages/sdk-typescript/src/setup.ts
echo "setup.ts contract present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('wire-sdk-exports', {
    agent: 'setup-worker',
    dependsOn: ['verify-setup-client'],
    task: `Update packages/sdk-typescript/src/index.ts and package exports if needed.
Export RelaycastSetup, setup option/result types, and setup errors from the root index.
Export the communicate Relay and communicate types from the root index exactly as docs/sdk-setup-client.md shows.
Remove any existing root Relay alias that points to RelayCast so Relay names the communicate wrapper.
Expose the communicate Relay and communicate types through ./communicate as well.
Add or preserve the package.json ./communicate subpath without changing unrelated metadata.
Only edit index.ts and package.json in this step.

Accepted contract:
{{steps.lead-acceptance-contract.output}}`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('verify-sdk-exports', {
    type: 'deterministic',
    dependsOn: ['wire-sdk-exports'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
rg "RelaycastSetup" packages/sdk-typescript/src/index.ts
rg "setup-types" packages/sdk-typescript/src/index.ts
rg "setup-errors" packages/sdk-typescript/src/index.ts
rg "export \\{ Relay \\} from '\''\\./communicate/relay\\.js'\''" packages/sdk-typescript/src/index.ts
rg "MessageCallback" packages/sdk-typescript/src/index.ts
rg "RelayConfig" packages/sdk-typescript/src/index.ts
! rg "RelayCast as Relay" packages/sdk-typescript/src/index.ts
test -f packages/sdk-typescript/src/communicate/index.ts
rg "export \\{ Relay \\}" packages/sdk-typescript/src/communicate/index.ts
rg "MessageCallback" packages/sdk-typescript/src/communicate/index.ts
rg "\"\\./communicate\"" packages/sdk-typescript/package.json
echo "SDK export contract present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('write-setup-unit-tests', {
    agent: 'test-worker',
    dependsOn: ['verify-sdk-exports'],
    task: `Create packages/sdk-typescript/src/__tests__/setup.test.ts and packages/sdk-typescript/src/__tests__/communicate.test.ts.
Use vitest and vi.stubGlobal('fetch') like existing SDK tests.
Cover every spec path: createWorkspace, joinWorkspace, lookupWorkspace, local mode, custom baseUrl, apiKey function, timeout, retry, 429 Retry-After, malformed response, API error, registerAgent, duplicate handling, relay(), as(), relayCast(), getAgentToken(), listRegisteredAgents(), and exports.
In communicate.test.ts, cover post(), send(), reply(), inbox(), and onMessage() lazy connect/unsubscribe behavior.
Assert snake_case HTTP bodies and camelCase TypeScript results.
For lookup not found, follow the accepted contract from the lead step.
Do not edit source implementation files in this step.

Accepted contract:
{{steps.lead-acceptance-contract.output}}`,
    verification: { type: 'file_exists', value: 'packages/sdk-typescript/src/__tests__/setup.test.ts' },
  })
  .step('verify-setup-unit-tests', {
    type: 'deterministic',
    dependsOn: ['write-setup-unit-tests'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
test -f packages/sdk-typescript/src/__tests__/setup.test.ts
test -f packages/sdk-typescript/src/__tests__/communicate.test.ts
for token in "createWorkspace" "joinWorkspace" "lookupWorkspace" "registerAgent" "AgentNotRegisteredError" "RelaycastApiError" "MalformedApiResponseError" "Retry-After" "requestTimeoutMs" "local mode" "listRegisteredAgents"; do
  rg -F "$token" packages/sdk-typescript/src/__tests__/setup.test.ts >/dev/null || { echo "Missing setup unit coverage marker: $token"; exit 1; }
done
for token in "post()" "send()" "reply()" "inbox()" "onMessage()" "connect"; do
  rg -F "$token" packages/sdk-typescript/src/__tests__/communicate.test.ts >/dev/null || { echo "Missing communicate unit coverage marker: $token"; exit 1; }
done
echo "setup and communicate unit coverage markers present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('write-local-e2e-script', {
    agent: 'test-worker',
    dependsOn: ['verify-sdk-exports'],
    task: `Create scripts/e2e-sdk-setup-client.ts.
It must run against a real base URL argument, defaulting to http://localhost:8787.
Exercise createWorkspace, registerAgent Alice and Bob, workspace.as(), relayCast(), relay(), send, post, onMessage, joinWorkspace, lookupWorkspace, local mode, and persisted workspace id/key files in a temp directory.
Use real SDK imports from packages/sdk-typescript/src/index.js.
Fail with clear errors when a setup path does not work.
Do not edit existing scripts/e2e.ts in this step.`,
    verification: { type: 'file_exists', value: 'scripts/e2e-sdk-setup-client.ts' },
  })
  .step('verify-local-e2e-script', {
    type: 'deterministic',
    dependsOn: ['write-local-e2e-script'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
test -f scripts/e2e-sdk-setup-client.ts
for token in "RelaycastSetup" "createWorkspace" "joinWorkspace" "lookupWorkspace" "registerAgent" ".as(" ".relay(" "relayCast()" "onMessage" "mkdtemp"; do
  rg -F "$token" scripts/e2e-sdk-setup-client.ts >/dev/null || { echo "Missing E2E coverage marker: $token"; exit 1; }
done
echo "e2e setup script coverage markers present"
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('run-setup-tests-initial', {
    type: 'deterministic',
    dependsOn: ['verify-setup-unit-tests', 'verify-local-e2e-script'],
    command: String.raw`/bin/bash -lc '
set -o pipefail
npm --workspace @relaycast/sdk run test -- src/__tests__/setup.test.ts src/__tests__/communicate.test.ts 2>&1 | tail -120
'`,
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-setup-tests', {
    agent: 'test-worker',
    dependsOn: ['run-setup-tests-initial'],
    task: `Fix failures from the setup unit test run.
Output:
{{steps.run-setup-tests-initial.output}}

If all tests already passed, make no changes.
If tests failed, inspect the failing source and test files, fix the smallest correct issue, and rerun:
npm --workspace @relaycast/sdk run test -- src/__tests__/setup.test.ts src/__tests__/communicate.test.ts
Keep looping locally until the setup tests pass.
Do not skip or weaken spec coverage.`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('run-setup-tests-final', {
    type: 'deterministic',
    dependsOn: ['fix-setup-tests'],
    command: 'npm --workspace @relaycast/sdk run test -- src/__tests__/setup.test.ts src/__tests__/communicate.test.ts',
    captureOutput: true,
    failOnError: true,
  })

  .step('run-sdk-build-initial', {
    type: 'deterministic',
    dependsOn: ['run-setup-tests-final'],
    command: String.raw`/bin/bash -lc '
set -o pipefail
npm --workspace @relaycast/types run build && npm --workspace @relaycast/sdk run build 2>&1 | tail -120
'`,
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-sdk-build', {
    agent: 'setup-worker',
    dependsOn: ['run-sdk-build-initial'],
    task: `Fix TypeScript or packaging failures from the SDK build.
Output:
{{steps.run-sdk-build-initial.output}}

If the build already passed, make no changes.
If it failed, fix source types rather than weakening strictness.
Rerun:
npm --workspace @relaycast/types run build
npm --workspace @relaycast/sdk run build`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('run-sdk-build-final', {
    type: 'deterministic',
    dependsOn: ['fix-sdk-build'],
    command: 'npm --workspace @relaycast/types run build && npm --workspace @relaycast/sdk run build',
    captureOutput: true,
    failOnError: true,
  })

  .step('run-sdk-regression-initial', {
    type: 'deterministic',
    dependsOn: ['run-sdk-build-final'],
    command: String.raw`/bin/bash -lc '
set -o pipefail
npm --workspace @relaycast/sdk test 2>&1 | tail -160
'`,
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-sdk-regressions', {
    agent: 'setup-worker',
    dependsOn: ['run-sdk-regression-initial'],
    task: `Fix regressions from the full SDK test suite.
Output:
{{steps.run-sdk-regression-initial.output}}

If all tests passed, make no changes.
If existing tests broke, preserve existing behavior and adapt the setup client around it.
Rerun npm --workspace @relaycast/sdk test until the full SDK suite is green.`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('run-sdk-regression-final', {
    type: 'deterministic',
    dependsOn: ['fix-sdk-regressions'],
    command: 'npm --workspace @relaycast/sdk test',
    captureOutput: true,
    failOnError: true,
  })

  .step('run-local-e2e-initial', {
    type: 'deterministic',
    dependsOn: ['run-sdk-regression-final'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
mkdir -p .relay
log=.relay/sdk-setup-client-server.log
rm -f "$log"
npm --workspace @relaycast/server run dev -- --port 8799 >"$log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
  wait "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
ready=0
for _ in {1..90}; do
  if curl -fsS http://127.0.0.1:8799/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Server did not become ready. Last log lines:"
  tail -120 "$log" || true
  exit 1
fi
npx tsx scripts/e2e-sdk-setup-client.ts http://127.0.0.1:8799 2>&1 | tail -200
'`,
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-local-e2e', {
    agent: 'test-worker',
    dependsOn: ['run-local-e2e-initial'],
    task: `Fix failures from the real local server E2E run.
Output:
{{steps.run-local-e2e-initial.output}}

This is the 100 percent gate. Do not replace it with mocks.
Fix source, tests, or the E2E script as needed, then rerun the same server-backed command.
The E2E must prove create, join, lookup, register, as(), relayCast(), relay(), channel post, DM send, onMessage, local mode, and persisted workspace paths.`,
    verification: { type: 'exit_code', value: '0' },
  })
  .step('run-local-e2e-final', {
    type: 'deterministic',
    dependsOn: ['fix-local-e2e'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
mkdir -p .relay
log=.relay/sdk-setup-client-server-final.log
rm -f "$log"
npm --workspace @relaycast/server run dev -- --port 8799 >"$log" 2>&1 &
server_pid=$!
cleanup() {
  kill "$server_pid" >/dev/null 2>&1 || true
  wait "$server_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
ready=0
for _ in {1..90}; do
  if curl -fsS http://127.0.0.1:8799/health >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Server did not become ready. Last log lines:"
  tail -120 "$log" || true
  exit 1
fi
npx tsx scripts/e2e-sdk-setup-client.ts http://127.0.0.1:8799
'`,
    captureOutput: true,
    failOnError: true,
  })

  .step('run-focused-server-regressions', {
    type: 'deterministic',
    dependsOn: ['run-local-e2e-final'],
    command: 'npm --workspace @relaycast/server run test -- src/routes/__tests__/workspace.test.ts src/routes/__tests__/agent.test.ts src/routes/__tests__/message.test.ts src/routes/__tests__/dm.test.ts',
    captureOutput: true,
    failOnError: true,
  })
  .step('run-monorepo-regression-final', {
    type: 'deterministic',
    dependsOn: ['run-focused-server-regressions'],
    command: 'npx turbo test --filter=@relaycast/sdk --filter=@relaycast/server',
    captureOutput: true,
    failOnError: true,
  })

  .step('audit-spec-coverage-initial', {
    type: 'deterministic',
    dependsOn: ['run-monorepo-regression-final'],
    command: specCoverageAuditCommand,
    captureOutput: true,
    failOnError: false,
  })
  .step('fix-spec-coverage', {
    agent: 'reviewer',
    dependsOn: ['audit-spec-coverage-initial'],
    task: `Close any remaining spec coverage gaps from the deterministic audit.

Audit output:
{{steps.audit-spec-coverage-initial.output}}

If the audit output contains APPROVED, make no changes.
If it contains CHANGES_REQUIRED, fix the exact files named by the audit.
Preserve the green tests and local E2E behavior; do not weaken coverage markers.
After edits, rerun the audit command embedded in workflows/sdk-setup-client-80-100.ts and then rerun any affected focused tests.`,
    verification: { type: 'exit_code', value: '0' },
    retries: 1,
  })
  .step('review-spec-coverage', {
    type: 'deterministic',
    dependsOn: ['fix-spec-coverage'],
    command: specCoverageAuditCommand,
    captureOutput: true,
    failOnError: true,
    verification: { type: 'output_contains', value: 'APPROVED' },
    retries: 1,
  })
  .step('final-diff-and-status', {
    type: 'deterministic',
    dependsOn: ['review-spec-coverage'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
git status --short
git diff --stat
git diff --check
'`,
    captureOutput: true,
    failOnError: true,
  })
  .step('commit-after-green', {
    type: 'deterministic',
    dependsOn: ['final-diff-and-status'],
    command: String.raw`/bin/bash -lc '
set -euo pipefail
git add \
  docs/sdk-setup-client-acceptance.md \
  packages/sdk-typescript/src/setup.ts \
  packages/sdk-typescript/src/setup-types.ts \
  packages/sdk-typescript/src/setup-errors.ts \
  packages/sdk-typescript/src/communicate \
  packages/sdk-typescript/src/index.ts \
  packages/sdk-typescript/package.json \
  packages/sdk-typescript/src/__tests__/setup.test.ts \
  packages/sdk-typescript/src/__tests__/communicate.test.ts \
  scripts/e2e-sdk-setup-client.ts
git commit -m "feat(sdk): add setup client"
'`,
    captureOutput: true,
    failOnError: true,
  })
  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd(), dryRun });

  if ('valid' in result) {
    console.log('Workflow dry-run valid:', result.valid);
    return;
  }

  console.log('Workflow status:', result.status);
}

runWorkflow().catch((error) => {
  console.error(error);
  process.exit(1);
});

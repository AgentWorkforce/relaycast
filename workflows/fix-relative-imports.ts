/**
 * fix-relative-imports.ts
 *
 * Replace all relative path imports to external repos (relayauth/, relayfile/)
 * with npm package imports (@relayauth/core, @relayauth/sdk, @relayauth/server).
 * Covers source files AND test files.
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/fix-relative-imports.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
const result = await workflow('fix-relative-imports')
  .description('Replace all relative path imports to external repos with npm package imports')
  .pattern('dag')
  .channel('wf-fix-imports')
  .maxConcurrency(3)
  .timeout(1_800_000)

  .agent('src-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Fixes relative imports in relayauth source files',
    cwd: CLOUD,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Fixes relative imports in test files',
    cwd: CLOUD,
  })

  .step('read-broken-imports', {
    type: 'deterministic',
    command: `echo "=== SOURCE ===" && grep -rn "from.*\\.\\./\\.\\./\\.\\./\\.\\./\\|from.*relayauth/packages" ${CLOUD}/packages/relayauth/src/ --include="*.ts" 2>/dev/null | grep -v node_modules | grep -v __tests__ && echo "" && echo "=== TESTS ===" && grep -rn "from.*\\.\\./\\.\\./\\.\\./\\.\\./\\|from.*relayauth/packages" ${CLOUD}/packages/relayauth/src/__tests__/ --include="*.ts" 2>/dev/null | grep -v node_modules`,
    captureOutput: true,
  })

  .step('read-npm-exports', {
    type: 'deterministic',
    command: `echo "=== @relayauth/core ===" && cat /Users/khaliqgant/Projects/AgentWorkforce/relayauth/packages/core/src/index.ts && echo "" && echo "=== @relayauth/sdk ===" && head -30 /Users/khaliqgant/Projects/AgentWorkforce/relayauth/packages/sdk/src/index.ts && echo "" && echo "=== @relayauth/types ===" && head -20 /Users/khaliqgant/Projects/AgentWorkforce/relayauth/packages/types/src/index.ts`,
    captureOutput: true,
  })

  .step('impl-fix-src', {
    agent: 'src-worker',
    dependsOn: ['read-broken-imports', 'read-npm-exports'],
    task: `Fix all relative path imports in cloud/packages/relayauth/src/ (non-test files).

BROKEN IMPORTS:
{{steps.read-broken-imports.output}}

NPM PACKAGE EXPORTS:
{{steps.read-npm-exports.output}}

For each file in ${CLOUD}/packages/relayauth/src/ that has a relative import
to the external relayauth repo (paths like ../../../../../relayauth/packages/...):

Replace with the correct npm package import:

- ../../../../../relayauth/packages/server/dist/middleware/scope.js
  → import { requireScope, requireScopes } from '@relayauth/server'
  (once @relayauth/server is published; for now use @relayauth/core if the
  export exists there, otherwise keep a TODO comment)

- ../../../../../relayauth/packages/server/dist/durable-objects/...
  → import { IdentityDO } from '@relayauth/server'

- ../../../../../relayauth/packages/server/dist/lib/auth.js
  → import { verifyToken } from '@relayauth/core'

- ../../../../../relayauth/packages/server/dist/engine/...
  → These are server internals. If they exist in @relayauth/core, import
  from there. If not, the files need to stay as local source (not imports).

If a file is just a one-line re-export like:
  export * from "../../../../../relayauth/packages/server/dist/..."
And the export is available from an npm package, replace the entire file
with the npm import.

If the export is NOT in any npm package yet (server-side code like routes,
engine modules), leave a TODO comment:
  // TODO: import from @relayauth/server once published

Also ensure ${CLOUD}/packages/relayauth/package.json has the npm packages
as dependencies (not file: references):
  "@relayauth/core": "^0.1.2",
  "@relayauth/sdk": "^0.1.2",
  "@relayauth/types": "^0.1.2"

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-fix-tests', {
    agent: 'test-worker',
    dependsOn: ['read-broken-imports', 'read-npm-exports'],
    task: `Fix all relative path imports in cloud/packages/relayauth/src/__tests__/.

BROKEN IMPORTS:
{{steps.read-broken-imports.output}}

NPM PACKAGE EXPORTS:
{{steps.read-npm-exports.output}}

Test files have imports like:
  import { ScopeChecker } from "../../../../sdk/src/scopes.js"
  import { RelayAuthAdapter } from "../../../../ai/src/adapter.js"
  import { TokenVerifier } from "../../../../sdk/src/verify.js"
  import { generateScopes } from "../../../../sdk/src/openapi-scopes.js"

Replace with npm package imports:
  import { ScopeChecker } from '@relayauth/sdk'
  import { TokenVerifier } from '@relayauth/sdk'

For RelayAuthAdapter (from packages/ai):
  Check if it's exported from @relayauth/sdk. If not, add it as a
  devDependency or skip the test for now with a TODO.

For generateScopes / openapi-scopes:
  Check if exported from @relayauth/sdk. If not, TODO comment.

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-fix-src', 'impl-fix-tests'],
    command: `echo "=== REMAINING RELATIVE IMPORTS ===" && grep -rn "from.*\\.\\./\\.\\./\\.\\./\\.\\./\\|from.*relayauth/packages/server" ${CLOUD}/packages/relayauth/src/ --include="*.ts" 2>/dev/null | grep -v node_modules | wc -l && echo "lines with external relative imports" && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'src-worker',
    dependsOn: ['verify'],
    task: `Fix any remaining issues.

VERIFY:
{{steps.verify.output}}

If relative imports remain or build fails, fix them.
cd ${CLOUD} && npx tsc --noEmit

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nFix Relative Imports: ${result.status}`);
}

main().catch(console.error);

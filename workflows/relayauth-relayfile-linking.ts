/**
 * relayauth-relayfile-linking.ts
 *
 * Link relayauth and relayfile in cloud so that:
 * 1. Relayfile validates agent tokens using shared secret with relayauth
 * 2. Workflow YAML supports per-agent permissions (ignored/readonly)
 * 3. Permissions flow: workflow config → relayauth scopes → relayfile ACLs
 * 4. Integration tests for the full flow
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/relayauth-relayfile-linking.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';

async function main() {
const result = await workflow('relayauth-relayfile-linking')
  .description('Link relayauth and relayfile — shared secret validation, workflow permissions, integration tests')
  .pattern('dag')
  .channel('wf-auth-file-link')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('secret-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Configures shared secret between relayauth and relayfile workers',
    cwd: CLOUD,
  })
  .agent('permissions-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Adds per-agent permissions support to workflow YAML schema and SDK',
    cwd: CLOUD,
  })
  .agent('flow-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Implements the permissions flow from workflow config to ACLs',
    cwd: CLOUD,
  })
  .agent('test-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Writes integration tests for the relayauth-relayfile flow',
    cwd: CLOUD,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-relayauth-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/relayauth.ts | head -80`,
    captureOutput: true,
  })

  .step('read-relayfile-infra', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/relayfile.ts | head -120`,
    captureOutput: true,
  })

  .step('read-infra-secrets', {
    type: 'deterministic',
    command: `cat ${CLOUD}/infra/secrets.ts`,
    captureOutput: true,
  })

  .step('read-workflow-types', {
    type: 'deterministic',
    command: `grep -rn "agents\|WorkflowAgent\|AgentConfig\|permissions\|scopes" ${CLOUD}/packages/core/src/types/ 2>/dev/null | head -20 || grep -rn "agents\|WorkflowAgent\|AgentConfig" /Users/khaliqgant/Projects/AgentWorkforce/relay/packages/sdk/src/workflows/types.ts | head -20`,
    captureOutput: true,
  })

  .step('read-script-generator', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/script-generator.ts | head -80`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Four codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-shared-secret', {
    agent: 'secret-worker',
    dependsOn: ['read-relayauth-infra', 'read-relayfile-infra', 'read-infra-secrets'],
    task: `Configure shared signing secret between relayauth and relayfile workers.

RELAYAUTH SST MODULE:
{{steps.read-relayauth-infra.output}}

RELAYFILE SST MODULE:
{{steps.read-relayfile-infra.output}}

INFRA SECRETS:
{{steps.read-infra-secrets.output}}

Both workers need the same JWT signing secret so that tokens issued
by relayauth (or minted by the orchestrator) are valid for relayfile.

1. In ${CLOUD}/infra/secrets.ts:
   - Ensure there's a single shared secret:
     export const RelayJwtSecret = new sst.Secret("RelayJwtSecret");
   - This replaces both RelayfileJwtSecret and any separate relayauth secret
   - Both workers use this same secret for token signing/verification

2. In ${CLOUD}/infra/relayauth.ts and ${CLOUD}/infra/relayfile.ts:
   - Bind RelayJwtSecret into both workers
   - Relayauth uses it as SIGNING_KEY
   - Relayfile uses it as RELAYFILE_JWT_SECRET

3. Keep the same shared secret name across the SST worker bindings for both services.

4. Update ${CLOUD}/packages/core/src/bootstrap/launcher.ts:
   - Use RelayJwtSecret instead of relayfileJwtSecret
   - The same secret signs tokens for both services

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-workflow-permissions', {
    agent: 'permissions-worker',
    dependsOn: ['read-workflow-types'],
    task: `Add per-agent permissions support to the workflow YAML schema.

WORKFLOW TYPES:
{{steps.read-workflow-types.output}}

Users should be able to define permissions per agent in their workflow YAML:

workflows:
  - name: my-workflow
    agents:
      - name: code-agent
        cli: codex
        permissions:
          ignored:
            - secrets/
            - .env
            - "**/*.pem"
          readonly:
            - README.md
            - LICENSE
            - package.json
      - name: review-agent
        cli: claude
        permissions:
          readonly: ["*"]  # everything is read-only for reviewer

The system can also set permissions. For example, certain files
should always be read-only for all agents (like .github/workflows/).

Find the workflow/agent type definitions and add:

interface AgentPermissions {
  ignored?: string[];     // files invisible to this agent
  readonly?: string[];    // files read-only for this agent
}

Add 'permissions?: AgentPermissions' to the agent config type.

Look in:
- /Users/khaliqgant/Projects/AgentWorkforce/relay/packages/sdk/src/workflows/types.ts
  (if that's where the shared types are)
- ${CLOUD}/packages/core/src/ for cloud-specific types

If the types are in the relay SDK, create a cloud-side extension type.
The relay SDK types should be updated in a separate PR to the relay repo.

For now, create the type in: ${CLOUD}/packages/core/src/types/permissions.ts

export interface AgentPermissions {
  ignored?: string[];
  readonly?: string[];
}

export interface SystemPermissions {
  // Always applied to all agents regardless of workflow config
  alwaysReadonly: string[];
  alwaysIgnored: string[];
}

export const DEFAULT_SYSTEM_PERMISSIONS: SystemPermissions = {
  alwaysReadonly: [
    '.github/workflows/**',
    'Dockerfile',
    'docker-compose*.yml',
  ],
  alwaysIgnored: [
    '.env',
    '.env.*',
    '**/*.pem',
    '**/*.key',
    '**/credentials*',
  ],
};

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-permissions-flow', {
    agent: 'flow-worker',
    dependsOn: ['read-script-generator', 'read-infra-secrets'],
    task: `Implement the permissions flow from workflow config to relayfile ACLs.

SCRIPT GENERATOR:
{{steps.read-script-generator.output}}

INFRA SECRETS:
{{steps.read-infra-secrets.output}}

Create ${CLOUD}/packages/core/src/permissions/compiler.ts:

This module takes agent permissions (from workflow YAML) and system
permissions (defaults) and produces:
1. Per-agent token scopes (for mintScopedRelayfileToken)
2. ACL rules (for seeding into relayfile workspace)

import { AgentPermissions, SystemPermissions, DEFAULT_SYSTEM_PERMISSIONS } from '../types/permissions.js';

interface CompiledAgentPermissions {
  agentName: string;
  scopes: string[];
  aclRules: Record<string, string[]>;  // dir → rules for .relayfile.acl
}

export function compileAgentPermissions(
  agentName: string,
  agentPerms: AgentPermissions,
  systemPerms: SystemPermissions = DEFAULT_SYSTEM_PERMISSIONS,
): CompiledAgentPermissions {
  // Merge agent + system permissions
  const ignored = [
    ...(agentPerms.ignored ?? []),
    ...systemPerms.alwaysIgnored,
  ];
  const readonly = [
    ...(agentPerms.readonly ?? []),
    ...systemPerms.alwaysReadonly,
  ];

  // Generate scopes
  // If no ignored/readonly, grant full access
  // If patterns specified, use wildcard scopes + ACL enforcement
  const scopes = ['relayfile:fs:read:*'];
  if (readonly.length === 0 || !readonly.includes('*')) {
    scopes.push('relayfile:fs:write:*');
  }

  // Generate ACL rules
  const aclRules: Record<string, string[]> = {};
  for (const pattern of ignored) {
    // Convert glob to directory ACL
    const dir = pattern.endsWith('/') ? '/' + pattern.replace(/\/$/, '') : '/';
    if (!aclRules[dir]) aclRules[dir] = [];
    aclRules[dir].push('deny:agent:' + agentName);
  }

  return { agentName, scopes, aclRules };
}

Also create ${CLOUD}/packages/core/src/permissions/seeder.ts:

export async function seedAgentPermissions(
  relayfileUrl: string,
  workspaceId: string,
  token: string,
  compiledPermissions: CompiledAgentPermissions[],
): Promise<void> {
  // Merge ACL rules from all agents
  // POST to /v1/workspaces/{ws}/fs/bulk with .relayfile.acl files
  // Same logic as relayauth/packages/core/src/acl.ts seedAclEntries
}

Update ${CLOUD}/packages/core/src/bootstrap/script-generator.ts:
- When generating the bootstrap script, include RELAY_AGENT_TOKENS
  env var so the sandbox can distribute per-agent tokens

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-integration-tests', {
    agent: 'test-worker',
    dependsOn: ['read-infra-secrets'],
    task: `Write integration tests for the relayauth-relayfile flow.

Create ${CLOUD}/tests/relayauth-relayfile-integration.test.ts:

Tests (can mock HTTP):

1. TestMintScopedToken
   - Mint token with specific scopes
   - Decode and verify claims contain agent_name, workspace_id, scopes
   - Verify scopes match input

2. TestCompileAgentPermissions
   - Input: ignored=['.env', 'secrets/'], readonly=['README.md']
   - Verify: scopes include read:* and write:*
   - Verify: ACL rules have deny:agent for secrets/

3. TestSystemPermissionsApplied
   - Input: no agent permissions
   - Verify: DEFAULT_SYSTEM_PERMISSIONS applied
   - .env always ignored, .github/workflows always readonly

4. TestPermissionsFlowEndToEnd
   - Compile permissions for two agents with different access
   - Verify: different scopes generated
   - Verify: ACL rules don't conflict

5. TestWorkflowYAMLWithPermissions
   - Parse a workflow YAML with agent permissions
   - Verify permissions field parsed into AgentPermissions type

Use vitest. Mock HTTP for relayfile API calls.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-shared-secret', 'impl-workflow-permissions', 'impl-permissions-flow', 'impl-integration-tests'],
    command: `echo "=== PERMISSIONS TYPE ===" && test -f ${CLOUD}/packages/core/src/types/permissions.ts && echo "EXISTS" || echo "MISSING" && echo "=== COMPILER ===" && test -f ${CLOUD}/packages/core/src/permissions/compiler.ts && echo "EXISTS" || echo "MISSING" && echo "=== SEEDER ===" && test -f ${CLOUD}/packages/core/src/permissions/seeder.ts && echo "EXISTS" || echo "MISSING" && echo "=== TESTS ===" && test -f ${CLOUD}/tests/relayauth-relayfile-integration.test.ts && echo "EXISTS" || echo "MISSING" && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'secret-worker',
    dependsOn: ['verify'],
    task: `Fix any build failures.

VERIFY:
{{steps.verify.output}}

Fix TypeScript errors. Then: cd ${CLOUD} && npx tsc --noEmit

IMPORTANT: Write fixes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: CLOUD,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\nRelayauth-Relayfile Linking: ${result.status}`);
}

main().catch(console.error);

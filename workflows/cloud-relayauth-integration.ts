/**
 * cloud-relayauth-integration.ts
 *
 * Wire relayauth into the cloud orchestration pipeline:
 * 1. Orchestrator provisions agent identities in relayauth during workflow launch
 * 2. Each agent gets scoped tokens (from workflow config or dotfiles)
 * 3. Relayfile validates tokens against shared secret with relayauth
 * 4. Agent provisioning API endpoint for programmatic access
 * 5. Remove Daytona volume fallback — relayfile is the only file layer
 *
 * Codex-only workers.
 *
 * Run: agent-relay run workflows/cloud-relayauth-integration.ts
 */

import { workflow } from '@relayflows/core';
import { Models } from '@agent-relay/sdk';

const CLOUD = '/Users/khaliqgant/Projects/AgentWorkforce/cloud';
const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';

async function main() {
const result = await workflow('cloud-relayauth-integration')
  .description('Wire relayauth identity + scoped tokens into cloud workflow orchestration')
  .pattern('dag')
  .channel('wf-cloud-relayauth')
  .maxConcurrency(4)
  .timeout(1_800_000)

  .agent('orchestrator-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Wires relayauth identity provisioning into the workflow launcher',
    cwd: CLOUD,
  })
  .agent('api-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Creates the agent provisioning API endpoint',
    cwd: CLOUD,
  })
  .agent('token-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Implements per-agent scoped token minting with workflow permissions',
    cwd: CLOUD,
  })
  .agent('cleanup-worker', {
    cli: 'codex',
    preset: 'worker',
    model: Models.Codex.GPT_5_4,
    role: 'Removes Daytona volume fallback, makes relayfile the only file layer',
    cwd: CLOUD,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-launcher', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/bootstrap/launcher.ts`,
    captureOutput: true,
  })

  .step('read-relay-file-access', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/relay-file-access.ts`,
    captureOutput: true,
  })

  .step('read-relay-agent-env', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/relay-agent-env.ts`,
    captureOutput: true,
  })

  .step('read-relayfile-client', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/core/src/relayfile/client.ts`,
    captureOutput: true,
  })

  .step('read-workflow-run-api', {
    type: 'deterministic',
    command: `cat ${CLOUD}/packages/web/app/api/v1/workflows/run/route.ts | head -100`,
    captureOutput: true,
  })

  .step('read-relayauth-scope-spec', {
    type: 'deterministic',
    command: `head -60 ${RELAYAUTH}/specs/scope-format.md`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Four codex workers in parallel
  // ═══════════════════════════════════════════════════════════════

  .step('impl-orchestrator', {
    agent: 'orchestrator-worker',
    dependsOn: ['read-launcher', 'read-relay-file-access', 'read-relay-agent-env'],
    task: `Wire relayauth identity provisioning into the workflow launcher.

CURRENT LAUNCHER:
{{steps.read-launcher.output}}

RELAY FILE ACCESS:
{{steps.read-relay-file-access.output}}

RELAY AGENT ENV:
{{steps.read-relay-agent-env.output}}

Edit ${CLOUD}/packages/core/src/bootstrap/launcher.ts:

Currently the launcher mints a GENERIC relayfile token (line 193):
  envVars.RELAYFILE_TOKEN = mintRelayfileToken('wf-' + runId, secret);

This gives every agent the same token with full access. Replace with
per-agent scoped tokens:

1. Add a new function provisionAgentAccess():

  async function provisionAgentAccess(config: {
    runId: string;
    relayfileUrl: string;
    relayfileJwtSecret: string;
    agents: Array<{ name: string; scopes?: string[]; permissions?: { ignored?: string[]; readonly?: string[] } }>;
  }): Promise<Map<string, { token: string; scopes: string[] }>> {
    const result = new Map();
    for (const agent of config.agents) {
      // Determine scopes from workflow config or defaults
      const scopes = agent.scopes ?? [
        'relayfile:fs:read:*',
        'relayfile:fs:write:*',
      ];

      // If permissions specified (from dotfiles or workflow yaml), restrict scopes
      if (agent.permissions?.ignored?.length) {
        // Remove read/write scopes for ignored paths
        // Add deny rules for ignored files
      }
      if (agent.permissions?.readonly?.length) {
        // Remove write scopes for readonly paths
      }

      // Mint scoped token
      const token = mintScopedRelayfileToken({
        workspaceId: 'wf-' + config.runId,
        agentName: agent.name,
        scopes,
        secret: config.relayfileJwtSecret,
      });

      result.set(agent.name, { token, scopes });
    }
    return result;
  }

2. Extract agent configs from the workflow YAML:

  The workflow config already has agent definitions. Parse their
  permissions:

  workflows:
    - name: my-workflow
      agents:
        - name: code-agent
          cli: codex
          permissions:           # NEW FIELD
            ignored:
              - secrets/
              - .env
            readonly:
              - README.md
              - LICENSE
        - name: review-agent
          cli: claude
          permissions:
            readonly: ['*']      # read-only access to everything

3. In launchOrchestratorSandbox():
  - Parse agent permissions from workflowConfig
  - Call provisionAgentAccess() to get per-agent tokens
  - Pass agent token map to the sandbox via env vars:
    envVars.RELAY_AGENT_TOKENS = JSON.stringify(Object.fromEntries(tokenMap));
  - The sandbox's workflow runner then gives each agent its specific token

4. Create mintScopedRelayfileToken() in the relayfile client:
  Like mintRelayfileToken() but with workspace_id, agent_name, and
  per-file scopes in the claims.

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-provisioning-api', {
    agent: 'api-worker',
    dependsOn: ['read-workflow-run-api', 'read-relayauth-scope-spec'],
    task: `Create the agent provisioning API endpoint.

WORKFLOW RUN API:
{{steps.read-workflow-run-api.output}}

SCOPE FORMAT:
{{steps.read-relayauth-scope-spec.output}}

Create ${CLOUD}/packages/web/app/api/v1/agents/provision/route.ts:

POST /api/v1/agents/provision

Request:
{
  "workspaceId": "wf-abc123",
  "agents": [
    {
      "name": "code-agent",
      "scopes": ["relayfile:fs:read:*", "relayfile:fs:write:/src/*"],
      "permissions": {
        "ignored": ["secrets/", ".env"],
        "readonly": ["README.md", "LICENSE"]
      }
    }
  ]
}

Response:
{
  "agents": [
    {
      "name": "code-agent",
      "token": "eyJ...",
      "scopes": ["relayfile:fs:read:/src/*", ...],
      "workspaceId": "wf-abc123"
    }
  ]
}

Implementation:
1. Validate request
2. For each agent: compute scopes from permissions (compile dotfile-style
   rules into relayauth scope format)
3. Mint JWT tokens with per-agent scopes
4. Create relayfile workspace if not exists
5. Seed ACL rules into workspace
6. Return tokens

Follow the same pattern as the workflows/run route.ts for auth,
error handling, and response format.

IMPORTANT: Write to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-scoped-tokens', {
    agent: 'token-worker',
    dependsOn: ['read-relayfile-client', 'read-relayauth-scope-spec'],
    task: `Implement per-agent scoped token minting with workflow permissions.

CURRENT TOKEN MINTING:
{{steps.read-relayfile-client.output}}

SCOPE FORMAT:
{{steps.read-relayauth-scope-spec.output}}

Edit ${CLOUD}/packages/core/src/relayfile/client.ts:

Current mintRelayfileToken() creates a generic token with workspace_id
and fixed scopes. Add a new function:

  export function mintScopedRelayfileToken(opts: {
    workspaceId: string;
    agentName: string;
    scopes: string[];
    secret: string;
    ttlSeconds?: number;
  }): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      workspace_id: opts.workspaceId,
      agent_name: opts.agentName,
      scopes: opts.scopes,
      aud: ['relayfile'],
      iat: now,
      exp: now + (opts.ttlSeconds ?? 3600),
      jti: 'tok-' + crypto.randomUUID(),
    };
    // Sign with HS256 using opts.secret
    return signJWT(payload, opts.secret);
  }

Also add a helper to compile permissions into scopes:

  export function compilePermissionsToScopes(
    permissions: { ignored?: string[]; readonly?: string[] },
    allFiles?: string[],
  ): string[] {
    // If no allFiles provided, use wildcard scopes minus exclusions
    // If allFiles provided, generate per-file scopes
    const scopes: string[] = [];

    if (!allFiles) {
      // Wildcard mode: grant everything, rely on ACLs for enforcement
      scopes.push('relayfile:fs:read:*');
      scopes.push('relayfile:fs:write:*');
      return scopes;
    }

    // Per-file mode: explicit scopes
    const ignoredSet = new Set(permissions.ignored ?? []);
    const readonlySet = new Set(permissions.readonly ?? []);

    for (const file of allFiles) {
      if (ignoredSet.has(file)) continue;
      scopes.push('relayfile:fs:read:/' + file);
      if (!readonlySet.has(file)) {
        scopes.push('relayfile:fs:write:/' + file);
      }
    }
    return scopes;
  }

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('impl-remove-daytona-volumes', {
    agent: 'cleanup-worker',
    dependsOn: ['read-launcher'],
    task: `Remove Daytona volume fallback — relayfile is the only file layer.

CURRENT LAUNCHER:
{{steps.read-launcher.output}}

Edit ${CLOUD}/packages/core/src/bootstrap/launcher.ts:

The launcher currently has a conditional path:
  if (useRelayfile) → use relayfile
  else → use Daytona VolumeManager

Changes:
1. Remove the VolumeManager import and usage
2. Remove the needsCodeVolume logic
3. Remove the codeVolume creation
4. Remove the legacy volume cleanup
5. Make relayfileUrl REQUIRED (not optional)
6. Remove the "legacy Daytona volume" warning

The launcher should ALWAYS use relayfile. If relayfileUrl is not set,
throw an error: "RELAYFILE_URL is required. Set it via sst secret set."

Keep the Daytona sandbox creation (that's the container runtime,
separate from the file volume). Only remove the VolumeManager usage.

Also clean up:
- Remove ${CLOUD}/packages/core/src/volumes/ directory if it exists
  and is only used for Daytona volumes
- Update any imports that reference VolumeManager

IMPORTANT: Write changes to disk. Do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['impl-orchestrator', 'impl-provisioning-api', 'impl-scoped-tokens', 'impl-remove-daytona-volumes'],
    command: `echo "=== PROVISIONING API ===" && test -f ${CLOUD}/packages/web/app/api/v1/agents/provision/route.ts && echo "EXISTS" || echo "MISSING" && echo "=== SCOPED TOKEN ===" && grep -c "mintScopedRelayfileToken\\|compilePermissionsToScopes" ${CLOUD}/packages/core/src/relayfile/client.ts && echo "=== DAYTONA REMOVED ===" && grep -c "VolumeManager" ${CLOUD}/packages/core/src/bootstrap/launcher.ts && echo "=== BUILD ===" && cd ${CLOUD} && npx tsc --noEmit 2>&1 | tail -10; echo "BUILD: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-build', {
    agent: 'orchestrator-worker',
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

console.log(`\nCloud Relayauth Integration: ${result.status}`);
}

main().catch(console.error);

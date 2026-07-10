import {
  createGitHubInvestigator,
  createGitHubLibrarian,
  type GitHubApiFallback,
  type GitHubCapabilityParams,
  type GitHubLibrarianOptions,
} from '@agent-assistant/specialists';
import {
  createOpenRouterModelAdapter,
  type HarnessModelAdapter,
} from '@agent-assistant/harness';

import type { RelayFileClient } from '@relayfile/sdk';

import { OPENROUTER_MODELS } from './openrouter.js';
import { createRelayFileVfsProvider } from './relayfile-vfs-provider.js';
import { RelayFileWorkspaceReader } from './relayfile-workspace-reader.js';
import { createWorkspaceToolRegistry } from './workspace-tool-registry.js';

import {
  createAgenticSpecialist,
  type AgenticSpecialist,
} from './agentic-specialist.js';
import type { A2AAgentCard } from './agent-card.js';
import { GITHUB_SPECIALIST_PROMPT } from './specialist-prompts.js';
import {
  composeToolRegistries,
  createGitHubEnumerateTool,
  createGitHubInvestigateTool,
} from './tool-adapters.js';
import { wrapToolRegistryWithTrace } from './tool-registry-trace.js';

const SPECIALIST_AGENT_NAME = 'sage-github-specialist';
const SPECIALIST_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 45_000;

type GitHubLibrarianApiFallback = GitHubLibrarianOptions['apiFallback'];

export interface GitHubAgenticSpecialistOptions {
  relayFile: RelayFileClient;
  workspaceId: string;
  /** OpenRouter API key. */
  apiKey: string;
  /** Defaults to OPENROUTER_MODELS.heavy. */
  model?: string;
  /** Optional live GitHub API fallback. Omit or pass null for VFS-only operation. */
  githubApiFallback?: GitHubApiFallback | null;
  /** Optional live GitHub enumeration fallback. Omit or pass null for VFS-only operation. */
  githubLibrarianApiFallback?: GitHubLibrarianApiFallback | null;
  /** Injectable fetch for tests and alternate runtimes. */
  fetchImpl?: typeof fetch;
  /** Defaults to 45 seconds. */
  timeoutMs?: number;
  /** Forward the `DEBUG_SPECIALIST` binding for diagnostic logging. */
  debugSpecialist?: string;
}

export function buildGitHubSpecialistCard(baseUrl = ''): A2AAgentCard {
  return {
    name: SPECIALIST_AGENT_NAME,
    description:
      'GitHub Investigation Specialist for Sage. Investigates PRs, enumerates GitHub entities, and returns structured findings.',
    url: baseUrl,
    version: SPECIALIST_VERSION,
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      {
        id: 'pr_investigation',
        name: 'PR Investigation',
        description:
          'Investigate a pull request and return structured evidence with risk areas and review concerns.',
      },
      {
        id: 'github.enumerate',
        name: 'GitHub Enumeration',
        description:
          'Enumerate GitHub entities matching a query and return structured findings with metadata.',
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}

export function createGitHubAgenticSpecialist(
  options: GitHubAgenticSpecialistOptions,
): AgenticSpecialist<GitHubCapabilityParams> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reader = new RelayFileWorkspaceReader({
    client: options.relayFile,
    workspaceId: options.workspaceId,
  });
  const vfs = createRelayFileVfsProvider(reader);

  const investigator = options.githubApiFallback
    ? createGitHubInvestigator({
        vfs,
        apiFallback: options.githubApiFallback,
      })
    : createGitHubInvestigator({ vfs });

  // RelayFile VFS exposes enumerate for filter-bearing queries that need properties.
  const librarian = options.githubLibrarianApiFallback
    ? createGitHubLibrarian({
        vfs,
        apiFallback: options.githubLibrarianApiFallback,
      })
    : createGitHubLibrarian({ vfs });

  const tools = wrapToolRegistryWithTrace(
    composeToolRegistries(
      createWorkspaceToolRegistry({ reader }),
      createGitHubEnumerateTool(librarian),
      createGitHubInvestigateTool(investigator),
    ),
    SPECIALIST_AGENT_NAME,
  );

  const model: HarnessModelAdapter = createOpenRouterModelAdapter({
    apiKey: options.apiKey,
    model: options.model ?? OPENROUTER_MODELS.heavy,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });

  return createAgenticSpecialist<GitHubCapabilityParams>({
    name: SPECIALIST_AGENT_NAME,
    version: SPECIALIST_VERSION,
    card: buildGitHubSpecialistCard(),
    systemPrompt: GITHUB_SPECIALIST_PROMPT,
    tools,
    model,
    timeoutMs,
    ...(options.debugSpecialist ? { debugSpecialist: options.debugSpecialist } : {}),
  });
}

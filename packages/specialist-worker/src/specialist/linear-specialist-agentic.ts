import {
  createLinearLibrarian,
  type LinearEnumerationParams,
  type LinearLibrarianOptions,
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

import type { A2AAgentCard } from './agent-card.js';
import {
  createAgenticSpecialist,
  type AgenticSpecialist,
} from './agentic-specialist.js';
import { LINEAR_SPECIALIST_PROMPT } from './specialist-prompts.js';
import {
  composeToolRegistries,
  createLinearEnumerateTool,
} from './tool-adapters.js';
import { wrapToolRegistryWithTrace } from './tool-registry-trace.js';

const SPECIALIST_AGENT_NAME = 'sage-linear-specialist';
const SPECIALIST_VERSION = '1.0.0';
const DEFAULT_TIMEOUT_MS = 45_000;

type LinearLibrarianApiFallback =
  NonNullable<LinearLibrarianOptions['apiFallback']>;

export interface LinearAgenticSpecialistOptions {
  relayFile: RelayFileClient;
  workspaceId: string;
  /** OpenRouter API key. */
  apiKey: string;
  /** Defaults to OPENROUTER_MODELS.heavy. */
  model?: string;
  /** Optional live Linear enumeration fallback. Omit or pass null for VFS-only operation. */
  linearLibrarianApiFallback?: LinearLibrarianApiFallback | null;
  /** Injectable fetch for tests and alternate runtimes. */
  fetchImpl?: typeof fetch;
  /** Defaults to 45 seconds. */
  timeoutMs?: number;
  /** Forward the `DEBUG_SPECIALIST` binding for diagnostic logging. */
  debugSpecialist?: string;
}

export function buildLinearSpecialistCard(): A2AAgentCard {
  return {
    name: 'sage-linear-specialist',
    description:
      'Linear specialist for Sage. Enumerates issues, projects, comments, and synthesizes status across teams.',
    version: '1.0.0',
    url: '',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      {
        id: 'linear.enumerate',
        name: 'Linear Enumeration',
        description:
          'Enumerate Linear entities matching a query and return structured findings.',
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}

export function createLinearAgenticSpecialist(
  options: LinearAgenticSpecialistOptions,
): AgenticSpecialist<LinearEnumerationParams> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reader = new RelayFileWorkspaceReader({
    client: options.relayFile,
    workspaceId: options.workspaceId,
  });
  const vfs = createRelayFileVfsProvider(reader);
  // RelayFile VFS exposes enumerate for filter-bearing queries that need properties.
  const librarian = options.linearLibrarianApiFallback
    ? createLinearLibrarian({
        vfs,
        apiFallback: options.linearLibrarianApiFallback,
      })
    : createLinearLibrarian({ vfs });
  const workspaceTools = createWorkspaceToolRegistry({ reader });

  const tools = wrapToolRegistryWithTrace(
    composeToolRegistries(
      workspaceTools,
      createLinearEnumerateTool(librarian),
    ),
    SPECIALIST_AGENT_NAME,
  );

  const model: HarnessModelAdapter = createOpenRouterModelAdapter({
    apiKey: options.apiKey,
    model: options.model ?? OPENROUTER_MODELS.heavy,
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });

  return createAgenticSpecialist<LinearEnumerationParams>({
    name: SPECIALIST_AGENT_NAME,
    version: SPECIALIST_VERSION,
    card: buildLinearSpecialistCard(),
    systemPrompt: LINEAR_SPECIALIST_PROMPT,
    tools,
    model,
    timeoutMs,
    ...(options.debugSpecialist ? { debugSpecialist: options.debugSpecialist } : {}),
  });
}

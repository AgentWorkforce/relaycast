import type { AgentCli, AgentPreset } from '@relayflows/core';

export interface PresetFlags {
  args: string[];
  env?: Record<string, string>;
}

export interface BuildAgentCommandResult {
  command: string;
  env?: Record<string, string>;
}

export function getPresetFlags(cli: AgentCli, preset: AgentPreset): PresetFlags {
  const key = `${cli}:${preset}`;

  switch (key) {
    // Interactive lead: keep PTY + relay access (no extra flags/env)
    case 'claude:lead':
      return { args: [] };

    // Claude non-interactive roles use print mode + relay disabled.
    // SDK's buildNonInteractiveCommand already adds -p/--dangerously-skip-permissions.
    case 'claude:worker':
      return { args: [], env: { DISABLE_RELAY: '1' } };
    case 'claude:reviewer':
      return { args: [], env: { DISABLE_RELAY: '1' } };
    case 'claude:analyst':
      return { args: [], env: { DISABLE_RELAY: '1' } };

    // Codex non-interactive role presets — no extra args (codex exec has no --quiet flag)
    case 'codex:worker':
      return { args: [], env: { DISABLE_RELAY: '1' } };
    case 'codex:reviewer':
      return { args: [], env: { DISABLE_RELAY: '1' } };
    case 'codex:analyst':
      return { args: [], env: { DISABLE_RELAY: '1' } };

    default:
      return { args: [] };
  }
}

export async function buildAgentCommand(
  cli: AgentCli,
  preset: AgentPreset,
  task: string,
  _agentName?: string,
  model?: string
): Promise<BuildAgentCommandResult> {
  const presetFlags = getPresetFlags(cli, preset);
  const extraArgs = [...presetFlags.args];
  if (model) {
    extraArgs.push('--model', model);
  }
  const { WorkflowRunner } = await import('@relayflows/core');
  const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand(cli, task, extraArgs);
  const escaped = [cmd, ...args].map(shellEscape).join(' ');

  return {
    command: escaped,
    env: presetFlags.env,
  };
}

/** Escape a shell arg for safe command composition */
function shellEscape(arg: string): string {
  if (/^[a-zA-Z0-9._\-/=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

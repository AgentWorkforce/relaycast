#!/usr/bin/env node

import { Command } from 'commander';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { registerAgentCommands } from './commands/agent.js';
import { registerConfigCommands } from './commands/config.js';
import { registerChannelCommands } from './commands/channel.js';
import { registerMessagingCommands } from './commands/messaging.js';
import { registerReadCommands } from './commands/read.js';
import { registerSearchCommands } from './commands/search.js';
import { registerReactionCommands } from './commands/reactions.js';
import { registerFileCommands } from './commands/files.js';
import { registerBillingCommands } from './commands/billing.js';
import { registerOpenClawCommands } from './commands/openclaw.js';
import { registerTelemetryCommands } from './commands/telemetry.js';
import { createCliTelemetry } from './telemetry.js';

export const CLI_VERSION = '0.1.2' as const;

const program = new Command();
const telemetry = createCliTelemetry(CLI_VERSION);
let activeCommandPath: string | null = null;
let activeCommandStartedAt = 0;

function getCommandPath(command: Command): string {
  const names: string[] = [];
  let current: Command | null = command;

  while (current && current.parent) {
    const name = current.name();
    if (name) names.unshift(name);
    current = current.parent;
  }

  return names.join(' ');
}

function captureDerivedEvents(commandPath: string, args: readonly unknown[]): void {
  if (commandPath === 'workspace create') {
    telemetry.capture('relaycast_workspace_created', { source_surface: 'cli' });
    return;
  }

  if (commandPath === 'send') {
    const target = typeof args[0] === 'string' ? args[0] : '';
    telemetry.capture('relaycast_message_sent', {
      source_surface: 'cli',
      message_kind: target.startsWith('@') ? 'dm' : 'channel',
      command: commandPath,
    });
    return;
  }

  if (commandPath === 'reply') {
    telemetry.capture('relaycast_message_sent', {
      source_surface: 'cli',
      message_kind: 'thread_reply',
      command: commandPath,
    });
    return;
  }

  if (commandPath === 'group-dm') {
    const participants = Array.isArray(args[0]) ? args[0].length : undefined;
    telemetry.capture('relaycast_message_sent', {
      source_surface: 'cli',
      message_kind: 'group_dm',
      participants_count: participants,
      command: commandPath,
    });
    return;
  }

  if (commandPath === 'inbox') {
    telemetry.capture('relaycast_inbox_checked', { source_surface: 'cli' });
    return;
  }

  if (commandPath === 'agent register') {
    telemetry.capture('relaycast_agent_registered', { source_surface: 'cli' });
  }
}

program
  .name('relaycast')
  .description('Relaycast — agent-to-agent messaging CLI')
  .version(CLI_VERSION);

registerWorkspaceCommands(program);
registerAgentCommands(program);
registerConfigCommands(program);
registerChannelCommands(program);
registerMessagingCommands(program);
registerReadCommands(program);
registerSearchCommands(program);
registerReactionCommands(program);
registerFileCommands(program);
registerBillingCommands(program);
registerOpenClawCommands(program);
registerTelemetryCommands(program, telemetry);

program.hook('preAction', (_thisCommand, actionCommand) => {
  const commandPath = getCommandPath(actionCommand);
  if (!commandPath) return;

  activeCommandPath = commandPath;
  activeCommandStartedAt = Date.now();
});

program.hook('postAction', async (_thisCommand, actionCommand) => {
  const commandPath = getCommandPath(actionCommand);
  if (!commandPath) return;

  const durationMs = Math.max(Date.now() - activeCommandStartedAt, 0);

  telemetry.capture('relaycast_cli_command_completed', {
    command: commandPath,
    duration_ms: durationMs,
    source_surface: 'cli',
  });
  captureDerivedEvents(commandPath, actionCommand.processedArgs);

  activeCommandPath = null;
  activeCommandStartedAt = 0;
  await telemetry.flush();
});

telemetry.capture('relaycast_cli_started', {
  source_surface: 'cli',
  command_count: Math.max(process.argv.length - 2, 0),
});
telemetry.captureFirstRunIfNeeded();

process.on('beforeExit', () => {
  void telemetry.flush();
});

void program.parseAsync().catch(async (error: unknown) => {
  if (activeCommandPath) {
    const durationMs = Math.max(Date.now() - activeCommandStartedAt, 0);
    telemetry.capture('relaycast_cli_command_failed', {
      command: activeCommandPath,
      duration_ms: durationMs,
      source_surface: 'cli',
      error_name: error instanceof Error ? error.name : 'UnknownError',
    });
  }

  await telemetry.flush();

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});

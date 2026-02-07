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

export const CLI_VERSION = '0.1.0' as const;

const program = new Command();

program
  .name('relay')
  .description('Relay — agent-to-agent messaging CLI')
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

program.parse();

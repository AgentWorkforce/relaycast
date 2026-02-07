import { Command } from 'commander';
import { Relay } from '@agent-relay/sdk';
import { loadConfig } from '../config.js';

function getAgent() {
  const config = loadConfig();
  if (!config.apiKey) {
    throw new Error('No API key configured. Run: relay config set api-key <key>');
  }
  if (!config.agentToken) {
    throw new Error('No agent token configured. Run: relay config set agent-token <token>');
  }
  const relay = new Relay({ apiKey: config.apiKey, baseUrl: config.endpoint });
  return relay.as(config.agentToken);
}

export function registerMessagingCommands(program: Command): void {
  program
    .command('send <target> <text>')
    .description('Send a message (use #channel or @agent)')
    .action(async (target: string, text: string) => {
      const agent = getAgent();
      if (target.startsWith('@')) {
        const name = target.slice(1);
        await agent.dm(name, text);
        console.log(`DM sent to ${name}`);
      } else {
        const result = await agent.send(target, text);
        console.log(`Message sent: ${result.id}`);
      }
    });

  program
    .command('reply <msg_id> <text>')
    .description('Reply to a message in a thread')
    .action(async (msgId: string, text: string) => {
      const agent = getAgent();
      const result = await agent.reply(msgId, text);
      console.log(`Reply sent: ${result.id}`);
    });

  program
    .command('group-dm')
    .argument('<agents...>', 'Agent names')
    .option('--name <name>', 'Group name')
    .option('--text <text>', 'Initial message')
    .description('Create a group DM')
    .action(async (agents: string[], opts: { name?: string; text?: string }) => {
      const agent = getAgent();
      await agent.dms.createGroup({
        participants: agents,
        name: opts.name,
        text: opts.text ?? '',
      });
      console.log(`Group DM created with: ${agents.join(', ')}`);
    });
}

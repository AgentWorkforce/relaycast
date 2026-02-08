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

export function registerReactionCommands(program: Command): void {
  program
    .command('react <msg_id> <emoji>')
    .description('React to a message')
    .action(async (msgId: string, emoji: string) => {
      const agent = getAgent();
      await agent.react(msgId, emoji);
      console.log(`Reacted with :${emoji}: on ${msgId}`);
    });

  program
    .command('unreact <msg_id> <emoji>')
    .description('Remove a reaction')
    .action(async (msgId: string, emoji: string) => {
      const agent = getAgent();
      await agent.unreact(msgId, emoji);
      console.log(`Removed :${emoji}: from ${msgId}`);
    });
}

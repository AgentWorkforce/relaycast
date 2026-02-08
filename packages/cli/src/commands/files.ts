import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { Relay } from '@relaycast/sdk';
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

export function registerFileCommands(program: Command): void {
  program
    .command('upload <file> <target> [text]')
    .description('Upload a file and send to channel/agent')
    .action(async (file: string, target: string, text?: string) => {
      const agent = getAgent();
      const stat = fs.statSync(file);
      const filename = path.basename(file);
      const upload = await agent.files.upload({
        filename,
        content_type: 'application/octet-stream',
        size_bytes: stat.size,
      });
      console.log(`Upload initiated: ${upload.file_id}`);
      console.log(`Upload URL: ${upload.upload_url}`);
      if (text) {
        await agent.send(target, text, { attachments: [upload.file_id] });
        console.log(`Message sent to ${target} with attachment`);
      }
    });

  program
    .command('files')
    .description('List files')
    .option('--channel <channel>', 'Filter by channel')
    .action(async () => {
      const agent = getAgent();
      const files = await agent.files.list();
      if (files.length === 0) {
        console.log('No files.');
        return;
      }
      for (const f of files) {
        console.log(`${f.file_id}  ${f.filename}  ${f.size} bytes`);
      }
    });
}

#!/usr/bin/env node

import { detectOpenClaw } from './config.js';
import { setupSkill } from './setup.js';

const args = process.argv.slice(2);
const command = args[0];

if (command === 'setup') {
  const apiKey = args[1] ?? process.env.RELAY_API_KEY;
  const clawName = args[2] ?? process.env.RELAY_CLAW_NAME ?? 'my-claw';

  if (!apiKey) {
    console.error(
      'Usage: relaycast-openclaw setup <api-key> [claw-name]\n' +
        '  Or set RELAY_API_KEY environment variable.',
    );
    process.exit(1);
  }

  const detection = await detectOpenClaw();
  if (!detection.installed) {
    console.error(
      'OpenClaw not detected. Expected config at ~/.openclaw/\n' +
        'Install OpenClaw first: https://github.com/openclaw/openclaw',
    );
    process.exit(1);
  }

  const result = await setupSkill({ apiKey, clawName });
  console.log(result.message);
} else if (command === 'status') {
  const detection = await detectOpenClaw();
  console.log(`OpenClaw installed: ${detection.installed}`);
  console.log(`Config dir: ${detection.configDir}`);
  console.log(`Config file: ${detection.configFile ?? 'not found'}`);
  console.log(`Workspace: ${detection.workspaceDir}`);
} else {
  console.log(
    'relaycast-openclaw — Relaycast integration for OpenClaw\n\n' +
      'Commands:\n' +
      '  setup <api-key> [claw-name]  Install Relaycast skill into OpenClaw\n' +
      '  status                       Check OpenClaw installation\n',
  );
}

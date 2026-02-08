import { Command } from 'commander';
import { detectOpenClaw, setupSkill } from '@relaycast/openclaw';
import { loadConfig } from '../config.js';

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function registerOpenClawCommands(program: Command): void {
  const oc = program
    .command('openclaw')
    .description('OpenClaw integration — add Relaycast to your claw');

  oc.command('status')
    .description('Check OpenClaw installation and Relaycast skill status')
    .action(async () => {
      const detection = await detectOpenClaw();
      printJson({
        openclaw_installed: detection.installed,
        config_dir: detection.configDir,
        config_file: detection.configFile,
        workspace_dir: detection.workspaceDir,
        has_config: detection.config !== null,
      });
    });

  oc.command('setup')
    .description('Install Relaycast skill into OpenClaw workspace')
    .option('-n, --name <name>', 'Name for this claw in Relaycast', 'my-claw')
    .option('-k, --api-key <key>', 'Relaycast workspace API key')
    .action(async (opts: { name: string; apiKey?: string }) => {
      const cfg = loadConfig();
      const apiKey = opts.apiKey ?? cfg.apiKey;
      if (!apiKey) {
        console.error(
          'Missing API key. Provide --api-key or run: relaycast config set api-key <value>',
        );
        process.exit(1);
      }

      const detection = await detectOpenClaw();
      if (!detection.installed) {
        console.error(
          'OpenClaw not detected at ~/.openclaw/\n' +
            'Install OpenClaw first: https://github.com/openclaw/openclaw',
        );
        process.exit(1);
      }

      const result = await setupSkill({
        apiKey,
        clawName: opts.name,
        baseUrl: cfg.endpoint,
      });

      console.log(result.message);
      console.log('\nNext steps:');
      console.log('  1. Restart your OpenClaw daemon to pick up the new skill');
      console.log(
        '  2. Your claw can now use Relaycast tools (send, read, search, etc.)',
      );
      console.log(
        '  3. Other claws in the same workspace will see this claw online',
      );
    });
}

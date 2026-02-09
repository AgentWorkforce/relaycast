import { Command } from 'commander';

import { loadConfig } from '../config.js';
import {
  installMcp,
  detectInstalledTools,
  TOOL_ADAPTERS,
  type InstallResult,
} from '../mcp-install.js';

function formatResults(results: InstallResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const icon =
      r.status === 'installed'
        ? '+'
        : r.status === 'already-configured'
          ? '='
          : '!';
    lines.push(`  [${icon}] ${r.tool}: ${r.message}`);
  }
  return lines.join('\n');
}

export function registerMcpCommands(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('MCP server auto-configuration');

  mcp
    .command('install')
    .description(
      'Auto-detect AI tools and install Relaycast as an MCP server',
    )
    .option('-k, --key <api-key>', 'Relaycast workspace API key')
    .option('-b, --base-url <url>', 'API base URL')
    .option(
      '-t, --tool <tool>',
      `Install for a specific tool only (${TOOL_ADAPTERS.map((a) => a.id).join(', ')})`,
    )
    .option(
      '-s, --scope <scope>',
      'Config scope: "user" (default) or "project"',
      'user',
    )
    .action(
      (options: {
        key?: string;
        baseUrl?: string;
        tool?: string;
        scope?: string;
      }) => {
        const cfg = loadConfig();
        const apiKey = options.key ?? cfg.apiKey;
        if (!apiKey) {
          console.error(
            'Missing API key. Provide --key or run: relaycast config set api-key <value>',
          );
          process.exitCode = 1;
          return;
        }

        const scope =
          options.scope === 'project' ? ('project' as const) : ('user' as const);
        const results = installMcp({
          apiKey,
          baseUrl: options.baseUrl ?? cfg.endpoint,
          tool: options.tool,
          scope,
        });

        console.log(formatResults(results));

        const hasError = results.some((r) => r.status === 'error');
        if (hasError) {
          process.exitCode = 1;
        }
      },
    );

  mcp
    .command('status')
    .description('Show which AI tools are detected')
    .action(() => {
      const detected = detectInstalledTools();
      if (detected.length === 0) {
        console.log('No supported AI tools detected.');
        return;
      }
      console.log('Detected AI tools:');
      for (const adapter of TOOL_ADAPTERS) {
        const found = detected.some((d) => d.id === adapter.id);
        const mark = found ? '+' : ' ';
        console.log(`  [${mark}] ${adapter.displayName} (${adapter.id})`);
      }
    });
}

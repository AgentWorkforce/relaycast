import { Command } from 'commander';
import type { CliTelemetry, TelemetryStatus } from '../telemetry.js';

const TELEMETRY_DOCS_URL = 'https://github.com/AgentWorkforce/relaycast/blob/main/TELEMETRY.md';

function reasonMessage(status: TelemetryStatus): string {
  if (status.reason === 'enabled') return 'Telemetry is enabled.';
  if (status.reason === 'env_opt_out') {
    return 'Telemetry disabled by environment variable (DO_NOT_TRACK or RELAYCAST_TELEMETRY_DISABLED).';
  }
  return 'Telemetry disabled by user preference.';
}

function printStatus(status: TelemetryStatus): void {
  console.log(
    JSON.stringify(
      {
        enabled: status.enabled,
        reason: status.reason,
        env_opt_out: status.envOptOut,
        user_opt_out: status.userOptOut,
        message: reasonMessage(status),
        documentation: TELEMETRY_DOCS_URL,
      },
      null,
      2,
    ),
  );
}

export function registerTelemetryCommands(program: Command, telemetryInstance: CliTelemetry): void {
  const telemetry = program
    .command('telemetry')
    .description('Anonymous usage telemetry settings (opt-out)');

  telemetry
    .command('status')
    .description('Show telemetry status and opt-out source')
    .action(() => {
      printStatus(telemetryInstance.status());
    });

  telemetry
    .command('enable')
    .description('Enable telemetry')
    .action(() => {
      const status = telemetryInstance.setEnabled(true);
      printStatus(status);
    });

  telemetry
    .command('disable')
    .description('Disable telemetry')
    .action(() => {
      const status = telemetryInstance.setEnabled(false);
      printStatus(status);
    });
}

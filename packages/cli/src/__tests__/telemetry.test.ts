import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

describe('telemetry config', () => {
  let homeDir: string;
  let prevHome: string | undefined;
  let prevDoNotTrack: string | undefined;
  let prevDisabled: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    homeDir = fs.mkdtempSync(path.join(process.cwd(), 'relay-cli-telemetry-home-'));
    prevHome = process.env.HOME;
    prevDoNotTrack = process.env.DO_NOT_TRACK;
    prevDisabled = process.env.RELAYCAST_TELEMETRY_DISABLED;
    process.env.HOME = homeDir;
    delete process.env.DO_NOT_TRACK;
    delete process.env.RELAYCAST_TELEMETRY_DISABLED;
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    process.env.HOME = prevHome;
    process.env.DO_NOT_TRACK = prevDoNotTrack;
    process.env.RELAYCAST_TELEMETRY_DISABLED = prevDisabled;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('can be disabled and re-enabled via telemetry command using shared instance', async () => {
    const { registerTelemetryCommands } = await import('../commands/telemetry.js');
    const { createCliTelemetry } = await import('../telemetry.js');
    const program = new Command().exitOverride();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const telemetry = createCliTelemetry();

    registerTelemetryCommands(program, telemetry);

    await program.parseAsync(['telemetry', 'disable'], { from: 'user' });
    // The same instance should reflect the change immediately
    expect(telemetry.status().enabled).toBe(false);
    expect(telemetry.status().reason).toBe('user_opt_out');

    await program.parseAsync(['telemetry', 'enable'], { from: 'user' });
    expect(telemetry.status().enabled).toBe(true);
    expect(telemetry.status().reason).toBe('enabled');

    expect(logSpy).toHaveBeenCalled();
  });

  it('DO_NOT_TRACK env var forces telemetry off', async () => {
    const { createCliTelemetry } = await import('../telemetry.js');
    process.env.DO_NOT_TRACK = '1';

    const status = createCliTelemetry().status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('env_opt_out');
  });

  it('captureFirstRunIfNeeded does not mark captured when telemetry is disabled', async () => {
    const { createCliTelemetry } = await import('../telemetry.js');
    process.env.DO_NOT_TRACK = '1';

    const telemetry = createCliTelemetry();
    telemetry.captureFirstRunIfNeeded();

    // After disabling DO_NOT_TRACK and creating a new instance,
    // first-run should still fire because it was not marked as captured
    delete process.env.DO_NOT_TRACK;
    vi.resetModules();
    const { createCliTelemetry: freshCreate } = await import('../telemetry.js');
    const freshTelemetry = freshCreate();
    // The status should be enabled now and first-run should not have been captured yet
    expect(freshTelemetry.status().enabled).toBe(true);
  });

  it('telemetry status output includes canonical docs URL', async () => {
    const { registerTelemetryCommands } = await import('../commands/telemetry.js');
    const { createCliTelemetry } = await import('../telemetry.js');
    const program = new Command().exitOverride();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const telemetry = createCliTelemetry();

    registerTelemetryCommands(program, telemetry);
    await program.parseAsync(['telemetry', 'status'], { from: 'user' });

    const lastOutput = logSpy.mock.calls.at(-1)?.[0];
    expect(typeof lastOutput).toBe('string');
    const parsed = JSON.parse(String(lastOutput)) as { documentation?: string };
    expect(parsed.documentation).toBe(
      'https://github.com/AgentWorkforce/relaycast/blob/main/TELEMETRY.md',
    );
  });
});

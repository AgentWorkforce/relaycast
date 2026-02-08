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

  it('can be disabled and re-enabled via telemetry command', async () => {
    const { registerTelemetryCommands } = await import('../commands/telemetry.js');
    const { createCliTelemetry } = await import('../telemetry.js');
    const program = new Command().exitOverride();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    registerTelemetryCommands(program);

    await program.parseAsync(['telemetry', 'disable'], { from: 'user' });
    expect(createCliTelemetry().status().enabled).toBe(false);
    expect(createCliTelemetry().status().reason).toBe('user_opt_out');

    await program.parseAsync(['telemetry', 'enable'], { from: 'user' });
    expect(createCliTelemetry().status().enabled).toBe(true);
    expect(createCliTelemetry().status().reason).toBe('enabled');

    expect(logSpy).toHaveBeenCalled();
  });

  it('DO_NOT_TRACK env var forces telemetry off', async () => {
    const { createCliTelemetry } = await import('../telemetry.js');
    process.env.DO_NOT_TRACK = '1';

    const status = createCliTelemetry().status();
    expect(status.enabled).toBe(false);
    expect(status.reason).toBe('env_opt_out');
  });
});

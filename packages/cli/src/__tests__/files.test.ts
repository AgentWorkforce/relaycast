import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(async () => ({
    file_id: 'file_1',
    upload_url: 'https://s3.example.com/upload',
    expires_at: '2025-01-01T01:00:00Z',
  })),
  send: vi.fn(async () => ({ id: 'msg_1' })),
  listFiles: vi.fn(async () => [
    { file_id: 'file_1', filename: 'error.log', size: 1024 },
    { file_id: 'file_2', filename: 'report.pdf', size: 2048 },
  ]),
}));

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(function () {
    return {
      as: vi.fn(() => ({
        files: {
          upload: mocks.upload,
          list: mocks.listFiles,
        },
        send: mocks.send,
      })),
    };
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ apiKey: 'rk_test', agentToken: 'at_test' })),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      statSync: vi.fn(() => ({ size: 512 })),
    },
    statSync: vi.fn(() => ({ size: 512 })),
  };
});

import { registerFileCommands } from '../commands/files.js';

describe('file commands', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('upload calls files.upload', async () => {
    const program = new Command().exitOverride();
    registerFileCommands(program);
    await program.parseAsync(['upload', './error.log', '#general', 'Here is the log'], { from: 'user' });
    expect(mocks.upload).toHaveBeenCalledWith({
      filename: 'error.log',
      content_type: 'application/octet-stream',
      size_bytes: 512,
    });
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('file_1'))).toBe(true);
  });

  it('files lists all files', async () => {
    const program = new Command().exitOverride();
    registerFileCommands(program);
    await program.parseAsync(['files'], { from: 'user' });
    expect(mocks.listFiles).toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('error.log'))).toBe(true);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('report.pdf'))).toBe(true);
  });
});

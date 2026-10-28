import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, secretFromEnv } from '../secretEnv.js';

describe('secretFromEnv (relaycast-engine CLI)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  function file(content: string): string {
    dir ??= mkdtempSync(join(tmpdir(), 'relaycast-secret-env-'));
    const path = join(dir, `secret-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  it('trims by default; a direct value wins over _FILE; blank falls through', () => {
    const path = file('  from-file \n');
    expect(secretFromEnv({ S: ' direct ' }, 'S')).toBe('direct');
    expect(secretFromEnv({ S: 'direct', S_FILE: path }, 'S')).toBe('direct');
    expect(secretFromEnv({ S: '  ', S_FILE: path }, 'S')).toBe('from-file');
    expect(secretFromEnv({ S: '  ' }, 'S')).toBeUndefined();
    expect(() => secretFromEnv({ S_FILE: join(tmpdir(), 'missing-relaycast-secret') }, 'S')).toThrow(ConfigError);
  });

  it('exact mode keeps a direct value verbatim (bootstrap-secret replay keys depend on its bytes)', () => {
    expect(secretFromEnv({ S: 'abc ' }, 'S', { exact: true })).toBe('abc ');
    expect(secretFromEnv({ S: ' abc' }, 'S', { exact: true })).toBe(' abc');
  });

  it('exact mode strips only one trailing newline from a _FILE', () => {
    expect(secretFromEnv({ S_FILE: file('abc \n') }, 'S', { exact: true })).toBe('abc ');
    expect(secretFromEnv({ S_FILE: file('abc\r\n') }, 'S', { exact: true })).toBe('abc');
    expect(secretFromEnv({ S_FILE: file('abc') }, 'S', { exact: true })).toBe('abc');
    expect(secretFromEnv({ S_FILE: file('\n') }, 'S', { exact: true })).toBeUndefined();
  });
});

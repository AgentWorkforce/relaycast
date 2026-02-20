import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_SRC_DIR = path.resolve(process.cwd(), 'src');

const ALLOWED_DIRECT_CAPTURE_FILES = new Set([
  path.normalize('durable-objects/agent.ts'),
  path.normalize('durable-objects/workspaceStream.ts'),
  path.normalize('lib/serverTelemetry.ts'),
  path.normalize('lib/telemetry.ts'),
  path.normalize('lib/__tests__/telemetry.test.ts'),
  path.normalize('lib/__tests__/telemetry-usage.test.ts'),
]);

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('server telemetry usage', () => {
  it('keeps captureInternalTelemetry usage constrained to low-level files', async () => {
    const files = await listTsFiles(SERVER_SRC_DIR);
    const offenders: string[] = [];

    for (const fullPath of files) {
      const relPath = path.normalize(path.relative(SERVER_SRC_DIR, fullPath));
      const contents = await readFile(fullPath, 'utf8');
      if (!contents.includes('captureInternalTelemetry(')) continue;
      if (ALLOWED_DIRECT_CAPTURE_FILES.has(relPath)) continue;
      offenders.push(relPath);
    }

    expect(offenders).toEqual([]);
  });
});

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFileStorage } from '../files.js';

describe('LocalFileStorage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relaycast-files-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the stored size only once the object is written, leaving no temporary files', async () => {
    const storage = new LocalFileStorage(dir, 'http://localhost', 'secret');

    expect(await storage.statObject({ storageKey: 'ws/f1/shot.png' })).toBeNull();
    await storage.write('ws/f1/shot.png', Buffer.from('12345'), 'image/png');

    expect(await storage.statObject({ storageKey: 'ws/f1/shot.png' })).toEqual({ sizeBytes: 5 });
    expect((await storage.read('ws/f1/shot.png'))?.contentType).toBe('image/png');
    expect((await readdir(join(dir, 'ws', 'f1'))).sort()).toEqual(['shot.png', 'shot.png.ct']);
  });

  it('surfaces storage failures instead of reporting a missing object', async () => {
    // A file where the object's parent directory should be: stat fails with
    // ENOTDIR, which is a storage fault, not "never uploaded".
    await writeFile(join(dir, 'ws'), 'not a directory');
    const storage = new LocalFileStorage(dir, 'http://localhost', 'secret');

    await expect(storage.statObject({ storageKey: 'ws/f1/shot.png' })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

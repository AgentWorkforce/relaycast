import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileStore } from '../files/index.js';
import { blockPlace, exportKey } from '@relaycast/engine/gateway';
import { sealBlock } from '../../../engine/src/adapters/migration/sealing.js';
import { gatewayOrigin, main } from '../migrate.js';
import { jsonResponse } from './fakeControlPlane.js';
import { INTERNAL_SECRET, WORKSPACE_ID, startHarness, type Harness } from './harness.js';

const RUN = 'run-0001-import';
const FILE_COLUMNS = ['id', 'workspace_id', 'uploaded_by', 'filename', 'content_type', 'size_bytes', 'storage_key', 'upload_expires_at', 'status', 'created_at'];

let harness: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await harness?.close();
  harness = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'relaycast-migrate-'));
  dirs.push(dir);
  return dir;
}

/** Sealed NDJSON lines for blocks of one table, as the exporter writes them. */
async function sealed(table: string, blocks: unknown[][][]): Promise<string> {
  const key = await exportKey(INTERNAL_SECRET, RUN);
  const lines = await Promise.all(blocks.map((block, seq) => sealBlock(key, blockPlace(WORKSPACE_ID, table, seq), JSON.stringify(block))));
  return lines.map((line) => `${line}\n`).join('');
}

/** An export with two tables: three message blocks and one files block. */
async function writeExport(files: unknown[][] = []) {
  const dir = await tempDir();
  const ws = join(dir, WORKSPACE_ID);
  await mkdir(ws, { recursive: true });
  const tables = [
    { name: 'messages', columns: ['id'], count: 3, sha256: 'a'.repeat(64), blocks: 3 },
    { name: 'files', columns: FILE_COLUMNS, count: files.length, sha256: 'b'.repeat(64), blocks: files.length > 0 ? 1 : 0 },
  ];
  await writeFile(join(ws, 'manifest.json'), JSON.stringify({ format: 1, run_id: RUN, workspace_id: WORKSPACE_ID, exported_at: '', tables }));
  await writeFile(join(ws, 'messages.ndjson'), await sealed('messages', [[[1, 'm1']], [[2, 'm2']], [[3, 'm3']]]));
  await writeFile(join(ws, 'files.ndjson'), files.length > 0 ? await sealed('files', [files]) : '');
  return dir;
}

describe('relaycast-migrate import', () => {
  it('begins, sends only the blocks the actor lacks, finishes, and prints no secret', async () => {
    const ops: Record<string, unknown>[] = [];
    harness = await startHarness({
      workspace: () => ({
        handle: () => jsonResponse(404, {}),
        importData: (body) => {
          const step = body as Record<string, unknown>;
          ops.push(step);
          if (step.op === 'begin') return jsonResponse(200, { ok: true, data: { run_id: RUN, status: 'in_progress', tables: { messages: { chunks: 1, rows: 1 } } } });
          return jsonResponse(200, { ok: true, data: {} });
        },
      }),
      env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET },
    });
    const dir = await writeExport();
    const lines: string[] = [];
    const code = await main(['import', '--dir', dir, '--gateway', harness.baseUrl], { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET }, (line) => lines.push(line));
    expect(code, lines.join('\n')).toBe(0);
    expect(ops.map((step) => [step.op, step.table, step.seq])).toEqual([
      ['begin', undefined, undefined],
      ['chunk', 'messages', 1],
      ['chunk', 'messages', 2],
      ['finish', undefined, undefined],
    ]);
    expect(ops.at(-1)!.manifest).toEqual({ messages: { count: 3, sha256: 'a'.repeat(64) }, files: { count: 0, sha256: 'b'.repeat(64) } });
    expect(lines.join('\n')).not.toContain(INTERNAL_SECRET);
    expect(lines.at(-1)).toMatch(/verified 3 rows in 2 tables \(2 blocks sent\)/);
  });

  it('exits 1 and reports the details when the actor refuses to finish', async () => {
    harness = await startHarness({
      workspace: () => ({
        handle: () => jsonResponse(404, {}),
        importData: (body) => (body as { op: string }).op === 'finish'
          ? jsonResponse(409, { ok: false, error: { code: 'import_verification_failed', message: 'mismatch', details: { mismatches: [{ table: 'messages' }] } } })
          : jsonResponse((body as { op: string }).op === 'begin' ? 201 : 200, { ok: true, data: { tables: {} } }),
      }),
      env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET },
    });
    const dir = await writeExport();
    const lines: string[] = [];
    expect(await main(['import', '--dir', dir, '--gateway', harness.baseUrl], { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET }, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain('import_verification_failed');
    expect(lines.join('\n')).toContain('"table":"messages"');
  });

  it('refuses a missing secret or flag with exit 64', async () => {
    const out: string[] = [];
    expect(await main(['import', '--dir', '/nowhere', '--gateway', 'http://127.0.0.1:1'], {}, (line) => out.push(line))).toBe(64);
    expect(await main(['import', '--dir', '/nowhere'], {}, (line) => out.push(line))).toBe(64);
    expect(await main(['bogus'], {}, (line) => out.push(line))).toBe(64);
    expect(await main(['verify-realtime'], {}, (line) => out.push(line))).toBe(64);
    expect(await main(['verify-realtime', '--gateway', 'http://127.0.0.1:1'], {}, (line) => out.push(line))).toBe(64);
  });
});

describe('relaycast-migrate files', () => {
  it('copies completed files into the store, verifies them, skips them on a rerun, and reports missing sources', async () => {
    const source = await tempDir();
    const target = await tempDir();
    const key = `${WORKSPACE_ID}/f1/notes.txt`;
    await mkdir(join(source, WORKSPACE_ID, 'f1'), { recursive: true });
    await writeFile(join(source, key), 'hello');
    const row = (id: string, storageKey: string, status: string, size: number) =>
      [Number(id.slice(1)), id, WORKSPACE_ID, 'agent', 'notes.txt', 'text/plain', size, storageKey, null, status, 0];
    const dir = await writeExport([
      row('f1', key, 'complete', 5),
      row('f2', `${WORKSPACE_ID}/f2/pending.bin`, 'pending', 9),
    ]);
    const env = { RELAYCAST_FILE_STORE: 'local', RELAYCAST_FILE_DIR: target, RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET };

    const first: string[] = [];
    expect(await main(['files', '--dir', dir, '--from', source], env, (line) => first.push(line))).toBe(0);
    expect(first).toEqual([`files ${WORKSPACE_ID}: 1 copied, 0 already present, 0 failed`]);
    const stored = await new LocalFileStore(target).get(key);
    expect(stored).toMatchObject({ size: 5, contentType: 'text/plain' });

    const second: string[] = [];
    expect(await main(['files', '--dir', dir, '--from', source], env, (line) => second.push(line))).toBe(0);
    expect(second).toEqual([`files ${WORKSPACE_ID}: 0 copied, 1 already present, 0 failed`]);

    await rm(join(source, key));
    const third: string[] = [];
    expect(await main(['files', '--dir', dir, '--from', source], { ...env, RELAYCAST_FILE_DIR: await tempDir() }, (line) => third.push(line))).toBe(1);
    expect(third.at(-1)).toBe(`files ${WORKSPACE_ID}: 0 copied, 0 already present, 1 failed`);
  });
});

describe('relaycast-migrate safety', () => {
  it('skips a workspace that is already open, so rerunning a finished export succeeds', async () => {
    const ops: string[] = [];
    harness = await startHarness({
      workspace: () => ({
        handle: () => jsonResponse(404, {}),
        importData: (body) => { ops.push((body as { op: string }).op); return jsonResponse(200, { ok: true, data: { status: 'complete' } }); },
      }),
      env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET },
    });
    const dir = await writeExport();
    const lines: string[] = [];
    expect(await main(['import', '--dir', dir, '--gateway', harness.baseUrl], { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET }, (line) => lines.push(line))).toBe(0);
    expect(ops).toEqual(['begin']);
    expect(lines.join('\n')).toContain('already imported and open');
  });

  it('refuses a block sealed under another secret', async () => {
    harness = await startHarness({
      workspace: () => ({ handle: () => jsonResponse(404, {}), importData: () => jsonResponse(201, { ok: true, data: { tables: {} } }) }),
      env: { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET },
    });
    const dir = await writeExport();
    // The export was written by a deployment with another internal secret.
    const other = await exportKey(`${INTERNAL_SECRET}-other`, RUN);
    await writeFile(join(dir, WORKSPACE_ID, 'messages.ndjson'), `${await sealBlock(other, blockPlace(WORKSPACE_ID, 'messages', 0), '[[1,"m1"]]')}\n`);
    const lines: string[] = [];
    expect(await main(['import', '--dir', dir, '--gateway', harness.baseUrl], { RELAYCAST_INTERNAL_SECRET: INTERNAL_SECRET }, (line) => lines.push(line))).toBe(1);
    expect(lines.join('\n')).toContain('does not open with this deployment');
  });

  it('sends the internal secret over plain http only inside the cluster or to loopback', () => {
    expect(gatewayOrigin('http://relaycast.agent-relay.svc:8787/')).toBe('http://relaycast.agent-relay.svc:8787');
    expect(gatewayOrigin('http://relaycast.agent-relay.svc.cluster.local:8787')).toBe('http://relaycast.agent-relay.svc.cluster.local:8787');
    expect(gatewayOrigin('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(gatewayOrigin('https://cast.example.com')).toBe('https://cast.example.com');
    expect(() => gatewayOrigin('http://cast.example.com')).toThrow(/must be https/);
  });
});

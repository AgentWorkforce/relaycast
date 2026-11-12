#!/usr/bin/env node
/**
 * `relaycast-migrate`: move workspaces exported from a PostgreSQL deployment
 * (`relaycast-engine export-for-actors`) into this deployment's workspace
 * actors.
 *
 *   relaycast-migrate files  --dir <export> --from <old files dir, e.g. /data/relaycast-files> [--workspace <id>]...
 *       Copy every completed file's bytes into this deployment's file store
 *       (RELAYCAST_FILE_STORE and its RELAYCAST_S3_* / RELAYCAST_GCS_* settings,
 *       as the gateway reads them), verifying size and sha256 by reading each
 *       object back. Objects already present with the same bytes are skipped.
 *   relaycast-migrate import --dir <export> --gateway <url> [--workspace <id>]...
 *       Send each workspace through POST /internal/workspaces/:id/import
 *       (RELAYCAST_INTERNAL_SECRET or _FILE): begin, every block, finish. A
 *       rerun with the same export resumes. Exits non-zero unless every
 *       workspace finished with the manifest's counts and digests.
 *   relaycast-migrate abort  --dir <export> --gateway <url> --workspace <id>
 *       Remove a failed import's rows so the actor is empty again.
 *
 * Copy files first: a workspace serves as soon as its import finishes.
 * Output is counts, ids and digests only; no credential or file content.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ConfigError, secretFromEnv, type FileStoreKind } from './config.js';
import { createFileStore, type FileStore } from './files/index.js';

type Out = (line: string) => void;

/** A refused command line or environment (exit 64). */
export class UsageError extends Error {}

interface ManifestTable { name: string; columns: string[]; count: number; sha256: string; blocks: number }
interface Manifest { format: number; run_id: string; workspace_id: string; tables: ManifestTable[] }

export interface MigrateArgs {
  command: 'files' | 'import' | 'abort';
  dir: string;
  workspaces: string[];
  gateway?: string;
  from?: string;
}

export function parseArgs(argv: readonly string[]): MigrateArgs {
  const [command, ...rest] = argv;
  if (command !== 'files' && command !== 'import' && command !== 'abort') {
    throw new UsageError('usage: relaycast-migrate files|import|abort --dir <export> ...');
  }
  const args: Partial<MigrateArgs> & { workspaces: string[] } = { command, workspaces: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    i += 1;
    if (flag === '--dir') args.dir = value;
    else if (flag === '--gateway') args.gateway = value.replace(/\/+$/, '');
    else if (flag === '--from') args.from = value;
    else if (flag === '--workspace') args.workspaces.push(value);
    else throw new UsageError(`unknown argument ${flag}`);
  }
  if (!args.dir) throw new UsageError('--dir is required');
  if (command !== 'files' && !args.gateway) throw new UsageError('--gateway is required');
  if (command === 'files' && !args.from) throw new UsageError('--from is required');
  if (command === 'abort' && args.workspaces.length !== 1) throw new UsageError('abort takes exactly one --workspace');
  return args as MigrateArgs;
}

async function workspaceDirs(dir: string, only: readonly string[]): Promise<string[]> {
  if (only.length > 0) return [...only];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory() && /^[0-9]+$/.test(entry.name)).map((entry) => entry.name).sort();
}

async function readManifest(dir: string, workspaceId: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(join(dir, workspaceId, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format !== 1 || manifest.workspace_id !== workspaceId) {
    throw new Error(`${workspaceId}: not a format 1 export of this workspace`);
  }
  return manifest;
}

/** One block per line, streamed: a table's file can be far larger than memory should hold. */
async function* blocks(dir: string, workspaceId: string, table: string): AsyncGenerator<unknown[][]> {
  const lines = createInterface({ input: createReadStream(join(dir, workspaceId, `${table}.ndjson`), 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as unknown[][];
}

// ---------------------------------------------------------------- files

/** sha256 and size of a stream. */
async function digestStream(stream: NodeJS.ReadableStream): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return { sha256: hash.digest('hex'), size };
}

export async function copyFiles(args: MigrateArgs, store: FileStore, out: Out): Promise<boolean> {
  const root = resolve(args.from!);
  let ok = true;
  for (const workspaceId of await workspaceDirs(args.dir, args.workspaces)) {
    const manifest = await readManifest(args.dir, workspaceId);
    const columns = manifest.tables.find((table) => table.name === 'files')!.columns;
    const at = (name: string) => 1 + columns.indexOf(name);
    let copied = 0;
    let present = 0;
    let failed = 0;
    for await (const block of blocks(args.dir, workspaceId, 'files')) {
      for (const row of block) {
        if (row[at('status')] !== 'complete') continue;
        const key = String(row[at('storage_key')]);
        const size = Number(row[at('size_bytes')]);
        const contentType = String(row[at('content_type')]);
        const source = resolve(root, ...key.split('/'));
        try {
          if (!source.startsWith(root + sep)) throw new Error('storage key escapes the source directory');
          const local = await stat(source);
          if (local.size !== size) throw new Error(`source has ${local.size} bytes, the row says ${size}`);
          const expected = await digestStream(createReadStream(source));
          const existing = await store.get(key);
          if (existing && existing.size === size && (await digestStream(existing.stream)).sha256 === expected.sha256) {
            present += 1;
            continue;
          }
          await store.put(key, createReadStream(source), { size, contentType });
          const stored = await store.get(key);
          if (!stored) throw new Error('object missing after upload');
          const readBack = await digestStream(stored.stream);
          if (readBack.size !== size || readBack.sha256 !== expected.sha256) throw new Error('object differs after upload');
          copied += 1;
        } catch (error) {
          failed += 1;
          ok = false;
          out(`files ${workspaceId}: ${key}: ${(error as Error).message}`);
        }
      }
    }
    out(`files ${workspaceId}: ${copied} copied, ${present} already present, ${failed} failed`);
  }
  return ok;
}

// ---------------------------------------------------------------- import

interface Envelope { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } }

async function send(args: MigrateArgs, secret: string, workspaceId: string, body: unknown): Promise<{ status: number; json: Envelope }> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${args.gateway}/internal/workspaces/${workspaceId}/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
      });
      const json = (await response.json().catch(() => ({ ok: false, error: { code: 'not_json', message: `HTTP ${response.status}` } }))) as Envelope;
      // The gateway's 502/503 (actor host unavailable) is retried: every step is idempotent.
      if ((response.status === 502 || response.status === 503) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      return { status: response.status, json };
    } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

export async function importWorkspaces(args: MigrateArgs, secret: string, out: Out): Promise<boolean> {
  let ok = true;
  for (const workspaceId of await workspaceDirs(args.dir, args.workspaces)) {
    const manifest = await readManifest(args.dir, workspaceId);
    const fail = (what: string, result: { status: number; json: Envelope }) => {
      ok = false;
      out(`import ${workspaceId}: ${what} failed (HTTP ${result.status} ${result.json.error?.code ?? ''}: ${result.json.error?.message ?? ''})`);
      if (result.json.error?.details !== undefined) out(`import ${workspaceId}: details ${JSON.stringify(result.json.error.details)}`);
    };
    const begun = await send(args, secret, workspaceId, {
      op: 'begin',
      run_id: manifest.run_id,
      tables: manifest.tables.map(({ name, columns }) => ({ name, columns })),
    });
    if (begun.status !== 200 && begun.status !== 201) {
      fail('begin', begun);
      continue;
    }
    const done = (begun.json.data?.tables ?? {}) as Record<string, { chunks: number }>;
    let sent = 0;
    let failed = false;
    for (const table of manifest.tables) {
      let seq = 0;
      for await (const rows of blocks(args.dir, workspaceId, table.name)) {
        if (seq >= (done[table.name]?.chunks ?? 0)) {
          const result = await send(args, secret, workspaceId, { op: 'chunk', run_id: manifest.run_id, table: table.name, seq, rows });
          if (result.status !== 200) {
            fail(`${table.name} block ${seq}`, result);
            failed = true;
            break;
          }
          sent += 1;
        }
        seq += 1;
      }
      if (failed) break;
    }
    if (failed) continue;
    const finished = await send(args, secret, workspaceId, {
      op: 'finish',
      run_id: manifest.run_id,
      manifest: Object.fromEntries(manifest.tables.map(({ name, count, sha256 }) => [name, { count, sha256 }])),
    });
    if (finished.status !== 200) {
      fail('finish', finished);
      continue;
    }
    const rows = manifest.tables.reduce((sum, table) => sum + table.count, 0);
    out(`import ${workspaceId}: verified ${rows} rows in ${manifest.tables.length} tables (${sent} blocks sent)`);
  }
  return ok;
}

export async function abortImport(args: MigrateArgs, secret: string, out: Out): Promise<boolean> {
  const [workspaceId] = args.workspaces;
  const manifest = await readManifest(args.dir, workspaceId!);
  const result = await send(args, secret, workspaceId!, { op: 'abort', run_id: manifest.run_id });
  out(`abort ${workspaceId}: HTTP ${result.status} ${result.json.ok ? 'aborted' : result.json.error?.code ?? ''}`);
  return result.status === 200;
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, out: Out = (line) => process.stdout.write(`${line}\n`)): Promise<number> {
  let args: MigrateArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    out(`relaycast-migrate: ${(error as Error).message}`);
    return 64;
  }
  try {
    if (args.command === 'files') {
      const kind = (env.RELAYCAST_FILE_STORE ?? 'local') as FileStoreKind;
      if (kind === 'local' && !env.RELAYCAST_FILE_DIR) throw new UsageError('RELAYCAST_FILE_DIR is required for a local file store');
      const store = createFileStore({ kind, fileDir: env.RELAYCAST_FILE_DIR ?? '', env });
      return (await copyFiles(args, store, out)) ? 0 : 1;
    }
    const secret = secretFromEnv(env, 'RELAYCAST_INTERNAL_SECRET');
    if (!secret) throw new UsageError('RELAYCAST_INTERNAL_SECRET (or _FILE) is required');
    return (await (args.command === 'import' ? importWorkspaces(args, secret, out) : abortImport(args, secret, out))) ? 0 : 1;
  } catch (error) {
    out(`relaycast-migrate: ${(error as Error).message}`);
    return error instanceof UsageError || error instanceof ConfigError ? 64 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

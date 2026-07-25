import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_TELEMETRY_EVENTS } from '@relaycast/types';

/**
 * Guard: every event name passed to `emitServerEvent` must exist in
 * `SERVER_TELEMETRY_EVENTS`.
 *
 * `parseInternalTelemetryEvent` validates the name against a zod enum built
 * from that list, and the hosted sink invokes it as `void capture...(...)` — so
 * an unlisted name throws into a floating promise and the event is dropped
 * before it reaches PostHog, silently and with no error surfaced. This test is
 * the only thing standing between a new emit site and a permanently invisible
 * event.
 */

const ENGINE_SRC = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Every `emitServerEvent(` occurrence, including the declaration itself. */
const EMIT_CALL = /emitServerEvent\(/g;
/** The event name is the third argument; the first two are short expressions. */
const EMIT_CALL_WITH_NAME = /emitServerEvent\([\s\S]{0,120}?'(relaycast_server_[a-zA-Z0-9_]*)'/g;

const DECLARATION_FILE = path.join('lib', 'serverTelemetry.ts');

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...(await listSourceFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

async function collectEmitSites(): Promise<{ names: Set<string>; unparsed: string[] }> {
  const names = new Set<string>();
  const unparsed: string[] = [];

  for (const file of await listSourceFiles(ENGINE_SRC)) {
    const contents = await readFile(file, 'utf8');

    const calls = contents.match(EMIT_CALL)?.length ?? 0;
    let parsed = 0;
    for (const match of contents.matchAll(EMIT_CALL_WITH_NAME)) {
      names.add(match[1]!);
      parsed += 1;
    }

    // `serverTelemetry.ts` holds the declaration, which is not a call site.
    const expected = file.endsWith(DECLARATION_FILE) ? calls - 1 : calls;
    if (parsed < expected) {
      unparsed.push(`${path.relative(ENGINE_SRC, file)} (${expected - parsed} call(s))`);
    }
  }

  return { names, unparsed };
}

describe('server telemetry catalog', () => {
  it('declares every event name the engine emits', async () => {
    const { names } = await collectEmitSites();
    const declared = new Set<string>(SERVER_TELEMETRY_EVENTS);

    const undeclared = [...names].filter((name) => !declared.has(name)).sort();

    expect(
      undeclared,
      'emitted but missing from SERVER_TELEMETRY_EVENTS — these are dropped before PostHog',
    ).toEqual([]);
    expect(names.size).toBeGreaterThan(0);
  });

  it('reads an event name out of every emitServerEvent call', async () => {
    const { unparsed } = await collectEmitSites();

    expect(
      unparsed,
      'an emitServerEvent call shape changed — this guard can no longer read its event name',
    ).toEqual([]);
  });
});

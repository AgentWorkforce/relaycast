#!/usr/bin/env bun
/**
 * Build `relaycast-engine` as standalone single-file executables with
 * `bun build --compile`: no Node, npm, compiler, or native addon needed at run
 * time.
 *
 * The binary runs the same entry as the npm bin (`src/bin/serve.ts`). Three
 * modules are swapped at bundle time; everything else is the shared engine:
 *
 *   src/adapters/node/sqlite-driver.ts    -> standalone/sqlite-driver.ts    (bun:sqlite)
 *   src/adapters/node/migration-source.ts -> standalone/migration-source.ts (embedded SQL)
 *   src/bin/version.ts                    -> standalone/version.ts          (inlined version)
 *
 * Usage:
 *   bun standalone/build.ts                         # every target
 *   bun standalone/build.ts --target linux-x64      # one target (repeatable)
 *   bun standalone/build.ts --target host           # the machine running the build
 *   bun standalone/build.ts --outdir dist-standalone
 *
 * Output: `<outdir>/relaycast-engine-<version>-<os>-<arch>[.exe]` plus a
 * `sha256sum`-compatible `.sha256` file next to each binary.
 *
 * Workspace dependencies (`@relaycast/types`, `@relaycast/a2a`) resolve to their
 * built `dist`, so build them first (`npx turbo build --filter=@relaycast/engine`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { BunPlugin } from 'bun';

/** Asset platform name -> Bun compile target. x64 uses the baseline (pre-AVX2) CPU build. */
export const TARGETS = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'linux-musl-x64': 'bun-linux-x64-baseline-musl',
  'linux-musl-arm64': 'bun-linux-arm64-musl',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'darwin-arm64': 'bun-darwin-arm64',
  'windows-x64': 'bun-windows-x64-baseline',
} as const;

export type TargetName = keyof typeof TARGETS;

const engineRoot = resolve(import.meta.dir, '..');
const srcRoot = join(engineRoot, 'src');

/** `src/`-relative module (without extension) -> standalone replacement. */
const SWAPS: Record<string, string> = {
  'adapters/node/sqlite-driver': join(import.meta.dir, 'sqlite-driver.ts'),
  'adapters/node/migration-source': join(import.meta.dir, 'migration-source.ts'),
  'bin/version': join(import.meta.dir, 'version.ts'),
};

function hostTarget(): TargetName {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'win32') return 'windows-x64';
  // glibc exposes its version in the process report; musl does not.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? `linux-${arch}` : `linux-musl-${arch}`;
}

function standalonePlugin(swapped: Set<string>): BunPlugin {
  return {
    name: 'relaycast-standalone',
    setup(build) {
      build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
        const target = resolve(dirname(args.importer), args.path).replace(/\.js$/, '');
        const key = relative(srcRoot, target).split('\\').join('/');
        const replacement = SWAPS[key];
        if (!replacement) return undefined;
        swapped.add(key);
        return { path: replacement };
      });
      // The native addon must never reach the binary; fail the build if it would.
      build.onResolve({ filter: /^(better-sqlite3|drizzle-orm\/better-sqlite3)$/ }, (args) => {
        throw new Error(`${args.path} imported from ${args.importer}; the standalone build must use bun:sqlite`);
      });
    },
  };
}

export function assetName(version: string, target: TargetName): string {
  return `relaycast-engine-${version}-${target}${target.startsWith('windows-') ? '.exe' : ''}`;
}

async function buildTarget(target: TargetName, version: string, outdir: string): Promise<string> {
  const outfile = join(outdir, assetName(version, target));
  const swapped = new Set<string>();
  const result = await Bun.build({
    entrypoints: [join(srcRoot, 'bin/serve.ts')],
    compile: { target: TARGETS[target], outfile },
    minify: true,
    sourcemap: 'none',
    plugins: [standalonePlugin(swapped)],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target}`);
  }
  const missing = Object.keys(SWAPS).filter((key) => !swapped.has(key));
  if (missing.length > 0) throw new Error(`standalone swap not applied for: ${missing.join(', ')}`);

  const digest = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  writeFileSync(`${outfile}.sha256`, `${digest}  ${basename(outfile)}\n`);
  return outfile;
}

function parseArgs(argv: string[]): { targets: TargetName[]; outdir: string } {
  const targets: TargetName[] = [];
  let outdir = join(engineRoot, 'dist-standalone');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--outdir') outdir = resolve(argv[++i] ?? outdir);
    else if (arg === '--target') {
      const name = argv[++i];
      const resolved = name === 'host' ? hostTarget() : name;
      if (!resolved || !(resolved in TARGETS)) {
        throw new Error(`Unknown --target ${name}; expected host or one of ${Object.keys(TARGETS).join(', ')}`);
      }
      targets.push(resolved as TargetName);
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return { targets: targets.length > 0 ? targets : (Object.keys(TARGETS) as TargetName[]), outdir };
}

if (import.meta.main) {
  const { targets, outdir } = parseArgs(process.argv.slice(2));
  const { version } = JSON.parse(readFileSync(join(engineRoot, 'package.json'), 'utf8')) as { version: string };
  mkdirSync(outdir, { recursive: true });
  for (const target of targets) {
    const outfile = await buildTarget(target, version, outdir);
    console.log(`built ${relative(process.cwd(), outfile)}`);
  }
}

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type SdkName = 'typescript' | 'rust' | 'python' | 'swift';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OPENAPI_PATH = path.join(REPO_ROOT, 'openapi.yaml');

const SDK_SOURCE_ROOTS: Record<SdkName, string> = {
  typescript: path.join(REPO_ROOT, 'packages/sdk-typescript/src'),
  rust: path.join(REPO_ROOT, 'packages/sdk-rust/src'),
  python: path.join(REPO_ROOT, 'packages/sdk-python/src/relay_sdk'),
  swift: path.join(REPO_ROOT, 'packages/sdk-swift/Sources'),
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.rs', '.py', '.swift']);
const IGNORED_SEGMENTS = new Set([
  '__tests__',
  '__pycache__',
  '.build',
  '.pytest_cache',
  '.venv',
  'dist',
  'node_modules',
  'target',
]);

const NON_SDK_OPENAPI_PATHS = new Set([
  '/v1/health',
  '/v1/.well-known/agent-card.json',
  '/v1/a2a/rpc',
  '/v1/a2a/webhook/{param}/{param}',
]);

const CORE_SDK_PATHS = new Set([
  '/v1/agent',
  '/v1/agents',
  '/v1/agents/{param}',
  '/v1/agents/{param}/rotate-token',
  '/v1/agents/heartbeat',
  '/v1/agents/disconnect',
  '/v1/channels',
  '/v1/channels/{param}',
  '/v1/channels/{param}/join',
  '/v1/channels/{param}/messages',
  '/v1/dm',
  '/v1/dm/conversations',
  '/v1/dm/{param}/messages',
  '/v1/files',
  '/v1/files/{param}',
  '/v1/files/upload',
  '/v1/inbox',
  '/v1/messages/{param}',
  '/v1/messages/{param}/replies',
  '/v1/search',
  '/v1/workspace',
  '/v1/ws',
]);

function readOpenApiPaths(): Set<string> {
  const lines = fs.readFileSync(OPENAPI_PATH, 'utf8').split(/\r?\n/);
  const paths = new Set<string>();
  let inPaths = false;

  for (const line of lines) {
    if (line.startsWith('paths:')) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[A-Za-z][^:]*:/.test(line)) break;

    const match = line.match(/^  (\/[^:]+):\s*$/);
    if (match) {
      paths.add(normalizeRoutePath(`/v1${match[1]}`));
    }
  }

  return paths;
}

function walkSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (IGNORED_SEGMENTS.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function readSdkRoutes(root: string): Set<string> {
  const routes = new Set<string>();
  const stringWithRoute = /(["'`])([^"'`\n]*\/v1[^"'`\n]*)\1/g;

  for (const file of walkSourceFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = stringWithRoute.exec(source)) !== null) {
      const route = normalizeRoutePath(match[2]);
      if (route.startsWith('/v1/')) {
        routes.add(route);
      }
    }
  }

  return routes;
}

function normalizeRoutePath(raw: string): string {
  const start = raw.indexOf('/v1');
  if (start < 0) return raw;

  return raw
    .slice(start)
    .replace(/\\\([^)]*\)[)]?/g, '{param}')
    .replace(/\$\{[^}]+}/g, '{param}')
    .replace(/\{[^}]*}/g, '{param}')
    .split(/[?#]/)[0]
    .replace(/\{param}\)+/g, '{param}')
    .replace(/\/+$/g, '');
}

describe('SDK/OpenAPI route sync', () => {
  const openApiPaths = readOpenApiPaths();
  const sdkRoutes = Object.fromEntries(
    Object.entries(SDK_SOURCE_ROOTS).map(([name, root]) => [name, readSdkRoutes(root)]),
  ) as Record<SdkName, Set<string>>;

  it('does not let SDKs call routes missing from openapi.yaml', () => {
    const failures: string[] = [];

    for (const [sdk, routes] of Object.entries(sdkRoutes) as Array<[SdkName, Set<string>]>) {
      for (const route of routes) {
        if (!openApiPaths.has(route)) {
          failures.push(`${sdk}: ${route}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('classifies every OpenAPI route as SDK-covered or intentionally non-SDK', () => {
    const allSdkRoutes = new Set(Object.values(sdkRoutes).flatMap((routes) => [...routes]));
    const unclassified = [...openApiPaths]
      .filter((route) => !allSdkRoutes.has(route))
      .filter((route) => !NON_SDK_OPENAPI_PATHS.has(route))
      .sort();

    expect(unclassified).toEqual([]);
  });

  it('keeps core agent messaging routes present in every SDK', () => {
    const missing: string[] = [];

    for (const [sdk, routes] of Object.entries(sdkRoutes) as Array<[SdkName, Set<string>]>) {
      for (const route of CORE_SDK_PATHS) {
        if (!routes.has(route)) {
          missing.push(`${sdk}: ${route}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

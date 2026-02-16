import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../../');
const DOCKERFILE = readFileSync(resolve(ROOT, 'deploy/Dockerfile'), 'utf8');

/** Get all workspace package directory names from packages/ */
function getWorkspacePackages(): string[] {
  return readdirSync(resolve(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Extract all `COPY packages/<name>/package.json` lines from a Dockerfile section */
function extractCopiedPackages(section: string): string[] {
  const matches = section.matchAll(/COPY packages\/([^/]+)\/package\.json/g);
  return [...matches].map((m) => m[1]);
}

describe('Dockerfile workspace sync', () => {
  const workspacePackages = getWorkspacePackages();

  it('builder stage copies all workspace package.json files', () => {
    // Split at "Stage 2" to get just the builder section
    const builderSection = DOCKERFILE.split(/# Stage 2/)[0];
    const copied = extractCopiedPackages(builderSection);

    for (const pkg of workspacePackages) {
      expect(copied, `builder stage is missing packages/${pkg}/package.json`).toContain(pkg);
    }
  });

  it('runner stage copies all workspace package.json files', () => {
    // Get the runner section (after "Stage 2")
    const runnerSection = DOCKERFILE.split(/# Stage 2/)[1];
    expect(runnerSection, 'Could not find Stage 2 in Dockerfile').toBeDefined();

    const copied = extractCopiedPackages(runnerSection);

    for (const pkg of workspacePackages) {
      expect(copied, `runner stage is missing packages/${pkg}/package.json`).toContain(pkg);
    }
  });

  it('server production dependencies are resolvable', () => {
    // Read server package.json and verify all production deps exist in node_modules
    const serverPkg = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/server/package.json'), 'utf8')
    );
    const deps = Object.keys(serverPkg.dependencies || {});

    for (const dep of deps) {
      // Skip workspace deps (resolved via workspace linking)
      if (dep.startsWith('@relaycast/')) continue;

      const depPath = resolve(ROOT, 'node_modules', dep, 'package.json');
      const nestedPath = resolve(ROOT, 'packages/server/node_modules', dep, 'package.json');

      let found = false;
      try {
        readFileSync(depPath);
        found = true;
      } catch {
        try {
          readFileSync(nestedPath);
          found = true;
        } catch {
          // not found in either location
        }
      }

      expect(found, `server dependency '${dep}' not found in node_modules`).toBe(true);
    }
  });
});

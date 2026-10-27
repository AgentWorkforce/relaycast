import { readFileSync } from 'node:fs';

/**
 * The engine package version, read from `package.json` next to the build.
 *
 * The standalone single-file build replaces this module at bundle time with one
 * that inlines the version, since the binary carries no `package.json`.
 */
export function engineVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

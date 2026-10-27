/** Standalone replacement for `src/bin/version.ts`: the version is inlined at bundle time. */
import pkg from '../package.json' with { type: 'json' };

export function engineVersion(): string {
  return pkg.version;
}

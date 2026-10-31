import { readFileSync } from 'node:fs';

/** A configuration the server refuses to run with (exit EX_USAGE). */
export class ConfigError extends Error {}

/**
 * `NAME`, or the contents of the file named by `NAME_FILE`; empty →
 * undefined. A directly set (non-empty) variable wins over its `_FILE`
 * variant, matching RelayAuth. An unreadable `_FILE` is a configuration error.
 *
 * By default both sources are whitespace-trimmed. With `exact` (secrets whose
 * bytes feed a derivation, like the workspace bootstrap secret) a directly set
 * value is used verbatim — exactly as before `_FILE` support — and a file
 * loses only one trailing newline (`\n` or `\r\n`).
 */
export function secretFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  { exact = false }: { exact?: boolean } = {},
): string | undefined {
  const rawDirect = env[name];
  const direct = exact ? rawDirect : rawDirect?.trim();
  if (direct) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  let value: string;
  try {
    value = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `${name}_FILE points at an unreadable file (${err instanceof Error && 'code' in err ? String(err.code) : 'read error'})`,
    );
  }
  const cleaned = exact ? value.replace(/\r?\n$/, '') : value.trim();
  return cleaned ? cleaned : undefined;
}

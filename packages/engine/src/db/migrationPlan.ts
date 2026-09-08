import { z } from 'zod';

// Only these reviewed DDL-only replacements are authorized. A missing or
// edited manifest must fail closed, never silently revert to the high peak.
const supersessionsSchema = z.object({
  '0048_bounded_maintenance.sql': z.literal('0050_compact_maintenance_indexes.sql'),
  '0049_redrive_review_hardening.sql': z.literal('0050_compact_maintenance_indexes.sql'),
}).strict();

/** Plan explicit replacements without claiming skipped SQL was applied. */
export function planMigrations(files: string[], applied: ReadonlySet<string>, metadata: unknown): string[] {
  const supersessions = supersessionsSchema.parse(metadata);
  const available = new Set(files);
  for (const [older, replacement] of Object.entries(supersessions)) {
    if (!available.has(older) || !available.has(replacement) || replacement <= older) {
      throw new Error(`Invalid migration supersession: ${older} -> ${replacement}`);
    }
  }
  return [...files].sort().filter(file => !applied.has(file) && !Object.hasOwn(supersessions, file));
}

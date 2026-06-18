/**
 * Small pure helpers for shaping engine values onto the snake_case JSON wire.
 *
 * Centralized so every module renders nullable timestamps the same way instead
 * of each re-deriving `date ? date.toISOString() : null` (the idiom this
 * replaces, which had drifted into per-module copies).
 */

/** Render a nullable `Date` as an ISO-8601 string, or `null` when absent. */
export function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

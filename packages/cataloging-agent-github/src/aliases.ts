export const BY_TITLE_SEGMENT = "by-title";
export const BY_ID_SEGMENT = "by-id";
export const BY_NAME_SEGMENT = "by-name";
export const BY_STATE_SEGMENT = "by-state";
// TODO(issue #106): add adapter-level coverage for missing canonical numbers and last-writer-wins slug collisions where alias files are emitted.
// Keep alias helpers duplicated byte-for-byte with cataloging-agent-linear until a shared internal helper is approved.

const MAX_ALIAS_SLUG_LENGTH = 80;

export function slugForAlias(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const truncated = normalized.slice(0, MAX_ALIAS_SLUG_LENGTH).replace(/^-+|-+$/g, "");
  return truncated || "untitled";
}

export function statePathSegment(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return "unknown";
  }
  return encodeURIComponent(normalized).replace(/-/g, "%2D");
}

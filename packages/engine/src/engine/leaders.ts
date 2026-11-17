import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, workspaces } from '../db/tables.js';
import type { WorkspaceLeadersSettings } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

/** Upper bound on stored leader patterns. */
export const MAX_LEADER_PATTERNS = 64;
/** Upper bound on one pattern's length (after trimming). */
export const MAX_LEADER_PATTERN_LENGTH = 128;

export interface WorkspaceLeader {
  name: string;
  agent_id: string;
}

export interface WorkspaceLeadersResponse {
  leaders: WorkspaceLeader[];
  patterns: string[];
}

// C0 controls, DEL, and C1 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** True when the pattern contains a glob wildcard (`*` or `?`). */
export function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Compile a leader pattern to an anchored, case-sensitive RegExp. `*` matches
 * any run of characters (including none), `?` matches exactly one character,
 * and every other character is literal (regex metacharacters are escaped).
 * Unicode mode, so `?` consumes one code point rather than one UTF-16 unit.
 */
export function compileLeaderPattern(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, 'su');
}

/** Whole-name, case-sensitive glob match of `name` against `pattern`. */
export function matchesLeaderPattern(pattern: string, name: string): boolean {
  if (!isGlobPattern(pattern)) return pattern === name;
  return compileLeaderPattern(pattern).test(name);
}

/** Build a predicate matching a name against any of the given patterns. */
export function leaderMatcher(patterns: readonly string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const globs: RegExp[] = [];
  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) globs.push(compileLeaderPattern(pattern));
    else exact.add(pattern);
  }
  return (name) => exact.has(name) || globs.some((glob) => glob.test(name));
}

export type LeaderPatternsValidation =
  | { ok: true; patterns: string[] }
  | { ok: false; message: string };

/**
 * Validate and normalize a `patterns` value: an array of at most
 * MAX_LEADER_PATTERNS strings, each trimmed, non-empty, at most
 * MAX_LEADER_PATTERN_LENGTH characters, free of control characters.
 * Duplicates (after trimming) are dropped, keeping first-seen order.
 */
export function normalizeLeaderPatterns(value: unknown): LeaderPatternsValidation {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'patterns must be an array of strings' };
  }
  if (value.length > MAX_LEADER_PATTERNS) {
    return { ok: false, message: `patterns must contain at most ${MAX_LEADER_PATTERNS} entries` };
  }
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      return { ok: false, message: `patterns[${index}] must be a string` };
    }
    if (CONTROL_CHARACTERS.test(entry)) {
      return { ok: false, message: `patterns[${index}] must not contain control characters` };
    }
    const pattern = entry.trim();
    if (pattern.length === 0) {
      return { ok: false, message: `patterns[${index}] must be a non-empty string` };
    }
    if (pattern.length > MAX_LEADER_PATTERN_LENGTH) {
      return {
        ok: false,
        message: `patterns[${index}] must be at most ${MAX_LEADER_PATTERN_LENGTH} characters`,
      };
    }
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
  }
  return { ok: true, patterns };
}

function storedPatterns(settings: WorkspaceLeadersSettings | null | undefined): string[] {
  const patterns = settings?.patterns;
  if (!Array.isArray(patterns)) return [];
  return patterns.filter((pattern): pattern is string => typeof pattern === 'string');
}

async function resolveLeaders(
  db: Db,
  workspaceId: string,
  patterns: string[],
): Promise<WorkspaceLeadersResponse> {
  if (patterns.length === 0) return { leaders: [], patterns };
  // Registered roster = every non-released agent row. Keep the tombstone
  // predicate literal, like listAgents, so the partial roster index applies.
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), sql`${agents.status} <> 'released'`));
  const matches = leaderMatcher(patterns);
  const byId = new Map<string, WorkspaceLeader>();
  for (const row of rows) {
    if (!byId.has(row.id) && matches(row.name)) {
      byId.set(row.id, { name: row.name, agent_id: row.id });
    }
  }
  const leaders = [...byId.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0);
  return { leaders, patterns };
}

export async function getWorkspaceLeaders(db: Db, workspaceId: string): Promise<WorkspaceLeadersResponse> {
  const [workspace] = await db
    .select({ leaders: workspaces.leaders })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return resolveLeaders(db, workspaceId, storedPatterns(workspace?.leaders));
}

/** Replace the stored list; an empty list clears it (stored as NULL). */
export async function setWorkspaceLeaders(
  db: Db,
  workspaceId: string,
  patterns: string[],
): Promise<WorkspaceLeadersResponse> {
  await db
    .update(workspaces)
    .set({ leaders: patterns.length === 0 ? null : { patterns } })
    .where(eq(workspaces.id, workspaceId));
  return resolveLeaders(db, workspaceId, patterns);
}

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, workspaces } from '../db/tables.js';
import type { WorkspaceLeadersSettings } from '../db/schema.js';

type Db = ReturnType<typeof getDb>;

/** Upper bound on stored leader patterns. */
export const MAX_LEADER_PATTERNS = 64;
/** Upper bound on one pattern's length after trimming, in Unicode code points (not UTF-16 units). */
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
 * A glob pattern split into code points, with runs of consecutive `*`
 * collapsed to one (they are equivalent and would only add work).
 */
type CompiledGlob = readonly string[];

function compileGlob(pattern: string): CompiledGlob {
  const tokens: string[] = [];
  for (const char of pattern) {
    if (char === '*' && tokens[tokens.length - 1] === '*') continue;
    tokens.push(char);
  }
  return tokens;
}

/**
 * Iterative two-pointer wildcard match with single "last star" backtracking.
 *
 * A RegExp is deliberately not used: compiling `*` to `.*` yields a
 * backtracking regex, and stored patterns such as `"*a".repeat(30) + "b"`
 * evaluated against a name like `"a".repeat(60)` backtrack catastrophically
 * on the serving thread. This loop only ever rewinds to the most recent `*`,
 * so the worst case is O(len(pattern) * len(name)) with no recursion.
 *
 * Both sides are code-point arrays, so `?` consumes one code point rather
 * than one UTF-16 unit, and newlines are ordinary characters.
 */
function globMatches(glob: CompiledGlob, name: readonly string[]): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  while (n < name.length) {
    const token = glob[p];
    if (p < glob.length && token !== '*' && (token === '?' || token === name[n])) {
      p += 1;
      n += 1;
    } else if (p < glob.length && token === '*') {
      star = p;
      mark = n;
      p += 1;
    } else if (star !== -1) {
      // Let the last `*` absorb one more code point and retry after it.
      p = star + 1;
      mark += 1;
      n = mark;
    } else {
      return false;
    }
  }
  while (p < glob.length && glob[p] === '*') p += 1;
  return p === glob.length;
}

/**
 * Whole-name, case-sensitive glob match of `name` against `pattern`. `*`
 * matches any run of code points (including none), `?` matches exactly one
 * code point, and every other character is literal. See globMatches for why
 * this is not RegExp-based.
 */
export function matchesLeaderPattern(pattern: string, name: string): boolean {
  if (!isGlobPattern(pattern)) return pattern === name;
  return globMatches(compileGlob(pattern), Array.from(name));
}

/** Build a predicate matching a name against any of the given patterns. */
export function leaderMatcher(patterns: readonly string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const globs: CompiledGlob[] = [];
  for (const pattern of patterns) {
    if (isGlobPattern(pattern)) globs.push(compileGlob(pattern));
    else exact.add(pattern);
  }
  return (name) => {
    if (exact.has(name)) return true;
    if (globs.length === 0) return false;
    const chars = Array.from(name);
    return globs.some((glob) => globMatches(glob, chars));
  };
}

export type LeaderPatternsValidation =
  | { ok: true; patterns: string[] }
  | { ok: false; message: string };

/**
 * Validate and normalize a `patterns` value: an array of at most
 * MAX_LEADER_PATTERNS strings, each trimmed, non-empty, at most
 * MAX_LEADER_PATTERN_LENGTH code points, free of control characters.
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
    if (codePointLength(pattern) > MAX_LEADER_PATTERN_LENGTH) {
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

/** Count Unicode code points, so an astral character counts once. */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
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

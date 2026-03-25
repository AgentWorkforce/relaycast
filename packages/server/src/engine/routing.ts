import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, routingConfigs, routingFailures } from '../db/schema.js';
import { buildFtsQuery } from './searchQuery.js';

type Db = ReturnType<typeof getDb>;

export interface RoutingWeights {
  skill_match: number;
  message_match: number;
  tag_match: number;
  rating: number;
  availability: number;
}

export interface RoutingConfig {
  weights: RoutingWeights;
  circuit_breaker_threshold: number;
  circuit_breaker_cooldown_seconds: number;
  updated_at: string | null;
}

interface CandidateRow {
  agent_id: string;
  agent_name: string;
  agent_status: string;
  agent_last_seen: number;
  directory_status: string;
  rating_sum: number;
  rating_count: number;
  skill_name: string;
  skill_description: string | null;
  skill_tags: string;
  agent_tags: string;
  skill_rank: number | null;
  agent_rank: number | null;
  consecutive_failures: number | null;
  total_failures: number | null;
  total_successes: number | null;
  circuit_open_until: number | null;
}

const DEFAULT_WEIGHTS: RoutingWeights = {
  skill_match: 0.45,
  message_match: 0.2,
  tag_match: 0.15,
  rating: 0.1,
  availability: 0.1,
};

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_SECONDS = 300;

function normalizeText(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

function tokenize(value?: string | null): string[] {
  return [...new Set(
    normalizeText(value)
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter(Boolean),
  )];
}

function normalizeTags(tags?: string[]): string[] {
  return [...new Set(
    (tags || [])
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toIso(date?: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function createError(message: string, code: string, status: number) {
  const err = new Error(message);
  Object.assign(err, { code, status });
  return err;
}

function withDefaultWeights(value: unknown): RoutingWeights {
  if (!value || typeof value !== 'object') return { ...DEFAULT_WEIGHTS };
  const candidate = value as Partial<RoutingWeights>;
  return {
    skill_match: typeof candidate.skill_match === 'number' ? candidate.skill_match : DEFAULT_WEIGHTS.skill_match,
    message_match: typeof candidate.message_match === 'number' ? candidate.message_match : DEFAULT_WEIGHTS.message_match,
    tag_match: typeof candidate.tag_match === 'number' ? candidate.tag_match : DEFAULT_WEIGHTS.tag_match,
    rating: typeof candidate.rating === 'number' ? candidate.rating : DEFAULT_WEIGHTS.rating,
    availability: typeof candidate.availability === 'number' ? candidate.availability : DEFAULT_WEIGHTS.availability,
  };
}

function normalizeWeights(weights: RoutingWeights): RoutingWeights {
  const total = Object.values(weights).reduce((sum, value) => sum + Math.max(value, 0), 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };

  return {
    skill_match: Number((Math.max(weights.skill_match, 0) / total).toFixed(6)),
    message_match: Number((Math.max(weights.message_match, 0) / total).toFixed(6)),
    tag_match: Number((Math.max(weights.tag_match, 0) / total).toFixed(6)),
    rating: Number((Math.max(weights.rating, 0) / total).toFixed(6)),
    availability: Number((Math.max(weights.availability, 0) / total).toFixed(6)),
  };
}

function availabilityScore(status: string, lastSeenEpochSeconds: number): number {
  if (status === 'offline') return 0;
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - lastSeenEpochSeconds);
  if (ageSeconds <= 60) return 1;
  if (ageSeconds <= 300) return 0.8;
  if (ageSeconds <= 900) return 0.5;
  return status === 'away' ? 0.35 : 0.2;
}

function skillMatchScore(skillQuery: string, row: CandidateRow): number {
  const query = normalizeText(skillQuery);
  const name = normalizeText(row.skill_name);
  const tags = normalizeTags([
    ...safeJsonArray(row.skill_tags),
    ...safeJsonArray(row.agent_tags),
  ]);

  if (!query) return 0;
  if (name === query) return 1;

  const queryTokens = tokenize(query);
  const nameTokens = tokenize(name);
  const overlap = queryTokens.filter((token) => nameTokens.includes(token) || tags.includes(token)).length;
  const partial = queryTokens.length ? overlap / queryTokens.length : 0;

  if (name.includes(query)) return Math.max(0.85, partial);
  if (tags.includes(query)) return Math.max(0.75, partial);
  return Math.min(1, partial);
}

function tagMatchScore(skillQuery: string, message: string, row: CandidateRow): number {
  const requestTags = tokenize(`${skillQuery} ${message}`);
  if (requestTags.length === 0) return 0;

  const candidateTags = new Set(normalizeTags([
    ...safeJsonArray(row.skill_tags),
    ...safeJsonArray(row.agent_tags),
  ]));

  const matches = requestTags.filter((token) => candidateTags.has(token)).length;
  return matches / requestTags.length;
}

function textMatchScore(row: CandidateRow): number {
  const skillRank = row.skill_rank === null ? 0 : 1 / (1 + Math.abs(row.skill_rank));
  const agentRank = row.agent_rank === null ? 0 : 1 / (1 + Math.abs(row.agent_rank));
  return Math.max(skillRank, agentRank);
}

function ratingScore(row: CandidateRow): number {
  if (!row.rating_count) return 0;
  return Math.min(1, (row.rating_sum / row.rating_count) / 5);
}

export async function getRoutingConfig(db: Db, workspaceId: string): Promise<RoutingConfig> {
  const [row] = await db
    .select()
    .from(routingConfigs)
    .where(eq(routingConfigs.workspaceId, workspaceId));

  return {
    weights: normalizeWeights(withDefaultWeights(row?.weights)),
    circuit_breaker_threshold: row?.circuitBreakerThreshold ?? DEFAULT_THRESHOLD,
    circuit_breaker_cooldown_seconds: row?.circuitBreakerCooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
    updated_at: toIso(row?.updatedAt),
  };
}

export async function setRoutingConfig(
  db: Db,
  workspaceId: string,
  input: Partial<{
    weights: Partial<RoutingWeights>;
    circuit_breaker_threshold: number;
    circuit_breaker_cooldown_seconds: number;
  }>,
): Promise<RoutingConfig> {
  const current = await getRoutingConfig(db, workspaceId);
  const weights = normalizeWeights(withDefaultWeights(input.weights || current.weights));
  const circuitBreakerThreshold = input.circuit_breaker_threshold ?? current.circuit_breaker_threshold;
  const circuitBreakerCooldownSeconds = input.circuit_breaker_cooldown_seconds ?? current.circuit_breaker_cooldown_seconds;
  const now = new Date();

  await db
    .insert(routingConfigs)
    .values({
      workspaceId,
      weights,
      circuitBreakerThreshold,
      circuitBreakerCooldownSeconds,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: routingConfigs.workspaceId,
      set: {
        weights,
        circuitBreakerThreshold,
        circuitBreakerCooldownSeconds,
        updatedAt: now,
      },
    });

  return {
    weights,
    circuit_breaker_threshold: circuitBreakerThreshold,
    circuit_breaker_cooldown_seconds: circuitBreakerCooldownSeconds,
    updated_at: now.toISOString(),
  };
}

export async function searchSkills(
  db: Db,
  workspaceId: string,
  opts: { q?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
  const ftsQuery = opts.q ? buildFtsQuery(opts.q) : null;
  const rows = await db.all<{
    agent_name: string;
    skill_name: string;
    skill_description: string | null;
    skill_tags: string;
    rank: number | null;
  }>(sql`
    SELECT
      a.name AS agent_name,
      ds.name AS skill_name,
      ds.description AS skill_description,
      ds.tags AS skill_tags,
      ${ftsQuery ? sql`bm25(directory_skills_fts)` : sql`NULL`} AS rank
    FROM directory_skills ds
    INNER JOIN directory_agents da ON da.id = ds.directory_agent_id
    INNER JOIN agents a ON a.id = da.source_agent_id
    ${ftsQuery ? sql`INNER JOIN directory_skills_fts ON directory_skills_fts.rowid = ds.rowid` : sql``}
    WHERE da.workspace_id = ${workspaceId}
      AND da.status = 'active'
      ${ftsQuery ? sql`AND directory_skills_fts MATCH ${ftsQuery}` : sql``}
    ORDER BY ${ftsQuery ? sql`bm25(directory_skills_fts) ASC,` : sql``} a.name ASC, ds.position ASC
    LIMIT ${limit}
  `);

  return rows.map((row) => ({
    agent_name: row.agent_name,
    skill_name: row.skill_name,
    description: row.skill_description,
    tags: safeJsonArray(row.skill_tags),
    relevance_score: row.rank === null ? 0 : Number((1 / (1 + Math.abs(row.rank))).toFixed(4)),
  }));
}

export async function recordRoutingSuccess(
  db: Db,
  workspaceId: string,
  agentName: string,
) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));

  if (!agent) {
    throw createError(`Agent "${agentName}" not found`, 'agent_not_found', 404);
  }

  const now = new Date();
  await db
    .insert(routingFailures)
    .values({
      workspaceId,
      agentId: agent.id,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 1,
      lastSuccessAt: now,
      circuitOpenUntil: null,
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [routingFailures.workspaceId, routingFailures.agentId],
      set: {
        consecutiveFailures: 0,
        totalSuccesses: sql`${routingFailures.totalSuccesses} + 1`,
        lastSuccessAt: now,
        circuitOpenUntil: null,
        lastError: null,
        updatedAt: now,
      },
    });

  return { ok: true };
}

export async function recordRoutingFailure(
  db: Db,
  workspaceId: string,
  agentName: string,
  errorMessage?: string,
) {
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, agentName)));

  if (!agent) {
    throw createError(`Agent "${agentName}" not found`, 'agent_not_found', 404);
  }

  const config = await getRoutingConfig(db, workspaceId);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(routingFailures)
    .where(and(eq(routingFailures.workspaceId, workspaceId), eq(routingFailures.agentId, agent.id)));

  const nextConsecutiveFailures = (existing?.consecutiveFailures ?? 0) + 1;
  const circuitOpenUntil = nextConsecutiveFailures >= config.circuit_breaker_threshold
    ? new Date(now.getTime() + config.circuit_breaker_cooldown_seconds * 1000)
    : null;

  await db
    .insert(routingFailures)
    .values({
      workspaceId,
      agentId: agent.id,
      consecutiveFailures: nextConsecutiveFailures,
      totalFailures: (existing?.totalFailures ?? 0) + 1,
      totalSuccesses: existing?.totalSuccesses ?? 0,
      lastFailureAt: now,
      circuitOpenUntil,
      lastError: errorMessage || null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [routingFailures.workspaceId, routingFailures.agentId],
      set: {
        consecutiveFailures: nextConsecutiveFailures,
        totalFailures: sql`${routingFailures.totalFailures} + 1`,
        lastFailureAt: now,
        circuitOpenUntil,
        lastError: errorMessage || null,
        updatedAt: now,
      },
    });

  return {
    ok: true,
    circuit_open_until: circuitOpenUntil?.toISOString() || null,
  };
}

export async function routeBySkill(
  db: Db,
  workspaceId: string,
  skill: string,
  message: string,
): Promise<{
  agentName: string;
  score: number;
  fallback: boolean;
}> {
  const normalizedSkill = normalizeText(skill);
  if (!normalizedSkill) {
    throw createError('skill is required', 'invalid_request', 400);
  }

  const config = await getRoutingConfig(db, workspaceId);
  const ftsQuery = buildFtsQuery([skill, message].filter(Boolean).join(' '));

  // D1 does not support bm25() with GROUP BY / aggregate context, so fetch
  // individual FTS match rows and compute min rank per entity in JS.
  const [skillFtsRaw, agentFtsRaw, baseRows] = await Promise.all([
    db.all<{ skill_id: string; rank: number }>(sql`
      SELECT ds.id AS skill_id, bm25(directory_skills_fts) AS rank
      FROM directory_skills_fts
      JOIN directory_skills ds ON ds.rowid = directory_skills_fts.rowid
      JOIN directory_agents da ON da.id = ds.directory_agent_id
      WHERE directory_skills_fts MATCH ${ftsQuery}
        AND da.workspace_id = ${workspaceId}
    `),
    db.all<{ directory_agent_id: string; rank: number }>(sql`
      SELECT da.id AS directory_agent_id, bm25(directory_agents_fts) AS rank
      FROM directory_agents_fts
      JOIN directory_agents da ON da.rowid = directory_agents_fts.rowid
      WHERE directory_agents_fts MATCH ${ftsQuery}
        AND da.workspace_id = ${workspaceId}
    `),
    db.all<Omit<CandidateRow, 'skill_rank' | 'agent_rank'> & { directory_agent_id: string; skill_id: string }>(sql`
      SELECT
        a.id AS agent_id,
        a.name AS agent_name,
        a.status AS agent_status,
        unixepoch(a.last_seen) AS agent_last_seen,
        da.status AS directory_status,
        da.id AS directory_agent_id,
        ds.id AS skill_id,
        da.rating_sum AS rating_sum,
        da.rating_count AS rating_count,
        ds.name AS skill_name,
        ds.description AS skill_description,
        ds.tags AS skill_tags,
        da.tags AS agent_tags,
        rf.consecutive_failures AS consecutive_failures,
        rf.total_failures AS total_failures,
        rf.total_successes AS total_successes,
        unixepoch(rf.circuit_open_until) AS circuit_open_until
      FROM directory_agents da
      INNER JOIN directory_skills ds ON ds.directory_agent_id = da.id
      INNER JOIN agents a ON a.id = da.source_agent_id
      LEFT JOIN routing_failures rf ON rf.workspace_id = da.workspace_id AND rf.agent_id = a.id
      WHERE da.workspace_id = ${workspaceId}
        AND da.status = 'active'
        AND a.status != 'offline'
      ORDER BY a.name ASC, ds.position ASC
    `),
  ]);

  const skillRankMap = new Map<string, number>();
  for (const m of skillFtsRaw) {
    const cur = skillRankMap.get(m.skill_id);
    if (cur === undefined || m.rank < cur) skillRankMap.set(m.skill_id, m.rank);
  }
  const agentRankMap = new Map<string, number>();
  for (const m of agentFtsRaw) {
    const cur = agentRankMap.get(m.directory_agent_id);
    if (cur === undefined || m.rank < cur) agentRankMap.set(m.directory_agent_id, m.rank);
  }

  const rows: CandidateRow[] = baseRows.map((row) => ({
    ...row,
    skill_rank: skillRankMap.get(row.skill_id) ?? null,
    agent_rank: agentRankMap.get(row.directory_agent_id) ?? null,
  }));

  if (rows.length === 0) {
    throw createError(`No active agents found for skill "${skill}"`, 'route_not_found', 404);
  }

  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  const candidates = rows
    .filter((row) => row.circuit_open_until === null || row.circuit_open_until <= nowEpochSeconds)
    .map((row) => {
      const exactSkill = skillMatchScore(skill, row);
      const messageScore = textMatchScore(row);
      const tagScore = tagMatchScore(skill, message, row);
      const rating = ratingScore(row);
      const availability = availabilityScore(row.agent_status, row.agent_last_seen);
      const weightedScore = (
        exactSkill * config.weights.skill_match
        + messageScore * config.weights.message_match
        + tagScore * config.weights.tag_match
        + rating * config.weights.rating
        + availability * config.weights.availability
      );

      return {
        row,
        exactSkill,
        weightedScore: Number(weightedScore.toFixed(6)),
      };
    })
    .filter((candidate) => candidate.exactSkill > 0 || candidate.weightedScore >= 0.2)
    .sort((left, right) =>
      right.weightedScore - left.weightedScore
      || right.exactSkill - left.exactSkill
      || left.row.agent_name.localeCompare(right.row.agent_name));

  if (candidates.length === 0) {
    throw createError(`No healthy agents found for skill "${skill}"`, 'route_not_found', 404);
  }

  const best = candidates[0];
  return {
    agentName: best.row.agent_name,
    score: Number(best.weightedScore.toFixed(4)),
    fallback: best.exactSkill < 0.999,
  };
}

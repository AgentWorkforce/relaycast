import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { agents, directoryAgents, directoryRatings, directorySkills } from '../db/schema.js';
import { buildFtsQuery } from './searchQuery.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

export interface DirectorySkillInput {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface SourceAgentSkillMetadata {
  id?: string;
  name?: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DirectoryAgentInput {
  source_agent_name?: string;
  slug?: string;
  name: string;
  description?: string;
  provider?: string;
  endpoint_url?: string;
  documentation_url?: string;
  version?: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: string;
  skills?: DirectorySkillInput[];
}

export interface DirectoryAgentUpdateInput {
  source_agent_name?: string | null;
  slug?: string;
  name?: string;
  description?: string | null;
  provider?: string | null;
  endpoint_url?: string | null;
  documentation_url?: string | null;
  version?: string | null;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: string;
  skills?: DirectorySkillInput[];
}

export interface DirectoryRatingInput {
  rater_agent_id: string;
  score: number;
  review?: string;
}

type DirectoryAgentRow = typeof directoryAgents.$inferSelect;
type DirectorySkillRow = typeof directorySkills.$inferSelect;

function createError(message: string, code: string, status: number) {
  const err = new Error(message);
  Object.assign(err, { code, status });
  return err;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalizeTags(tags?: string[]): string[] {
  return [...new Set((tags || [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean))];
}

function parseSourceAgentSkills(metadata?: Record<string, unknown>): DirectorySkillInput[] {
  const rawSkills = metadata?.skills;
  if (!Array.isArray(rawSkills)) return [];

  const skills: DirectorySkillInput[] = [];
  for (const value of rawSkills) {
    if (!value || typeof value !== 'object') continue;
    const skill = value as SourceAgentSkillMetadata;
    if (typeof skill.name !== 'string' || !skill.name.trim()) continue;
    skills.push({
      id: typeof skill.id === 'string' && skill.id.trim() ? skill.id.trim() : undefined,
      name: skill.name.trim(),
      description: typeof skill.description === 'string' ? skill.description : undefined,
      tags: Array.isArray(skill.tags)
        ? skill.tags.filter((tag): tag is string => typeof tag === 'string')
        : undefined,
      metadata: skill.metadata && typeof skill.metadata === 'object'
        ? skill.metadata
        : undefined,
    });
  }
  return skills;
}

function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function ratingAverage(row: Pick<DirectoryAgentRow, 'ratingSum' | 'ratingCount'>): number {
  if (!row.ratingCount) return 0;
  return Number((row.ratingSum / row.ratingCount).toFixed(2));
}

async function resolveSourceAgentId(
  db: Db,
  workspaceId: string,
  sourceAgentName?: string | null,
): Promise<string | null> {
  if (sourceAgentName === undefined) return null;
  if (sourceAgentName === null) return null;

  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, sourceAgentName)));

  if (!agent) {
    throw createError(`Agent "${sourceAgentName}" not found`, 'agent_not_found', 404);
  }

  return agent.id;
}

async function syncSkills(
  db: Db,
  workspaceId: string,
  directoryAgentId: string,
  skills: DirectorySkillInput[],
) {
  await db.delete(directorySkills).where(eq(directorySkills.directoryAgentId, directoryAgentId));

  if (!skills.length) return;

  await db.insert(directorySkills).values(
    skills.map((skill, index) => ({
      id: `dskill_${generateId()}`,
      workspaceId,
      directoryAgentId,
      skillId: skill.id || null,
      name: skill.name,
      description: skill.description || null,
      tags: normalizeTags(skill.tags),
      metadata: skill.metadata || {},
      position: index,
    })),
  );
}

async function recalculateRatingSummary(db: Db, directoryAgentId: string) {
  const rows = await db
    .select({
      score: directoryRatings.score,
    })
    .from(directoryRatings)
    .where(eq(directoryRatings.directoryAgentId, directoryAgentId));

  const ratingSum = rows.reduce((total, row) => total + row.score, 0);
  const ratingCount = rows.length;

  await db
    .update(directoryAgents)
    .set({
      ratingSum,
      ratingCount,
      updatedAt: new Date(),
    })
    .where(eq(directoryAgents.id, directoryAgentId));
}

async function loadSkills(
  db: Db,
  directoryAgentIds: string[],
): Promise<Map<string, Array<{
  id: string;
  skill_id: string | null;
  name: string;
  description: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}>>> {
  const skillsByAgent = new Map<string, Array<{
    id: string;
    skill_id: string | null;
    name: string;
    description: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
  }>>();

  if (!directoryAgentIds.length) return skillsByAgent;

  const rows = await db
    .select()
    .from(directorySkills)
    .where(inArray(directorySkills.directoryAgentId, directoryAgentIds))
    .orderBy(asc(directorySkills.position));

  for (const row of rows) {
    const item = {
      id: row.id,
      skill_id: row.skillId,
      name: row.name,
      description: row.description,
      tags: row.tags || [],
      metadata: (row.metadata || {}) as Record<string, unknown>,
    };

    const list = skillsByAgent.get(row.directoryAgentId) || [];
    list.push(item);
    skillsByAgent.set(row.directoryAgentId, list);
  }

  return skillsByAgent;
}

function serializeDirectoryAgent(
  row: DirectoryAgentRow,
  skills: Array<{
    id: string;
    skill_id: string | null;
    name: string;
    description: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
  }> = [],
) {
  return {
    id: row.id,
    source_agent_id: row.sourceAgentId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    provider: row.provider,
    endpoint_url: row.endpointUrl,
    documentation_url: row.documentationUrl,
    version: row.version,
    tags: row.tags || [],
    capabilities: (row.capabilities || {}) as Record<string, unknown>,
    metadata: (row.metadata || {}) as Record<string, unknown>,
    status: row.status,
    rating_avg: ratingAverage(row),
    rating_count: row.ratingCount,
    skills,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function getDirectoryAgentRow(
  db: Db,
  workspaceId: string,
  slug: string,
) {
  const [row] = await db
    .select()
    .from(directoryAgents)
    .where(and(eq(directoryAgents.workspaceId, workspaceId), eq(directoryAgents.slug, slug)));

  return row || null;
}

export async function createDirectoryAgent(
  db: Db,
  workspaceId: string,
  data: DirectoryAgentInput,
) {
  const slug = slugify(data.slug || data.name);
  if (!slug) {
    throw createError('slug could not be derived from name', 'invalid_request', 400);
  }

  const sourceAgentId = await resolveSourceAgentId(db, workspaceId, data.source_agent_name);
  const now = new Date();

  const [row] = await db
    .insert(directoryAgents)
    .values({
      id: `dir_${generateId()}`,
      workspaceId,
      sourceAgentId,
      slug,
      name: data.name,
      description: data.description || null,
      provider: data.provider || null,
      endpointUrl: data.endpoint_url || null,
      documentationUrl: data.documentation_url || null,
      version: data.version || null,
      tags: normalizeTags(data.tags),
      capabilities: data.capabilities || {},
      metadata: data.metadata || {},
      status: data.status || 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await syncSkills(db, workspaceId, row.id, data.skills || []);
  return getDirectoryAgent(db, workspaceId, row.slug);
}

export async function listDirectoryAgents(
  db: Db,
  workspaceId: string,
  opts?: { status?: string; limit?: number },
) {
  const rows = await db
    .select()
    .from(directoryAgents)
    .where(
      and(
        eq(directoryAgents.workspaceId, workspaceId),
        opts?.status ? eq(directoryAgents.status, opts.status) : undefined,
      ),
    )
    .orderBy(desc(directoryAgents.ratingCount), asc(directoryAgents.slug))
    .limit(Math.min(Math.max(opts?.limit || 50, 1), 100));

  const skillsByAgent = await loadSkills(db, rows.map((row) => row.id));
  return rows.map((row) => serializeDirectoryAgent(row, skillsByAgent.get(row.id) || []));
}

export async function getDirectoryAgent(
  db: Db,
  workspaceId: string,
  slug: string,
) {
  const row = await getDirectoryAgentRow(db, workspaceId, slug);
  if (!row) return null;

  const skillsByAgent = await loadSkills(db, [row.id]);
  return serializeDirectoryAgent(row, skillsByAgent.get(row.id) || []);
}

export async function updateDirectoryAgent(
  db: Db,
  workspaceId: string,
  slug: string,
  data: DirectoryAgentUpdateInput,
) {
  const existing = await getDirectoryAgentRow(db, workspaceId, slug);
  if (!existing) return null;

  const nextSlug = data.slug || (data.name ? slugify(data.name) : existing.slug);
  if (!nextSlug) {
    throw createError('slug could not be derived from name', 'invalid_request', 400);
  }

  const sourceAgentId = data.source_agent_name === undefined
    ? existing.sourceAgentId
    : await resolveSourceAgentId(db, workspaceId, data.source_agent_name);

  const [updated] = await db
    .update(directoryAgents)
    .set({
      sourceAgentId,
      slug: nextSlug,
      name: data.name ?? existing.name,
      description: data.description === undefined ? existing.description : data.description,
      provider: data.provider === undefined ? existing.provider : data.provider,
      endpointUrl: data.endpoint_url === undefined ? existing.endpointUrl : data.endpoint_url,
      documentationUrl: data.documentation_url === undefined ? existing.documentationUrl : data.documentation_url,
      version: data.version === undefined ? existing.version : data.version,
      tags: data.tags === undefined ? existing.tags : normalizeTags(data.tags),
      capabilities: data.capabilities === undefined ? existing.capabilities : data.capabilities,
      metadata: data.metadata === undefined ? existing.metadata : data.metadata,
      status: data.status ?? existing.status,
      updatedAt: new Date(),
    })
    .where(eq(directoryAgents.id, existing.id))
    .returning();

  if (data.skills) {
    await syncSkills(db, workspaceId, existing.id, data.skills);
  }

  return getDirectoryAgent(db, workspaceId, updated.slug);
}

export async function deleteDirectoryAgent(
  db: Db,
  workspaceId: string,
  slug: string,
) {
  const deleted = await db
    .delete(directoryAgents)
    .where(and(eq(directoryAgents.workspaceId, workspaceId), eq(directoryAgents.slug, slug)))
    .returning({ id: directoryAgents.id });

  return deleted.length > 0;
}

export async function listDirectoryRatings(
  db: Db,
  workspaceId: string,
  slug: string,
) {
  const row = await getDirectoryAgentRow(db, workspaceId, slug);
  if (!row) {
    throw createError(`Directory agent "${slug}" not found`, 'directory_agent_not_found', 404);
  }

  const ratings = await db
    .select({
      id: directoryRatings.id,
      score: directoryRatings.score,
      review: directoryRatings.review,
      createdAt: directoryRatings.createdAt,
      updatedAt: directoryRatings.updatedAt,
      raterAgentId: directoryRatings.raterAgentId,
      raterAgentName: agents.name,
    })
    .from(directoryRatings)
    .innerJoin(agents, eq(directoryRatings.raterAgentId, agents.id))
    .where(eq(directoryRatings.directoryAgentId, row.id))
    .orderBy(desc(directoryRatings.updatedAt));

  return ratings.map((rating) => ({
    id: rating.id,
    score: rating.score,
    review: rating.review,
    rater_agent_id: rating.raterAgentId,
    rater_agent_name: rating.raterAgentName,
    created_at: rating.createdAt.toISOString(),
    updated_at: rating.updatedAt.toISOString(),
  }));
}

export async function upsertDirectoryRating(
  db: Db,
  workspaceId: string,
  slug: string,
  data: DirectoryRatingInput,
) {
  const row = await getDirectoryAgentRow(db, workspaceId, slug);
  if (!row) {
    throw createError(`Directory agent "${slug}" not found`, 'directory_agent_not_found', 404);
  }

  const [existingRating] = await db
    .select()
    .from(directoryRatings)
    .where(
      and(
        eq(directoryRatings.directoryAgentId, row.id),
        eq(directoryRatings.raterAgentId, data.rater_agent_id),
      ),
    );

  const now = new Date();
  let saved;

  if (existingRating) {
    [saved] = await db
      .update(directoryRatings)
      .set({
        score: data.score,
        review: data.review || null,
        updatedAt: now,
      })
      .where(eq(directoryRatings.id, existingRating.id))
      .returning();
  } else {
    [saved] = await db
      .insert(directoryRatings)
      .values({
        id: `drate_${generateId()}`,
        workspaceId,
        directoryAgentId: row.id,
        raterAgentId: data.rater_agent_id,
        score: data.score,
        review: data.review || null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  }

  await recalculateRatingSummary(db, row.id);

  const [rater] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, saved.raterAgentId));

  return {
    id: saved.id,
    score: saved.score,
    review: saved.review,
    rater_agent_id: saved.raterAgentId,
    rater_agent_name: rater?.name || 'unknown',
    created_at: saved.createdAt.toISOString(),
    updated_at: saved.updatedAt.toISOString(),
  };
}

export async function searchDirectory(
  db: Db,
  workspaceId: string,
  opts: {
    q?: string;
    tags?: string[];
    status?: string;
    limit?: number;
  },
) {
  const tags = normalizeTags(opts.tags);
  const ftsQuery = opts.q ? buildFtsQuery(opts.q) : null;

  if (!ftsQuery && tags.length === 0) {
    return [];
  }

  const limit = Math.min(Math.max(opts.limit || 20, 1), 100);
  const statusFilter = opts.status || 'active';

  const agentMatchWhere = ftsQuery
    ? sql`directory_agents_fts MATCH ${ftsQuery}`
    : sql`1 = 0`;
  const skillMatchWhere = ftsQuery
    ? sql`directory_skills_fts MATCH ${ftsQuery}`
    : sql`1 = 0`;
  const matchFilter = ftsQuery
    ? sql`agent_matches.directory_agent_id IS NOT NULL OR skill_matches.directory_agent_id IS NOT NULL`
    : sql`1 = 1`;

  const rows = await db.all<{
    id: string;
    workspace_id: string;
    source_agent_id: string | null;
    slug: string;
    name: string;
    description: string | null;
    provider: string | null;
    endpoint_url: string | null;
    documentation_url: string | null;
    version: string | null;
    tags: string;
    capabilities: string;
    metadata: string;
    status: string;
    rating_sum: number;
    rating_count: number;
    created_at: number;
    updated_at: number;
    agent_rank: number | null;
    skill_rank: number | null;
  }>(sql`
    WITH agent_matches AS (
      SELECT da.id AS directory_agent_id, MIN(bm25(directory_agents_fts)) AS rank
      FROM directory_agents_fts
      JOIN directory_agents da ON da.rowid = directory_agents_fts.rowid
      WHERE ${agentMatchWhere}
        AND da.workspace_id = ${workspaceId}
      GROUP BY da.id
    ),
    skill_matches AS (
      SELECT ds.directory_agent_id AS directory_agent_id, MIN(bm25(directory_skills_fts)) AS rank
      FROM directory_skills_fts
      JOIN directory_skills ds ON ds.rowid = directory_skills_fts.rowid
      JOIN directory_agents da ON da.id = ds.directory_agent_id
      WHERE ${skillMatchWhere}
        AND da.workspace_id = ${workspaceId}
      GROUP BY ds.directory_agent_id
    )
    SELECT
      da.id,
      da.workspace_id,
      da.source_agent_id,
      da.slug,
      da.name,
      da.description,
      da.provider,
      da.endpoint_url,
      da.documentation_url,
      da.version,
      da.tags,
      da.capabilities,
      da.metadata,
      da.status,
      da.rating_sum,
      da.rating_count,
      da.created_at,
      da.updated_at,
      agent_matches.rank AS agent_rank,
      skill_matches.rank AS skill_rank
    FROM directory_agents da
    LEFT JOIN agent_matches ON agent_matches.directory_agent_id = da.id
    LEFT JOIN skill_matches ON skill_matches.directory_agent_id = da.id
    WHERE da.workspace_id = ${workspaceId}
      AND da.status = ${statusFilter}
      AND (
        ${matchFilter}
      )
    ORDER BY
      COALESCE(agent_matches.rank, 999999) ASC,
      COALESCE(skill_matches.rank, 999999) ASC,
      da.rating_count DESC,
      da.slug ASC
    LIMIT ${ftsQuery ? Math.max(limit * 3, limit) : Math.max(limit * 10, 250)}
  `);

  const hydratedRows: DirectoryAgentRow[] = rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    sourceAgentId: row.source_agent_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    provider: row.provider,
    endpointUrl: row.endpoint_url,
    documentationUrl: row.documentation_url,
    version: row.version,
    tags: JSON.parse(row.tags || '[]'),
    capabilities: JSON.parse(row.capabilities || '{}'),
    metadata: JSON.parse(row.metadata || '{}'),
    status: row.status,
    ratingSum: row.rating_sum,
    ratingCount: row.rating_count,
    createdAt: new Date(row.created_at * 1000),
    updatedAt: new Date(row.updated_at * 1000),
  }));

  const skillsByAgent = await loadSkills(db, hydratedRows.map((row) => row.id));

  const filtered = hydratedRows.filter((row) => {
    if (tags.length === 0) return true;
    const skills = skillsByAgent.get(row.id) || [];
    const allTags = new Set([
      ...normalizeTags(row.tags),
      ...skills.flatMap((skill) => normalizeTags(skill.tags)),
    ]);
    return tags.some((tag) => allTags.has(tag));
  });

  const enriched = filtered.map((row) => {
    const skills = skillsByAgent.get(row.id) || [];
    const agentSkillTags = new Set([
      ...normalizeTags(row.tags),
      ...skills.flatMap((skill) => normalizeTags(skill.tags)),
    ]);
    const tagMatches = tags.filter((tag) => agentSkillTags.has(tag)).length;
    const rankRow = rows.find((candidate) => candidate.id === row.id);
    const agentRank = rankRow?.agent_rank ?? null;
    const skillRank = rankRow?.skill_rank ?? null;
    const agentTextScore = agentRank === null ? 0 : 1 / (1 + Math.abs(agentRank));
    const skillTextScore = skillRank === null ? 0 : 1 / (1 + Math.abs(skillRank));
    const ratingScore = row.ratingCount === 0 ? 0 : (row.ratingSum / row.ratingCount) / 5;
    const relevanceScore = Number((agentTextScore * 0.5 + skillTextScore * 0.25 + tagMatches * 0.15 + ratingScore * 0.1).toFixed(4));

    return {
      ...serializeDirectoryAgent(row, skills),
      relevance_score: relevanceScore,
    };
  });

  enriched.sort((a, b) => b.relevance_score - a.relevance_score || b.rating_count - a.rating_count || a.slug.localeCompare(b.slug));
  return enriched.slice(0, limit);
}

export async function syncSourceAgentDirectoryEntry(
  db: Db,
  workspaceId: string,
  sourceAgent: {
    id: string;
    name: string;
    status?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const metadata = (sourceAgent.metadata || {}) as Record<string, unknown>;
  const skills = parseSourceAgentSkills(metadata);

  if (skills.length === 0) {
    await db
      .delete(directoryAgents)
      .where(and(
        eq(directoryAgents.workspaceId, workspaceId),
        eq(directoryAgents.sourceAgentId, sourceAgent.id),
      ));
    return null;
  }

  const slug = slugify(sourceAgent.name);
  if (!slug) {
    throw createError('slug could not be derived from source agent name', 'invalid_request', 400);
  }

  const tags = normalizeTags([
    ...(Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : []),
    ...skills.flatMap((skill) => skill.tags || []),
  ]);

  const description = typeof metadata.description === 'string'
    ? metadata.description
    : `Auto-synced workspace agent ${sourceAgent.name}`;
  const provider = typeof metadata.provider === 'string' ? metadata.provider : 'relaycast';
  const capabilities = metadata.capabilities && typeof metadata.capabilities === 'object'
    ? metadata.capabilities as Record<string, unknown>
    : {};

  const existing = await db
    .select()
    .from(directoryAgents)
    .where(and(
      eq(directoryAgents.workspaceId, workspaceId),
      eq(directoryAgents.sourceAgentId, sourceAgent.id),
    ));

  const now = new Date();
  if (existing[0]) {
    await db
      .update(directoryAgents)
      .set({
        slug,
        name: sourceAgent.name,
        description,
        provider,
        tags,
        capabilities,
        metadata: {
          ...metadata,
          sync_source: 'agent_registration',
          auto_synced: true,
        },
        status: sourceAgent.status === 'offline' ? 'inactive' : 'active',
        updatedAt: now,
      })
      .where(eq(directoryAgents.id, existing[0].id));

    await syncSkills(db, workspaceId, existing[0].id, skills);
    return getDirectoryAgent(db, workspaceId, slug);
  }

  const [created] = await db
    .insert(directoryAgents)
    .values({
      id: `dir_${generateId()}`,
      workspaceId,
      sourceAgentId: sourceAgent.id,
      slug,
      name: sourceAgent.name,
      description,
      provider,
      tags,
      capabilities,
      metadata: {
        ...metadata,
        sync_source: 'agent_registration',
        auto_synced: true,
      },
      status: sourceAgent.status === 'offline' ? 'inactive' : 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await syncSkills(db, workspaceId, created.id, skills);
  return getDirectoryAgent(db, workspaceId, slug);
}

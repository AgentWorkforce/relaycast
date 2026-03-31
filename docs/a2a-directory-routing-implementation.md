# A2A Directory & Smart Routing Implementation

**Status:** Design
**Spec Sections:** 4 (Agent Registry / Directory) and 7 (Smart Routing & Agent Discovery)
**Date:** 2026-03-24

---

## 1. Overview

This document covers the implementation of two tightly coupled features:

1. **Agent Directory** -- a managed registry where agents publish capabilities and developers discover agents by skill
2. **Smart Routing** -- skill-based message routing that matches queries to the best available agent

Both features build on existing Relaycast patterns: Drizzle ORM on D1/SQLite, Hono routes with `requireAuth`/`rateLimit` middleware, Snowflake IDs, and FTS5 full-text search (already used for message search).

**Key design decision:** Tag-based matching ships in v1. Embedding-based semantic matching is deferred to v2 (see Section 9).

---

## 2. Database Migrations

### 2.1 Migration: `0005_directory_entries.sql`

```sql
-- Directory entries: public/private agent listings
CREATE TABLE `directory_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `organization` text,
  `description` text,
  `category` text,
  `tags` text DEFAULT '[]',
  `visibility` text DEFAULT 'private',
  `pricing_model` text DEFAULT 'free',
  `price_per_task` real,
  `monthly_price` real,
  `certified` integer DEFAULT 0,
  `total_tasks` integer DEFAULT 0,
  `avg_response_ms` integer DEFAULT 0,
  `success_rate` real DEFAULT 0,
  `uptime_percent` real DEFAULT 0,
  `rating` real DEFAULT 0,
  `rating_count` integer DEFAULT 0,
  `published_at` integer DEFAULT (unixepoch()),
  `updated_at` integer DEFAULT (unixepoch()),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_directory_slug` ON `directory_entries` (`slug`);
--> statement-breakpoint
CREATE INDEX `idx_directory_workspace` ON `directory_entries` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `idx_directory_category` ON `directory_entries` (`category`);
--> statement-breakpoint
CREATE INDEX `idx_directory_visibility` ON `directory_entries` (`visibility`);
--> statement-breakpoint

-- FTS5 virtual table for directory search (external content, synced via triggers)
CREATE VIRTUAL TABLE directory_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  tags,
  category,
  content=directory_entries,
  content_rowid=rowid
);
--> statement-breakpoint

-- Triggers to keep FTS in sync
CREATE TRIGGER directory_fts_insert AFTER INSERT ON directory_entries BEGIN
  INSERT INTO directory_fts(rowid, id, name, description, tags, category)
  VALUES (new.rowid, new.id, new.name, new.description, new.tags, new.category);
END;
--> statement-breakpoint
CREATE TRIGGER directory_fts_delete AFTER DELETE ON directory_entries BEGIN
  INSERT INTO directory_fts(directory_fts, rowid, id, name, description, tags, category)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.tags, old.category);
END;
--> statement-breakpoint
CREATE TRIGGER directory_fts_update AFTER UPDATE ON directory_entries BEGIN
  INSERT INTO directory_fts(directory_fts, rowid, id, name, description, tags, category)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.tags, old.category);
  INSERT INTO directory_fts(rowid, id, name, description, tags, category)
  VALUES (new.rowid, new.id, new.name, new.description, new.tags, new.category);
END;
```

### 2.2 Migration: `0006_skill_index.sql`

```sql
-- Skill index: denormalized skill records for fast tag/skill lookup
CREATE TABLE `skill_index` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `skill_id` text NOT NULL,
  `name` text NOT NULL,
  `description` text,
  `tags` text DEFAULT '[]',
  `examples` text DEFAULT '[]',
  `metadata` text DEFAULT '{}',
  `created_at` integer DEFAULT (unixepoch()),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_workspace` ON `skill_index` (`workspace_id`);
--> statement-breakpoint
CREATE INDEX `idx_skill_agent` ON `skill_index` (`agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_skill_skill_id` ON `skill_index` (`workspace_id`, `skill_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_skill_agent_skill` ON `skill_index` (`agent_id`, `skill_id`);
--> statement-breakpoint

-- FTS5 for skill search (name + description + tags)
CREATE VIRTUAL TABLE skill_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  tags,
  content=skill_index,
  content_rowid=rowid
);
--> statement-breakpoint

CREATE TRIGGER skill_fts_insert AFTER INSERT ON skill_index BEGIN
  INSERT INTO skill_fts(rowid, id, name, description, tags)
  VALUES (new.rowid, new.id, new.name, new.description, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER skill_fts_delete AFTER DELETE ON skill_index BEGIN
  INSERT INTO skill_fts(skill_fts, rowid, id, name, description, tags)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER skill_fts_update AFTER UPDATE ON skill_index BEGIN
  INSERT INTO skill_fts(skill_fts, rowid, id, name, description, tags)
  VALUES ('delete', old.rowid, old.id, old.name, old.description, old.tags);
  INSERT INTO skill_fts(rowid, id, name, description, tags)
  VALUES (new.rowid, new.id, new.name, new.description, new.tags);
END;
```

### 2.3 Migration: `0007_routing_config.sql`

```sql
-- Per-workspace routing configuration
CREATE TABLE `routing_config` (
  `id` text PRIMARY KEY NOT NULL,
  `workspace_id` text NOT NULL,
  `weight_availability` real DEFAULT 0.3,
  `weight_latency` real DEFAULT 0.2,
  `weight_success` real DEFAULT 0.25,
  `weight_cost` real DEFAULT 0.15,
  `weight_load` real DEFAULT 0.1,
  `fallback` text DEFAULT 'queue',
  `max_retries` integer DEFAULT 2,
  `timeout_ms` integer DEFAULT 30000,
  `updated_at` integer DEFAULT (unixepoch()),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_routing_config_workspace` ON `routing_config` (`workspace_id`);
```

---

## 3. Drizzle Schema Additions

Add to `packages/server/src/db/schema.ts`:

```typescript
// --- Directory ---

export const directoryEntries = sqliteTable('directory_entries', {
  id:             text('id').primaryKey(),
  workspaceId:    text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId:        text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  slug:           text('slug').notNull(),
  name:           text('name').notNull(),
  organization:   text('organization'),
  description:    text('description'),
  category:       text('category'),
  tags:           text('tags', { mode: 'json' }).$type<string[]>().default([]),
  visibility:     text('visibility').default('private'),   // 'public' | 'private' | 'listed'
  pricingModel:   text('pricing_model').default('free'),   // 'free' | 'per_task' | 'monthly'
  pricePerTask:   real('price_per_task'),
  monthlyPrice:   real('monthly_price'),
  certified:      integer('certified', { mode: 'boolean' }).default(false),
  totalTasks:     integer('total_tasks').default(0),
  avgResponseMs:  integer('avg_response_ms').default(0),
  successRate:    real('success_rate').default(0),
  uptimePercent:  real('uptime_percent').default(0),
  rating:         real('rating').default(0),
  ratingCount:    integer('rating_count').default(0),
  publishedAt:    integer('published_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt:      integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// --- Skill Index ---

export const skillIndex = sqliteTable('skill_index', {
  id:           text('id').primaryKey(),
  workspaceId:  text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  agentId:      text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  skillId:      text('skill_id').notNull(),
  name:         text('name').notNull(),
  description:  text('description'),
  tags:         text('tags', { mode: 'json' }).$type<string[]>().default([]),
  examples:     text('examples', { mode: 'json' }).$type<string[]>().default([]),
  metadata:     text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().default({}),
  createdAt:    integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// --- Routing Config ---

export const routingConfig = sqliteTable('routing_config', {
  id:                  text('id').primaryKey(),
  workspaceId:         text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  weightAvailability:  real('weight_availability').default(0.3),
  weightLatency:       real('weight_latency').default(0.2),
  weightSuccess:       real('weight_success').default(0.25),
  weightCost:          real('weight_cost').default(0.15),
  weightLoad:          real('weight_load').default(0.1),
  fallback:            text('fallback').default('queue'),       // 'queue' | 'reject' | 'any_agent'
  maxRetries:          integer('max_retries').default(2),
  timeoutMs:           integer('timeout_ms').default(30000),
  updatedAt:           integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
```

---

## 4. Engine: `directory.ts`

**File:** `packages/server/src/engine/directory.ts`

Follows the same pattern as `command.ts` and `search.ts` -- pure functions that take `(db, workspaceId, ...)`.

```typescript
import { eq, and, sql } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { directoryEntries, agents, skillIndex } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

// --- Publish to directory ---

export async function publishEntry(
  db: Db,
  workspaceId: string,
  data: {
    agent_name: string;
    name: string;
    description: string;
    category: string;
    tags?: string[];
    visibility?: 'public' | 'private' | 'listed';
    pricing_model?: 'free' | 'per_task' | 'monthly';
    price_per_task?: number;
    monthly_price?: number;
    organization?: string;
  },
) {
  // 1. Look up agent by name (same pattern as command.ts)
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.name, data.agent_name)));

  if (!agent) {
    const err = new Error(`Agent "${data.agent_name}" not found`);
    (err as any).status = 404;
    (err as any).code = 'agent_not_found';
    throw err;
  }

  // 2. Generate slug from name
  const slug = data.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  // 3. Check slug uniqueness
  const [existing] = await db
    .select({ id: directoryEntries.id })
    .from(directoryEntries)
    .where(eq(directoryEntries.slug, slug));

  if (existing) {
    const err = new Error(`Directory entry with slug "${slug}" already exists`);
    (err as any).status = 409;
    (err as any).code = 'slug_conflict';
    throw err;
  }

  // 4. Check if agent already has certification (from certifications table)
  const certified = false; // Looked up from certifications table in real impl

  // 5. Insert
  const id = `dir_${generateId()}`;
  const [entry] = await db
    .insert(directoryEntries)
    .values({
      id,
      workspaceId,
      agentId: agent.id,
      slug,
      name: data.name,
      organization: data.organization || null,
      description: data.description,
      category: data.category,
      tags: data.tags || [],
      visibility: data.visibility || 'private',
      pricingModel: data.pricing_model || 'free',
      pricePerTask: data.price_per_task ?? null,
      monthlyPrice: data.monthly_price ?? null,
      certified,
    })
    .returning();

  return formatEntry(entry, data.agent_name);
}

// --- Search directory (FTS5) ---

export async function searchDirectory(
  db: Db,
  filters: {
    q?: string;
    category?: string;
    min_rating?: number;
    certified?: boolean;
    visibility?: string;
    sort?: 'rating' | 'tasks' | 'recent';
    limit?: number;
    offset?: number;
  },
) {
  const limit = Math.min(filters.limit || 20, 100);
  const offset = filters.offset || 0;

  // If free-text query, use FTS5 MATCH
  if (filters.q) {
    // Tokenize for FTS5: "billing stripe" -> "billing OR stripe"
    const ftsQuery = filters.q
      .trim()
      .split(/\s+/)
      .map((t) => `"${t}"`)
      .join(' OR ');

    const rows = await db.all(sql`
      SELECT d.*, bm25(directory_fts) as rank
      FROM directory_fts fts
      JOIN directory_entries d ON d.id = fts.id
      WHERE directory_fts MATCH ${ftsQuery}
        ${filters.category ? sql`AND d.category = ${filters.category}` : sql``}
        ${filters.min_rating ? sql`AND d.rating >= ${filters.min_rating}` : sql``}
        ${filters.certified !== undefined ? sql`AND d.certified = ${filters.certified ? 1 : 0}` : sql``}
        AND d.visibility IN ('public', 'listed')
      ORDER BY rank
      LIMIT ${limit} OFFSET ${offset}
    `);

    return rows.map(formatEntryRow);
  }

  // No free-text query: filtered browse
  const rows = await db.all(sql`
    SELECT d.*
    FROM directory_entries d
    WHERE d.visibility IN ('public', 'listed')
      ${filters.category ? sql`AND d.category = ${filters.category}` : sql``}
      ${filters.min_rating ? sql`AND d.rating >= ${filters.min_rating}` : sql``}
      ${filters.certified !== undefined ? sql`AND d.certified = ${filters.certified ? 1 : 0}` : sql``}
    ORDER BY ${
      filters.sort === 'rating' ? sql`d.rating DESC`
      : filters.sort === 'tasks' ? sql`d.total_tasks DESC`
      : sql`d.published_at DESC`
    }
    LIMIT ${limit} OFFSET ${offset}
  `);

  return rows.map(formatEntryRow);
}

// --- Get single entry ---

export async function getEntry(db: Db, slug: string) {
  const [row] = await db
    .select()
    .from(directoryEntries)
    .where(eq(directoryEntries.slug, slug));

  if (!row) return null;

  // Also fetch skills for this agent
  const skills = await db
    .select()
    .from(skillIndex)
    .where(eq(skillIndex.agentId, row.agentId));

  return {
    ...formatEntryRow(row),
    skills: skills.map((s) => ({
      id: s.skillId,
      name: s.name,
      description: s.description,
      tags: s.tags || [],
    })),
  };
}

// --- Update entry ---

export async function updateEntry(
  db: Db,
  workspaceId: string,
  slug: string,
  data: Partial<{
    name: string;
    description: string;
    category: string;
    tags: string[];
    visibility: string;
    pricing_model: string;
    price_per_task: number;
    monthly_price: number;
    organization: string;
  }>,
) {
  // Verify ownership
  const [existing] = await db
    .select()
    .from(directoryEntries)
    .where(and(eq(directoryEntries.slug, slug), eq(directoryEntries.workspaceId, workspaceId)));

  if (!existing) {
    const err = new Error(`Directory entry "${slug}" not found`);
    (err as any).status = 404;
    (err as any).code = 'entry_not_found';
    throw err;
  }

  const updateFields: Record<string, unknown> = { updatedAt: sql`(unixepoch())` };
  if (data.name !== undefined) updateFields.name = data.name;
  if (data.description !== undefined) updateFields.description = data.description;
  if (data.category !== undefined) updateFields.category = data.category;
  if (data.tags !== undefined) updateFields.tags = JSON.stringify(data.tags);
  if (data.visibility !== undefined) updateFields.visibility = data.visibility;
  if (data.pricing_model !== undefined) updateFields.pricingModel = data.pricing_model;
  if (data.price_per_task !== undefined) updateFields.pricePerTask = data.price_per_task;
  if (data.monthly_price !== undefined) updateFields.monthlyPrice = data.monthly_price;
  if (data.organization !== undefined) updateFields.organization = data.organization;

  const [updated] = await db
    .update(directoryEntries)
    .set(updateFields)
    .where(eq(directoryEntries.id, existing.id))
    .returning();

  return formatEntryRow(updated);
}

// --- Delete entry ---

export async function deleteEntry(db: Db, workspaceId: string, slug: string) {
  const result = await db
    .delete(directoryEntries)
    .where(and(eq(directoryEntries.slug, slug), eq(directoryEntries.workspaceId, workspaceId)))
    .returning();

  return result.length > 0;
}

// --- Add directory agent to workspace ---

export async function addToWorkspace(
  db: Db,
  workspaceId: string,
  slug: string,
) {
  const entry = await getEntry(db, slug);
  if (!entry) {
    const err = new Error(`Directory entry "${slug}" not found`);
    (err as any).status = 404;
    (err as any).code = 'entry_not_found';
    throw err;
  }
  if (entry.visibility === 'private') {
    const err = new Error('Cannot add private agent');
    (err as any).status = 403;
    (err as any).code = 'visibility_private';
    throw err;
  }

  // Create a proxy agent in the target workspace pointing to the directory entry
  // (Implementation depends on how cross-workspace agent proxying works --
  //  likely similar to A2A external agent registration)
  return { slug: entry.slug, name: entry.name, added: true };
}

// --- Categories ---

export async function listCategories(db: Db) {
  const rows = await db.all(sql`
    SELECT category, COUNT(*) as count
    FROM directory_entries
    WHERE visibility IN ('public', 'listed') AND category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `);
  return rows;
}

// --- Helpers ---

function formatEntry(entry: any, agentName?: string) {
  return {
    id: entry.id,
    slug: entry.slug,
    name: entry.name,
    organization: entry.organization,
    description: entry.description,
    category: entry.category,
    tags: entry.tags || [],
    visibility: entry.visibility,
    pricing_model: entry.pricingModel,
    price_per_task: entry.pricePerTask,
    monthly_price: entry.monthlyPrice,
    certified: !!entry.certified,
    total_tasks: entry.totalTasks,
    avg_response_ms: entry.avgResponseMs,
    success_rate: entry.successRate,
    uptime_percent: entry.uptimePercent,
    rating: entry.rating,
    rating_count: entry.ratingCount,
    published_at: entry.publishedAt?.toISOString?.() || entry.published_at,
    updated_at: entry.updatedAt?.toISOString?.() || entry.updated_at,
    ...(agentName ? { agent_name: agentName } : {}),
  };
}

function formatEntryRow(row: any) {
  return formatEntry(row);
}
```

---

## 5. Engine: `routing.ts`

**File:** `packages/server/src/engine/routing.ts`

```typescript
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { skillIndex, agents, routingConfig } from '../db/schema.js';
import { generateId } from './snowflake.js';

type Db = ReturnType<typeof getDb>;

// --- Skill Indexing (called on agent registration) ---

export async function indexSkills(
  db: Db,
  workspaceId: string,
  agentId: string,
  skills: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    examples?: string[];
    metadata?: Record<string, unknown>;
  }>,
) {
  // Delete existing skills for this agent (full replace on re-registration)
  await db
    .delete(skillIndex)
    .where(eq(skillIndex.agentId, agentId));

  if (skills.length === 0) return [];

  // Batch insert
  const rows = skills.map((skill) => ({
    id: `skl_${generateId()}`,
    workspaceId,
    agentId,
    skillId: skill.id,
    name: skill.name,
    description: skill.description || null,
    tags: skill.tags || [],
    examples: skill.examples || [],
    metadata: skill.metadata || {},
  }));

  await db.insert(skillIndex).values(rows);
  return rows;
}

// --- Skill Lookup ---

export async function listSkills(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      id: skillIndex.id,
      skillId: skillIndex.skillId,
      name: skillIndex.name,
      description: skillIndex.description,
      tags: skillIndex.tags,
      agentId: skillIndex.agentId,
      agentName: agents.name,
    })
    .from(skillIndex)
    .innerJoin(agents, eq(skillIndex.agentId, agents.id))
    .where(eq(skillIndex.workspaceId, workspaceId));

  return rows.map((r) => ({
    skill_id: r.skillId,
    name: r.name,
    description: r.description,
    tags: r.tags || [],
    agent_id: r.agentId,
    agent_name: r.agentName,
  }));
}

// --- Skill Search (FTS5) ---

export async function searchSkills(
  db: Db,
  workspaceId: string,
  query: string,
) {
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((t) => `"${t}"`)
    .join(' OR ');

  const rows = await db.all(sql`
    SELECT s.*, a.name as agent_name, a.status as agent_status, bm25(skill_fts) as rank
    FROM skill_fts fts
    JOIN skill_index s ON s.id = fts.id
    JOIN agents a ON a.id = s.agent_id
    WHERE skill_fts MATCH ${ftsQuery}
      AND s.workspace_id = ${workspaceId}
    ORDER BY rank
    LIMIT 20
  `);

  return rows;
}

// --- Core Routing ---

interface RouteRequest {
  skill?: string;       // Tag match (fast path)
  query?: string;       // FTS match
  message: string;      // The message to route
}

interface ScoredAgent {
  agentId: string;
  agentName: string;
  score: number;
  matchedSkill: string;
}

export async function route(
  db: Db,
  workspaceId: string,
  request: RouteRequest,
): Promise<{ agent: ScoredAgent; fallback_agents: ScoredAgent[] } | null> {
  // 1. Find candidate agents by skill tag or FTS query
  const candidates = request.skill
    ? await findAgentsByTag(db, workspaceId, request.skill)
    : request.query
    ? await findAgentsByQuery(db, workspaceId, request.query)
    : [];

  if (candidates.length === 0) return null;

  // 2. Load routing config for workspace
  const config = await getRoutingConfig(db, workspaceId);

  // 3. Filter out offline/suspended agents
  const agentIds = [...new Set(candidates.map((c) => c.agentId))];
  const agentRows = await db
    .select()
    .from(agents)
    .where(and(
      eq(agents.workspaceId, workspaceId),
      inArray(agents.id, agentIds),
    ));

  const agentMap = new Map(agentRows.map((a) => [a.id, a]));
  const activeAgents = candidates.filter((c) => {
    const agent = agentMap.get(c.agentId);
    return agent && agent.status === 'online';
  });

  if (activeAgents.length === 0) {
    // All matched agents are offline -- apply fallback
    if (config.fallback === 'reject') return null;
    if (config.fallback === 'any_agent') {
      // Try any online agent in workspace
      // (Implementation: query agents table for any online agent)
    }
    // 'queue' fallback: return first candidate, let caller queue
    const first = candidates[0];
    return {
      agent: { ...first, score: 0 },
      fallback_agents: [],
    };
  }

  // 4. Score each candidate
  const scored: ScoredAgent[] = activeAgents.map((candidate) => {
    const agent = agentMap.get(candidate.agentId)!;
    const meta = (agent.metadata as any) || {};

    const availabilityScore = agent.status === 'online' ? 1.0 : 0.0;
    const latencyScore = meta.avg_latency_ms
      ? Math.max(0, 1.0 - meta.avg_latency_ms / 10000)
      : 0.5; // default if unknown
    const successScore = meta.success_rate ?? 0.5;
    const costScore = meta.cost_per_task
      ? Math.max(0, 1.0 - meta.cost_per_task / 1.0) // $1.00 max
      : 0.5;
    const loadScore = meta.active_tasks != null && meta.max_capacity
      ? Math.max(0, 1.0 - meta.active_tasks / meta.max_capacity)
      : 0.5;

    const total =
      config.weightAvailability * availabilityScore +
      config.weightLatency * latencyScore +
      config.weightSuccess * successScore +
      config.weightCost * costScore +
      config.weightLoad * loadScore;

    return {
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      score: Math.round(total * 1000) / 1000,
      matchedSkill: candidate.matchedSkill,
    };
  });

  // 5. Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return {
    agent: scored[0],
    fallback_agents: scored.slice(1, config.maxRetries + 1),
  };
}

// --- Tag-based agent lookup (fast path) ---

async function findAgentsByTag(
  db: Db,
  workspaceId: string,
  tag: string,
): Promise<Array<{ agentId: string; agentName: string; matchedSkill: string }>> {
  // Search skill_index for matching tags using JSON
  // D1/SQLite: use json_each to search within the tags JSON array
  const rows = await db.all(sql`
    SELECT s.agent_id, a.name as agent_name, s.name as skill_name
    FROM skill_index s
    JOIN agents a ON a.id = s.agent_id
    JOIN json_each(s.tags) t ON t.value = ${tag.toLowerCase()}
    WHERE s.workspace_id = ${workspaceId}
  `);

  return (rows as any[]).map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    matchedSkill: r.skill_name,
  }));
}

// --- FTS-based agent lookup (query path) ---

async function findAgentsByQuery(
  db: Db,
  workspaceId: string,
  query: string,
): Promise<Array<{ agentId: string; agentName: string; matchedSkill: string }>> {
  const ftsQuery = query
    .trim()
    .split(/\s+/)
    .map((t) => `"${t}"`)
    .join(' OR ');

  const rows = await db.all(sql`
    SELECT s.agent_id, a.name as agent_name, s.name as skill_name, bm25(skill_fts) as rank
    FROM skill_fts fts
    JOIN skill_index s ON s.id = fts.id
    JOIN agents a ON a.id = s.agent_id
    WHERE skill_fts MATCH ${ftsQuery}
      AND s.workspace_id = ${workspaceId}
    ORDER BY rank
    LIMIT 10
  `);

  return (rows as any[]).map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    matchedSkill: r.skill_name,
  }));
}

// --- Routing Config ---

export async function getRoutingConfig(db: Db, workspaceId: string) {
  const [config] = await db
    .select()
    .from(routingConfig)
    .where(eq(routingConfig.workspaceId, workspaceId));

  // Return defaults if no config exists
  return {
    weightAvailability: config?.weightAvailability ?? 0.3,
    weightLatency: config?.weightLatency ?? 0.2,
    weightSuccess: config?.weightSuccess ?? 0.25,
    weightCost: config?.weightCost ?? 0.15,
    weightLoad: config?.weightLoad ?? 0.1,
    fallback: config?.fallback ?? 'queue',
    maxRetries: config?.maxRetries ?? 2,
    timeoutMs: config?.timeoutMs ?? 30000,
  };
}

export async function updateRoutingConfig(
  db: Db,
  workspaceId: string,
  data: {
    weights?: {
      availability?: number;
      latency?: number;
      success?: number;
      cost?: number;
      load?: number;
    };
    fallback?: 'queue' | 'reject' | 'any_agent';
    max_retries?: number;
    timeout_ms?: number;
  },
) {
  const existing = await getRoutingConfig(db, workspaceId);

  const values = {
    weightAvailability: data.weights?.availability ?? existing.weightAvailability,
    weightLatency: data.weights?.latency ?? existing.weightLatency,
    weightSuccess: data.weights?.success ?? existing.weightSuccess,
    weightCost: data.weights?.cost ?? existing.weightCost,
    weightLoad: data.weights?.load ?? existing.weightLoad,
    fallback: data.fallback ?? existing.fallback,
    maxRetries: data.max_retries ?? existing.maxRetries,
    timeoutMs: data.timeout_ms ?? existing.timeoutMs,
    updatedAt: sql`(unixepoch())`,
  };

  // Validate weights sum to ~1.0
  const weightSum =
    values.weightAvailability + values.weightLatency + values.weightSuccess +
    values.weightCost + values.weightLoad;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    const err = new Error(`Routing weights must sum to 1.0 (got ${weightSum.toFixed(3)})`);
    (err as any).status = 400;
    (err as any).code = 'invalid_weights';
    throw err;
  }

  // Upsert
  const [row] = await db
    .insert(routingConfig)
    .values({ id: `rcfg_${generateId()}`, workspaceId, ...values })
    .onConflictDoUpdate({
      target: routingConfig.workspaceId,
      set: values,
    })
    .returning();

  return formatConfig(row);
}

function formatConfig(row: any) {
  return {
    weights: {
      availability: row.weightAvailability,
      latency: row.weightLatency,
      success: row.weightSuccess,
      cost: row.weightCost,
      load: row.weightLoad,
    },
    fallback: row.fallback,
    max_retries: row.maxRetries,
    timeout_ms: row.timeoutMs,
  };
}

// --- Circuit Breaker ---
// Tracks consecutive failures per agent. Opens circuit after 3 failures.
// Resets after 60s. Stored in-memory (resets on worker restart -- acceptable
// for v1 since D1 is single-region anyway).

const circuitState = new Map<string, { failures: number; openedAt: number }>();
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 60_000;

export function isCircuitOpen(agentId: string): boolean {
  const state = circuitState.get(agentId);
  if (!state) return false;
  if (state.failures < CIRCUIT_THRESHOLD) return false;
  if (Date.now() - state.openedAt > CIRCUIT_RESET_MS) {
    circuitState.delete(agentId);
    return false; // Half-open: allow one attempt
  }
  return true;
}

export function recordSuccess(agentId: string) {
  circuitState.delete(agentId);
}

export function recordFailure(agentId: string) {
  const state = circuitState.get(agentId) || { failures: 0, openedAt: 0 };
  state.failures++;
  if (state.failures >= CIRCUIT_THRESHOLD) {
    state.openedAt = Date.now();
  }
  circuitState.set(agentId, state);
}
```

---

## 6. Engine: Skill Indexing on Agent Registration

**Integration point:** `packages/server/src/engine/a2a.ts` `registerA2aAgent()` and the agent registration route.

When an agent registers (either via `/v1/agents` or `/v1/a2a/register`), if the request includes `skills`, call `routing.indexSkills()`:

```typescript
// In the agent registration handler (routes/agent.ts POST /agents):
import * as routing from '../engine/routing.js';

// After agent is created:
if (data.skills && data.skills.length > 0) {
  await routing.indexSkills(db, workspace.id, agent.id, data.skills);
}

// In the A2A registration handler (engine/a2a.ts registerA2aAgent):
// Extract skills from the A2A Agent Card and index them
if (agentCard.skills && agentCard.skills.length > 0) {
  await routing.indexSkills(db, workspaceId, relayAgent.id, agentCard.skills.map((s) => ({
    id: s.id || s.name.toLowerCase().replace(/\s+/g, '-'),
    name: s.name,
    description: s.description,
    tags: s.tags || [],
    examples: s.examples || [],
  })));
}
```

Skills are re-indexed on every registration (full replace via `DELETE` + `INSERT`). This is simple and correct -- agent re-registration is infrequent relative to skill lookups.

---

## 7. Routes

### 7.1 Directory Routes: `packages/server/src/routes/directory.ts`

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as directoryEngine from '../engine/directory.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const directoryRoutes = new Hono<AppEnv>();

// POST /v1/directory -- Publish agent to directory
const publishSchema = z.object({
  agent_name: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  category: z.string(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(['public', 'private', 'listed']).optional(),
  pricing_model: z.enum(['free', 'per_task', 'monthly']).optional(),
  price_per_task: z.number().optional(),
  monthly_price: z.number().optional(),
  organization: z.string().optional(),
});

directoryRoutes.post('/directory', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = publishSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message || 'Invalid body' },
      }, 400);
    }
    const result = await directoryEngine.publishEntry(db, workspace.id, parsed.data);
    emitServerEvent(c, workspace.id, 'directory.published', { slug: result.slug });
    return c.json({ ok: true, data: result }, 201);
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /v1/directory -- Search/browse
directoryRoutes.get('/directory', rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const results = await directoryEngine.searchDirectory(db, {
      q: c.req.query('q') || undefined,
      category: c.req.query('category') || undefined,
      min_rating: c.req.query('min_rating') ? parseFloat(c.req.query('min_rating')!) : undefined,
      certified: c.req.query('certified') === 'true' ? true : c.req.query('certified') === 'false' ? false : undefined,
      sort: (c.req.query('sort') as any) || undefined,
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined,
      offset: c.req.query('offset') ? parseInt(c.req.query('offset')!, 10) : undefined,
    });
    return c.json({ ok: true, data: results });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /v1/directory/categories -- List categories
directoryRoutes.get('/directory/categories', rateLimit, async (c) => {
  const db = c.get('db');
  const categories = await directoryEngine.listCategories(db);
  return c.json({ ok: true, data: categories });
});

// GET /v1/directory/:slug -- Get entry
directoryRoutes.get('/directory/:slug', rateLimit, async (c) => {
  const db = c.get('db');
  const entry = await directoryEngine.getEntry(db, c.req.param('slug'));
  if (!entry) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Entry not found' } }, 404);
  }
  return c.json({ ok: true, data: entry });
});

// PUT /v1/directory/:slug -- Update listing
directoryRoutes.put('/directory/:slug', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const data = await c.req.json();
    const result = await directoryEngine.updateEntry(db, workspace.id, c.req.param('slug'), data);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// DELETE /v1/directory/:slug -- Remove listing
directoryRoutes.delete('/directory/:slug', requireAuth, rateLimit, async (c) => {
  const db = c.get('db');
  const workspace = c.get('workspace');
  const deleted = await directoryEngine.deleteEntry(db, workspace.id, c.req.param('slug'));
  if (!deleted) {
    return c.json({ ok: false, error: { code: 'not_found', message: 'Entry not found' } }, 404);
  }
  return c.json({ ok: true }, 204);
});

// POST /v1/directory/:slug/add -- Add agent to your workspace
directoryRoutes.post('/directory/:slug/add', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const result = await directoryEngine.addToWorkspace(db, workspace.id, c.req.param('slug'));
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
```

### 7.2 Routing Routes: `packages/server/src/routes/routing.ts`

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import * as routingEngine from '../engine/routing.js';
import { emitServerEvent } from '../lib/serverTelemetry.js';

export const routingRoutes = new Hono<AppEnv>();

// POST /v1/route -- Route message by skill
const routeSchema = z.object({
  skill: z.string().optional(),
  query: z.string().optional(),
  message: z.string(),
}).refine((d) => d.skill || d.query, { message: 'Either skill or query is required' });

routingRoutes.post('/route', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = routeSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message || 'Invalid body' },
      }, 400);
    }

    const result = await routingEngine.route(db, workspace.id, parsed.data);
    if (!result) {
      return c.json({
        ok: false,
        error: { code: 'no_agent_found', message: 'No agent found matching the requested skill' },
      }, 404);
    }

    // Check circuit breaker on the selected agent
    if (routingEngine.isCircuitOpen(result.agent.agentId)) {
      // Try fallback agents
      const fallback = result.fallback_agents.find(
        (a) => !routingEngine.isCircuitOpen(a.agentId),
      );
      if (fallback) {
        result.agent = fallback;
      } else {
        return c.json({
          ok: false,
          error: { code: 'circuit_open', message: 'All matching agents are temporarily unavailable' },
        }, 503);
      }
    }

    emitServerEvent(c, workspace.id, 'routing.routed', {
      agent: result.agent.agentName,
      skill: result.agent.matchedSkill,
      score: result.agent.score,
    });

    return c.json({
      ok: true,
      data: {
        routed_to: {
          agent_id: result.agent.agentId,
          agent_name: result.agent.agentName,
          score: result.agent.score,
          matched_skill: result.agent.matchedSkill,
        },
        fallback_agents: result.fallback_agents.map((a) => ({
          agent_id: a.agentId,
          agent_name: a.agentName,
          score: a.score,
        })),
      },
    });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});

// GET /v1/skills -- List all skills in workspace
routingRoutes.get('/skills', requireAuth, rateLimit, async (c) => {
  const db = c.get('db');
  const workspace = c.get('workspace');
  const skills = await routingEngine.listSkills(db, workspace.id);
  return c.json({ ok: true, data: skills });
});

// GET /v1/skills/search?q=... -- Search skills
routingRoutes.get('/skills/search', requireAuth, rateLimit, async (c) => {
  const db = c.get('db');
  const workspace = c.get('workspace');
  const q = c.req.query('q');
  if (!q) {
    return c.json({
      ok: false,
      error: { code: 'invalid_request', message: 'q is required' },
    }, 400);
  }
  const results = await routingEngine.searchSkills(db, workspace.id, q);
  return c.json({ ok: true, data: results });
});

// GET /v1/routing/config -- Get routing config
routingRoutes.get('/routing/config', requireAuth, rateLimit, async (c) => {
  const db = c.get('db');
  const workspace = c.get('workspace');
  const config = await routingEngine.getRoutingConfig(db, workspace.id);
  return c.json({ ok: true, data: config });
});

// PUT /v1/routing/config -- Update routing config
const configSchema = z.object({
  weights: z.object({
    availability: z.number().min(0).max(1).optional(),
    latency: z.number().min(0).max(1).optional(),
    success: z.number().min(0).max(1).optional(),
    cost: z.number().min(0).max(1).optional(),
    load: z.number().min(0).max(1).optional(),
  }).optional(),
  fallback: z.enum(['queue', 'reject', 'any_agent']).optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  timeout_ms: z.number().int().min(1000).max(300000).optional(),
});

routingRoutes.put('/routing/config', requireAuth, rateLimit, async (c) => {
  try {
    const db = c.get('db');
    const workspace = c.get('workspace');
    const parsed = configSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        ok: false,
        error: { code: 'invalid_request', message: parsed.error.issues[0]?.message || 'Invalid body' },
      }, 400);
    }
    const result = await routingEngine.updateRoutingConfig(db, workspace.id, parsed.data);
    return c.json({ ok: true, data: result });
  } catch (err: unknown) {
    const error = err as Error & { code?: string; status?: number };
    return c.json({
      ok: false,
      error: { code: error.code || 'internal_error', message: error.message },
    }, (error.status || 500) as any);
  }
});
```

### 7.3 Route Mounting

Add to `packages/server/src/worker.ts` in the v1 subrouter section:

```typescript
import { directoryRoutes } from './routes/directory.js';
import { routingRoutes } from './routes/routing.js';

// Inside the v1 subrouter block:
v1.route('/', directoryRoutes);
v1.route('/', routingRoutes);
```

---

## 8. SDK Methods

### 8.1 TypeScript SDK (`packages/sdk-typescript`)

```typescript
// In relay.ts or client.ts -- new methods on the RelayClient class:

// --- Directory ---

async publishToDirectory(data: {
  agent_name: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  visibility?: 'public' | 'private' | 'listed';
}): Promise<DirectoryEntry> {
  return this.post('/v1/directory', data);
}

async searchDirectory(params?: {
  q?: string;
  category?: string;
  min_rating?: number;
  certified?: boolean;
  sort?: 'rating' | 'tasks' | 'recent';
}): Promise<DirectoryEntry[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q);
  if (params?.category) qs.set('category', params.category);
  if (params?.min_rating) qs.set('min_rating', String(params.min_rating));
  if (params?.certified !== undefined) qs.set('certified', String(params.certified));
  if (params?.sort) qs.set('sort', params.sort);
  return this.get(`/v1/directory?${qs}`);
}

async addFromDirectory(slug: string): Promise<{ slug: string; name: string; added: boolean }> {
  return this.post(`/v1/directory/${slug}/add`, {});
}

// --- Smart Routing ---

async route(skillOrQuery: string, message: string): Promise<RouteResult> {
  // Heuristic: if single word, treat as skill tag; if multi-word, treat as query
  const isTag = /^[a-z0-9_-]+$/.test(skillOrQuery);
  return this.post('/v1/route', {
    ...(isTag ? { skill: skillOrQuery } : { query: skillOrQuery }),
    message,
  });
}

async listSkills(): Promise<Skill[]> {
  return this.get('/v1/skills');
}

async searchSkills(query: string): Promise<Skill[]> {
  return this.get(`/v1/skills/search?q=${encodeURIComponent(query)}`);
}

async getRoutingConfig(): Promise<RoutingConfig> {
  return this.get('/v1/routing/config');
}

async updateRoutingConfig(config: Partial<RoutingConfig>): Promise<RoutingConfig> {
  return this.put('/v1/routing/config', config);
}
```

### 8.2 Python SDK (analogous)

```python
# relay.route("billing", "process refund for order #1042")
# relay.search_directory(q="billing", certified=True)
# relay.publish_to_directory(agent_name="billing-expert", name="Stripe Billing", ...)
```

---

## 9. Semantic Matching (v2 -- Deferred)

v1 uses **tag matching** (exact match on skill tags via `json_each`) and **FTS5 text search** (BM25 ranking on skill name/description/tags).

v2 will add **embedding-based semantic matching**:

### 9.1 Approach

1. On skill registration, generate an embedding for `name + description + examples` using a lightweight model (e.g., `text-embedding-3-small`)
2. Store the embedding vector in a new `skill_embeddings` table (or use Cloudflare Vectorize if available)
3. On `POST /v1/route` with `query`, compute query embedding and find nearest neighbors
4. Combine embedding similarity score with the existing weighted scoring algorithm

### 9.2 Why Defer

- Tag matching + FTS5 covers 80%+ of use cases for v1
- Embedding storage in D1 is awkward (no native vector type -- would store as JSON blob)
- Cloudflare Vectorize is the natural fit but adds infrastructure dependency
- Latency: embedding generation adds 50-200ms per routing request
- Cost: embedding API calls at scale

### 9.3 Migration Path

The `skill_index.description` and `skill_index.examples` fields are already stored -- when v2 ships, we index existing skills without re-registration. The routing engine's `findAgentsByQuery` function is the single integration point.

---

## 10. Testing Strategy

### 10.1 Engine Tests

- `packages/server/src/engine/__tests__/directory.test.ts` -- CRUD, FTS5 search, slug generation, visibility filtering
- `packages/server/src/engine/__tests__/routing.test.ts` -- scoring algorithm, circuit breaker, tag lookup, config validation

### 10.2 Route Tests

- `packages/server/src/routes/__tests__/directory.test.ts` -- HTTP status codes, auth, validation
- `packages/server/src/routes/__tests__/routing.test.ts` -- route endpoint, skills endpoints, config endpoints

### 10.3 Key Test Cases

1. **Skill indexing:** Register agent with skills -> skills appear in `GET /v1/skills`
2. **Tag routing:** Register 2 agents with "billing" tag -> route by "billing" -> returns higher-scored agent
3. **FTS search:** Register agent with description "process Stripe refunds" -> search "stripe" -> finds it
4. **Circuit breaker:** Fail agent 3 times -> circuit opens -> route falls back to next agent
5. **Weight validation:** Submit weights summing to 0.5 -> 400 error
6. **Directory visibility:** Private entry not visible in public search
7. **Slug uniqueness:** Two entries with same name -> 409 conflict

---

## 11. File Summary

| File | Purpose |
|------|---------|
| `src/db/migrations/0005_directory_entries.sql` | Directory table + FTS5 |
| `src/db/migrations/0006_skill_index.sql` | Skill index table + FTS5 |
| `src/db/migrations/0007_routing_config.sql` | Per-workspace routing config |
| `src/db/schema.ts` | Add `directoryEntries`, `skillIndex`, `routingConfig` tables |
| `src/engine/directory.ts` | Directory CRUD, FTS5 search, categories |
| `src/engine/routing.ts` | Skill indexing, routing algorithm, circuit breaker, config |
| `src/routes/directory.ts` | `/v1/directory/*` endpoints |
| `src/routes/routing.ts` | `/v1/route`, `/v1/skills/*`, `/v1/routing/config` endpoints |
| `src/worker.ts` | Mount new routes on v1 subrouter |

---

## 12. Open Decisions

1. **Directory is global vs per-workspace?** The spec implies global (`agentrelay.dev/directory`). This design uses a global `directory_entries` table with `workspace_id` for ownership but `visibility: 'public'` entries are browsable by anyone. The `GET /v1/directory` endpoint does NOT require auth for public browsing.

2. **`/v1/route` auto-sends or just resolves?** This design returns the routing decision (which agent + score). The caller then sends via `relay.send()`. This keeps routing and messaging decoupled. A convenience `route_and_send` can be added later.

3. **Skill tag normalization:** Tags are stored lowercase. The `json_each` join does exact match. Should we normalize on write (strip whitespace, lowercase) or on read? **Recommendation:** normalize on write in `indexSkills()`.

4. **Rating/review system:** Stubbed in the schema (`rating`, `rating_count`) but the `POST /v1/directory/:slug/review` endpoint is not implemented in this design. Defer to Phase 3b.

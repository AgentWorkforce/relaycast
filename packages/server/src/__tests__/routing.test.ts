import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema.js';
import { createDirectoryAgent, upsertDirectoryRating } from '../engine/directory.js';
import { routeBySkill, setRoutingConfig } from '../engine/routing.js';

const TEST_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  system_prompt TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  metadata TEXT DEFAULT '{}'
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'agent',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'online',
  persona TEXT,
  metadata TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX agents_workspace_name_unique ON agents(workspace_id, name);
CREATE INDEX idx_agents_workspace ON agents(workspace_id);
CREATE INDEX idx_agents_token ON agents(token_hash);

CREATE TABLE directory_agents (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  provider TEXT,
  endpoint_url TEXT,
  documentation_url TEXT,
  version TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX directory_agents_workspace_slug_unique
  ON directory_agents(workspace_id, slug);
CREATE INDEX idx_directory_agents_workspace
  ON directory_agents(workspace_id, created_at);
CREATE INDEX idx_directory_agents_source_agent
  ON directory_agents(source_agent_id);
CREATE INDEX idx_directory_agents_status
  ON directory_agents(workspace_id, status);

CREATE TABLE directory_skills (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  directory_agent_id TEXT NOT NULL REFERENCES directory_agents(id) ON DELETE CASCADE,
  skill_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_directory_skills_agent
  ON directory_skills(directory_agent_id, position);
CREATE INDEX idx_directory_skills_workspace
  ON directory_skills(workspace_id);

CREATE TABLE directory_ratings (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  directory_agent_id TEXT NOT NULL REFERENCES directory_agents(id) ON DELETE CASCADE,
  rater_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  review TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX directory_ratings_agent_rater_unique
  ON directory_ratings(directory_agent_id, rater_agent_id);
CREATE INDEX idx_directory_ratings_workspace
  ON directory_ratings(workspace_id, created_at);
CREATE INDEX idx_directory_ratings_directory_agent
  ON directory_ratings(directory_agent_id, created_at);

CREATE VIRTUAL TABLE directory_agents_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  provider,
  tags,
  content=directory_agents,
  content_rowid=rowid
);

CREATE TRIGGER directory_agents_fts_insert
AFTER INSERT ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(rowid, id, name, description, provider, tags)
  VALUES (NEW.rowid, NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.provider, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER directory_agents_fts_update
AFTER UPDATE OF name, description, provider, tags ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(directory_agents_fts, rowid, id, name, description, provider, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.provider, ''), COALESCE(OLD.tags, '[]'));
  INSERT INTO directory_agents_fts(rowid, id, name, description, provider, tags)
  VALUES (NEW.rowid, NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.provider, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER directory_agents_fts_delete
AFTER DELETE ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(directory_agents_fts, rowid, id, name, description, provider, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.provider, ''), COALESCE(OLD.tags, '[]'));
END;

CREATE VIRTUAL TABLE directory_skills_fts USING fts5(
  id UNINDEXED,
  directory_agent_id UNINDEXED,
  name,
  description,
  tags,
  content=directory_skills,
  content_rowid=rowid
);

CREATE TRIGGER directory_skills_fts_insert
AFTER INSERT ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(rowid, id, directory_agent_id, name, description, tags)
  VALUES (NEW.rowid, NEW.id, NEW.directory_agent_id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER directory_skills_fts_update
AFTER UPDATE OF name, description, tags ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(directory_skills_fts, rowid, id, directory_agent_id, name, description, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.directory_agent_id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.tags, '[]'));
  INSERT INTO directory_skills_fts(rowid, id, directory_agent_id, name, description, tags)
  VALUES (NEW.rowid, NEW.id, NEW.directory_agent_id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER directory_skills_fts_delete
AFTER DELETE ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(directory_skills_fts, rowid, id, directory_agent_id, name, description, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.directory_agent_id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.tags, '[]'));
END;

CREATE TABLE routing_configs (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  weights TEXT NOT NULL DEFAULT '{}',
  circuit_breaker_threshold INTEGER NOT NULL DEFAULT 3,
  circuit_breaker_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_routing_configs_updated_at
  ON routing_configs(updated_at);

CREATE TABLE routing_failures (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  circuit_open_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE INDEX idx_routing_failures_workspace
  ON routing_failures(workspace_id, updated_at);

CREATE INDEX idx_routing_failures_circuit
  ON routing_failures(workspace_id, circuit_open_until);
`;

class FakeD1PreparedStatement {
  private readonly sqlite: DatabaseSync;
  private readonly query: string;
  private readonly params: unknown[];

  constructor(sqlite: DatabaseSync, query: string, params: unknown[] = []) {
    this.sqlite = sqlite;
    this.query = query;
    this.params = params;
  }

  bind(...params: unknown[]) {
    return new FakeD1PreparedStatement(this.sqlite, this.query, params);
  }

  async run() {
    this.sqlite.prepare(this.query).run(...this.params);
    return { success: true, meta: {}, results: [] };
  }

  async all() {
    return {
      success: true,
      meta: {},
      results: this.sqlite.prepare(this.query).all(...this.params),
    };
  }

  async raw() {
    const statement = this.sqlite.prepare(this.query);
    statement.setReturnArrays(true);
    return statement.all(...this.params);
  }

  async first() {
    return this.sqlite.prepare(this.query).get(...this.params);
  }
}

class FakeD1Database {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(TEST_SCHEMA_SQL);
  }

  prepare(query: string) {
    return new FakeD1PreparedStatement(this.sqlite, query);
  }

  async batch(statements: Array<FakeD1PreparedStatement>) {
    return Promise.all(statements.map((statement) => statement.all()));
  }

  async exec(query: string) {
    this.sqlite.exec(query);
  }
}

function createTestDb() {
  const d1 = new FakeD1Database();
  return {
    db: drizzle(d1 as unknown as D1Database, { schema }),
    sqlite: d1.sqlite,
  };
}

async function seedWorkspace(db: ReturnType<typeof createTestDb>['db']) {
  await db.insert(schema.workspaces).values({
    id: 'ws_test',
    name: 'test-workspace',
    apiKeyHash: 'workspace-key-hash',
    metadata: {},
  });
}

async function seedAgent(
  db: ReturnType<typeof createTestDb>['db'],
  input: { id: string; name: string; status?: string; lastSeenSecondsAgo?: number },
) {
  const now = vi.getMockedSystemTime() ?? new Date();
  await db.insert(schema.agents).values({
    id: input.id,
    workspaceId: 'ws_test',
    name: input.name,
    tokenHash: `${input.id}-token`,
    status: input.status ?? 'online',
    metadata: {},
    lastSeen: new Date(now.getTime() - (input.lastSeenSecondsAgo ?? 0) * 1000),
  });
}

describe('routing engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00.000Z'));
  });

  it('routes by a skill tag to the correct agent', async () => {
    const { db } = createTestDb();
    await seedWorkspace(db);
    await seedAgent(db, { id: 'agent_billing', name: 'BillingBot' });
    await seedAgent(db, { id: 'agent_support', name: 'SupportBot' });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'BillingBot',
      name: 'BillingBot',
      description: 'Payments and disputes specialist.',
      tags: ['finance'],
      skills: [
        {
          id: 'skill_disputes',
          name: 'Dispute Handling',
          description: 'Resolve card disputes and merchant credits.',
          tags: ['chargeback', 'refunds'],
        },
      ],
    });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'SupportBot',
      name: 'SupportBot',
      description: 'General inbox support.',
      tags: ['support'],
      skills: [
        {
          id: 'skill_inbox',
          name: 'Inbox Triage',
          description: 'Sort and route incoming tickets.',
          tags: ['support'],
        },
      ],
    });

    const result = await routeBySkill(db, 'ws_test', 'refunds', 'customer needs help with a failed refund');
    expect(result.agentName).toBe('BillingBot');
    expect(result.score).toBeGreaterThan(0);
  });

  it('changes routing decisions when weights change', async () => {
    const { db } = createTestDb();
    await seedWorkspace(db);
    await seedAgent(db, { id: 'agent_skill', name: 'SkillBot' });
    await seedAgent(db, { id: 'agent_rating', name: 'RatingBot' });
    await seedAgent(db, { id: 'agent_reviewer_1', name: 'ReviewerOne' });
    await seedAgent(db, { id: 'agent_reviewer_2', name: 'ReviewerTwo' });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'SkillBot',
      name: 'SkillBot',
      description: 'Exact refund specialist.',
      tags: ['billing'],
      skills: [
        {
          id: 'skill_exact_refund',
          name: 'Refund Approval',
          description: 'Handle direct refund approval requests.',
          tags: ['refund', 'approval'],
        },
      ],
    });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'RatingBot',
      name: 'RatingBot',
      description: 'High-satisfaction billing assistant.',
      tags: ['billing', 'refund'],
      skills: [
        {
          id: 'skill_general_billing',
          name: 'Billing Assistant',
          description: 'Help with refund approvals and billing conversations.',
          tags: ['refund'],
        },
      ],
    });

    await upsertDirectoryRating(db, 'ws_test', 'ratingbot', {
      rater_agent_id: 'agent_reviewer_1',
      score: 5,
      review: 'Excellent.',
    });
    await upsertDirectoryRating(db, 'ws_test', 'ratingbot', {
      rater_agent_id: 'agent_reviewer_2',
      score: 5,
      review: 'Very reliable.',
    });

    await setRoutingConfig(db, 'ws_test', {
      weights: {
        skill_match: 1,
        message_match: 0,
        tag_match: 0,
        rating: 0,
        availability: 0,
      },
    });

    const skillWeighted = await routeBySkill(db, 'ws_test', 'refund approval', 'customer requests a refund approval');
    expect(skillWeighted.agentName).toBe('SkillBot');

    await setRoutingConfig(db, 'ws_test', {
      weights: {
        skill_match: 0,
        message_match: 0,
        tag_match: 0,
        rating: 1,
        availability: 0,
      },
    });

    const ratingWeighted = await routeBySkill(db, 'ws_test', 'refund approval', 'customer requests a refund approval');
    expect(ratingWeighted.agentName).toBe('RatingBot');
  });

  it('excludes agents with an open circuit breaker', async () => {
    const { db, sqlite } = createTestDb();
    await seedWorkspace(db);
    await seedAgent(db, { id: 'agent_primary', name: 'PrimaryBot' });
    await seedAgent(db, { id: 'agent_secondary', name: 'SecondaryBot' });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'PrimaryBot',
      name: 'PrimaryBot',
      description: 'Primary refund specialist.',
      tags: ['billing'],
      skills: [
        {
          id: 'skill_primary_refund',
          name: 'Refund',
          description: 'Best refund handler in the workspace.',
          tags: ['refund'],
        },
      ],
    });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'SecondaryBot',
      name: 'SecondaryBot',
      description: 'Backup refund specialist.',
      tags: ['billing'],
      skills: [
        {
          id: 'skill_secondary_refund',
          name: 'Refund Backup',
          description: 'Fallback coverage for refund requests.',
          tags: ['refund'],
        },
      ],
    });

    sqlite.prepare(`
      INSERT INTO routing_failures (
        workspace_id,
        agent_id,
        consecutive_failures,
        total_failures,
        total_successes,
        circuit_open_until,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).run(
      'ws_test',
      'agent_primary',
      3,
      3,
      0,
      '2099-01-01T00:00:00.000Z',
      'upstream timeout',
    );

    const result = await routeBySkill(db, 'ws_test', 'refund', 'customer needs a refund');
    expect(result.agentName).toBe('SecondaryBot');
  });

  it('returns a fallback route when no exact skill match exists', async () => {
    const { db } = createTestDb();
    await seedWorkspace(db);
    await seedAgent(db, { id: 'agent_disputes', name: 'DisputesBot' });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'DisputesBot',
      name: 'DisputesBot',
      description: 'Investigates billing disputes and reversals.',
      tags: ['billing'],
      skills: [
        {
          id: 'skill_disputes',
          name: 'Dispute Review',
          description: 'Handle chargeback investigations and representment cases.',
          tags: ['chargeback'],
        },
      ],
    });

    const result = await routeBySkill(
      db,
      'ws_test',
      'chargeback investigations',
      'merchant needs chargeback investigation help',
    );
    expect(result.agentName).toBe('DisputesBot');
    expect(result.fallback).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it('preserves existing weights when applying a partial routing update', async () => {
    const { db } = createTestDb();
    await seedWorkspace(db);

    await setRoutingConfig(db, 'ws_test', {
      weights: {
        skill_match: 0.4,
        message_match: 0.2,
        tag_match: 0.15,
        rating: 0.15,
        availability: 0.1,
      },
    });

    const updated = await setRoutingConfig(db, 'ws_test', {
      weights: {
        skill_match: 0.5,
      },
    });

    expect(updated.weights).toEqual({
      skill_match: 0.454545,
      message_match: 0.181818,
      tag_match: 0.136364,
      rating: 0.136364,
      availability: 0.090909,
    });
  });
});

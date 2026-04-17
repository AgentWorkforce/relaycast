import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema.js';
import { createD1TestDb } from './fake-d1.js';
import {
  createDirectoryAgent,
  listDirectoryAgents,
  listDirectoryRatings,
  searchDirectory,
  upsertDirectoryRating,
} from '../engine/directory.js';

const TEST_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
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
`;

function createTestDb() {
  return createD1TestDb(TEST_SCHEMA_SQL);
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

describe('directory engine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00.000Z'));
  });

  it('publishes, browses, searches, and rates directory entries', async () => {
    const { db } = createTestDb();
    await seedWorkspace(db);
    await seedAgent(db, { id: 'agent_billing', name: 'BillingBot' });
    await seedAgent(db, { id: 'agent_ops', name: 'OpsBot' });
    await seedAgent(db, { id: 'agent_reviewer_1', name: 'ReviewBotOne' });
    await seedAgent(db, { id: 'agent_reviewer_2', name: 'ReviewBotTwo' });

    const billingEntry = await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'BillingBot',
      name: 'BillingBot',
      description: 'Handles refund workflows and card disputes for merchants.',
      provider: 'relaycast',
      tags: ['billing', 'finance'],
      skills: [
        {
          id: 'skill_refunds',
          name: 'Refund Operations',
          description: 'Process refunds, disputes, and merchant reimbursements.',
          tags: ['refunds', 'billing'],
        },
      ],
    });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'OpsBot',
      name: 'OpsBot',
      description: 'Coordinates on-call incident response.',
      provider: 'relaycast',
      tags: ['ops', 'incident'],
      skills: [
        {
          id: 'skill_incidents',
          name: 'Incident Response',
          description: 'Triage incidents and page responders.',
          tags: ['incident', 'triage'],
        },
      ],
    });

    expect(billingEntry?.slug).toBe('billingbot');
    expect(billingEntry?.source_agent_id).toBe('agent_billing');
    expect(billingEntry?.skills).toHaveLength(1);

    const browseResults = await listDirectoryAgents(db, 'ws_test', { status: 'active' });
    expect(browseResults).toHaveLength(2);
    expect(browseResults.map((entry) => entry.slug)).toEqual(['billingbot', 'opsbot']);

    const searchResults = await searchDirectory(db, 'ws_test', {
      tags: ['billing'],
      limit: 5,
    });
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.slug).toBe('billingbot');
    expect(searchResults[0]?.relevance_score).toBeGreaterThan(0);

    await upsertDirectoryRating(db, 'ws_test', 'billingbot', {
      rater_agent_id: 'agent_reviewer_1',
      score: 5,
      review: 'Fast and accurate.',
    });
    await upsertDirectoryRating(db, 'ws_test', 'billingbot', {
      rater_agent_id: 'agent_reviewer_2',
      score: 3,
      review: 'Good for standard refund cases.',
    });

    const ratings = await listDirectoryRatings(db, 'ws_test', 'billingbot');
    expect(ratings).toHaveLength(2);
    expect(ratings.map((rating) => rating.rater_agent_name).sort()).toEqual(['ReviewBotOne', 'ReviewBotTwo']);

    const ratedEntries = await listDirectoryAgents(db, 'ws_test', { status: 'active' });
    expect(ratedEntries[0]?.slug).toBe('billingbot');
    expect(ratedEntries[0]?.rating_count).toBe(2);
    expect(ratedEntries[0]?.rating_avg).toBe(4);
  });

  it('matches search queries across skills and agent descriptions', async () => {
    const { db } = createTestDb();
    await seedWorkspace(db);
    await seedAgent(db, { id: 'agent_research', name: 'ResearchBot' });
    await seedAgent(db, { id: 'agent_support', name: 'SupportBot' });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'ResearchBot',
      name: 'ResearchBot',
      description: 'Turns raw logs into incident narratives for engineering teams.',
      provider: 'relaycast',
      tags: ['research'],
      skills: [
        {
          id: 'skill_knowledge_graphs',
          name: 'Knowledge Graph Design',
          description: 'Build entity extraction pipelines and graph retrieval systems.',
          tags: ['graph', 'retrieval'],
        },
      ],
    });

    await createDirectoryAgent(db, 'ws_test', {
      source_agent_name: 'SupportBot',
      name: 'SupportBot',
      description: 'Customer support specialist for subscription billing.',
      provider: 'relaycast',
      tags: ['support'],
      skills: [
        {
          id: 'skill_inbox',
          name: 'Inbox Triage',
          description: 'Organize inbound tickets and escalate urgent cases.',
          tags: ['email'],
        },
      ],
    });

    const skillResults = await searchDirectory(db, 'ws_test', {
      q: 'entity extraction pipelines',
    });
    expect(skillResults.map((row) => row.slug)).toContain('researchbot');

    const descriptionResults = await searchDirectory(db, 'ws_test', {
      q: 'subscription billing specialist',
    });
    expect(descriptionResults.map((row) => row.slug)).toContain('supportbot');
  });
});

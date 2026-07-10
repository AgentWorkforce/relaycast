CREATE TABLE IF NOT EXISTS directory_agents (
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

CREATE UNIQUE INDEX IF NOT EXISTS directory_agents_workspace_slug_unique
  ON directory_agents(workspace_id, slug);
CREATE INDEX IF NOT EXISTS idx_directory_agents_workspace
  ON directory_agents(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_directory_agents_source_agent
  ON directory_agents(source_agent_id);
CREATE INDEX IF NOT EXISTS idx_directory_agents_status
  ON directory_agents(workspace_id, status);

CREATE TABLE IF NOT EXISTS directory_skills (
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

CREATE INDEX IF NOT EXISTS idx_directory_skills_agent
  ON directory_skills(directory_agent_id, position);
CREATE INDEX IF NOT EXISTS idx_directory_skills_workspace
  ON directory_skills(workspace_id);

CREATE TABLE IF NOT EXISTS directory_ratings (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  directory_agent_id TEXT NOT NULL REFERENCES directory_agents(id) ON DELETE CASCADE,
  rater_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  review TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS directory_ratings_agent_rater_unique
  ON directory_ratings(directory_agent_id, rater_agent_id);
CREATE INDEX IF NOT EXISTS idx_directory_ratings_workspace
  ON directory_ratings(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_directory_ratings_directory_agent
  ON directory_ratings(directory_agent_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS directory_agents_fts USING fts5(
  id UNINDEXED,
  name,
  description,
  provider,
  tags,
  content=directory_agents,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS directory_agents_fts_insert
AFTER INSERT ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(rowid, id, name, description, provider, tags)
  VALUES (NEW.rowid, NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.provider, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_agents_fts_update
AFTER UPDATE OF name, description, provider, tags ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(directory_agents_fts, rowid, id, name, description, provider, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.provider, ''), COALESCE(OLD.tags, '[]'));
  INSERT INTO directory_agents_fts(rowid, id, name, description, provider, tags)
  VALUES (NEW.rowid, NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.provider, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_agents_fts_delete
AFTER DELETE ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(directory_agents_fts, rowid, id, name, description, provider, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.provider, ''), COALESCE(OLD.tags, '[]'));
END;

CREATE VIRTUAL TABLE IF NOT EXISTS directory_skills_fts USING fts5(
  id UNINDEXED,
  directory_agent_id UNINDEXED,
  name,
  description,
  tags,
  content=directory_skills,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS directory_skills_fts_insert
AFTER INSERT ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(rowid, id, directory_agent_id, name, description, tags)
  VALUES (NEW.rowid, NEW.id, NEW.directory_agent_id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_skills_fts_update
AFTER UPDATE OF name, description, tags ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(directory_skills_fts, rowid, id, directory_agent_id, name, description, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.directory_agent_id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.tags, '[]'));
  INSERT INTO directory_skills_fts(rowid, id, directory_agent_id, name, description, tags)
  VALUES (NEW.rowid, NEW.id, NEW.directory_agent_id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_skills_fts_delete
AFTER DELETE ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(directory_skills_fts, rowid, id, directory_agent_id, name, description, tags)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.directory_agent_id, OLD.name, COALESCE(OLD.description, ''), COALESCE(OLD.tags, '[]'));
END;

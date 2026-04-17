import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../db/schema.js';

const DIRECTORY_AGENTS_FTS_FALLBACK = `
CREATE TABLE IF NOT EXISTS directory_agents_fts (
  id TEXT,
  name TEXT,
  description TEXT,
  provider TEXT,
  tags TEXT
);

CREATE TRIGGER IF NOT EXISTS directory_agents_fts_insert
AFTER INSERT ON directory_agents BEGIN
  INSERT INTO directory_agents_fts(rowid, id, name, description, provider, tags)
  VALUES (NEW.rowid, NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.provider, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_agents_fts_update
AFTER UPDATE OF name, description, provider, tags ON directory_agents BEGIN
  DELETE FROM directory_agents_fts WHERE rowid = OLD.rowid;
  INSERT INTO directory_agents_fts(rowid, id, name, description, provider, tags)
  VALUES (NEW.rowid, NEW.id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.provider, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_agents_fts_delete
AFTER DELETE ON directory_agents BEGIN
  DELETE FROM directory_agents_fts WHERE rowid = OLD.rowid;
END;
`;

const DIRECTORY_SKILLS_FTS_FALLBACK = `
CREATE TABLE IF NOT EXISTS directory_skills_fts (
  id TEXT,
  directory_agent_id TEXT,
  name TEXT,
  description TEXT,
  tags TEXT
);

CREATE TRIGGER IF NOT EXISTS directory_skills_fts_insert
AFTER INSERT ON directory_skills BEGIN
  INSERT INTO directory_skills_fts(rowid, id, directory_agent_id, name, description, tags)
  VALUES (NEW.rowid, NEW.id, NEW.directory_agent_id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_skills_fts_update
AFTER UPDATE OF name, description, tags ON directory_skills BEGIN
  DELETE FROM directory_skills_fts WHERE rowid = OLD.rowid;
  INSERT INTO directory_skills_fts(rowid, id, directory_agent_id, name, description, tags)
  VALUES (NEW.rowid, NEW.id, NEW.directory_agent_id, NEW.name, COALESCE(NEW.description, ''), COALESCE(NEW.tags, '[]'));
END;

CREATE TRIGGER IF NOT EXISTS directory_skills_fts_delete
AFTER DELETE ON directory_skills BEGIN
  DELETE FROM directory_skills_fts WHERE rowid = OLD.rowid;
END;
`;

function sqliteSupportsFts5(sqlite: DatabaseSync) {
  try {
    sqlite.exec('CREATE VIRTUAL TABLE __fts5_probe USING fts5(value); DROP TABLE __fts5_probe;');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such module: fts5')) return false;
    throw error;
  }
}

function useDirectoryFtsFallback(schemaSql: string) {
  return schemaSql
    .replace(/CREATE TRIGGER(?: IF NOT EXISTS)? directory_agents_fts_insert[\s\S]*?END;\s*/g, '')
    .replace(/CREATE TRIGGER(?: IF NOT EXISTS)? directory_agents_fts_update[\s\S]*?END;\s*/g, '')
    .replace(/CREATE TRIGGER(?: IF NOT EXISTS)? directory_agents_fts_delete[\s\S]*?END;\s*/g, '')
    .replace(
      /CREATE VIRTUAL TABLE(?: IF NOT EXISTS)? directory_agents_fts USING fts5\([\s\S]*?\);\s*/g,
      DIRECTORY_AGENTS_FTS_FALLBACK,
    )
    .replace(/CREATE TRIGGER(?: IF NOT EXISTS)? directory_skills_fts_insert[\s\S]*?END;\s*/g, '')
    .replace(/CREATE TRIGGER(?: IF NOT EXISTS)? directory_skills_fts_update[\s\S]*?END;\s*/g, '')
    .replace(/CREATE TRIGGER(?: IF NOT EXISTS)? directory_skills_fts_delete[\s\S]*?END;\s*/g, '')
    .replace(
      /CREATE VIRTUAL TABLE(?: IF NOT EXISTS)? directory_skills_fts USING fts5\([\s\S]*?\);\s*/g,
      DIRECTORY_SKILLS_FTS_FALLBACK,
    );
}

function normalizeSearchText(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s"]/g, ' ');
}

function ftsMatch(document: unknown, query: unknown) {
  const haystack = normalizeSearchText(document);
  const terms = normalizeSearchText(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) return 1;
  return terms.every((term) => haystack.includes(term)) ? 1 : 0;
}

function rewriteFtsQueryForFallback(query: string) {
  return query
    .replace(/bm25\(directory_agents_fts\)/g, '0')
    .replace(/bm25\(directory_skills_fts\)/g, '0')
    .replace(
      /directory_agents_fts\s+MATCH\s+\?/g,
      "fts_match(COALESCE(directory_agents_fts.name, '') || ' ' || COALESCE(directory_agents_fts.description, '') || ' ' || COALESCE(directory_agents_fts.provider, '') || ' ' || COALESCE(directory_agents_fts.tags, ''), ?)",
    )
    .replace(
      /directory_skills_fts\s+MATCH\s+\?/g,
      "fts_match(COALESCE(directory_skills_fts.name, '') || ' ' || COALESCE(directory_skills_fts.description, '') || ' ' || COALESCE(directory_skills_fts.tags, ''), ?)",
    );
}

function rowsToArrays(statement: ReturnType<DatabaseSync['prepare']>, rows: Record<string, unknown>[]) {
  const columns = typeof statement.columns === 'function'
    ? statement.columns().map((column) => column.name)
    : Object.keys(rows[0] ?? {});
  return rows.map((row) => columns.map((column) => row[column]));
}

export class FakeD1PreparedStatement {
  private readonly sqlite: DatabaseSync;
  private readonly query: string;
  private readonly params: unknown[];
  private readonly useFtsFallback: boolean;

  constructor(
    sqlite: DatabaseSync,
    query: string,
    params: unknown[] = [],
    useFtsFallback = false,
  ) {
    this.sqlite = sqlite;
    this.query = query;
    this.params = params;
    this.useFtsFallback = useFtsFallback;
  }

  private get sqliteQuery() {
    return this.useFtsFallback ? rewriteFtsQueryForFallback(this.query) : this.query;
  }

  bind(...params: unknown[]) {
    return new FakeD1PreparedStatement(this.sqlite, this.query, params, this.useFtsFallback);
  }

  async run() {
    this.sqlite.prepare(this.sqliteQuery).run(...this.params);
    return { success: true, meta: {}, results: [] };
  }

  async all() {
    return {
      success: true,
      meta: {},
      results: this.sqlite.prepare(this.sqliteQuery).all(...this.params),
    };
  }

  async raw() {
    const statement = this.sqlite.prepare(this.sqliteQuery);
    if (typeof statement.setReturnArrays === 'function') {
      statement.setReturnArrays(true);
      return statement.all(...this.params);
    }

    return rowsToArrays(statement, statement.all(...this.params) as Record<string, unknown>[]);
  }

  async first() {
    return this.sqlite.prepare(this.sqliteQuery).get(...this.params);
  }
}

export class FakeD1Database {
  readonly sqlite = new DatabaseSync(':memory:');
  private readonly useFtsFallback: boolean;

  constructor(schemaSql: string) {
    const needsFts5 = /USING\s+fts5/i.test(schemaSql);
    this.useFtsFallback = needsFts5 && !sqliteSupportsFts5(this.sqlite);

    if (this.useFtsFallback) {
      this.sqlite.function('fts_match', { deterministic: true }, ftsMatch);
    }

    this.sqlite.exec(this.useFtsFallback ? useDirectoryFtsFallback(schemaSql) : schemaSql);
  }

  prepare(query: string) {
    return new FakeD1PreparedStatement(this.sqlite, query, [], this.useFtsFallback);
  }

  async batch(statements: Array<FakeD1PreparedStatement>) {
    return Promise.all(statements.map((statement) => statement.all()));
  }

  async exec(query: string) {
    this.sqlite.exec(this.useFtsFallback ? rewriteFtsQueryForFallback(query) : query);
  }
}

export function createD1TestDb(schemaSql: string) {
  const d1 = new FakeD1Database(schemaSql);
  return {
    d1,
    db: drizzle(d1 as unknown as D1Database, { schema }),
    sqlite: d1.sqlite,
  };
}

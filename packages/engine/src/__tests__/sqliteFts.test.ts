import { describe, expect, it } from 'vitest';
import * as fts from '../adapters/sqlite/fts.js';
import { UnsupportedOnPostgresError } from '../db/sqlx.js';
import { compileSqliteQuery } from '../adapters/sqlite-handle.js';

const calls: Record<string, (db: object | 'sqlite' | 'pg') => unknown> = {
  directoryAgentFtsRanks: (db) => fts.directoryAgentFtsRanks(db, 'q', 'ws'),
  directorySkillFtsRanks: (db) => fts.directorySkillFtsRanks(db, 'q', 'ws'),
  skillSearchFtsFragments: (db) => fts.skillSearchFtsFragments(db, 'q'),
  routingSkillFtsRanks: (db) => fts.routingSkillFtsRanks(db, 'q', 'ws'),
  routingAgentFtsRanks: (db) => fts.routingAgentFtsRanks(db, 'q', 'ws'),
  mentionFtsCandidateFilter: (db) => fts.mentionFtsCandidateFilter(db, 'ws1', ['alice']),
  mentionFtsBackfillPage: (db) => fts.mentionFtsBackfillPage(db, 0, 10, 5),
  mentionFtsBackfillInsert: (db) => fts.mentionFtsBackfillInsert(db, 0, 10),
};

describe('adapters/sqlite/fts', () => {
  it('covers every export', () => {
    expect(Object.keys(fts).sort()).toEqual(Object.keys(calls).sort());
  });

  for (const [name, call] of Object.entries(calls)) {
    it(`${name} throws unsupported_on_postgres on pg`, () => {
      for (const db of ['pg', { engineDialect: 'pg' }] as const) {
        let error: unknown;
        try { call(db); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(UnsupportedOnPostgresError);
        expect((error as UnsupportedOnPostgresError).code).toBe('unsupported_on_postgres');
      }
    });

    it(`${name} throws for an unbranded handle`, () => {
      expect(() => call({})).toThrow(/engineDialect/);
    });

    it(`${name} builds on sqlite`, () => {
      expect(() => call('sqlite')).not.toThrow();
    });
  }

  it('keeps the inline mention MATCH text', () => {
    const filter = fts.mentionFtsCandidateFilter('sqlite', 'ws1', ['alice']);
    expect(compileSqliteQuery(filter!).sql).toBe(
      `messages.rowid IN (SELECT rowid FROM messages_mention_fts WHERE messages_mention_fts MATCH 'workspace_id : "ws1" AND body : "alice"*')`,
    );
    expect(fts.mentionFtsCandidateFilter('sqlite', 'ws1', ['al'])).toBeNull();
  });

  it('keeps the inline skill-search fragments', () => {
    const f = fts.skillSearchFtsFragments('sqlite', 'q');
    expect(compileSqliteQuery(f.match)).toMatchObject({ sql: 'AND directory_skills_fts MATCH ?', params: ['q'] });
    expect(compileSqliteQuery(f.order).sql).toBe('bm25(directory_skills_fts) ASC,');
  });
});

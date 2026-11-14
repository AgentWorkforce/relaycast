import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { pgTsQuery } from '../../adapters/sqlite/fts.js';
import * as sqlx from '../sqlx.js';

describe('PostgreSQL search and JSON helpers', () => {
  const text = (q: string) => new PgDialect().sqlToQuery(pgTsQuery(q));

  it('builds tsquery text with AND and phrases, quoting lexemes', () => {
    expect(text('foo bar').params).toEqual(["'foo' & 'bar'"]);
    expect(text('"one two" three').params).toEqual(["('one' <-> 'two') & 'three'"]);
    expect(text("o'r").params).toEqual(["'or'"]);
    expect(text('').params).toEqual(['']);
  });

  it('parses a raw JSON column from text or an already parsed value', () => {
    expect(sqlx.parseJsonColumn('["a"]', [])).toEqual(['a']);
    expect(sqlx.parseJsonColumn(['a'], [])).toEqual(['a']);
    expect(sqlx.parseJsonColumn(null, {})).toEqual({});
    expect(sqlx.parseJsonColumn('', {})).toEqual({});
  });
});

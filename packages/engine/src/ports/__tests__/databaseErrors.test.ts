import { is } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import * as pgSchema from '../../db/schema.pg.js';
import {
  databaseConstraintKind,
  databaseTriggerRefusal,
  databaseUniqueViolation,
  PG_NOT_NULL_SENTINELS,
  PG_UNIQUE_CONSTRAINTS,
} from '../database.js';

/** A node-postgres DatabaseError as the protocol parser fills it in. */
function pgError(code: string, fields: Partial<Record<'schema' | 'table' | 'column' | 'constraint', string>>, message = 'synthetic'): pg.DatabaseError {
  const err = new pg.DatabaseError(message, message.length, 'error');
  err.severity = 'ERROR';
  err.code = code;
  Object.assign(err, fields);
  return err;
}

/** As drizzle surfaces it: a DrizzleQueryError whose cause is the driver error. */
const wrapped = (cause: Error) => new DrizzleQueryError('insert into "relaycast"."t" ...', [], cause);

describe('PostgreSQL SQLSTATE decoding', () => {
  describe('23502 not-null sentinels', () => {
    it.each(Object.entries(PG_NOT_NULL_SENTINELS))('%s -> %s', (key, kind) => {
      const [table, column] = key.split('.');
      const err = pgError('23502', { schema: 'public', table, column });
      expect(databaseConstraintKind(err)).toBe(kind);
      expect(databaseConstraintKind(wrapped(err))).toBe(kind);
      expect(databaseConstraintKind(new Error('outer', { cause: wrapped(err) }))).toBe(kind);
    });

    it('decodes the same kinds SQLite decodes for the same columns', () => {
      for (const [key, kind] of Object.entries(PG_NOT_NULL_SENTINELS)) {
        expect(databaseConstraintKind(Object.assign(new Error(`NOT NULL constraint failed: ${key}`), { code: 'SQLITE_CONSTRAINT_NOTNULL' }))).toBe(kind);
      }
    });

    it('ignores other columns, the key guard, other schemas and missing fields', () => {
      expect(databaseConstraintKind(pgError('23502', { schema: 'public', table: 'messages', column: 'id' }))).toBeUndefined();
      expect(databaseConstraintKind(pgError('23502', { schema: 'public', table: 'channels', column: 'workspace_id' }))).toBeUndefined();
      expect(databaseConstraintKind(pgError('23502', { schema: 'control', table: 'nodes', column: 'active_agents' }))).toBeUndefined();
      expect(databaseConstraintKind(pgError('23502', { table: 'nodes', column: 'active_agents' }))).toBeUndefined();
      expect(databaseConstraintKind(pgError('23502', { schema: 'public', table: 'nodes' }))).toBeUndefined();
    });

    it('never reads the message: a PG error with SQLite-looking text decodes nothing', () => {
      const err = pgError('23502', { schema: 'public', table: 'messages', column: 'id' }, 'NOT NULL constraint failed: nodes.active_agents');
      expect(databaseConstraintKind(err)).toBeUndefined();
      expect(databaseConstraintKind(pgError('23514', { schema: 'public' }, 'NOT NULL constraint failed: deliveries.status'))).toBeUndefined();
    });

    it('a trigger refusal is not an admission sentinel on either dialect', () => {
      expect(databaseConstraintKind(pgError('23000', {}, 'agent_node_bindings workspace/agent mismatch'))).toBeUndefined();
      expect(databaseConstraintKind(new Error('agent_node_bindings workspace/agent mismatch'))).toBeUndefined();
    });
  });

  describe('23505 unique violations', () => {
    it('maps a constraint name to its table and columns', () => {
      const err = pgError('23505', { schema: 'public', table: 'observer_tokens', constraint: 'observer_tokens_workspace_name_unique' });
      expect(databaseUniqueViolation(wrapped(err))).toEqual({
        table: 'observer_tokens',
        columns: ['workspace_id', 'name'],
        constraint: 'observer_tokens_workspace_name_unique',
      });
      expect(databaseUniqueViolation(pgError('23505', { schema: 'public', constraint: 'workspaces_pkey' }))).toEqual({
        table: 'workspaces',
        columns: ['id'],
        constraint: 'workspaces_pkey',
      });
    });

    it('refuses unknown names, other schemas, other codes, and never reads the message', () => {
      expect(databaseUniqueViolation(pgError('23505', { schema: 'public', constraint: 'nope_unique' }))).toBeUndefined();
      expect(databaseUniqueViolation(pgError('23505', { schema: 'control', constraint: 'workspaces_pkey' }))).toBeUndefined();
      expect(databaseUniqueViolation(pgError('23503', { schema: 'public', constraint: 'workspaces_pkey' }))).toBeUndefined();
      expect(
        databaseUniqueViolation(pgError('23505', { schema: 'public' }, 'UNIQUE constraint failed: workspaces.id')),
      ).toBeUndefined();
    });

    it('decodes SQLite and D1 unique failures to the same table/columns shape', () => {
      const sqlite = Object.assign(new Error('UNIQUE constraint failed: observer_tokens.workspace_id, observer_tokens.name'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      expect(databaseUniqueViolation(sqlite)).toEqual({ table: 'observer_tokens', columns: ['workspace_id', 'name'] });
      const d1 = new Error('D1_ERROR: UNIQUE constraint failed: workspaces.id: SQLITE_CONSTRAINT');
      expect(databaseUniqueViolation(wrapped(d1))).toEqual({ table: 'workspaces', columns: ['id'] });
      const notNull = Object.assign(new Error('NOT NULL constraint failed: workspaces.id'), { code: 'SQLITE_CONSTRAINT_NOTNULL' });
      expect(databaseUniqueViolation(notNull)).toBeUndefined();
    });

    it('covers every unique index, unique constraint and primary key in schema.pg.ts, by server-side name', () => {
      const expected: Record<string, readonly [string, readonly string[]]> = {};
      // PostgreSQL truncates identifiers to NAMEDATALEN-1 = 63 bytes.
      const serverName = (name: string) => Buffer.from(name).subarray(0, 63).toString();
      for (const table of Object.values(pgSchema)) {
        if (!is(table, PgTable)) continue;
        const config = getTableConfig(table);
        for (const column of config.columns) {
          if (column.primary) expected[serverName(`${config.name}_pkey`)] = [config.name, [column.name]];
          if (column.isUnique && column.uniqueName) expected[serverName(column.uniqueName)] = [config.name, [column.name]];
        }
        for (const pk of config.primaryKeys) expected[serverName(pk.getName())] = [config.name, pk.columns.map((c) => c.name)];
        for (const unique of config.uniqueConstraints) {
          expected[serverName(unique.getName() ?? "")] = [config.name, unique.columns.map((c) => c.name)];
        }
        for (const index of config.indexes) {
          if (!index.config.unique) continue;
          expected[serverName(index.config.name!)] = [config.name, index.config.columns.map((c) => (c as { name: string }).name)];
        }
      }
      expect(Object.keys(expected).length).toBeGreaterThan(100);
      expect(PG_UNIQUE_CONSTRAINTS).toEqual(expected);
      expect(Object.isFrozen(PG_UNIQUE_CONSTRAINTS)).toBe(true);
      expect(Object.isFrozen(PG_NOT_NULL_SENTINELS)).toBe(true);
    });

    it('every not-null sentinel names a real NOT NULL column in schema.pg.ts', () => {
      const tables = new Map(
        Object.values(pgSchema).filter((t) => is(t, PgTable)).map((t) => [getTableConfig(t as PgTable).name, getTableConfig(t as PgTable)]),
      );
      for (const key of Object.keys(PG_NOT_NULL_SENTINELS)) {
        const [table, column] = key.split('.');
        expect(tables.get(table)?.columns.find((c) => c.name === column)?.notNull, key).toBe(true);
      }
    });
  });

  describe('23000 trigger refusals', () => {
    it('matches the exact trigger message only with SQLSTATE 23000', () => {
      expect(databaseTriggerRefusal(wrapped(pgError('23000', {}, 'agent_node_bindings workspace/agent mismatch')))).toBe('binding_agent_workspace_mismatch');
      expect(databaseTriggerRefusal(pgError('23000', {}, 'agent_node_bindings workspace/node mismatch'))).toBe('binding_node_workspace_mismatch');
      expect(databaseTriggerRefusal(pgError('23000', {}, 'agent_node_bindings workspace/node mismatch!'))).toBeUndefined();
      expect(databaseTriggerRefusal(pgError('P0001', {}, 'agent_node_bindings workspace/node mismatch'))).toBeUndefined();
    });

    it('matches the SQLite RAISE(ABORT) text, including D1 wrapping', () => {
      expect(databaseTriggerRefusal(Object.assign(new Error('agent_node_bindings workspace/agent mismatch'), { code: 'SQLITE_CONSTRAINT_TRIGGER' }))).toBe('binding_agent_workspace_mismatch');
      expect(databaseTriggerRefusal(new Error('D1_ERROR: agent_node_bindings workspace/node mismatch: SQLITE_CONSTRAINT'))).toBe('binding_node_workspace_mismatch');
      expect(databaseTriggerRefusal(new Error('something else'))).toBeUndefined();
    });
  });
});

/**
 * Type-level tests for the dialect-neutral `EngineDatabase` (src/ports/engineDb.ts).
 * Checked by `tsc -p tsconfig.typecheck.json`; never executed.
 *
 * 1. Row inference flows through select/from/innerJoin/leftJoin/crossJoin,
 *    partial selections, subqueries and `.returning()` -- for the real SQLite
 *    schema tables and for a table type that is a union of a SQLite and a PG
 *    declaration of the same table (the shape a dual-dialect binding has).
 * 2. For concrete queries the neutral row types equal what drizzle's own
 *    SQLite and PG builders infer.
 * 3. Spike record: drizzle's database classes are NOT structurally assignable
 *    to `EngineDatabase` (deferred dialect-bound conditionals in join/from
 *    signatures), and a `BaseSQLiteDatabase | PgDatabase` union is not
 *    callable. The `@ts-expect-error` lines fail the typecheck if that ever
 *    changes, at which point adapters can drop their construction cast.
 */
import { eq, sql } from 'drizzle-orm';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { bigint, pgTable, text as pgText } from 'drizzle-orm/pg-core';
import { agents, channels, workspaces } from '../../src/db/schema.js';
import type { EngineDatabase } from '../../src/ports/engineDb.js';

// Mutual assignability, rejecting `any` (drizzle's own types mix `$inferSelect`
// aliases and mapped types, so identity-based equality is too strict).
type IsAny<T> = 0 extends 1 & T ? true : false;
type Equal<A, B> = IsAny<A> extends true ? false : IsAny<B> extends true ? false
  : [A] extends [B] ? ([B] extends [A] ? true : false) : false;
function assertType<T extends true>(_value?: T): void {}

declare const db: EngineDatabase;

// --- 1. inference through the neutral builders, real schema tables ----------
export async function inference(): Promise<void> {
  const full = await db.select().from(agents).where(eq(agents.workspaceId, 'w'));
  assertType<Equal<typeof full, (typeof agents.$inferSelect)[]>>();

  const joined = await db.select().from(agents).innerJoin(workspaces, eq(agents.workspaceId, workspaces.id));
  assertType<Equal<typeof joined, { agents: typeof agents.$inferSelect; workspaces: typeof workspaces.$inferSelect }[]>>();

  const left = await db.select().from(agents).leftJoin(channels, eq(channels.workspaceId, agents.workspaceId));
  assertType<Equal<typeof left, { agents: typeof agents.$inferSelect; channels: typeof channels.$inferSelect | null }[]>>();

  const partial = await db
    .select({ id: agents.id, workspace: workspaces.name, channel: channels.name, n: sql<number>`1` })
    .from(agents)
    .innerJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .leftJoin(channels, eq(channels.workspaceId, workspaces.id))
    .orderBy(agents.id)
    .limit(1);
  assertType<Equal<typeof partial, { id: string; workspace: string; channel: string | null; n: number }[]>>();

  const crossed = await db.select({ a: agents.id, c: channels.id }).from(agents).crossJoin(channels);
  assertType<Equal<typeof crossed, { a: string; c: string }[]>>();

  const sub = db.select({ id: agents.id, name: agents.name }).from(agents).as('sub');
  const fromSub = await db.select({ id: sub.id }).from(sub);
  assertType<Equal<typeof fromSub, { id: string }[]>>();

  const inserted = await db.insert(channels).values({ id: 'c', workspaceId: 'w', name: 'n' }).returning();
  assertType<Equal<typeof inserted, (typeof channels.$inferSelect)[]>>();

  const updated = await db.update(agents).set({ name: 'x' }).where(eq(agents.id, 'a')).returning({ id: agents.id });
  assertType<Equal<typeof updated, { id: string }[]>>();

  const deleted = await db.delete(agents).where(eq(agents.id, 'a')).returning({ id: agents.id, ws: agents.workspaceId });
  assertType<Equal<typeof deleted, { id: string; ws: string }[]>>();

  await db.insert(agents).values([{ id: 'a', workspaceId: 'w', name: 'n', tokenHash: 'h' }]).onConflictDoNothing();
  // @ts-expect-error required column `workspaceId` missing
  await db.insert(agents).values({ id: 'a', name: 'n', tokenHash: 'h' });
  // @ts-expect-error unknown column
  await db.update(agents).set({ nope: 1 });
}

// --- 1b. a table typed as "SQLite or PG declaration" still infers ----------
const sItems = sqliteTable('items', { id: text('id').primaryKey(), seq: integer('seq').notNull(), note: text('note') });
const pItems = pgTable('items', { id: pgText('id').primaryKey(), seq: bigint('seq', { mode: 'number' }).notNull(), note: pgText('note') });
declare const items: typeof sItems | typeof pItems;

export async function neutralTable(): Promise<void> {
  const rows = await db.select().from(items);
  assertType<Equal<typeof rows, { id: string; seq: number; note: string | null }[]>>();
  const picked = await db.select({ id: items.id, seq: items.seq }).from(items).innerJoin(agents, eq(agents.id, items.id));
  assertType<Equal<typeof picked, { id: string; seq: number }[]>>();
  const ins = await db.insert(items).values({ id: 'x', seq: 1 }).returning();
  assertType<Equal<typeof ins, { id: string; seq: number; note: string | null }[]>>();
}

// --- 2. neutral rows equal drizzle's own inference -------------------------
declare const sqliteDb: BaseSQLiteDatabase<'async', unknown, Record<string, never>>;
declare const pgDb: PgDatabase<PgQueryResultHKT, Record<string, never>>;
const pgAgents = pgTable('agents', { id: pgText('id').primaryKey(), workspaceId: pgText('workspace_id').notNull() });
const pgWorkspaces = pgTable('workspaces', { id: pgText('id').primaryKey(), name: pgText('name').notNull() });

export async function agreesWithDrizzle(): Promise<void> {
  const viaSqlite = await sqliteDb.select({ id: agents.id, ws: workspaces.name }).from(agents)
    .leftJoin(workspaces, eq(agents.workspaceId, workspaces.id));
  const viaNeutral = await db.select({ id: agents.id, ws: workspaces.name }).from(agents)
    .leftJoin(workspaces, eq(agents.workspaceId, workspaces.id));
  assertType<Equal<typeof viaSqlite, typeof viaNeutral>>();

  const sqliteJoin = await sqliteDb.select().from(agents).innerJoin(workspaces, eq(agents.workspaceId, workspaces.id));
  const neutralJoin = await db.select().from(agents).innerJoin(workspaces, eq(agents.workspaceId, workspaces.id));
  assertType<Equal<typeof sqliteJoin, typeof neutralJoin>>();

  const sqliteRet = await sqliteDb.insert(channels).values({ id: 'c', workspaceId: 'w', name: 'n' }).returning();
  const neutralRet = await db.insert(channels).values({ id: 'c', workspaceId: 'w', name: 'n' }).returning();
  assertType<Equal<typeof sqliteRet, typeof neutralRet>>();

  const sqliteSub = sqliteDb.select({ id: agents.id }).from(agents).as('s');
  const neutralSub = db.select({ id: agents.id }).from(agents).as('s');
  const viaSqliteSub = await sqliteDb.select({ id: sqliteSub.id }).from(sqliteSub);
  const viaNeutralSub = await db.select({ id: neutralSub.id }).from(neutralSub);
  assertType<Equal<typeof viaSqliteSub, typeof viaNeutralSub>>();

  const pgJoin = await pgDb.select().from(pgAgents).leftJoin(pgWorkspaces, eq(pgAgents.workspaceId, pgWorkspaces.id));
  const neutralPgJoin = await db.select().from(pgAgents).leftJoin(pgWorkspaces, eq(pgAgents.workspaceId, pgWorkspaces.id));
  assertType<Equal<typeof pgJoin, typeof neutralPgJoin>>();

  const pgRet = await pgDb.insert(pgAgents).values({ id: 'a', workspaceId: 'w' }).returning({ id: pgAgents.id });
  const neutralPgRet = await db.insert(pgAgents).values({ id: 'a', workspaceId: 'w' }).returning({ id: pgAgents.id });
  assertType<Equal<typeof pgRet, typeof neutralPgRet>>();
}

// --- 3. spike record: why adapters construct the handle explicitly ---------
// @ts-expect-error BaseSQLiteDatabase's join/from signatures use deferred SQLiteTable conditionals
export const sqliteAssignable: EngineDatabase = sqliteDb as typeof sqliteDb & { readonly dialect: 'sqlite' };
// @ts-expect-error PgDatabase's from() takes a conditional parameter; joins are PgTable-bound
export const pgAssignable: EngineDatabase = pgDb as typeof pgDb & { readonly dialect: 'pg' };

declare const unionDb: typeof sqliteDb | typeof pgDb;
// @ts-expect-error a union of the two database classes is not callable (TS2349)
export const unionSelect = unionDb.select().from(agents);

/**
 * Dialect-neutral database handle used by engine code.
 *
 * The engine runs on SQLite (node, durable actor, D1) and is being taught to
 * run on PostgreSQL. Drizzle's database classes are dialect specific
 * (`BaseSQLiteDatabase`, `PgDatabase`), and their builder signatures contain
 * dialect-bound deferred conditional types (join selections are filtered by
 * `SQLiteTable`/`PgTable`, PG `from()` rejects empty selections through a
 * conditional parameter). TypeScript cannot relate those generic signatures to
 * a neutral generic signature, so neither database class is structurally
 * assignable to an interface that still infers rows (see
 * `test/types/engineDb.ts`, which pins this down).
 *
 * This module therefore describes the query-builder surface the engine uses in
 * terms of drizzle's dialect-independent helper types (`SelectResult`,
 * `AppendToResult`, `SelectResultFields`, ...), which is the same machinery
 * both dialects use internally, so row inference matches drizzle's. Adapters
 * build a drizzle database for their dialect and present it as an
 * `EngineDatabase` (that construction is the only place the two meet; it lives
 * under `adapters/`). Raw SQL goes through `db/sqlx.ts`, which dispatches on the
 * `engineDialect` brand instead of calling `run`/`all` (SQLite-only) directly.
 */
import type { Column, ColumnsSelection, Placeholder, Query, SQL, SQLWrapper, Subquery, Table } from 'drizzle-orm';
import type { MakeColumnConfig } from 'drizzle-orm/column-builder';
import type {
  AppendToNullabilityMap,
  AppendToResult,
  BuildSubquerySelection,
  GetSelectTableName,
  GetSelectTableSelection,
  JoinNullability,
  JoinType,
  SelectMode,
  SelectResult,
  SelectResultFields,
} from 'drizzle-orm/query-builders/select.types';
import type { SelectedFields as SelectedFieldsBase, SelectedFieldsFlat as SelectedFieldsFlatBase } from 'drizzle-orm/operations';

/** SQL dialect of a handle. Every handle carries it; raw SQL helpers switch on it. */
export type EngineDialect = 'sqlite' | 'pg';

export type EngineTableSource = Table | Subquery | SQL;
export type EngineSelectedFields = SelectedFieldsBase<Column, Table>;
export type EngineSelectedFieldsFlat = SelectedFieldsFlatBase<Column>;
type OrderTerm = Column | SQL | SQL.Aliased;

/**
 * Drizzle's `AddAliasToSelection` maps columns to the dialect's column class and
 * yields `never` for the `'common'` dialect, so subquery columns are re-homed
 * onto the base `Column` here instead (same config, table name = alias).
 */
export type EngineAliasedSelection<TSelection extends ColumnsSelection, TAlias extends string> = {
  [K in keyof TSelection]: TSelection[K] extends Column
    ? Column<MakeColumnConfig<TSelection[K]['_'], TAlias>>
    : TSelection[K] extends Table
      ? EngineAliasedSelection<TSelection[K]['_']['columns'], TAlias>
      : TSelection[K] extends SQL | SQL.Aliased
        ? TSelection[K]
        : TSelection[K] extends ColumnsSelection
          ? EngineAliasedSelection<TSelection[K], TAlias>
          : never;
} & {};

type JoinFn<
  TTableName extends string | undefined,
  TSelection extends ColumnsSelection,
  TSelectMode extends SelectMode,
  TNull extends Record<string, JoinNullability>,
  TJoinType extends JoinType,
> = <TJoined extends EngineTableSource, TJoinedName extends GetSelectTableName<TJoined> = GetSelectTableName<TJoined>>(
  table: TJoined,
  on: SQL | undefined,
) => EngineSelect<
  TTableName,
  AppendToResult<TTableName, TSelection, TJoinedName, GetSelectTableSelection<TJoined> & EngineSelectedFields, TSelectMode>,
  TSelectMode extends 'partial' ? TSelectMode : 'multiple',
  AppendToNullabilityMap<TNull, TJoinedName, TJoinType>
>;

type CrossJoinFn<
  TTableName extends string | undefined,
  TSelection extends ColumnsSelection,
  TSelectMode extends SelectMode,
  TNull extends Record<string, JoinNullability>,
> = <TJoined extends EngineTableSource, TJoinedName extends GetSelectTableName<TJoined> = GetSelectTableName<TJoined>>(
  table: TJoined,
) => EngineSelect<
  TTableName,
  AppendToResult<TTableName, TSelection, TJoinedName, GetSelectTableSelection<TJoined> & EngineSelectedFields, TSelectMode>,
  TSelectMode extends 'partial' ? TSelectMode : 'multiple',
  AppendToNullabilityMap<TNull, TJoinedName, 'cross'>
>;

/** A SELECT under construction; awaiting it yields the inferred rows. */
export interface EngineSelect<
  TTableName extends string | undefined,
  TSelection extends ColumnsSelection,
  TSelectMode extends SelectMode,
  // `{}` (as in drizzle) for a table-less source such as `from(sql`...`)`: an
  // index signature here would make every later join's nullability `never`.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  TNull extends Record<string, JoinNullability> = TTableName extends string ? Record<TTableName, 'not-null'> : {},
  TResult = SelectResult<TSelection, TSelectMode, TNull>[],
  TSelectedFields extends ColumnsSelection = BuildSubquerySelection<TSelection, TNull>,
> extends PromiseLike<TResult>, SQLWrapper {
  readonly _: { readonly selectedFields: TSelectedFields; readonly result: TResult };
  where(where: SQL | undefined): this;
  having(having: SQL | undefined): this;
  groupBy(...columns: (Column | SQL | SQL.Aliased)[]): this;
  orderBy(...columns: OrderTerm[]): this;
  limit(limit: number | Placeholder): this;
  offset(offset: number | Placeholder): this;
  innerJoin: JoinFn<TTableName, TSelection, TSelectMode, TNull, 'inner'>;
  leftJoin: JoinFn<TTableName, TSelection, TSelectMode, TNull, 'left'>;
  crossJoin: CrossJoinFn<TTableName, TSelection, TSelectMode, TNull>;
  as<TAlias extends string>(
    alias: TAlias,
  ): Subquery<TAlias, EngineAliasedSelection<TSelectedFields, TAlias>> & EngineAliasedSelection<TSelectedFields, TAlias>;
  toSQL(): Query;
}

export interface EngineSelectBuilder<TSelection extends EngineSelectedFields | undefined> {
  from<TFrom extends EngineTableSource>(source: TFrom): EngineSelect<
    GetSelectTableName<TFrom>,
    TSelection extends undefined ? GetSelectTableSelection<TFrom> : TSelection,
    TSelection extends undefined ? 'single' : 'partial'
  >;
}

/** Standalone select builder handed to `insert(...).select((qb) => ...)`. */
export interface EngineQueryBuilder {
  select(): EngineSelectBuilder<undefined>;
  select<TSelection extends EngineSelectedFields>(fields: TSelection): EngineSelectBuilder<TSelection>;
  selectDistinct(): EngineSelectBuilder<undefined>;
  selectDistinct<TSelection extends EngineSelectedFields>(fields: TSelection): EngineSelectBuilder<TSelection>;
}

export type EngineInsertValue<T extends Table> = { [K in keyof T['$inferInsert']]: T['$inferInsert'][K] | SQL | Placeholder };
export type EngineUpdateSet<T extends Table> = { [K in keyof T['$inferInsert']]?: T['$inferInsert'][K] | SQL | Column | undefined };

/** An executable write statement; awaiting it yields `unknown` (driver run result). */
export interface EngineWrite extends PromiseLike<unknown>, SQLWrapper {
  toSQL(): Query;
}

/** A write statement after `.returning(...)`; awaiting it yields the returned rows. */
export interface EngineReturningWrite<TRow> extends PromiseLike<TRow[]>, SQLWrapper {
  toSQL(): Query;
}

interface Returning<T extends Table> {
  returning(): EngineReturningWrite<T['$inferSelect']>;
  returning<TFields extends EngineSelectedFieldsFlat>(fields: TFields): EngineReturningWrite<SelectResultFields<TFields>>;
}

export interface EngineInsert<T extends Table> extends EngineWrite, Returning<T> {
  onConflictDoNothing(config?: { target?: Column | Column[]; where?: SQL }): EngineInsert<T>;
  onConflictDoUpdate(config: {
    target: Column | Column[];
    set: EngineUpdateSet<T>;
    targetWhere?: SQL;
    setWhere?: SQL;
    where?: SQL;
  }): EngineInsert<T>;
}

type InsertSelectSource<T extends Table> =
  | SQL
  | { readonly _: { readonly selectedFields: { [K in keyof T['$inferInsert']]: unknown } } };

export interface EngineInsertBuilder<T extends Table> {
  values(value: EngineInsertValue<T>): EngineInsert<T>;
  values(values: EngineInsertValue<T>[]): EngineInsert<T>;
  select(query: InsertSelectSource<T> | ((qb: EngineQueryBuilder) => InsertSelectSource<T>)): EngineInsert<T>;
}

export interface EngineUpdate<T extends Table> extends EngineWrite, Returning<T> {
  where(where: SQL | undefined): EngineUpdate<T>;
}

export interface EngineUpdateBuilder<T extends Table> {
  set(values: EngineUpdateSet<T>): EngineUpdate<T>;
}

export interface EngineDelete<T extends Table> extends EngineWrite, Returning<T> {
  where(where: SQL | undefined): EngineDelete<T>;
}

/**
 * The query-builder surface of a database handle, independent of dialect.
 *
 * The brand is `engineDialect`, not `dialect`: drizzle's database objects
 * already own a `dialect` property (their SQL dialect object, read by every
 * builder), so it must not be shadowed.
 */
export interface EngineDatabase extends EngineQueryBuilder {
  readonly engineDialect: EngineDialect;
  insert<T extends Table>(table: T): EngineInsertBuilder<T>;
  update<T extends Table>(table: T): EngineUpdateBuilder<T>;
  delete<T extends Table>(table: T): EngineDelete<T>;
}

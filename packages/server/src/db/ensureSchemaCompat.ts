type D1CompatDatabase = D1Database & Pick<D1Database, 'prepare'>;


type ColumnRequirement = {
  table: 'channels' | 'messages';
  column: 'metadata';
  ddl: string;
};

const REQUIRED_COLUMNS: readonly ColumnRequirement[] = [
  {
    table: 'channels',
    column: 'metadata',
    ddl: "ALTER TABLE channels ADD COLUMN metadata TEXT DEFAULT '{}'",
  },
  {
    table: 'messages',
    column: 'metadata',
    ddl: "ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT '{}'",
  },
];

const schemaReadyByDb = new WeakMap<D1Database, Promise<void>>();

function canCheckSchema(db: D1Database): db is D1CompatDatabase {
  const maybeDb = db as unknown as { prepare?: unknown };
  return typeof maybeDb.prepare === 'function';
}

async function listTableColumns(
  db: D1CompatDatabase,
  table: 'channels' | 'messages',
): Promise<Set<string>> {
  const result = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
  const rows = Array.isArray(result.results) ? result.results : [];
  return new Set(rows.map((row) => row.name));
}

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.toLowerCase().includes('duplicate column name');
}

async function applyMissingColumn(
  db: D1CompatDatabase,
  requirement: ColumnRequirement,
): Promise<void> {
  const columns = await listTableColumns(db, requirement.table);
  if (columns.has(requirement.column)) return;

  try {
    const execFn = (db as unknown as { exec?: (query: string) => Promise<unknown> }).exec;
    if (typeof execFn === 'function') {
      await execFn.call(db, requirement.ddl);
    } else {
      await db.prepare(requirement.ddl).run();
    }
  } catch (error) {
    // A concurrent request may add the same column first.
    if (!isDuplicateColumnError(error)) throw error;
  }
}

export async function ensureSchemaCompat(db: D1Database): Promise<void> {
  if (!canCheckSchema(db)) return;

  const existing = schemaReadyByDb.get(db);
  if (existing) {
    await existing;
    return;
  }

  const ready = (async () => {
    for (const requirement of REQUIRED_COLUMNS) {
      await applyMissingColumn(db, requirement);
    }
  })().catch((error) => {
    schemaReadyByDb.delete(db);
    throw error;
  });

  schemaReadyByDb.set(db, ready);
  await ready;
}

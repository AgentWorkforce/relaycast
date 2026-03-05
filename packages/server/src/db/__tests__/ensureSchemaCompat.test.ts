import { describe, it, expect, vi } from 'vitest';
import { ensureSchemaCompat } from '../ensureSchemaCompat.js';

function createMockD1(
  initialColumns: Record<string, string[]>,
  opts: { throwDuplicateOnExec?: boolean } = {},
): D1Database & { prepare: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> } {
  const columnsByTable = new Map<string, Set<string>>(
    Object.entries(initialColumns).map(([table, columns]) => [table, new Set(columns)]),
  );

  const prepare = vi.fn((query: string) => ({
    all: vi.fn(async () => {
      const match = query.match(/PRAGMA table_info\("([^"]+)"\)/i);
      const table = match?.[1] ?? '';
      const cols = columnsByTable.get(table) ?? new Set<string>();
      return { results: [...cols].map((name) => ({ name })) };
    }),
  }));

  const exec = vi.fn(async (query: string) => {
    const match = query.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
    if (!match) return;
    const table = match[1];
    const column = match[2];

    const cols = columnsByTable.get(table) ?? new Set<string>();
    if (cols.has(column) || opts.throwDuplicateOnExec) {
      throw new Error(`duplicate column name: ${column}`);
    }
    cols.add(column);
    columnsByTable.set(table, cols);
  });

  return { prepare, exec } as unknown as D1Database & {
    prepare: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
  };
}

describe('ensureSchemaCompat', () => {
  it('adds missing metadata columns for channels and messages', async () => {
    const d1 = createMockD1({
      channels: ['id', 'workspace_id', 'name'],
      messages: ['id', 'workspace_id', 'channel_id'],
    });

    await ensureSchemaCompat(d1);

    expect(d1.exec).toHaveBeenCalledTimes(2);
    expect(d1.exec).toHaveBeenCalledWith(
      "ALTER TABLE channels ADD COLUMN metadata TEXT DEFAULT '{}'",
    );
    expect(d1.exec).toHaveBeenCalledWith(
      "ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT '{}'",
    );
  });

  it('does nothing when columns already exist', async () => {
    const d1 = createMockD1({
      channels: ['id', 'metadata'],
      messages: ['id', 'metadata'],
    });

    await ensureSchemaCompat(d1);

    expect(d1.exec).not.toHaveBeenCalled();
  });

  it('treats duplicate-column race as success', async () => {
    const d1 = createMockD1(
      {
        channels: ['id'],
        messages: ['id'],
      },
      { throwDuplicateOnExec: true },
    );

    await expect(ensureSchemaCompat(d1)).resolves.toBeUndefined();
  });

  it('runs only once per DB binding', async () => {
    const d1 = createMockD1({
      channels: ['id'],
      messages: ['id'],
    });

    await ensureSchemaCompat(d1);
    await ensureSchemaCompat(d1);

    expect(d1.exec).toHaveBeenCalledTimes(2);
  });
});

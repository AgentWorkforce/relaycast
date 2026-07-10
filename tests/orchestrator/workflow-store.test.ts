import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, index, integer } from "drizzle-orm/pg-core";

// ── Inline schema (mirrors packages/web/lib/db/schema.ts) ──────────────

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });
const uuidColumn = (name: string) => uuid(name);

const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuidColumn("id").primaryKey(),
    sandboxId: text("sandbox_id").notNull(),
    userId: uuidColumn("user_id").notNull(),
    workspaceId: uuidColumn("workspace_id").notNull(),
    workflow: text("workflow").notNull(),
    fileType: text("file_type").notNull(),
    callbackToken: text("callback_token").notNull(),
    status: text("status").notNull(),
    result: text("result"),
    error: text("error"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => ({
    userIndex: index("idx_workflow_runs_user").on(table.userId),
    workspaceIndex: index("idx_workflow_runs_workspace").on(table.workspaceId),
    statusIndex: index("idx_workflow_runs_status").on(table.status),
  }),
);

// ── Lightweight store (same logic as packages/web/lib/workflows.ts) ────

type WorkflowFileType = "yaml" | "ts" | "py";

interface WorkflowRecord {
  runId: string;
  sandboxId: string;
  userId: string;
  workspaceId: string;
  workflow: string;
  fileType: WorkflowFileType;
  status: string;
  callbackToken: string;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

interface WorkflowCreateInput {
  runId: string;
  sandboxId: string;
  userId: string;
  workspaceId: string;
  workflow: string;
  fileType: WorkflowFileType;
  callbackToken: string;
  status: string;
}

interface WorkflowPatch {
  status?: string;
  result?: unknown;
  error?: string;
}

function rowToRecord(row: typeof workflowRuns.$inferSelect): WorkflowRecord {
  return {
    runId: row.id,
    sandboxId: row.sandboxId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    workflow: row.workflow,
    fileType: row.fileType as WorkflowFileType,
    status: row.status,
    callbackToken: row.callbackToken,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
  };
}

function createWorkflowStore(db: ReturnType<typeof drizzle>) {
  return {
    async create(input: WorkflowCreateInput): Promise<WorkflowRecord> {
      const now = new Date();
      const [row] = await db
        .insert(workflowRuns)
        .values({
          id: input.runId,
          sandboxId: input.sandboxId,
          userId: input.userId,
          workspaceId: input.workspaceId,
          workflow: input.workflow,
          fileType: input.fileType,
          callbackToken: input.callbackToken,
          status: input.status,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return rowToRecord(row);
    },

    async get(runId: string): Promise<WorkflowRecord | null> {
      const [row] = await db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .limit(1);
      return row ? rowToRecord(row) : null;
    },

    async update(runId: string, patch: WorkflowPatch): Promise<WorkflowRecord> {
      const values: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.result !== undefined) values.result = JSON.stringify(patch.result);
      if (patch.error !== undefined) values.error = patch.error;

      const [row] = await db
        .update(workflowRuns)
        .set(values)
        .where(eq(workflowRuns.id, runId))
        .returning();

      if (!row) throw new Error(`Workflow run not found: ${runId}`);
      return rowToRecord(row);
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("workflowStore", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let workflowStore: ReturnType<typeof createWorkflowStore>;

  before(async () => {
    client = new PGlite();
    db = drizzle(client);

    // Create the table
    await client.exec(`
      CREATE TABLE workflow_runs (
        id UUID PRIMARY KEY,
        sandbox_id TEXT NOT NULL,
        user_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        workflow TEXT NOT NULL,
        file_type TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX idx_workflow_runs_user ON workflow_runs (user_id);
      CREATE INDEX idx_workflow_runs_workspace ON workflow_runs (workspace_id);
      CREATE INDEX idx_workflow_runs_status ON workflow_runs (status);
    `);

    workflowStore = createWorkflowStore(db);
  });

  after(async () => {
    await client.close();
  });

  it("creates a workflow record with timestamps", async () => {
    const record = await workflowStore.create({
      runId: "a0000000-0000-0000-0000-000000000001",
      sandboxId: "sb-1",
      userId: "b0000000-0000-0000-0000-000000000001",
      workspaceId: "c0000000-0000-0000-0000-000000000001",
      workflow: "name: test",
      fileType: "yaml",
      callbackToken: "cb-1",
      status: "pending",
    });

    assert.equal(record.runId, "a0000000-0000-0000-0000-000000000001");
    assert.equal(record.status, "pending");
    assert.ok(record.createdAt);
    assert.ok(record.updatedAt);
  });

  it("retrieves a created record by runId", async () => {
    await workflowStore.create({
      runId: "a0000000-0000-0000-0000-000000000002",
      sandboxId: "sb-2",
      userId: "b0000000-0000-0000-0000-000000000001",
      workspaceId: "c0000000-0000-0000-0000-000000000001",
      workflow: "name: test",
      fileType: "yaml",
      callbackToken: "cb-2",
      status: "pending",
    });

    const found = await workflowStore.get("a0000000-0000-0000-0000-000000000002");
    assert.ok(found);
    assert.equal(found!.runId, "a0000000-0000-0000-0000-000000000002");
    assert.equal(found!.sandboxId, "sb-2");
  });

  it("returns null for nonexistent runId", async () => {
    const found = await workflowStore.get("a0000000-0000-0000-0000-999999999999");
    assert.equal(found, null);
  });

  it("updates a record with patch", async () => {
    await workflowStore.create({
      runId: "a0000000-0000-0000-0000-000000000003",
      sandboxId: "sb-3",
      userId: "b0000000-0000-0000-0000-000000000001",
      workspaceId: "c0000000-0000-0000-0000-000000000001",
      workflow: "name: test",
      fileType: "ts",
      callbackToken: "cb-3",
      status: "pending",
    });

    const updated = await workflowStore.update("a0000000-0000-0000-0000-000000000003", {
      status: "completed",
      result: { summary: "done" },
    });

    assert.equal(updated.status, "completed");
    assert.deepEqual(updated.result, { summary: "done" });
    assert.ok(updated.updatedAt >= updated.createdAt);
  });

  it("update sets error field when provided", async () => {
    await workflowStore.create({
      runId: "a0000000-0000-0000-0000-000000000004",
      sandboxId: "sb-4",
      userId: "b0000000-0000-0000-0000-000000000001",
      workspaceId: "c0000000-0000-0000-0000-000000000001",
      workflow: "name: test",
      fileType: "py",
      callbackToken: "cb-4",
      status: "running",
    });

    const updated = await workflowStore.update("a0000000-0000-0000-0000-000000000004", {
      status: "failed",
      error: "Sandbox crashed",
    });

    assert.equal(updated.status, "failed");
    assert.equal(updated.error, "Sandbox crashed");
  });

  it("throws on update for nonexistent runId", async () => {
    await assert.rejects(
      () => workflowStore.update("a0000000-0000-0000-0000-999999999998", { status: "completed" }),
      { message: /not found/i },
    );
  });
});

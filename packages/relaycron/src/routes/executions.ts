import { Hono } from "hono";
import { eq, and, desc, lt } from "drizzle-orm";
import { ListExecutionsQuery } from "../schemas.js";
import { schedules, executions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import type { Env } from "../types.js";

const executionsRouter = new Hono<{ Bindings: Env }>();

executionsRouter.use("*", requireAuth);

// List executions for a schedule
executionsRouter.get("/schedules/:schedule_id/executions", async (c) => {
  const auth = c.get("auth");
  const db = c.get("db");
  const scheduleId = c.req.param("schedule_id");

  // Verify ownership
  const [schedule] = await db
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.id, scheduleId),
        eq(schedules.api_key_id, auth.apiKeyId)
      )
    )
    .limit(1);

  if (!schedule) {
    return c.json(
      {
        ok: false,
        error: { code: "not_found", message: "Schedule not found" },
      },
      404
    );
  }

  const queryParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) {
    if (typeof v === "string") queryParams[k] = v;
  }
  const query = ListExecutionsQuery.parse(queryParams);
  const conditions = [eq(executions.schedule_id, scheduleId)];
  if (query.status) conditions.push(eq(executions.status, query.status));
  if (query.cursor) conditions.push(lt(executions.started_at, query.cursor));

  const results = await db
    .select()
    .from(executions)
    .where(and(...conditions))
    .orderBy(desc(executions.started_at))
    .limit(query.limit + 1);

  const hasMore = results.length > query.limit;
  const items = hasMore ? results.slice(0, query.limit) : results;

  return c.json({
    ok: true,
    data: items,
    cursor: hasMore ? items[items.length - 1].started_at : null,
    has_more: hasMore,
  });
});

// Get single execution
executionsRouter.get(
  "/schedules/:schedule_id/executions/:execution_id",
  async (c) => {
    const auth = c.get("auth");
    const db = c.get("db");
    const scheduleId = c.req.param("schedule_id");
    const executionId = c.req.param("execution_id");

    // Verify ownership
    const [schedule] = await db
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.id, scheduleId),
          eq(schedules.api_key_id, auth.apiKeyId)
        )
      )
      .limit(1);

    if (!schedule) {
      return c.json(
        {
          ok: false,
          error: { code: "not_found", message: "Schedule not found" },
        },
        404
      );
    }

    const [execution] = await db
      .select()
      .from(executions)
      .where(
        and(
          eq(executions.id, executionId),
          eq(executions.schedule_id, scheduleId)
        )
      )
      .limit(1);

    if (!execution) {
      return c.json(
        {
          ok: false,
          error: { code: "not_found", message: "Execution not found" },
        },
        404
      );
    }

    return c.json({ ok: true, data: execution });
  }
);

export default executionsRouter;

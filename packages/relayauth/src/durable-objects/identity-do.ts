import { DurableObject } from "cloudflare:workers";
import type {
  IdentityBudget,
  IdentityBudgetUsage,
  StoredIdentity,
} from "@relayauth/server/storage/interface";

import type { CloudflareStorageBindings } from "../storage/cloudflare/types.js";

export type { IdentityBudget, IdentityBudgetUsage, StoredIdentity };

type Bindings = Pick<CloudflareStorageBindings, "DB" | "INTERNAL_SECRET">;
type IdentityUpdate = Partial<StoredIdentity>;

interface SqlRow {
  data: string;
}

interface SqlCursor<T> {
  one(): T | null;
}

interface DurableObjectSqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): SqlCursor<T>;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS identity_records (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_identity_records_updated_at
    ON identity_records(updated_at);
`;

const SELECT_SQL = `
  SELECT data
  FROM identity_records
  ORDER BY updated_at DESC, id DESC
  LIMIT 1
`;

const UPSERT_SQL = `
  INSERT OR REPLACE INTO identity_records (id, data, updated_at)
  VALUES (?, ?, ?)
`;

// Each DO instance holds exactly one identity, so DELETE removes that single row.
const DELETE_SQL = `DELETE FROM identity_records`;

export class IdentityDO extends DurableObject<Bindings> {
  private readonly schemaReady: Promise<void>;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.schemaReady = this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA_SQL);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/internal/")) {
      const secret = request.headers.get("x-internal-secret");
      if (!secret || secret !== this.env.INTERNAL_SECRET) {
        return jsonErrorResponse("Unauthorized", 401);
      }
    }

    try {
      if (request.method === "POST" && url.pathname === "/internal/create") {
        const body = await request.json<StoredIdentity>().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonErrorResponse("Invalid JSON body", 400);
        }
        const identity = await this.create(body);
        return Response.json(identity, { status: 201 });
      }

      if (request.method === "GET" && url.pathname === "/internal/get") {
        const identity = await this.get();
        if (!identity) {
          return jsonErrorResponse("identity_not_found", 404);
        }
        return Response.json(identity, { status: 200 });
      }

      if (request.method === "PATCH" && url.pathname === "/internal/update") {
        const body = await request.json<IdentityUpdate>().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonErrorResponse("Invalid JSON body", 400);
        }
        const identity = await this.update(body);
        return Response.json(identity, { status: 200 });
      }

      if (request.method === "POST" && url.pathname === "/internal/suspend") {
        const body = await request.json<{ reason?: string }>().catch(() => null);
        const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
        if (!reason) {
          return jsonErrorResponse("reason is required", 400);
        }
        const identity = await this.suspend(reason);
        return Response.json(identity, { status: 200 });
      }

      if (request.method === "POST" && url.pathname === "/internal/retire") {
        const identity = await this.retire();
        return Response.json(identity, { status: 200 });
      }

      if (request.method === "POST" && url.pathname === "/internal/reactivate") {
        const identity = await this.reactivate();
        return Response.json(identity, { status: 200 });
      }

      if (request.method === "DELETE" && url.pathname === "/internal/delete") {
        const existing = await this.get();
        if (!existing) {
          return jsonErrorResponse("identity_not_found", 404);
        }
        await this.delete();
        return new Response(null, { status: 204 });
      }

      return jsonErrorResponse("Not found", 404);
    } catch (error) {
      return toErrorResponse(error);
    }
  }

  async create(input: StoredIdentity): Promise<StoredIdentity> {
    await this.schemaReady;
    this.assertCreateInput(input);

    const timestamp = new Date().toISOString();
    const finalIdentity = await this.applyBudgetPolicy(input, input, timestamp);

    await this.save(finalIdentity);
    await this.syncBudgetUsage(finalIdentity);

    return finalIdentity;
  }

  async get(): Promise<StoredIdentity | null> {
    await this.schemaReady;
    return this.read();
  }

  async update(input: IdentityUpdate): Promise<StoredIdentity> {
    await this.schemaReady;

    const current = await this.requireIdentity();
    const timestamp = new Date().toISOString();
    const merged = this.mergeIdentity(current, input, timestamp);
    const finalIdentity = await this.applyBudgetPolicy(current, merged, timestamp);

    await this.save(finalIdentity);
    await this.syncBudgetUsage(finalIdentity);
    return finalIdentity;
  }

  async suspend(reason: string): Promise<StoredIdentity> {
    await this.schemaReady;

    const current = await this.requireIdentity();
    if (current.status === "retired") {
      throw new Error("Retired identities cannot be suspended");
    }

    const timestamp = new Date().toISOString();
    const suspended: StoredIdentity = {
      ...current,
      status: "suspended",
      suspendReason: reason,
      suspendedAt: timestamp,
      updatedAt: timestamp,
    };

    await this.save(suspended);
    return suspended;
  }

  async reactivate(): Promise<StoredIdentity> {
    await this.schemaReady;

    const current = await this.requireIdentity();
    if (current.status === "retired") {
      throw new Error("Retired identities cannot be reactivated");
    }

    const timestamp = new Date().toISOString();
    const reactivated: StoredIdentity = {
      ...current,
      status: "active",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: timestamp,
    };

    await this.save(reactivated);
    return reactivated;
  }

  async retire(): Promise<StoredIdentity> {
    await this.schemaReady;

    const current = await this.requireIdentity();
    const timestamp = new Date().toISOString();
    const retired: StoredIdentity = {
      ...current,
      status: "retired",
      suspendedAt: undefined,
      suspendReason: undefined,
      updatedAt: timestamp,
    };

    await this.save(retired);
    await this.syncBudgetUsage(retired);
    return retired;
  }

  async delete(): Promise<void> {
    await this.schemaReady;
    this.sql.exec(DELETE_SQL);
    await this.ctx.storage.delete("budgetUsage");
  }

  private get sql(): DurableObjectSqlStorage {
    return (this.ctx.storage as DurableObjectStorage & { sql: DurableObjectSqlStorage }).sql;
  }

  private async read(): Promise<StoredIdentity | null> {
    const row = this.sql.exec<SqlRow>(SELECT_SQL).one();
    if (!row) {
      return null;
    }

    return JSON.parse(row.data) as StoredIdentity;
  }

  private async requireIdentity(): Promise<StoredIdentity> {
    const identity = await this.read();
    if (!identity) {
      throw new Error("Identity not found");
    }

    return identity;
  }

  private async save(identity: StoredIdentity): Promise<void> {
    this.sql.exec(UPSERT_SQL, identity.id, JSON.stringify(identity), identity.updatedAt);
  }

  private async syncBudgetUsage(identity: StoredIdentity): Promise<void> {
    if (identity.budgetUsage) {
      await this.ctx.storage.put("budgetUsage", identity.budgetUsage);
      return;
    }

    await this.ctx.storage.delete("budgetUsage");
  }

  private mergeIdentity(
    current: StoredIdentity,
    update: IdentityUpdate,
    timestamp: string,
  ): StoredIdentity {
    return {
      ...current,
      ...update,
      metadata: update.metadata ? { ...current.metadata, ...update.metadata } : current.metadata,
      scopes: update.scopes ?? current.scopes,
      roles: update.roles ?? current.roles,
      sponsorChain: update.sponsorChain ?? current.sponsorChain,
      budget: update.budget ?? current.budget,
      budgetUsage: update.budgetUsage ?? current.budgetUsage,
      updatedAt: timestamp,
    };
  }

  private async applyBudgetPolicy(
    previous: StoredIdentity,
    identity: StoredIdentity,
    timestamp: string,
  ): Promise<StoredIdentity> {
    if (!this.isBudgetExceeded(identity) || identity.status === "retired") {
      return identity;
    }

    if (!identity.budget?.autoSuspend) {
      return identity;
    }

    const suspended: StoredIdentity = {
      ...identity,
      status: "suspended",
      suspendReason: "budget_exceeded",
      suspendedAt: identity.suspendedAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (previous.status !== "suspended" || previous.suspendReason !== "budget_exceeded") {
      await this.writeBudgetAuditEvent(suspended);
    }

    return suspended;
  }

  private isBudgetExceeded(identity: StoredIdentity): boolean {
    const budget = identity.budget;
    const usage = identity.budgetUsage;
    if (!budget || !usage) {
      return false;
    }

    const actionsExceeded =
      typeof budget.maxActionsPerHour === "number"
      && usage.actionsThisHour > budget.maxActionsPerHour;
    const costExceeded =
      typeof budget.maxCostPerDay === "number" && usage.costToday > budget.maxCostPerDay;

    return actionsExceeded || costExceeded;
  }

  private async writeBudgetAuditEvent(identity: StoredIdentity): Promise<void> {
    const query = `
      INSERT INTO audit_events (
        id,
        org_id,
        workspace_id,
        identity_id,
        action,
        reason,
        payload,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const payload = JSON.stringify({
      eventType: "budget.exceeded",
      status: identity.status,
      sponsorId: identity.sponsorId,
      sponsorChain: identity.sponsorChain,
      budget: identity.budget,
      budgetUsage: identity.budgetUsage,
    });

    try {
      await this.env.DB.prepare(query)
        .bind(
          crypto.randomUUID(),
          identity.orgId,
          identity.workspaceId,
          identity.id,
          "identity.suspended",
          "budget_exceeded",
          payload,
          identity.updatedAt,
        )
        .run();
    } catch (err) {
      console.error("Failed to write budget audit event", err);
    }
  }

  private assertCreateInput(input: StoredIdentity): void {
    if (!input.sponsorId) {
      throw new Error("sponsorId is required");
    }

    if (!Array.isArray(input.sponsorChain) || input.sponsorChain.length === 0) {
      throw new Error("sponsorChain is required");
    }

    if (!input.workspaceId) {
      throw new Error("workspaceId is required");
    }
  }
}

export default IdentityDO;

function jsonErrorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function toErrorResponse(error: unknown): Response {
  if (error instanceof Error) {
    if (error.message === "Identity not found") {
      return jsonErrorResponse("identity_not_found", 404);
    }

    if (error.message === "Retired identities cannot be suspended") {
      return jsonErrorResponse(error.message, 409);
    }

    if (error.message === "Retired identities cannot be reactivated") {
      return jsonErrorResponse(error.message, 409);
    }

    if (
      error.message === "sponsorId is required"
      || error.message === "sponsorChain is required"
      || error.message === "workspaceId is required"
    ) {
      return jsonErrorResponse(error.message, 400);
    }

    return jsonErrorResponse(error.message || "internal_error", 500);
  }

  return jsonErrorResponse("internal_error", 500);
}

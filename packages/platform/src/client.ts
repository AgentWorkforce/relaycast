import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema.js";
import type { PlatformProduct, WorkspacePolicy } from "./schema.js";

export type PlatformDb = NodePgDatabase<typeof schema>;

export interface ProductRegistrationInput {
  id: string;
  displayName?: string;
  description?: string | null;
}

export interface ProductAccessInput {
  workspaceId: string;
  productId: string;
  displayName?: string;
  description?: string | null;
}

export interface PlatformClient {
  db: PlatformDb;
  pool: Pool;
  getWorkspacePolicy: (workspaceId: string) => Promise<WorkspacePolicy>;
  registerProduct: (input: string | ProductRegistrationInput) => Promise<PlatformProduct>;
  grantProductAccess: (input: ProductAccessInput) => Promise<WorkspacePolicy>;
  revokeProductAccess: (workspaceId: string, productId: string) => Promise<WorkspacePolicy>;
  close: () => Promise<void>;
}

export function createPlatformDb(pool: Pool): PlatformDb {
  return drizzle(pool, { schema });
}

export function createPlatformClient(config: string | Pool | PoolConfig): PlatformClient {
  const pool =
    typeof config === "string"
      ? new Pool({ connectionString: config })
      : config instanceof Pool
        ? config
        : new Pool(config);
  const db = createPlatformDb(pool);

  return {
    db,
    pool,
    getWorkspacePolicy: (workspaceId) => getWorkspacePolicy(db, workspaceId),
    registerProduct: (input) => registerProduct(db, input),
    grantProductAccess: (input) => grantProductAccess(db, input),
    revokeProductAccess: (workspaceId, productId) =>
      revokeProductAccess(db, workspaceId, productId),
    close: () => pool.end(),
  };
}

export async function getWorkspacePolicy(
  db: PlatformDb,
  workspaceId: string,
): Promise<WorkspacePolicy> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);

  const [policyRecord, accessRows] = await Promise.all([
    db.query.workspacePlatformPolicies.findFirst({
      where: eq(schema.workspacePlatformPolicies.workspaceId, normalizedWorkspaceId),
    }),
    db
      .select({
        productId: schema.workspacePlatformAccess.productId,
      })
      .from(schema.workspacePlatformAccess)
      .where(eq(schema.workspacePlatformAccess.workspaceId, normalizedWorkspaceId))
      .orderBy(asc(schema.workspacePlatformAccess.productId)),
  ]);

  return {
    workspaceId: normalizedWorkspaceId,
    enforceProductScope: policyRecord?.enforceProductScope ?? false,
    allowedProductIds: accessRows.map((row) => row.productId),
    productScopes: {},
  };
}

export async function registerProduct(
  db: PlatformDb,
  input: string | ProductRegistrationInput,
): Promise<PlatformProduct> {
  const product = normalizeProductInput(input);

  const [record] = await db
    .insert(schema.platformProducts)
    .values({
      id: product.id,
      displayName: product.displayName,
      description: product.description ?? null,
    })
    .onConflictDoUpdate({
      target: schema.platformProducts.id,
      set: {
        displayName: product.displayName,
        description: product.description ?? null,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return record;
}

export async function grantProductAccess(
  db: PlatformDb,
  input: ProductAccessInput,
): Promise<WorkspacePolicy> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const productId = normalizeProductId(input.productId);

  // Ensure the product exists. If the caller explicitly supplied
  // displayName/description, upsert those through registerProduct. Otherwise
  // insert-if-absent using a stable humanized fallback — we do NOT want to
  // overwrite an existing product's curated displayName (e.g. seeded
  // "NightCTO") with a derived "Nightcto" from humanizeProductId.
  const callerSuppliedMetadata =
    input.displayName !== undefined || input.description !== undefined;

  if (callerSuppliedMetadata) {
    await registerProduct(db, {
      id: productId,
      displayName: input.displayName,
      description: input.description,
    });
  } else {
    await db
      .insert(schema.platformProducts)
      .values({
        id: productId,
        displayName: humanizeProductId(productId),
        description: null,
      })
      .onConflictDoNothing();
  }

  await db
    .insert(schema.workspacePlatformPolicies)
    .values({
      workspaceId,
      enforceProductScope: false,
    })
    .onConflictDoNothing();

  await db
    .insert(schema.workspacePlatformAccess)
    .values({
      workspaceId,
      productId,
    })
    .onConflictDoNothing();

  return getWorkspacePolicy(db, workspaceId);
}

export async function revokeProductAccess(
  db: PlatformDb,
  workspaceId: string,
  productId: string,
): Promise<WorkspacePolicy> {
  const normalizedWorkspaceId = normalizeWorkspaceId(workspaceId);
  const normalizedProductId = normalizeProductId(productId);

  await db
    .delete(schema.workspacePlatformAccess)
    .where(
      sql`${schema.workspacePlatformAccess.workspaceId} = ${normalizedWorkspaceId}
        and ${schema.workspacePlatformAccess.productId} = ${normalizedProductId}`,
    );

  return getWorkspacePolicy(db, normalizedWorkspaceId);
}

function normalizeProductInput(
  input: string | ProductRegistrationInput,
): ProductRegistrationInput & { id: string; displayName: string } {
  const id = normalizeProductId(typeof input === "string" ? input : input.id);
  const displayName =
    typeof input === "string" ? humanizeProductId(id) : normalizeDisplayName(input.displayName, id);

  return {
    id,
    displayName,
    description: typeof input === "string" ? null : input.description ?? null,
  };
}

function normalizeWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!value) {
    throw new Error("workspaceId is required");
  }
  return value;
}

function normalizeProductId(productId: string): string {
  const value = productId.trim().toLowerCase();
  if (!value) {
    throw new Error("productId is required");
  }
  return value;
}

function normalizeDisplayName(displayName: string | undefined, productId: string): string {
  const value = displayName?.trim();
  return value && value.length > 0 ? value : humanizeProductId(productId);
}

function humanizeProductId(productId: string): string {
  return productId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

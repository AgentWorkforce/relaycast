import { describe, expect, it } from "vitest";
import {
  getWorkspacePolicy,
  grantProductAccess,
  registerProduct,
  revokeProductAccess,
} from "./client.js";
import { bootstrapPlatform, DEFAULT_PLATFORM_PRODUCTS } from "./bootstrap.js";
import { createFakePlatformDb } from "./test-helpers.js";

describe("platform policy and product helpers", () => {
  it("returns the default policy for an unknown workspace", async () => {
    const db = createFakePlatformDb();

    await expect(getWorkspacePolicy(db, "  ws-unknown  ")).resolves.toEqual({
      workspaceId: "ws-unknown",
      enforceProductScope: false,
      allowedProductIds: [],
      productScopes: {},
    });
  });

  it("registerProduct is idempotent for the same product id", async () => {
    const db = createFakePlatformDb();

    const first = await registerProduct(db, {
      id: "nightcto",
      displayName: "NightCTO",
    });
    const second = await registerProduct(db, {
      id: "  NIGHTCTO ",
      displayName: "NightCTO",
    });

    expect(second).toMatchObject({
      id: first.id,
      displayName: first.displayName,
      description: first.description,
    });
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(db.productCount()).toBe(1);
    expect(db.listProducts()).toHaveLength(1);
    expect(db.listProducts()[0]).toMatchObject({
      id: "nightcto",
      displayName: "NightCTO",
    });
  });

  it("reflects granted product access in the workspace policy", async () => {
    const db = createFakePlatformDb();

    const grantedPolicy = await grantProductAccess(db, {
      workspaceId: "workspace-1",
      productId: "sage",
    });
    const workspacePolicy = await getWorkspacePolicy(db, "workspace-1");

    expect(grantedPolicy).toEqual({
      workspaceId: "workspace-1",
      enforceProductScope: false,
      allowedProductIds: ["sage"],
      productScopes: {},
    });
    expect(workspacePolicy).toEqual({
      workspaceId: "workspace-1",
      enforceProductScope: false,
      allowedProductIds: ["sage"],
      productScopes: {},
    });
  });

  it("removes revoked product access from the workspace policy", async () => {
    const db = createFakePlatformDb();

    await grantProductAccess(db, {
      workspaceId: "workspace-1",
      productId: "sage",
    });

    const revokedPolicy = await revokeProductAccess(db, "workspace-1", "sage");
    const workspacePolicy = await getWorkspacePolicy(db, "workspace-1");

    expect(revokedPolicy).toEqual({
      workspaceId: "workspace-1",
      enforceProductScope: false,
      allowedProductIds: [],
      productScopes: {},
    });
    expect(workspacePolicy).toEqual({
      workspaceId: "workspace-1",
      enforceProductScope: false,
      allowedProductIds: [],
      productScopes: {},
    });
  });

  it("grantProductAccess does not clobber a seeded product's displayName", async () => {
    const db = createFakePlatformDb();

    // Simulate bootstrap: seed with curated metadata.
    await registerProduct(db, {
      id: "nightcto",
      displayName: "NightCTO",
      description: "Night-shift CTO reviews",
    });

    // Caller grants access without re-supplying metadata. Must NOT overwrite
    // the curated displayName with a humanizeProductId-derived "Nightcto".
    await grantProductAccess(db, {
      workspaceId: "workspace-1",
      productId: "nightcto",
    });

    const product = db.listProducts().find((p) => p.id === "nightcto");
    expect(product?.displayName).toBe("NightCTO");
    expect(product?.description).toBe("Night-shift CTO reviews");
  });

  it("grantProductAccess upserts metadata when the caller explicitly supplies it", async () => {
    const db = createFakePlatformDb();

    await registerProduct(db, {
      id: "nightcto",
      displayName: "NightCTO",
      description: "old description",
    });

    await grantProductAccess(db, {
      workspaceId: "workspace-1",
      productId: "nightcto",
      displayName: "NightCTO (v2)",
      description: "new description",
    });

    const product = db.listProducts().find((p) => p.id === "nightcto");
    expect(product?.displayName).toBe("NightCTO (v2)");
    expect(product?.description).toBe("new description");
  });

  it("bootstrap seeds the expected default products", async () => {
    const db = createFakePlatformDb();

    const result = await bootstrapPlatform(db);

    expect(result).toEqual({
      seededProducts: DEFAULT_PLATFORM_PRODUCTS.map((product) => product.id),
      wasFirstRun: true,
    });
    expect(db.listProducts().map((product) => product.id)).toEqual(
      DEFAULT_PLATFORM_PRODUCTS.map((product) => product.id),
    );
  });
});

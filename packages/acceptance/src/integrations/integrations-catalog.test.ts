// @route GET /api/v1/integrations/catalog
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { requestApi } from "../helpers/runtime";
import { parseJson } from "./_helpers";

const providerSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  configKey: z.string().min(1).optional(),
  vfsRoot: z.string().min(1),
  backend: z.string().min(1).optional(),
  backends: z.array(z.string().min(1)).optional(),
  sources: z.array(z.string().min(1)).optional(),
}).passthrough();

const catalogSchema = z.object({
  providers: z.array(providerSchema),
  version: z.string().regex(/^[a-f0-9]{12}$/),
});

describe("/api/v1/integrations/catalog", () => {
  it("returns the static integration catalog", async () => {
    const response = await requestApi("/api/v1/integrations/catalog");

    expect(response.status).toBe(200);

    const body = await parseJson(response, catalogSchema);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "github", vfsRoot: "/github" }),
        expect.objectContaining({ id: "notion", vfsRoot: "/notion" }),
        expect.objectContaining({ id: "linear", vfsRoot: "/linear" }),
      ]),
    );
  });

  it(
    "returns the dynamic integration catalog",
    async () => {
      const response = await requestApi("/api/v1/integrations/catalog?dynamic=true");

      expect(response.status).toBe(200);
      const body = await parseJson(response, catalogSchema);
      expect(body.providers.length).toBeGreaterThan(0);
    },
    15_000,
  );
});

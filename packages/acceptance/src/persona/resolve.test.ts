// @route POST /api/persona/resolve

import { z } from "zod";
import { describe, expect, it } from "vitest";

import { request } from "../../helpers/server";

const personaIntegrationSummarySchema = z.object({
  provider: z.string().min(1),
  label: z.string().min(1),
  providerConfigKey: z.string().min(1),
  description: z.string(),
});

const personaSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  sourceUrl: z.string().optional(),
  imageUrl: z.string().optional(),
  slug: z.string().min(1),
  harness: z.string().nullable(),
  model: z.string().optional(),
  modelProvider: z.string().optional(),
  useSubscription: z.boolean(),
  integrations: z.array(personaIntegrationSummarySchema),
  inputs: z.array(z.object({
    key: z.string().min(1),
    description: z.string(),
    optional: z.boolean(),
    default: z.string().optional(),
    picker: z.object({
      provider: z.string().min(1),
      resource: z.string().min(1),
    }).optional(),
  })),
  triggers: z.array(z.object({
    kind: z.enum(["integration", "schedule"]),
    provider: z.string().min(1),
    label: z.string().min(1),
  })),
  tagline: z.string().optional(),
});

const personaResolveSchema = z.object({
  persona: z.unknown().nullable(),
  agent: z.unknown().nullable(),
  bundle: z.unknown().nullable(),
  summary: personaSummarySchema,
  warnings: z.array(z.string()).optional(),
  fallback: z.object({
    reason: z.string().min(1),
  }).optional(),
});

const errorSchema = z.object({
  error: z.string().min(1),
});

describe("POST /api/persona/resolve", () => {
  it("returns a fallback PersonaSummary for an unreachable persona URL", async () => {
    const response = await request("POST", "/api/persona/resolve", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: "https://example.invalid/AgentWorkforce/agents/blob/main/review/persona.ts",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const parsed = personaResolveSchema.parse(await response.json());
    expect(parsed.fallback).toBeTruthy();
    expect(parsed.warnings?.length).toBeGreaterThan(0);
    expect(parsed.summary.id).toBe("pr-reviewer");
    expect(parsed.summary.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "github",
          label: "GitHub",
          providerConfigKey: "github-relay",
        }),
      ]),
    );
  });

  it("rejects a missing url body", async () => {
    const response = await request("POST", "/api/persona/resolve", {
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    expect(errorSchema.parse(await response.json()).error).toBe("url is required");
  });
});

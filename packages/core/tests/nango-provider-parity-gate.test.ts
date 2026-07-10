import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  GENERATED_NANGO_PROVIDER_MODEL_REGISTRY,
  type GeneratedNangoProviderModelEntry,
} from "../src/sync/nango-provider-registry.generated.js";
import {
  enabledGeneratedNangoProviderModelsForProviderConfigKey,
  isGeneratedNangoProviderModel,
  nangoProviderModelKey,
  REPO_DECLARED_NANGO_PROVIDER_MODELS,
} from "../src/sync/nango-provider-parity.js";

type NangoJsonSync = {
  name?: unknown;
  output?: unknown;
  json_schema?: {
    definitions?: Record<string, unknown>;
  };
};

type NangoJsonIntegration = {
  providerConfigKey?: unknown;
  syncs?: NangoJsonSync[];
};

function readString(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.notEqual(value, "", `${label} must be non-empty`);
  return value as string;
}

async function readGeneratedRegistryFromNangoJson(): Promise<GeneratedNangoProviderModelEntry[]> {
  const [configRaw, schemaRaw] = await Promise.all([
    readFile("nango-integrations/.nango/nango.json", "utf8"),
    readFile("nango-integrations/.nango/schema.json", "utf8"),
  ]);
  const config = JSON.parse(configRaw) as NangoJsonIntegration[];
  const schema = JSON.parse(schemaRaw) as { definitions?: Record<string, unknown> };
  assert.ok(schema.definitions, ".nango/schema.json must expose definitions");

  const entries: GeneratedNangoProviderModelEntry[] = [];
  for (const integration of config) {
    const provider = readString(integration.providerConfigKey, "providerConfigKey");
    for (const sync of integration.syncs ?? []) {
      const syncName = readString(sync.name, `${provider}.sync.name`);
      assert.ok(Array.isArray(sync.output), `${provider}.${syncName}.output must be an array`);
      for (const output of sync.output) {
        const model = readString(output, `${provider}.${syncName}.output[]`);
        const syncLocalDefinitions = sync.json_schema?.definitions;
        const hasDefinition =
          Boolean(schema.definitions[model]) ||
          Boolean(syncLocalDefinitions && syncLocalDefinitions[model]);
        assert.ok(
          hasDefinition,
          `${provider}:${syncName}:${model} output model must exist in .nango/schema.json definitions`,
        );
        entries.push({
          key: `${provider}:${syncName}:${model}`,
          provider,
          sync: syncName,
          model,
        } as GeneratedNangoProviderModelEntry);
      }
    }
  }
  return entries;
}

function keys(entries: readonly { key: string }[]): string[] {
  return entries.map((entry) => entry.key).sort();
}

function formatDiff(expected: readonly string[], actual: readonly string[]): string {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !actualSet.has(key));
  const extra = actual.filter((key) => !expectedSet.has(key));
  return [
    missing.length ? `Missing curated classifications:\n${missing.join("\n")}` : "",
    extra.length ? `Stale curated classifications:\n${extra.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

describe("Nango provider parity gate", () => {
  it("keeps the generated registry in sync with nango.json and schema.json", async () => {
    assert.deepEqual(
      GENERATED_NANGO_PROVIDER_MODEL_REGISTRY,
      await readGeneratedRegistryFromNangoJson(),
    );
  });

  it("requires every generated provider/sync/model triple to be consciously classified", () => {
    const generatedKeys = keys(GENERATED_NANGO_PROVIDER_MODEL_REGISTRY);
    const curatedKeys = keys(REPO_DECLARED_NANGO_PROVIDER_MODELS);
    assert.deepEqual(
      curatedKeys,
      generatedKeys,
      formatDiff(generatedKeys, curatedKeys),
    );
  });

  it("exposes generated provider/sync/model lookup helpers for webhook boundaries", () => {
    assert.equal(
      nangoProviderModelKey({
        providerConfigKey: "github-relay",
        syncName: "fetch-open-prs",
        model: "PullRequest",
      }),
      "github-relay:fetch-open-prs:PullRequest",
    );
    assert.equal(
      isGeneratedNangoProviderModel({
        providerConfigKey: "github-relay",
        syncName: "fetch-open-prs",
        model: "PullRequest",
      }),
      true,
    );
    assert.equal(
      isGeneratedNangoProviderModel({
        providerConfigKey: "confluence-relay",
        syncName: "fetch-pages",
        model: "Page",
      }),
      false,
    );
    assert.deepEqual(
      enabledGeneratedNangoProviderModelsForProviderConfigKey("slack-relay").map(
        (entry) => entry.key,
      ),
      [
        "slack-relay:fetch-channel-history:SlackMessage",
        "slack-relay:fetch-users:SlackUser",
        "slack-relay:fetch-channels:SlackChannel",
      ],
    );
  });
});

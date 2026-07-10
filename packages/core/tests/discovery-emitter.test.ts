import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureProviderDiscoveryContract,
  ensureProviderDiscoveryContractReport,
  sampleExistingRecordsByResource,
  writeBatchToRelayfile,
  type RelayfileWriteClient,
} from "../src/sync/record-writer.js";
import {
  assertLayoutDiscoveryConsistency,
  buildCreateExample,
  buildResourceSchema,
  writeDiscoveryArtifacts,
  type AdapterResourceConfig,
  type DiscoveryEmitDeps,
} from "../src/sync/discovery-emitter.js";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";

import { resources as linearResources } from "@relayfile/adapter-linear";
import { resources as githubResources } from "@relayfile/adapter-github";
import { resources as confluenceResources } from "@relayfile/adapter-confluence";
import { resources as jiraResources } from "@relayfile/adapter-jira";
import { emitConfluenceAuxiliaryFiles } from "@relayfile/adapter-confluence";
import { emitJiraAuxiliaryFiles } from "@relayfile/adapter-jira";
import { resources as notionResources } from "@relayfile/adapter-notion";
import { resources as gitLabResources } from "@relayfile/adapter-gitlab";
import { resources as slackResources } from "@relayfile/adapter-slack";
import { linearLayoutPromptFile } from "@relayfile/adapter-linear";
import { githubLayoutPromptFile } from "@relayfile/adapter-github";
import { confluenceLayoutPromptFile } from "@relayfile/adapter-confluence/layout-prompt";
import { jiraLayoutPromptFile } from "@relayfile/adapter-jira";
import { notionLayoutPromptFile } from "@relayfile/adapter-notion";
import {
  layoutPromptFile as gcpLayoutPromptFile,
} from "@relayfile/adapter-gcp";
import { readOnlyResources as gcpResources } from "@relayfile/adapter-gcp/resources";

interface RecordedWrite {
  path: string;
  content: string;
  contentType: string;
}

function makeMutableReadingClient(): RelayfileWriteClient & {
  writes: RecordedWrite[];
  deletes: string[];
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const writes: RecordedWrite[] = [];
  const deletes: string[] = [];
  return {
    writes,
    deletes,
    files,
    async writeFile(input) {
      writes.push({
        path: input.path,
        content: input.content,
        contentType: input.contentType,
      });
      files.set(input.path, input.content);
    },
    async deleteFile(input) {
      deletes.push(input.path);
      files.delete(input.path);
    },
    async readFile(_workspaceId, path) {
      if (files.has(path)) {
        return { content: files.get(path), revision: `rev:${path}` };
      }
      const err = new Error("not found") as Error & { status: number };
      err.status = 404;
      throw err;
    },
  };
}

function linearJob(model: string): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_fc7b534b",
    provider: "linear",
    providerConfigKey: "linear-relay",
    connectionId: "conn_test",
    syncName: `fetch-${model.replace(/^Linear/, "").toLowerCase()}s`,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

function jobFor(provider: string, model: string): NangoSyncJob {
  return {
    type: "nango_sync",
    workspaceId: "rw_fc7b534b",
    provider,
    providerConfigKey: `${provider}-relay`,
    connectionId: "conn_test",
    syncName: `fetch-${model.toLowerCase()}s`,
    model,
    cursor: null,
    modifiedAfter: "1970-01-01T00:00:00.000Z",
  };
}

const idemDeps = {
  async writeManagedFile(input: {
    client: RelayfileWriteClient;
    workspaceId: string;
    path: string;
    content: string;
    contentType: string;
  }) {
    const existing = await (input.client.readFile?.(
      input.workspaceId,
      input.path,
    ) as Promise<{ content?: string } | string> | undefined)?.catch(
      () => undefined,
    );
    const existingContent =
      existing == null
        ? undefined
        : typeof existing === "string"
          ? existing
          : existing.content;
    if (existingContent === input.content) return;
    await input.client.writeFile({
      workspaceId: input.workspaceId,
      path: input.path,
      content: input.content,
      contentType: input.contentType,
      encoding: "utf-8",
      baseRevision: "*",
    });
  },
};

describe("buildResourceSchema", () => {
  const resource: AdapterResourceConfig = {
    name: "issues",
    path: "/linear/issues",
    pathPattern: /^\/linear\/issues/,
    idPattern: /.*/,
    schema: "discovery/linear/issues/.schema.json",
    createExample: "discovery/linear/issues/.create.example.json",
  };

  it("emits JSON Schema draft 2020-12 with object type", () => {
    const schema = buildResourceSchema("linear", resource, [
      { id: "iss_1", title: "Bug", description: "x", createdAt: "2026-01-01" },
    ]);
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(schema.type, "object");
    assert.ok(schema.properties);
  });

  it("marks server-managed fields readOnly (id, timestamps, urls)", () => {
    const schema = buildResourceSchema("linear", resource, [
      {
        id: "iss_1",
        url: "https://linear.app/x",
        title: "Bug",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-02",
        description: "details",
      },
    ]);
    assert.equal(schema.properties!.id.readOnly, true);
    assert.equal(schema.properties!.url.readOnly, true);
    assert.equal(schema.properties!.createdAt.readOnly, true);
    assert.equal(schema.properties!.updatedAt.readOnly, true);
    assert.notEqual(schema.properties!.title.readOnly, true);
    assert.notEqual(schema.properties!.description.readOnly, true);
  });

  it("required excludes read-only fields and only includes fields present in every record", () => {
    const schema = buildResourceSchema("linear", resource, [
      { id: "iss_1", title: "A", description: "d" },
      { id: "iss_2", title: "B" },
    ]);
    assert.ok(schema.required?.includes("title"));
    assert.ok(!schema.required?.includes("id")); // readOnly
    assert.ok(!schema.required?.includes("description")); // not in every record
  });

  it("is deterministic regardless of record key order (idempotent re-sync)", () => {
    const a = buildResourceSchema("linear", resource, [
      { title: "A", id: "1", description: "d" },
    ]);
    const b = buildResourceSchema("linear", resource, [
      { description: "d", id: "1", title: "A" },
    ]);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

describe("buildCreateExample", () => {
  const resource: AdapterResourceConfig = {
    name: "issues",
    path: "/linear/issues",
    pathPattern: /.*/,
    idPattern: /.*/,
    schema: "discovery/linear/issues/.schema.json",
    createExample: "discovery/linear/issues/.create.example.json",
  };

  it("omits read-only / server-managed fields and includes required writable ones", () => {
    const schema = buildResourceSchema("linear", resource, [
      { id: "iss_1", title: "Bug", createdAt: "2026-01-01" },
      { id: "iss_2", title: "Bug2", createdAt: "2026-01-02" },
    ]);
    const example = buildCreateExample(schema);
    assert.ok(!("id" in example));
    assert.ok(!("createdAt" in example));
    assert.ok("title" in example);
    assert.equal(example.title, "");
  });
});

describe("writeDiscoveryArtifacts (generic)", () => {
  it("emits .schema.json + .create.example.json at the EXACT adapter-advertised paths + .adapter.md", async () => {
    const client = makeMutableReadingClient();
    const recordsByResource = new Map<
      string,
      readonly Record<string, unknown>[]
    >([["issues", [{ id: "iss_1", title: "Bug" }]]]);

    const result = await writeDiscoveryArtifacts(
      idemDeps,
      client,
      "rw_fc7b534b",
      "linear",
      linearResources as readonly AdapterResourceConfig[],
      recordsByResource,
    );

    assert.equal(result.errors.length, 0);
    for (const resource of linearResources as readonly AdapterResourceConfig[]) {
      assert.ok(
        client.files.has(`/${resource.schema}`),
        `missing ${resource.schema}`,
      );
      assert.ok(
        client.files.has(`/${resource.createExample}`),
        `missing ${resource.createExample}`,
      );
    }
    assert.ok(client.files.has("/discovery/linear/.adapter.md"));
  });

  it("prefers adapter-authored write contracts over inferred read-record fields", async () => {
    const client = makeMutableReadingClient();
    const recordsByResource = new Map<
      string,
      readonly Record<string, unknown>[]
    >([
      [
        "messages",
        [
          {
            channel: "C123",
            channel_is_private: false,
            channel_name: "engineering",
            channelId: "C123",
            file_count: 0,
          },
        ],
      ],
    ]);

    const result = await writeDiscoveryArtifacts(
      idemDeps,
      client,
      "rw_fc7b534b",
      "slack",
      slackResources as readonly AdapterResourceConfig[],
      recordsByResource,
    );

    assert.equal(result.errors.length, 0);

    const example = JSON.parse(
      client.files.get(
        "/discovery/slack/channels/{channelId}/messages/.create.example.json",
      )!,
    );
    assert.deepEqual(example, {
      text: "Replace example message text.",
    });

    const schema = JSON.parse(
      client.files.get(
        "/discovery/slack/channels/{channelId}/messages/.schema.json",
      )!,
    ) as {
      anyOf?: { required?: string[] }[];
      properties?: Record<string, unknown>;
    };
    assert.ok(schema.properties?.text, "authored schema must include text");
    assert.ok(
      schema.anyOf?.some((entry) => entry.required?.includes("text")),
      "authored schema must preserve the text/blocks/attachments requirement",
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        schema.properties ?? {},
        "channel_is_private",
      ),
      false,
      "read-record channel metadata must not leak into the write schema",
    );

    assert.match(
      client.files.get("/discovery/slack/.adapter.md") ?? "",
      /^# Slack adapter/,
    );
  });

  it("is idempotent: re-emit with same records writes nothing new", async () => {
    const client = makeMutableReadingClient();
    const recordsByResource = new Map<
      string,
      readonly Record<string, unknown>[]
    >([["issues", [{ id: "iss_1", title: "Bug" }]]]);

    await writeDiscoveryArtifacts(
      idemDeps,
      client,
      "rw_fc7b534b",
      "linear",
      linearResources as readonly AdapterResourceConfig[],
      recordsByResource,
    );
    const firstWriteCount = client.writes.length;
    assert.ok(firstWriteCount > 0);

    await writeDiscoveryArtifacts(
      idemDeps,
      client,
      "rw_fc7b534b",
      "linear",
      linearResources as readonly AdapterResourceConfig[],
      recordsByResource,
    );
    assert.equal(
      client.writes.length,
      firstWriteCount,
      "re-emit must not write identical content again",
    );
  });

  it("emits the contract even when a resource has zero synced records", async () => {
    const client = makeMutableReadingClient();
    const result = await writeDiscoveryArtifacts(
      idemDeps,
      client,
      "rw_fc7b534b",
      "linear",
      linearResources as readonly AdapterResourceConfig[],
      new Map(),
    );
    assert.equal(result.errors.length, 0);
    for (const resource of linearResources as readonly AdapterResourceConfig[]) {
      assert.ok(client.files.has(`/${resource.schema}`));
      assert.ok(client.files.has(`/${resource.createExample}`));
    }
  });

  it("keeps the permissive empty fallback schema when no authored artifact exists", async () => {
    const client = makeMutableReadingClient();
    const resource: AdapterResourceConfig = {
      name: "widgets",
      path: "/fallback/widgets",
      pathPattern: /^\/fallback\/widgets/,
      idPattern: /.*/,
      schema: "discovery/no-authored/widgets/.schema.json",
      createExample: "discovery/no-authored/widgets/.create.example.json",
    };

    const result = await writeDiscoveryArtifacts(
      idemDeps,
      client,
      "rw_fc7b534b",
      "no-authored",
      [resource],
      new Map(),
    );

    assert.equal(result.errors.length, 0);
    const schema = JSON.parse(
      client.files.get("/discovery/no-authored/widgets/.schema.json")!,
    ) as { properties?: Record<string, unknown>; additionalProperties?: boolean };
    assert.deepEqual(schema.properties ?? {}, {});
    assert.equal(schema.additionalProperties, true);
    assert.deepEqual(
      JSON.parse(
        client.files.get(
          "/discovery/no-authored/widgets/.create.example.json",
        )!,
      ),
      {},
    );
  });
});

describe("discovery materialization via writeBatchToRelayfile (end-to-end, the rw_fc7b534b defect)", () => {
  it("linear sync materializes the discovery surface LAYOUT.md advertises", async () => {
    const client = makeMutableReadingClient();
    await writeBatchToRelayfile(
      client,
      [{ id: "iss_1", title: "Login bug", description: "broken" }],
      linearJob("LinearIssue"),
    );

    // The exact paths linear/LAYOUT.md advertises must now exist.
    assert.ok(
      client.files.has("/discovery/linear/issues/.schema.json"),
      "linear issues schema absent — the original rw_fc7b534b defect",
    );
    assert.ok(
      client.files.has("/discovery/linear/issues/.create.example.json"),
    );
    assert.ok(
      client.files.has(
        "/discovery/linear/issues/{issueId}/comments/.schema.json",
      ),
    );
    assert.ok(client.files.has("/discovery/linear/.adapter.md"));

    const schema = JSON.parse(
      client.files.get("/discovery/linear/issues/.schema.json")!,
    );
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(schema.properties.id.readOnly, true);
    const example = JSON.parse(
      client.files.get("/discovery/linear/issues/.create.example.json")!,
    );
    assert.ok(!("id" in example));
  });

  for (const [provider, model, resources] of [
    ["github", "GitHubIssue", githubResources],
    ["confluence", "ConfluencePage", confluenceResources],
    ["jira", "JiraIssue", jiraResources],
    ["notion", "NotionPage", notionResources],
    ["gitlab", "GitLabMergeRequest", gitLabResources],
    ["slack", "SlackChannel", slackResources],
    ["gcp", "GcpCloudRunService", gcpResources],
  ] as const) {
    it(`${provider} sync materializes every advertised discovery path`, async () => {
      const client = makeMutableReadingClient();
      await writeBatchToRelayfile(
        client,
        [{ id: "obj_1", title: "Thing", name: "Thing" }],
        jobFor(provider, model),
      );
      for (const resource of resources as readonly AdapterResourceConfig[]) {
        assert.ok(
          client.files.has(`/${resource.schema}`),
          `${provider}: missing ${resource.schema}`,
        );
        assert.ok(
          client.files.has(`/${resource.createExample}`),
          `${provider}: missing ${resource.createExample}`,
        );
      }
    });
  }
});

describe("fallback inferred discovery stability (revision-churn regression)", () => {
  // Adapter-authored discovery is now preferred when present. This keeps the
  // old inferred-schema convergence guard on a fake discovery slug with no
  // adapter package, which is the path Cloud-owned/custom resources still use.
  const fallbackResource: AdapterResourceConfig = {
    name: "issues",
    path: "/fallback/issues",
    pathPattern: /^\/fallback\/issues/,
    idPattern: /.*/,
    schema: "discovery/fallback/issues/.schema.json",
    createExample: "discovery/fallback/issues/.create.example.json",
  };
  const SCHEMA = "/discovery/fallback/issues/.schema.json";
  const EXAMPLE = "/discovery/fallback/issues/.create.example.json";

  function schemaWritesFor(
    client: { writes: RecordedWrite[] },
    path: string,
  ): RecordedWrite[] {
    return client.writes.filter((w) => w.path === path);
  }

  it("converges schema across pages with different field subsets and then no-ops", async () => {
    const client = makeMutableReadingClient();

    const deps: DiscoveryEmitDeps = {
      ...idemDeps,
      async readManagedFile(input) {
        const value = await input.client
          .readFile?.(input.workspaceId, input.path)
          .catch(() => undefined);
        return typeof value === "string" ? value : value?.content;
      },
    };

    // Page 1: issues carry {title, body} (plus the server-managed id).
    await writeDiscoveryArtifacts(
      deps,
      client,
      "rw_fc7b534b",
      "fallback",
      [fallbackResource],
      new Map([
        [
          "issues",
          [
            { id: "iss_1", title: "Login bug", body: "broken" },
            { id: "iss_2", title: "Logout bug", body: "also broken" },
          ],
        ],
      ]),
    );
    assert.equal(
      schemaWritesFor(client, SCHEMA).length,
      1,
      "page 1 must write the schema once",
    );
    const afterPage1 = client.files.get(SCHEMA)!;
    assert.ok(afterPage1.includes('"title"'));
    assert.ok(afterPage1.includes('"body"'));
    assert.ok(!afterPage1.includes('"summary"'));

    // Page 2: a DIFFERENT subset — {title, summary}, no `body`. The merged
    // schema must UNION fields ({title, body, summary}) and RELAX `required`
    // (body present only on page 1, summary only on page 2 → neither is
    // required-everywhere across the converged surface; title is in both).
    await writeDiscoveryArtifacts(
      deps,
      client,
      "rw_fc7b534b",
      "fallback",
      [fallbackResource],
      new Map([
        [
          "issues",
          [
            { id: "iss_3", title: "Search bug", summary: "no results" },
            { id: "iss_4", title: "Sort bug", summary: "wrong order" },
          ],
        ],
      ]),
    );
    const page2Writes = schemaWritesFor(client, SCHEMA).length;
    assert.ok(
      page2Writes === 1 || page2Writes === 2,
      `page 2 may rewrite at most once to the converged form (saw ${page2Writes})`,
    );
    const afterPage2 = client.files.get(SCHEMA)!;
    const merged = JSON.parse(afterPage2);
    assert.ok("title" in merged.properties, "union must keep title");
    assert.ok("body" in merged.properties, "union must keep body from page 1");
    assert.ok(
      "summary" in merged.properties,
      "union must keep summary from page 2",
    );
    // required relaxed: title required in both pages, body/summary not.
    const required: string[] = merged.required ?? [];
    assert.ok(!required.includes("body"), "body must relax to optional");
    assert.ok(!required.includes("summary"), "summary must relax to optional");
    assert.equal(
      schemaWritesFor(client, SCHEMA).length,
      page2Writes,
      "no extra schema write within page 2",
    );

    // Page 3: identical to page 2's subset. Surface is already converged →
    // production `writeManagedFile` MUST no-op (zero further schema writes).
    const writesBeforePage3 = schemaWritesFor(client, SCHEMA).length;
    const exampleWritesBeforePage3 = schemaWritesFor(client, EXAMPLE).length;
    await writeDiscoveryArtifacts(
      deps,
      client,
      "rw_fc7b534b",
      "fallback",
      [fallbackResource],
      new Map([
        [
          "issues",
          [
            { id: "iss_5", title: "Filter bug", summary: "ignored" },
            { id: "iss_6", title: "Paging bug", summary: "skips" },
          ],
        ],
      ]),
    );
    assert.equal(
      schemaWritesFor(client, SCHEMA).length,
      writesBeforePage3,
      "converged schema must NOT be rewritten on an identical-surface page (production writeManagedFile no-op)",
    );
    assert.equal(
      schemaWritesFor(client, EXAMPLE).length,
      exampleWritesBeforePage3,
      "converged create-example must NOT be rewritten either",
    );

    // Page 4: identical surface again — still stable.
    await writeDiscoveryArtifacts(
      deps,
      client,
      "rw_fc7b534b",
      "fallback",
      [fallbackResource],
      new Map([
        [
          "issues",
          [{ id: "iss_7", title: "Another", summary: "stable" }],
        ],
      ]),
    );
    assert.equal(
      schemaWritesFor(client, SCHEMA).length,
      writesBeforePage3,
      "schema stays stable on subsequent identical-surface pages",
    );

    // Final converged form must be byte-stable: re-canonicalizing must equal
    // what's on disk (the dedup guarantee).
    assert.deepEqual(JSON.parse(client.files.get(SCHEMA)!), merged);
  });
});

describe("already-synced workspace: refresh with ZERO record batches backfills discovery (the live rw_fc7b534b repro)", () => {
  // The live defect: rw_fc7b534b has 6 connected nango providers, ~781 paths,
  // every record/index/alias tree + provider LAYOUT.md present, and LAYOUT
  // still advertises `discovery/<provider>/.../.schema.json` — yet ZERO
  // discovery artifacts exist. Its providers are already fully synced, so the
  // next refresh/incremental produces NO record-producing batch. The
  // production Nango sync still calls `writeBatchToRelayfile` once per Nango
  // page even when that page carries `records: []`. Discovery materialization
  // MUST therefore be reached on a zero-record batch — derivable purely from
  // the static adapter registry + LAYOUT + a permissive inferred schema — so
  // any routine refresh of an already-synced workspace backfills discovery with
  // no migration. This is the exact byte-for-byte repro of the live workspace.
  for (const [provider, model, resources] of [
    ["confluence", "ConfluencePage", confluenceResources],
    ["linear", "LinearIssue", linearResources],
    ["notion", "NotionPage", notionResources],
    ["github", "GitHubIssue", githubResources],
    ["jira", "JiraIssue", jiraResources],
    ["gitlab", "GitLabMergeRequest", gitLabResources],
    ["gcp", "GcpCloudRunService", gcpResources],
  ] as const) {
    it(`${provider}: a no-op refresh (page.records === []) still materializes every advertised discovery path`, async () => {
      const client = makeMutableReadingClient();

      // Exactly what Nango sync does for an already-fully-synced provider:
      // one page, zero records.
      await writeBatchToRelayfile(client, [], jobFor(provider, model));

      for (const resource of resources as readonly AdapterResourceConfig[]) {
        assert.ok(
          client.files.has(`/${resource.schema}`),
          `${provider}: zero-record refresh did NOT materialize ${resource.schema} — the live rw_fc7b534b defect`,
        );
        assert.ok(
          client.files.has(`/${resource.createExample}`),
          `${provider}: zero-record refresh did NOT materialize ${resource.createExample}`,
        );
        const schema = JSON.parse(client.files.get(`/${resource.schema}`)!);
        assert.equal(
          schema.$schema,
          "https://json-schema.org/draft/2020-12/schema",
          `${provider}: ${resource.schema} is not a valid permissive schema`,
        );
      }
      // The provider LAYOUT advertiser must also be present (writeCommonLayouts).
      assert.ok(
        client.files.has(`/${provider}/LAYOUT.md`),
        `${provider}: zero-record refresh did NOT materialize the provider LAYOUT advertiser`,
      );
    });
  }

  it("a second no-op refresh is byte-stable (production writeManagedFile no-op, no churn)", async () => {
    const client = makeMutableReadingClient();

    await writeBatchToRelayfile(client, [], jobFor("linear", "LinearIssue"));
    const writesAfterFirst = client.writes.length;
    assert.ok(
      writesAfterFirst > 0,
      "first no-op refresh must materialize the discovery surface",
    );
    const snapshot = new Map(client.files);

    // A second identical no-op refresh of the now-converged surface must NOT
    // rewrite anything (revision/writeback/event churn guard, reusing #745's
    // monotonic-merge + canonicalize + writeManagedFile dedup).
    await writeBatchToRelayfile(client, [], jobFor("linear", "LinearIssue"));
    assert.equal(
      client.writes.length,
      writesAfterFirst,
      "second no-op refresh rewrote the discovery surface — not byte-stable",
    );
    for (const [path, content] of snapshot) {
      assert.equal(
        client.files.get(path),
        content,
        `discovery file ${path} changed on a second no-op refresh`,
      );
    }
  });
});

describe("ensureProviderDiscoveryContract: batch-independent refresh backfill (closes the rw_fc7b534b worker-never-runs gap)", () => {
  // The live gap #745 did NOT close: an already-fully-synced workspace's
  // sync worker only runs when Nango fires a `sync` webhook, and there was
  // no cloud refresh path that invoked the record-writer on demand. The
  // refresh touchpoint must backfill the contract WITHOUT any Nango batch.
  // This function is exactly what the `POST .../sync` refresh route calls;
  // it did not exist on origin/main @ ccf791b2 (TDD red: undefined import).
  for (const [provider, resources] of [
    ["confluence", confluenceResources],
    ["linear", linearResources],
    ["notion", notionResources],
    ["github", githubResources],
    ["jira", jiraResources],
    ["gitlab", gitLabResources],
    ["gcp", gcpResources],
  ] as const) {
    it(`${provider}: materializes every advertised discovery path with no records and no sync job`, async () => {
      const client = makeMutableReadingClient();

      const errors = await ensureProviderDiscoveryContract(
        client,
        provider,
        "rw_fc7b534b",
      );
      assert.deepEqual(errors, [], `${provider}: backfill reported errors`);

      for (const resource of resources as readonly AdapterResourceConfig[]) {
        assert.ok(
          client.files.has(`/${resource.schema}`),
          `${provider}: refresh backfill did NOT materialize ${resource.schema}`,
        );
        assert.ok(
          client.files.has(`/${resource.createExample}`),
          `${provider}: refresh backfill did NOT materialize ${resource.createExample}`,
        );
      }
      assert.ok(
        client.files.has(`/${provider}/LAYOUT.md`),
        `${provider}: refresh backfill did NOT materialize the LAYOUT advertiser`,
      );
    });
  }

  it("is byte-stable across repeated refreshes (no revision/writeback churn)", async () => {
    const client = makeMutableReadingClient();

    await ensureProviderDiscoveryContract(client, "linear", "rw_fc7b534b");
    const writesAfterFirst = client.writes.length;
    assert.ok(writesAfterFirst > 0, "first refresh must materialize discovery");
    const snapshot = new Map(client.files);

    await ensureProviderDiscoveryContract(client, "linear", "rw_fc7b534b");
    assert.equal(
      client.writes.length,
      writesAfterFirst,
      "second refresh rewrote the discovery surface — not byte-stable",
    );
    for (const [path, content] of snapshot) {
      assert.equal(client.files.get(path), content, `${path} churned`);
    }
  });

  it("is nango-only: returns [] and writes nothing for a non-registry provider (Composio/x untouched)", async () => {
    const client = makeMutableReadingClient();
    const errors = await ensureProviderDiscoveryContract(
      client,
      "composio-only-provider",
      "rw_fc7b534b",
    );
    assert.deepEqual(errors, []);
    assert.equal(client.writes.length, 0);
  });
});

describe("LAYOUT ⟺ discovery consistency invariant (regression guard)", () => {
  // Every adapter whose LAYOUT.md advertises a discovery/<provider>/.../
  // .schema.json contract MUST export `resources` for the producer to
  // materialize. This is the invariant whose violation WAS the defect.
  for (const [provider, layoutFile, resources] of [
    ["linear", linearLayoutPromptFile, linearResources],
    ["github", githubLayoutPromptFile, githubResources],
    ["confluence", confluenceLayoutPromptFile, confluenceResources],
    ["jira", jiraLayoutPromptFile, jiraResources],
    ["notion", notionLayoutPromptFile, notionResources],
    ["gcp", gcpLayoutPromptFile, gcpResources],
  ] as const) {
    it(`${provider}: LAYOUT advertises discovery AND adapter exports resources`, () => {
      const layout = layoutFile();
      const advertises = /discovery\/[^\s`)]+\.schema\.json/.test(
        layout.content,
      );
      assert.ok(
        advertises,
        `${provider} LAYOUT.md no longer advertises a discovery schema contract`,
      );
      assert.ok(
        (resources as readonly unknown[]).length > 0,
        `${provider} adapter exports no resources to materialize the advertised contract`,
      );
      assert.equal(
        assertLayoutDiscoveryConsistency(
          provider,
          layout.content,
          resources as readonly AdapterResourceConfig[],
        ),
        true,
      );
    });

    it(`${provider}: every advertised discovery/*.schema.json path is covered by a resource`, () => {
      const layout = layoutFile();
      const advertised = new Set(
        [
          ...layout.content.matchAll(/discovery\/[^\s`)]+\.schema\.json/g),
        ].map((m) => m[0]),
      );
      const emitted = new Set(
        (resources as readonly AdapterResourceConfig[]).map((r) => r.schema),
      );
      for (const path of advertised) {
        assert.ok(
          emitted.has(path),
          `${provider} LAYOUT advertises ${path} but no resource emits it`,
        );
      }
    });
  }

  it("flags LAYOUT advertising discovery with no resources", () => {
    assert.equal(
      assertLayoutDiscoveryConsistency(
        "fake",
        "read `discovery/fake/things/.schema.json` first",
        [],
      ),
      false,
    );
  });

  it("passes when neither LAYOUT advertises nor resources exist", () => {
    assert.equal(
      assertLayoutDiscoveryConsistency("x", "no discovery here", []),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// The rw_fc7b534b CONTENT-EMPTY defect (the bug this branch fixes).
//
// #756's `ensureProviderDiscoveryContract` materializes the discovery files at
// the right PATHS but passes `[]` records to inference, so an already-synced
// workspace gets `.schema.json` with `properties: {}` and `.create.example.json`
// `{}` — useless for writeback validation. The on-demand backfill must SAMPLE
// the workspace's existing synced records (canonical envelope at
// `<resource.path>/by-id/<id>.json`, listed via `<resource.path>/_index.json`)
// and infer the real schema, exactly as #745's active-sync path does from a
// live batch.
// ---------------------------------------------------------------------------
describe("ensureProviderDiscoveryContract infers schema from EXISTING synced records (rw_fc7b534b content-empty defect)", () => {
  // Same envelope shape cloud's canonical/by-id writer emits (verified by
  // probing writeBatchToRelayfile): {provider,objectType,objectId,deleted,
  // payload:{...real record...},connectionId}.
  function envelope(id: string, payload: Record<string, unknown>): string {
    return JSON.stringify({
      provider: "jira",
      objectType: "issue",
      objectId: id,
      deleted: false,
      payload,
      connectionId: "conn_test",
    });
  }

  function seedJiraIssues(
    client: { files: Map<string, string> },
    issues: Array<{ id: string; payload: Record<string, unknown> }>,
  ): void {
    const rows = issues.map((i) => ({
      id: i.id,
      title: String(i.payload.fields ?? ""),
      updated: "2026-05-10T10:00:00.000Z",
    }));
    client.files.set("/jira/issues/_index.json", JSON.stringify(rows));
    for (const i of issues) {
      client.files.set(
        `/jira/issues/by-id/${encodeURIComponent(i.id)}.json`,
        envelope(i.id, i.payload),
      );
    }
  }

  const sampleIssues = [
    {
      id: "10001",
      payload: {
        id: "10001",
        key: "ENG-1",
        summary: "Fix login bug",
        status: "In Progress",
        assignee: "ana",
        created: "2026-05-01T00:00:00.000Z",
      },
    },
    {
      id: "10002",
      payload: {
        id: "10002",
        key: "ENG-2",
        summary: "Refactor auth",
        status: "Done",
        assignee: "bob",
        created: "2026-05-02T00:00:00.000Z",
      },
    },
  ];

  it("emits the adapter-authored write schema + create example when present", async () => {
    const client = makeMutableReadingClient();
    seedJiraIssues(client, sampleIssues);

    const errors = await ensureProviderDiscoveryContract(
      client,
      "jira",
      "rw_fc7b534b",
    );
    assert.deepEqual(errors, [], "backfill reported errors");

    const schemaBody = client.files.get("/discovery/jira/issues/.schema.json");
    assert.ok(schemaBody, "issues .schema.json was not materialized");
    const schema = JSON.parse(schemaBody!) as {
      properties?: Record<string, { readOnly?: boolean }>;
    };
    const props = schema.properties ?? {};
    assert.ok(
      Object.keys(props).length > 0,
      `expected .schema.json properties to be NON-empty; got ${JSON.stringify(props)}`,
    );
    assert.ok(props.fields, "expected authored Jira `fields` object");
    assert.deepEqual(
      (schema as { required?: string[] }).required,
      ["fields"],
      "expected adapter-authored create requirements",
    );
    assert.equal(props.id?.readOnly, true, "`id` must be readOnly");
    assert.equal(
      props.createdAt?.readOnly,
      true,
      "`createdAt` must be readOnly",
    );

    const exampleBody = client.files.get(
      "/discovery/jira/issues/.create.example.json",
    );
    assert.ok(exampleBody, "issues .create.example.json was not materialized");
    const example = JSON.parse(exampleBody!) as Record<string, unknown>;
    assert.ok(
      Object.keys(example).length > 0,
      `expected .create.example.json to be NON-empty; got ${exampleBody}`,
    );
    assert.ok(example.fields, "expected authored Jira create fields");
    assert.equal(
      Object.prototype.hasOwnProperty.call(example, "id"),
      false,
      "`id` must NOT appear in create example (server-managed)",
    );
  });

  it("is idempotent: second on-demand backfill is byte-stable (no churn)", async () => {
    const client = makeMutableReadingClient();
    seedJiraIssues(client, sampleIssues);

    await ensureProviderDiscoveryContract(client, "jira", "rw_fc7b534b");
    const writesAfterFirst = client.writes.length;
    const snapshot = new Map(client.files);

    await ensureProviderDiscoveryContract(client, "jira", "rw_fc7b534b");
    assert.equal(
      client.writes.length,
      writesAfterFirst,
      "second backfill rewrote discovery — not byte-stable",
    );
    for (const [path, content] of snapshot) {
      assert.equal(client.files.get(path), content, `${path} churned`);
    }
  });

  it("zero-record resource still emits the adapter-authored write schema", async () => {
    // No _index.json / by-id seeded => no records to sample. Providers with
    // authored discovery still get the adapter-owned write contract instead of
    // a guessed empty schema.
    const client = makeMutableReadingClient();

    await ensureProviderDiscoveryContract(client, "jira", "rw_fc7b534b");

    const schemaBody = client.files.get("/discovery/jira/issues/.schema.json");
    assert.ok(schemaBody, "issues .schema.json must still be materialized");
    const schema = JSON.parse(schemaBody!) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    assert.ok(schema.properties?.fields, "expected authored Jira fields schema");
    assert.deepEqual(
      schema.required,
      ["fields"],
      "expected authored Jira create requirements",
    );
  });

  it("respects the sampling bound: seeds more records than the limit, only the deterministic first N are read", async () => {
    const client = makeMutableReadingClient();
    const many = Array.from({ length: 50 }, (_, n) => {
      const id = String(100000 + n);
      return {
        id,
        payload: {
          id,
          key: `ENG-${n}`,
          summary: `Issue ${n}`,
          status: "Open",
          // A field that ONLY appears on a high-id record beyond the
          // deterministic first-N window — must NOT leak into the schema,
          // proving the read is bounded AND ordered (sorted by id, first N).
          ...(n === 49 ? { lateOnlyField: "should-not-appear" } : {}),
        },
      };
    });
    seedJiraIssues(client, many);

    const readPaths: string[] = [];
    const origRead = client.readFile!.bind(client);
    client.readFile = async (ws: string, path: string) => {
      if (path.startsWith("/jira/issues/by-id/")) readPaths.push(path);
      return origRead(ws, path);
    };

    await ensureProviderDiscoveryContract(client, "jira", "rw_fc7b534b");

    assert.ok(
      readPaths.length <= 20,
      `expected at most DISCOVERY_SAMPLE_LIMIT (20) by-id reads; got ${readPaths.length}`,
    );
    const schema = JSON.parse(
      client.files.get("/discovery/jira/issues/.schema.json")!,
    ) as { properties?: Record<string, unknown> };
    assert.ok(
      !(schema.properties ?? {}).lateOnlyField,
      "a field only on a record beyond the deterministic first-N window leaked into the schema — sampling not bounded/ordered",
    );
  });
});

// ---------------------------------------------------------------------------
// PHASE 3 — generic canonical-record sampler regressions.
//
// The pre-fix sampler reconstructed `<resource.path>/by-id/<index-row-id>.json`.
// That is keyed on the index row `id` for Jira/Confluence (works) but the
// Linear adapter keys its `by-id/` alias on the human IDENTIFIER (e.g. AGE-8)
// while `_index.json` row `id` is the UUID — the UUID alias is at
// `by-uuid/<uuid>.json`. So Linear silently no-op'd → empty schema. The fix
// dereferences each index row id through an ordered list of UNIVERSAL
// id-keyed alias conventions (`by-id/<id>.json`, then `by-uuid/<id>.json`),
// adapter-agnostic, deterministic, alias-keying-independent.
// ---------------------------------------------------------------------------
describe("ensureProviderDiscoveryContract: generic canonical-record sampler (Linear/Confluence + alias-exclusion + convergence)", () => {
  // The Linear issue envelope cloud's writer emits — same `content` is written
  // to the canonical path AND every alias including the always-emitted
  // by-uuid anchor (verified in @relayfile/adapter-linear emit-auxiliary-files:
  // `writes = newPaths.map(path => ({ path, content }))`).
  function linearEnvelope(
    uuid: string,
    payload: Record<string, unknown>,
  ): string {
    return JSON.stringify({
      provider: "linear",
      objectType: "issue",
      objectId: uuid,
      deleted: false,
      payload,
      connectionId: "conn_test",
    });
  }

  // Reproduce EXACTLY the on-disk layout adapter-linear materializes for an
  // issue: canonical `/linear/issues/<identifier>__<uuid>.json`, the always-
  // emitted by-uuid anchor keyed on the UUID (== index row id), the by-id
  // alias keyed on the human identifier, plus by-state. Index row carries
  // `{ id: <uuid>, title, updated, identifier, state }`.
  function seedLinearIssues(
    client: { files: Map<string, string> },
    issues: Array<{
      uuid: string;
      identifier: string;
      payload: Record<string, unknown>;
    }>,
  ): void {
    const rows = issues.map((i) => ({
      id: i.uuid,
      title: String(i.payload.title ?? ""),
      updated: "2026-05-10T10:00:00.000Z",
      identifier: i.identifier,
      state: String(i.payload.state ?? ""),
    }));
    client.files.set("/linear/issues/_index.json", JSON.stringify(rows));
    for (const i of issues) {
      const content = linearEnvelope(i.uuid, i.payload);
      // Canonical record file (slug__uuid).
      client.files.set(
        `/linear/issues/${i.identifier}__${i.uuid}.json`,
        content,
      );
      // by-uuid anchor — keyed on the UUID == index row id (ALWAYS emitted).
      client.files.set(`/linear/issues/by-uuid/${i.uuid}.json`, content);
      // by-id alias — keyed on the human identifier (NOT the index row id).
      client.files.set(
        `/linear/issues/by-id/${i.identifier}.json`,
        content,
      );
      // a grouped alias subtree (must never be sampled / double-counted).
      client.files.set(
        `/linear/issues/by-state/${String(i.payload.state ?? "todo")}/${i.identifier}.json`,
        content,
      );
    }
  }

  const linearIssues = [
    {
      uuid: "11111111-1111-1111-1111-111111111111",
      identifier: "AGE-8",
      payload: {
        id: "11111111-1111-1111-1111-111111111111",
        identifier: "AGE-8",
        title: "Investigate discovery backfill",
        description: "The on-demand sampler must infer real schemas.",
        state: "in_progress",
        priority: 2,
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-10T10:00:00.000Z",
      },
    },
    {
      uuid: "22222222-2222-2222-2222-222222222222",
      identifier: "AGE-9",
      payload: {
        id: "22222222-2222-2222-2222-222222222222",
        identifier: "AGE-9",
        title: "Ship generic sampler",
        description: "Adapter-agnostic id-keyed dereference.",
        state: "todo",
        priority: 1,
        createdAt: "2026-05-02T00:00:00.000Z",
        updatedAt: "2026-05-11T10:00:00.000Z",
      },
    },
  ];

  // THE reviewer-specified Linear behavioral RED. On the pre-fix branch the
  // sampler reads `/linear/issues/by-id/<uuid>.json` (UUID, which does NOT
  // exist — by-id is keyed on AGE-8), gets 404, samples nothing, and emits
  // `properties: {}`. The authored write schema now keeps this non-empty even
  // when a read sampler would be sparse.
  it("Linear: emits NON-empty authored schema (by-id keyed on identifier, UUID alias at by-uuid)", async () => {
    const client = makeMutableReadingClient();
    seedLinearIssues(client, linearIssues);

    const errors = await ensureProviderDiscoveryContract(
      client,
      "linear",
      "rw_fc7b534b",
    );
    assert.deepEqual(errors, [], "linear backfill reported errors");

    const schemaBody = client.files.get(
      "/discovery/linear/issues/.schema.json",
    );
    assert.ok(schemaBody, "linear issues .schema.json was not materialized");
    const schema = JSON.parse(schemaBody!) as {
      properties?: Record<string, { readOnly?: boolean }>;
    };
    const props = schema.properties ?? {};
    assert.ok(
      Object.keys(props).length > 0,
      `expected linear issues .schema.json properties NON-empty; got ${JSON.stringify(props)}`,
    );
    assert.ok(props.title, "expected authored field `title` in linear schema");
    assert.ok(
      props.teamId,
      "expected authored field `teamId` in linear schema",
    );

    const exampleBody = client.files.get(
      "/discovery/linear/issues/.create.example.json",
    );
    assert.ok(exampleBody, "linear .create.example.json not materialized");
    const example = JSON.parse(exampleBody!) as Record<string, unknown>;
    assert.ok(
      Object.keys(example).length > 0,
      `expected linear .create.example.json NON-empty; got ${exampleBody}`,
    );
  });

  it("Confluence: emits NON-empty schema from sampled pages (by-id keyed on page id)", async () => {
    const client = makeMutableReadingClient();
    const pages = [
      {
        id: "page-100",
        payload: {
          id: "page-100",
          title: "Engineering Handbook",
          status: "current",
          spaceId: "SPACE1",
          body: "<p>Onboarding</p>",
          version: { number: 3 },
          createdAt: "2026-04-01T00:00:00.000Z",
        },
      },
      {
        id: "page-200",
        payload: {
          id: "page-200",
          title: "Release Process",
          status: "current",
          spaceId: "SPACE1",
          body: "<p>Cut a release</p>",
          version: { number: 7 },
          createdAt: "2026-04-05T00:00:00.000Z",
        },
      },
    ];
    const rows = pages.map((p) => ({
      id: p.id,
      title: String(p.payload.title),
      updated: "2026-05-10T10:00:00.000Z",
      status: String(p.payload.status),
    }));
    client.files.set("/confluence/pages/_index.json", JSON.stringify(rows));
    for (const p of pages) {
      const content = JSON.stringify({
        provider: "confluence",
        objectType: "page",
        objectId: p.id,
        deleted: false,
        payload: p.payload,
        connectionId: "conn_test",
      });
      // by-id keyed on the page id (== index row id) — always emitted.
      client.files.set(`/confluence/pages/by-id/${p.id}.json`, content);
      // canonical + by-title alias (must not double-count).
      client.files.set(
        `/confluence/pages/${p.payload.title.replace(/\s+/g, "-").toLowerCase()}__${p.id}.json`,
        content,
      );
      client.files.set(
        `/confluence/pages/by-title/${p.payload.title.replace(/\s+/g, "-").toLowerCase()}.json`,
        content,
      );
    }

    const errors = await ensureProviderDiscoveryContract(
      client,
      "confluence",
      "rw_fc7b534b",
    );
    assert.deepEqual(errors, [], "confluence backfill reported errors");

    const schemaBody = client.files.get(
      "/discovery/confluence/pages/.schema.json",
    );
    assert.ok(schemaBody, "confluence pages .schema.json not materialized");
    const props =
      (JSON.parse(schemaBody!) as { properties?: Record<string, unknown> })
        .properties ?? {};
    assert.ok(
      Object.keys(props).length > 0,
      `expected confluence pages .schema.json properties NON-empty; got ${JSON.stringify(props)}`,
    );
    assert.ok(props.title, "expected sampled field `title` in confluence schema");
    assert.ok(props.status, "expected sampled field `status`");
  });

  it("Jira + Confluence: actual adapter-emitted flat resources sample into non-empty schemas", async () => {
    const jiraClient = makeMutableReadingClient();
    await emitJiraAuxiliaryFiles(jiraClient, {
      workspaceId: "rw_fc7b534b",
      connectionId: "conn_test",
      issues: [
        {
          id: "10035",
          key: "KAN-4",
          fields: {
            summary: "relayfile writeback test",
            updated: "2026-05-19T17:40:48.647Z",
            status: { name: "Open" },
            project: { key: "KAN" },
          },
        },
      ],
    });

    const jiraReport = await ensureProviderDiscoveryContractReport(
      jiraClient,
      "jira",
      "rw_fc7b534b",
    );
    assert.equal(jiraReport.status, "complete");
    assert.deepEqual(jiraReport.samplingWarnings, []);
    const jiraProps =
      (JSON.parse(
        jiraClient.files.get("/discovery/jira/issues/.schema.json")!,
      ) as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(
      Object.keys(jiraProps).length > 0,
      "actual adapter-emitted Jira issue files must infer a non-empty schema",
    );
    assert.ok(jiraProps.fields, "expected sampled Jira `fields` object");

    const confluenceClient = makeMutableReadingClient();
    await emitConfluenceAuxiliaryFiles(confluenceClient, {
      workspaceId: "rw_fc7b534b",
      connectionId: "conn_test",
      pages: [
        {
          id: "page-100",
          title: "Engineering Handbook",
          status: "current",
          spaceId: "SPACE1",
          body: { storage: { value: "<p>Onboarding</p>" } },
          version: { number: 3, createdAt: "2026-05-19T19:22:39.047Z" },
        },
      ],
    });

    const confluenceReport = await ensureProviderDiscoveryContractReport(
      confluenceClient,
      "confluence",
      "rw_fc7b534b",
    );
    assert.equal(confluenceReport.status, "complete");
    assert.deepEqual(confluenceReport.samplingWarnings, []);
    const confluenceProps =
      (JSON.parse(
        confluenceClient.files.get(
          "/discovery/confluence/pages/.schema.json",
        )!,
      ) as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(
      Object.keys(confluenceProps).length > 0,
      "actual adapter-emitted Confluence page files must infer a non-empty schema",
    );
    assert.ok(confluenceProps.title, "expected sampled Confluence `title`");
    assert.ok(confluenceProps.body, "expected sampled Confluence `body`");
  });

  it("alias-exclusion + determinism: canonical + every alias copy of the same record are NOT double-counted, bound honored", async () => {
    const client = makeMutableReadingClient();
    // 25 issues > DISCOVERY_SAMPLE_LIMIT (20). Each record is reachable via
    // canonical, by-uuid, by-id and by-state — the sampler must dereference
    // exactly ONE per index row (id-keyed), bounded to the first 20.
    const issues = Array.from({ length: 25 }, (_, n) => {
      const uuid = `uuid-${String(n).padStart(4, "0")}`;
      const identifier = `AGE-${n}`;
      return {
        uuid,
        identifier,
        payload: {
          id: uuid,
          identifier,
          title: `Issue ${n}`,
          state: "todo",
          // Field only on a record beyond the first-20 window (sorted by id)
          // — must NOT leak in (proves bounded + deterministic + reads the
          // id-keyed record, not an arbitrary alias copy).
          ...(n === 24 ? { lateOnlyField: "should-not-appear" } : {}),
        },
      };
    });
    seedLinearIssues(client, issues);

    const reads: string[] = [];
    const origRead = client.readFile!.bind(client);
    client.readFile = async (ws: string, path: string) => {
      if (path.startsWith("/linear/issues/") && path.endsWith(".json"))
        reads.push(path);
      return origRead(ws, path);
    };

    await ensureProviderDiscoveryContract(client, "linear", "rw_fc7b534b");

    // Record dereferences (exclude the _index.json listing read). The sampler
    // tries the ordered id-keyed alias conventions per row and STOPS at the
    // first hit, so AT MOST ID_KEYED_ALIAS_DIRS.length (2) reads per sampled
    // row and exactly ONE record per row — never N × every-alias-copy. Bound:
    // ≤ 2 × DISCOVERY_SAMPLE_LIMIT reads, and the DISTINCT index-row ids
    // touched is ≤ the limit (bounded list-then-read-N).
    const recordReads = reads.filter((p) => !p.endsWith("_index.json"));
    assert.ok(
      recordReads.length <= 2 * 20,
      `expected ≤2×20 id-keyed alias reads (≤ALIAS_DIRS per row, stop at first hit, no every-alias-copy fan-out); got ${recordReads.length}: ${JSON.stringify(recordReads.slice(0, 6))}`,
    );
    const distinctRowIds = new Set(
      recordReads.map((p) => p.replace(/^.*\/(by-id|by-uuid)\//, "").replace(/\.json$/, "")),
    );
    assert.ok(
      distinctRowIds.size <= 20,
      `expected ≤20 DISTINCT index-row ids dereferenced (bounded sample, one record per row); got ${distinctRowIds.size}`,
    );
    // Alias subtrees that are NOT id-keyed (by-state, by-title, the canonical
    // slug file) must never be sampled.
    assert.ok(
      !recordReads.some(
        (p) => p.includes("/by-state/") || p.includes("/by-title/"),
      ),
      "non-id-keyed alias subtree was sampled — alias exclusion violated",
    );
    const schema = JSON.parse(
      client.files.get("/discovery/linear/issues/.schema.json")!,
    ) as { properties?: Record<string, unknown> };
    assert.ok(
      !(schema.properties ?? {}).lateOnlyField,
      "a field only on a record beyond the deterministic first-N window leaked in — not bounded/ordered",
    );
    assert.ok(
      Object.keys(schema.properties ?? {}).length > 0,
      "expected non-empty schema from the bounded sample",
    );
  });

  it("Jira sanitized→raw convergence: a later active sync with full record monotonically widens (no field dropped)", async () => {
    const client = makeMutableReadingClient();
    // On-demand samples the STORED (sanitized) jira by-id payload: assignee
    // redacted to null, no changelog.
    const sanitized = {
      id: "10001",
      key: "ENG-1",
      fields: { summary: "Fix login", status: { name: "Open" } },
      assignee: null,
    };
    client.files.set(
      "/jira/issues/_index.json",
      JSON.stringify([
        { id: "10001", title: "Fix login", updated: "2026-05-10T10:00:00Z" },
      ]),
    );
    client.files.set(
      "/jira/issues/by-id/10001.json",
      JSON.stringify({
        provider: "jira",
        objectType: "issue",
        objectId: "10001",
        deleted: false,
        payload: sanitized,
        connectionId: "conn_test",
      }),
    );

    await ensureProviderDiscoveryContract(client, "jira", "rw_fc7b534b");
    const afterOnDemand = JSON.parse(
      client.files.get("/discovery/jira/issues/.schema.json")!,
    ) as { properties?: Record<string, unknown> };
    const onDemandKeys = Object.keys(afterOnDemand.properties ?? {});
    assert.ok(onDemandKeys.length > 0, "on-demand sanitized schema empty");

    // Simulated active sync delivering the RAW record (full assignee object,
    // changelog) — the monotonic merge must keep ALL prior fields and ADD the
    // richer ones.
    const rawBatch = [
      {
        id: "10001",
        key: "ENG-1",
        fields: {
          summary: "Fix login",
          status: { name: "Open" },
          assignee: { accountId: "acc-1", displayName: "Ana" },
        },
        changelog: { histories: [{ id: "h1" }] },
      },
    ];
    await writeBatchToRelayfile(client, rawBatch, jobFor("jira", "JiraIssue"));

    const afterActive = JSON.parse(
      client.files.get("/discovery/jira/issues/.schema.json")!,
    ) as { properties?: Record<string, unknown> };
    const activeKeys = Object.keys(afterActive.properties ?? {});
    for (const k of onDemandKeys) {
      assert.ok(
        activeKeys.includes(k),
        `monotonic-merge regression: field '${k}' from the on-demand (sanitized) schema was DROPPED after an active raw sync`,
      );
    }
  });

  it("malformed / unreadable record files are resilient (no throw, authored schema preserved)", async () => {
    const client = makeMutableReadingClient();
    client.files.set(
      "/linear/issues/_index.json",
      JSON.stringify([
        { id: "u1", title: "x", updated: "t", identifier: "AGE-1" },
      ]),
    );
    // Index row points to an id with NO resolvable id-keyed alias, and the
    // by-uuid alias is corrupt JSON.
    client.files.set("/linear/issues/by-uuid/u1.json", "{ not json ::::");

    const errors = await ensureProviderDiscoveryContract(
      client,
      "linear",
      "rw_fc7b534b",
    );
    assert.deepEqual(errors, [], "must not error on malformed record files");
    const schema = JSON.parse(
      client.files.get("/discovery/linear/issues/.schema.json")!,
    ) as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(schema.properties?.title, "expected authored Linear title schema");
    assert.ok(
      schema.properties?.teamId,
      "expected authored Linear teamId schema",
    );
    assert.deepEqual(
      schema.required,
      ["teamId", "title"],
      "malformed samples must not erase authored create requirements",
    );
  });

  it("surfaces indexed-but-unsampled flat resources as a non-fatal warning/report", async () => {
    const client = makeMutableReadingClient();
    client.files.set(
      "/jira/issues/_index.json",
      JSON.stringify([
        {
          id: "10035",
          title: "relayfile writeback test",
          updated: "2026-05-19T17:40:48.647Z",
          key: "KAN-4",
          state: "Open",
          projectKey: "KAN",
        },
      ]),
    );

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let report: Awaited<ReturnType<typeof ensureProviderDiscoveryContractReport>>;
    try {
      report = await ensureProviderDiscoveryContractReport(
        client,
        "jira",
        "rw_fc7b534b",
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(report.status, "degraded");
    assert.equal(report.indexedResources, 1);
    assert.equal(report.sampledResources, 0);
    assert.deepEqual(report.samplingWarnings, [
      {
        provider: "jira",
        resourceName: "issues",
        resourcePath: "/jira/issues",
        indexPath: "/jira/issues/_index.json",
        indexRows: 1,
        sampledIds: 1,
        sampledRecords: 0,
        reason: "skipped-no-alias-match",
      },
    ]);
    assert.ok(
      warnings.some(
        (warning) =>
          typeof warning[0] === "string" &&
          warning[0].includes("sampled zero records"),
      ),
      "expected a structured console.warn for indexed rows with no sampled record",
    );
  });

  it("uses a generic degraded status while preserving the exact sampling warning reason", async () => {
    const client = makeMutableReadingClient();
    client.files.set(
      "/jira/issues/_index.json",
      JSON.stringify([
        {
          title: "row without a readable id",
          updated: "2026-05-19T17:40:48.647Z",
          key: "KAN-4",
        },
      ]),
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    let report: Awaited<ReturnType<typeof ensureProviderDiscoveryContractReport>>;
    try {
      report = await ensureProviderDiscoveryContractReport(
        client,
        "jira",
        "rw_fc7b534b",
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(report.status, "degraded");
    assert.equal(report.samplingWarnings[0]?.reason, "skipped-no-readable-row-ids");
  });

  // NIT-2 defensive guard. Today no two SAMPLED (flat, placeholder-free)
  // resources from a single real adapter share a `name`, so this scenario is
  // not reachable through the real adapter registry — it is unit-tested
  // directly against the exported `sampleExistingRecordsByResource` with a
  // SYNTHETIC two-resource list whose names collide. Without the guard the
  // second flat resource's records silently CLOBBER the first's in the
  // `resource.name`-keyed map (observable: the returned map entry for the
  // shared name holds resource B's records, A's are lost). With the guard the
  // first is preserved, the duplicate is skipped, and a structured
  // console.warn is emitted (non-fatal graceful degradation).
  it("guards against silent Map-key clobber when two SAMPLED flat resources share a name (warn+skip, first preserved)", async () => {
    const client = makeMutableReadingClient();

    // Two genuinely-flat (no `{placeholder}`) resources, DISTINCT paths, but
    // the SAME `name` — a hypothetical future config mistake.
    const resourceA: AdapterResourceConfig = {
      name: "issues",
      path: "/synthetic/alpha",
      pathPattern: /^\/synthetic\/alpha/,
      idPattern: /^[A-Za-z0-9_-]+$/,
      schema: "discovery/synthetic/alpha/.schema.json",
      createExample: "discovery/synthetic/alpha/.create.example.json",
    };
    const resourceB: AdapterResourceConfig = {
      ...resourceA,
      path: "/synthetic/beta",
      pathPattern: /^\/synthetic\/beta/,
      schema: "discovery/synthetic/beta/.schema.json",
      createExample: "discovery/synthetic/beta/.create.example.json",
    };

    const envelope = (objectId: string, payload: Record<string, unknown>) =>
      JSON.stringify({
        provider: "synthetic",
        objectType: "issue",
        objectId,
        deleted: false,
        payload,
        connectionId: "conn_test",
      });

    client.files.set(
      "/synthetic/alpha/_index.json",
      JSON.stringify([{ id: "a1" }]),
    );
    client.files.set(
      "/synthetic/alpha/by-id/a1.json",
      envelope("a1", { fromResource: "A", alphaOnly: true }),
    );
    client.files.set(
      "/synthetic/beta/_index.json",
      JSON.stringify([{ id: "b1" }]),
    );
    client.files.set(
      "/synthetic/beta/by-id/b1.json",
      envelope("b1", { fromResource: "B", betaOnly: true }),
    );

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    let result: Map<string, readonly Record<string, unknown>[]>;
    try {
      result = await sampleExistingRecordsByResource(client, "rw_fc7b534b", [
        resourceA,
        resourceB,
      ]);
    } finally {
      console.warn = originalWarn;
    }

    // First-wins: the shared key must still resolve to resource A's record,
    // NOT be silently clobbered by resource B.
    const entry = result.get("issues");
    assert.ok(entry, "expected a sampled entry for the shared name 'issues'");
    assert.equal(entry!.length, 1, "expected exactly resource A's one record");
    assert.equal(
      (entry![0] as { fromResource?: string }).fromResource,
      "A",
      "resource A's record must be preserved (not clobbered by resource B)",
    );
    // The collision must be reported, not silent.
    assert.ok(
      warnings.some(
        (w) =>
          typeof w[0] === "string" &&
          (w[0] as string).includes("[record-writer]") &&
          (w[0] as string).toLowerCase().includes("collision"),
      ),
      `expected a structured collision warning; got ${JSON.stringify(warnings)}`,
    );
  });
});

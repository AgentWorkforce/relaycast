import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  refreshWorkspaceDigests,
  type WorkspaceDigestContext,
} from "../../relayfile/src/durable-objects/digest.js";
import type {
  WorkspaceEvent,
  WorkspaceFile,
} from "../../relayfile/src/types.js";
import type {
  PlannedRelayfileWrite,
  ProviderModelKey,
} from "../src/sync/provider-write-planner.js";
import type { NangoSyncJob } from "../src/sync/nango-sync-job.js";
import {
  planProviderRecordWrites,
  providerModelKey,
} from "../src/sync/provider-write-planner.js";
import {
  writeBatchToRelayfile,
  type RelayfileWriteClient,
} from "../src/sync/record-writer.js";
import { processWebhookQueueMessage } from "../../webhook-worker/src/queue-consumer.js";

type StoredDigest = {
  path: string;
  content: string;
  contentType: string;
  revision: string;
};

type RecordedWrite = {
  path: string;
  content: string;
  contentType: string;
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: unknown[];
};

export function enabledOnly(key: ProviderModelKey): ReadonlySet<ProviderModelKey> {
  return new Set([key]);
}

export function enabledSetFor(job: NangoSyncJob) {
  return new Set([providerModelKey(job)]);
}

export function planSmokeWrites(
  job: NangoSyncJob,
  record: Record<string, unknown>,
): PlannedRelayfileWrite[] {
  const plan = planProviderRecordWrites(job, [record], enabledSetFor(job));
  assert.equal(plan.written, 1);
  assert.equal(plan.deleted, 0);
  assert.equal(plan.skipped, 0);
  return plan.writes;
}

export function assertHasPath(
  writes: readonly { path: string }[],
  path: string,
): void {
  assert.ok(
    writes.some((write) => write.path === path),
    `expected ${path}; got ${JSON.stringify(writes.map((write) => write.path).sort())}`,
  );
}

export function makeMutableReadingClient(): RelayfileWriteClient & {
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

export async function assertWriterEmitsPaths(
  job: NangoSyncJob,
  record: Record<string, unknown>,
  expectedPaths: readonly string[],
): Promise<void> {
  const client = makeMutableReadingClient();
  const result = await writeBatchToRelayfile(client, [record], job);
  assert.equal(result.written, 1);
  assert.equal(result.deleted, 0);
  assert.equal(result.errors, 0);
  for (const path of expectedPaths) {
    assertHasPath(client.writes, path);
  }
}

export function writeByPath(
  writes: readonly PlannedRelayfileWrite[],
  path: string,
): PlannedRelayfileWrite {
  const write = writes.find((candidate) => candidate.path === path);
  assert.ok(write, `expected planned write for ${path}`);
  assert.equal(write.delete, undefined, `${path} should be a write`);
  assert.equal(typeof write.contents, "string", `${path} should have contents`);
  return write;
}

export function assertNoThrowForMalformed(
  action: () => unknown,
): void {
  assert.doesNotThrow(action);
}

export async function assertGeneratedModelSchema(
  model: string,
  record: Record<string, unknown>,
): Promise<void> {
  const schemaRaw = await readFile("nango-integrations/.nango/schema.json", "utf8");
  const schema = JSON.parse(schemaRaw) as { definitions?: Record<string, JsonSchema> };
  const definition = schema.definitions?.[model];
  assert.ok(definition, `missing generated Nango schema for ${model}`);
  assertMatchesSchema(record, definition, model);
}

export function assertMatchesSchema(
  value: unknown,
  schema: JsonSchema,
  path = "value",
): void {
  if (schema.anyOf) {
    const errors: unknown[] = [];
    for (const option of schema.anyOf) {
      try {
        assertMatchesSchema(value, option, path);
        return;
      } catch (error) {
        errors.push(error);
      }
    }
    assert.fail(`${path} did not match any schema option: ${errors.map(String).join("; ")}`);
  }

  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${path} must be one of ${schema.enum.join(", ")}`);
  }

  if (!schema.type) return;
  if (schema.type === "object") {
    assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${path} must be an object`);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      assert.ok(Object.prototype.hasOwnProperty.call(record, key), `${path}.${key} is required`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        assert.ok(schema.properties[key], `${path}.${key} is not declared in generated schema`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (record[key] !== undefined) assertMatchesSchema(record[key], propertySchema, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    for (const [index, item] of (value as unknown[]).entries()) {
      if (schema.items) assertMatchesSchema(item, schema.items, `${path}[${index}]`);
    }
    return;
  }
  if (schema.type === "string") {
    assert.equal(typeof value, "string", `${path} must be a string`);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    assert.equal(typeof value, "number", `${path} must be a number`);
    return;
  }
  if (schema.type === "boolean") {
    assert.equal(typeof value, "boolean", `${path} must be a boolean`);
    return;
  }
  if (schema.type === "null") {
    assert.equal(value, null, `${path} must be null`);
  }
}

export async function renderTodayDigest(input: {
  provider: string;
  path: string;
  contents: string;
  timestamp: string;
}): Promise<string> {
  const revision = `rev_${input.provider}_today`;
  const { context, stored } = createDigestContext(
    [
      {
        eventId: `evt_${input.provider}_today`,
        type: "file.updated",
        path: input.path,
        revision,
        origin: "provider_sync",
        provider: input.provider,
        correlationId: `corr_${input.provider}_today`,
        timestamp: input.timestamp,
      },
    ],
    new Map([[`${input.path}@${revision}`, input.contents]]),
  );

  await refreshWorkspaceDigests(context, "rw_test", {
    changedPaths: [input.path],
    generatedAt: new Date("2026-05-15T12:00:00.000Z"),
    correlationId: `corr_${input.provider}_digest`,
  });

  const todayDigest = stored.find((item) => item.path === "/digests/today.md");
  assert.ok(todayDigest, "expected /digests/today.md to be written");
  return todayDigest.content;
}

export async function assertTodayDigestIncludes(
  provider: string,
  path: string,
  content: string,
): Promise<void> {
  const todayDigest = await renderTodayDigest({
    provider,
    path,
    contents: content,
    timestamp: "2026-05-15T09:00:00.000Z",
  });
  assert.ok(todayDigest.includes("covers: today"));
  assert.ok(todayDigest.includes(path));
}

export async function assertMalformedNangoMessageAcked(
  providerConfigKey: string,
  syncName: string,
  model: string,
): Promise<void> {
  const message = {
    id: `msg_${providerConfigKey}`,
    timestamp: new Date("2026-05-20T00:00:00.000Z"),
    attempts: 1,
    body: {
      version: 2,
      provider: "nango",
      ingress: "nango-sync",
      requestId: `req_${providerConfigKey}`,
      receivedAt: "2026-05-20T00:00:00.000Z",
      headers: {},
      payload: {
        storage: "inline",
        body: "{}",
        sizeBytes: 2,
        sha256: "hash",
      },
      nango: {
        providerConfigKey,
        syncName,
        model,
      },
    },
    ackCalls: 0,
    retryCalls: 0,
    ack() {
      this.ackCalls += 1;
    },
    retry() {
      this.retryCalls += 1;
    },
  };

  await processWebhookQueueMessage(
    message as never,
    {} as never,
    {} as never,
  );

  assert.equal(message.ackCalls, 1);
  assert.equal(message.retryCalls, 0);
}

function createDigestContext(
  events: WorkspaceEvent[],
  initialContent: Map<string, string>,
): {
  context: WorkspaceDigestContext;
  stored: StoredDigest[];
} {
  const files = new Map<string, Partial<WorkspaceFile>>();
  const stored: StoredDigest[] = [];
  const insertedEvents: WorkspaceEvent[] = [];
  let revisionCounter = 0;
  let eventCounter = 100;

  const allRows = ((query: string, ...bindings: unknown[]) => {
    if (query.includes("FROM events")) {
      const [from, to, limit] = bindings as [string, string, number | undefined];
      const rows = events
        .concat(insertedEvents)
        .filter(
          (event) =>
            event.timestamp >= from &&
            event.timestamp < to &&
            !event.path.startsWith("/digests/"),
        )
        .sort((left, right) =>
          query.includes("ORDER BY timestamp DESC")
            ? right.timestamp.localeCompare(left.timestamp) ||
              right.eventId.localeCompare(left.eventId)
            : left.timestamp.localeCompare(right.timestamp) ||
              left.eventId.localeCompare(right.eventId),
        )
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .sort((left, right) =>
          query.includes("ORDER BY timestamp ASC")
            ? left.timestamp.localeCompare(right.timestamp) ||
              left.eventId.localeCompare(right.eventId)
            : 0,
        );
      return rows.map((event) => ({
        event_id: event.eventId,
        type: event.type,
        path: event.path,
        revision: event.revision,
        origin: event.origin,
        provider: event.provider,
        correlation_id: event.correlationId,
        timestamp: event.timestamp,
      }));
    }
    if (query.includes("SELECT DISTINCT provider")) {
      const providers = new Set<string>();
      for (const file of files.values()) {
        if (file.provider) providers.add(file.provider);
      }
      return [...providers].sort().map((provider) => ({ provider }));
    }
    return [];
  }) as WorkspaceDigestContext["allRows"];

  const context: WorkspaceDigestContext = {
    allRows,
    sqlExec(query: string, ...bindings: unknown[]) {
      if (!query.includes("INSERT INTO files")) return;
      const [
        path,
        revision,
        contentType,
        contentRef,
        size,
        encoding,
        updatedAt,
        semanticsJson,
        provider,
        providerObjectId,
        contentHash,
      ] = bindings as string[];
      files.set(path, {
        path,
        revision,
        contentType,
        contentRef,
        size: Number(size),
        encoding: encoding as "utf-8",
        updatedAt,
        semanticsJson,
        provider,
        providerObjectId,
        contentHash,
      });
    },
    getFileRow(path: string) {
      return files.get(path) ?? null;
    },
    nextId(prefix: "rev" | "evt" | "op") {
      if (prefix === "evt") return `evt_${++eventCounter}`;
      if (prefix === "rev") return `rev_${++revisionCounter}`;
      return "op_1";
    },
    contentRef(_workspaceId: string, path: string, revision: string) {
      return `${path}@${revision}`;
    },
    async putObject(contentRef, content, _encoding, contentType) {
      const [path, revision] = contentRef.split("@") as [string, string];
      stored.push({ path, revision, content, contentType });
    },
    async loadContent(contentRef) {
      const storedContent = stored.find((item) => `${item.path}@${item.revision}` === contentRef);
      return storedContent?.content ?? initialContent.get(contentRef) ?? "";
    },
    async deleteContent() {},
    insertEvent(event) {
      insertedEvents.push(event as WorkspaceEvent);
    },
    broadcastEvent() {},
    async flushStorage() {},
  };

  return { context, stored };
}

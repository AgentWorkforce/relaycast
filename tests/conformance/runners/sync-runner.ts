// Sync direction runner.
//
// Drives the REAL record-writer code path:
//   Nango model records -> writeBatchToRelayfile -> relayfile write/delete
// The ONLY mocked boundary is relayfile persistence, captured via an in-process
// RelayfileWriteClient (record-writer's sanctioned outer seam). Evidence is the
// captured writes[]/deletes[] with {path, content, contentType, encoding}.

import {
  type ConformanceManifest,
  type SyncFixture,
} from "../manifest-schema.ts";
import { missingSubstrings, pathMatches } from "../assertions.ts";
import type { FixtureResult } from "../harness-types.ts";

const TEST_WORKSPACE_ID = "rw_conformance_test";
const TEST_CONNECTION_ID = "conn_conformance_test";

interface RecordedWrite {
  path: string;
  content: string;
  contentType: string;
  encoding: string;
}

/**
 * record-writer's RelayfileWriteClient seam: a small in-memory store that
 * records writes + deletes AND serves prior content back via readFile. The
 * read-back is what lets deletion reconciliation (which reads the canonical /
 * alias / index files to know what to remove) actually issue deletes — a fresh
 * store has nothing to delete, so delete fixtures must seed the prior write.
 */
function makeRecordingClient() {
  const writes: RecordedWrite[] = [];
  const deletes: string[] = [];
  const store = new Map<string, RecordedWrite>();
  const client = {
    writes,
    deletes,
    /** Clear the captured writes/deletes (keeps the store) — used after seeding. */
    resetCapture() {
      writes.length = 0;
      deletes.length = 0;
    },
    async readFile(_workspaceId: string, path: string) {
      const found = store.get(path);
      if (!found) {
        const err = new Error("not found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      return { content: found.content, revision: "rev_seeded" };
    },
    async writeFile(input: {
      path: string;
      content: string;
      contentType: string;
      encoding: string;
    }) {
      const rec = {
        path: input.path,
        content: input.content,
        contentType: input.contentType,
        encoding: input.encoding,
      };
      writes.push(rec);
      store.set(input.path, rec);
      return { path: input.path, revision: `rev_${writes.length}` };
    },
    async deleteFile(input: { path: string }) {
      deletes.push(input.path);
      store.delete(input.path);
      return { path: input.path };
    },
  };
  return client;
}

async function importRecordWriter() {
  return import(
    new URL(
      "../../../packages/core/src/sync/record-writer.ts",
      import.meta.url,
    ).href
  ) as Promise<{
    writeBatchToRelayfile: (
      client: unknown,
      records: readonly unknown[],
      job: unknown,
      options?: Record<string, unknown>,
    ) => Promise<{ written: number; deleted: number; errors: number }>;
  }>;
}

export async function runSyncFixture(
  manifest: ConformanceManifest,
  fixture: SyncFixture,
  providerConfigKey: string,
): Promise<FixtureResult> {
  const label = `sync:${fixture.model}/${fixture.syncName}`;
  const errors: string[] = [];
  const client = makeRecordingClient();

  let result: { written: number; deleted: number; errors: number } | undefined;
  try {
    const { writeBatchToRelayfile } = await importRecordWriter();
    const job = {
      type: "nango_sync" as const,
      workspaceId: TEST_WORKSPACE_ID,
      relayWorkspaceId: TEST_WORKSPACE_ID,
      provider: manifest.provider,
      providerConfigKey,
      connectionId: TEST_CONNECTION_ID,
      syncName: fixture.syncName,
      model: fixture.model,
      cursor: null,
      modifiedAfter: "1970-01-01T00:00:00.000Z",
    };
    // Seed prior state (for delete reconciliation) then reset capture so
    // assertions apply only to the records under test.
    if (fixture.seedRecords && fixture.seedRecords.length > 0) {
      await writeBatchToRelayfile(client, fixture.seedRecords, job, {
        materializeContract: false,
      });
      client.resetCapture();
    }
    result = await writeBatchToRelayfile(client, fixture.records, job, {
      // Keep evidence focused on data writes; contract/aux files still exercise
      // the real adapter emitters but are not asserted unless a fixture names
      // their path.
      materializeContract: false,
    });
  } catch (error) {
    errors.push(
      `writeBatchToRelayfile threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (result && result.errors > 0) {
    errors.push(`record-writer reported ${result.errors} write error(s)`);
  }

  // Evaluate each expectation against captured writes/deletes.
  for (const ex of fixture.expect) {
    const op = ex.op ?? "write";
    if (op === "delete") {
      const match = client.deletes.find((p) =>
        pathMatches(p, ex.path, ex.pathPattern),
      );
      if (!match) {
        errors.push(
          `expected delete ${ex.path ?? ex.pathPattern} not found in deletes[${client.deletes.length}]: ${JSON.stringify(client.deletes)}`,
        );
      }
      continue;
    }
    const match = client.writes.find((w) =>
      pathMatches(w.path, ex.path, ex.pathPattern),
    );
    if (!match) {
      errors.push(
        `expected write ${ex.path ?? ex.pathPattern} not found in writes[${client.writes.length}]: ${JSON.stringify(client.writes.map((w) => w.path))}`,
      );
      continue;
    }
    errors.push(...missingSubstrings(match.content, ex.contentIncludes));
  }

  return {
    direction: "sync",
    label,
    passed: errors.length === 0,
    errors,
    evidence: {
      result,
      writes: client.writes,
      deletes: client.deletes,
    },
  };
}

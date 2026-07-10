# Spec: Async Nango Sync Worker

## Problem

When Nango completes a sync, it sends a webhook to our Next.js Lambda (60s timeout).
The handler fetches **all** records from Nango's API and writes them one-by-one to the
relayfile VFS. This works for small syncs (21 issues = ~30s) but **times out** for
larger ones (87 PRs, 72 repos). For a repo like `kubernetes` with 70k+ issues, this
approach is fundamentally broken — even a 15-minute Lambda can't process that many
records sequentially.

**Evidence**: 6 Lambda timeouts in the last hour. `fetch-open-prs` (87 records) and
`fetch-repos` (72 records) never completed. Only `fetch-open-issues` (21 records)
succeeded.

## Solution

Move sync record processing out of the webhook Lambda into a dedicated SQS-backed
worker Lambda with cursor checkpointing and parallel writes.

```
Nango webhook ──► API route (validate + enqueue + return 200) ──► SQS
                                                                    │
                                                                    ▼
                                                              Worker Lambda
                                                              (15 min timeout)
                                                                    │
                                                     ┌──────────────┼──────────────┐
                                                     ▼              ▼              ▼
                                              fetch page      write batch     checkpoint
                                              from Nango      to relayfile    cursor to SQS
                                              (100 records)   (parallel 10)   if more pages
```

## Architecture

### 1. SQS Queue (`infra/nango-sync-queue.ts`)

```typescript
import { nangoSecretKey, relayJwtSecret } from "./secrets";
import { appDatabase } from "./database";
import { vpc } from "./vpc";

const nangoSyncDlq = new sst.aws.Queue("NangoSyncDlq", {
  visibilityTimeout: "15 minutes",
});

export const nangoSyncQueue = new sst.aws.Queue("NangoSyncQueue", {
  visibilityTimeout: "16 minutes",  // must exceed worker timeout
  dlq: {
    queue: nangoSyncDlq,
    retry: 3,
  },
});

nangoSyncQueue.subscribe(
  {
    handler: "packages/core/src/sync/nango-sync-worker.handler",
    timeout: "15 minutes",
    memory: "512 MB",
    link: [appDatabase, nangoSecretKey, relayJwtSecret],
    vpc,
  },
  {
    batch: { size: 1 },  // one sync job per invocation
  },
);
```

Register in `sst.config.ts`:
```typescript
await import("./infra/nango-sync-queue");
```

### 2. Link queue to the web Lambda

The web Lambda needs permission to send messages to the queue. Add `nangoSyncQueue`
to the `link` array in `infra/web.ts`:

```typescript
import { nangoSyncQueue } from "./nango-sync-queue";

// In the sst.aws.Nextjs link array:
link: [
  // ...existing links...
  nangoSyncQueue,
],
```

### 3. SQS Message Schema

```typescript
/** Message sent from webhook handler to the SQS queue. */
export interface NangoSyncJob {
  /** Discriminator for future message types. */
  type: "nango_sync";
  /** Resolved provider: "github" | "linear" | "slack" | "notion" */
  provider: string;
  /** Nango connection ID */
  connectionId: string;
  /** Nango provider config key (e.g. "github-sage") */
  providerConfigKey: string;
  /** Nango sync name (e.g. "fetch-open-issues") */
  syncName: string;
  /** Nango model name (e.g. "Issue", "PullRequest", "Repo") */
  model: string;
  /** ISO timestamp — only fetch records modified after this */
  modifiedAfter: string;
  /**
   * Cursor for resumption. When the worker approaches timeout, it
   * re-enqueues the job with the cursor of the last processed page.
   * Null on first invocation.
   */
  cursor: string | null;
  /** Cloud workspace ID (resolved by webhook handler before enqueue) */
  workspaceId: string;
}
```

### 4. Webhook Handler Changes

**File**: `packages/web/app/api/v1/webhooks/nango/route.ts`

No changes to signature validation or envelope parsing. Only the sync path changes.

**File**: `packages/web/lib/integrations/nango-webhook-router.ts`

Modify `handleSyncEvent()` to enqueue instead of process inline:

```typescript
export async function handleSyncEvent(envelope: NangoWebhookEnvelope): Promise<void> {
  const payload = isObject(envelope.payload) ? envelope.payload : {};
  const syncName = readString(payload, "syncName") ?? readString(payload, "sync_name") ?? "unknown";
  const success = readBoolean(payload, "success");
  const model = readString(payload, "model") ?? "";
  const modifiedAfter = readString(payload, "modifiedAfter") ?? readString(payload, "modified_after") ?? "";
  const connectionId = envelope.connectionId?.trim() ?? "";
  const providerConfigKey = envelope.providerConfigKey || "";

  if (success === false) {
    await logger.warn("Nango sync webhook reported a failed sync", { ... });
    return;
  }

  const provider = normalizeProvider(envelope.providerConfigKey)
    ?? normalizeNangoProviderToWorkspaceProvider(envelope.providerConfigKey)
    ?? normalizeProvider(envelope.from)
    ?? normalizeNangoProviderToWorkspaceProvider(envelope.from);

  if (!provider || !connectionId) {
    await logger.warn("Nango sync webhook could not determine provider or connection", { ... });
    return;
  }

  // Resolve workspace ID here (fast DB lookup) so the worker doesn't need DB access
  // for workspace resolution.
  const workspaceId = await resolveWorkspaceIdForSync(provider, connectionId);
  if (!workspaceId) {
    await logger.warn("Nango sync webhook could not resolve workspace", { ... });
    return;
  }

  // Enqueue for async processing
  await enqueueNangoSyncJob({
    type: "nango_sync",
    provider,
    connectionId,
    providerConfigKey,
    syncName,
    model,
    modifiedAfter,
    cursor: null,
    workspaceId,
  });

  await logger.info("Nango sync job enqueued", {
    area: "nango-webhook",
    provider,
    connectionId,
    providerConfigKey,
    syncName,
    model,
    workspaceId,
  });
}
```

The `enqueueNangoSyncJob` function uses the SST Resource link:

```typescript
import { Resource } from "sst";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

async function enqueueNangoSyncJob(job: NangoSyncJob): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: Resource.NangoSyncQueue.url,
    MessageBody: JSON.stringify(job),
  }));
}
```

**Important**: `forward` and `auth` webhook types remain synchronous in the webhook
handler — they are fast and don't paginate through records. Only `sync` events are
enqueued.

### 5. Worker Lambda (`packages/core/src/sync/nango-sync-worker.ts`)

```typescript
import type { SQSHandler, SQSRecord } from "aws-lambda";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { Resource } from "sst";

const WRITE_CONCURRENCY = 10;          // parallel writes per batch
const CHECKPOINT_BUFFER_MS = 60_000;   // re-enqueue 60s before timeout
const DEFAULT_TIMEOUT_MS = 14 * 60 * 1000; // 14 min (1 min buffer from 15 min limit)

export const handler: SQSHandler = async (event, context) => {
  const deadline = Date.now() + (context.getRemainingTimeInMillis?.() ?? DEFAULT_TIMEOUT_MS) - CHECKPOINT_BUFFER_MS;

  for (const record of event.Records) {
    await processRecord(record, deadline);
  }
};
```

#### `processRecord` pseudocode:

```typescript
async function processRecord(record: SQSRecord, deadline: number): Promise<void> {
  const job: NangoSyncJob = JSON.parse(record.body);

  // 1. Create relayfile client for this workspace
  const relayfileClient = createRelayfileClient(job.workspaceId);

  // 2. Create Nango SDK client
  const nangoClient = new Nango({
    secretKey: Resource.NangoSecretKey.value,
    host: getNangoHost(),
  });

  // 3. Paginate through records
  let cursor = job.cursor;
  let totalWritten = 0;
  let totalDeleted = 0;
  let totalErrors = 0;

  do {
    // Check if approaching deadline
    if (Date.now() > deadline) {
      // Re-enqueue with current cursor for resumption
      await reenqueue({ ...job, cursor });
      logger.info("Nango sync checkpointed — re-enqueued for continuation", {
        provider: job.provider, syncName: job.syncName, model: job.model,
        cursor, written: totalWritten,
      });
      return;
    }

    // Fetch one page of records from Nango
    const page = await nangoClient.listRecords({
      providerConfigKey: job.providerConfigKey,
      connectionId: job.connectionId,
      model: job.model,
      ...(job.modifiedAfter ? { modifiedAfter: job.modifiedAfter } : {}),
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });

    // Write batch in parallel (chunks of WRITE_CONCURRENCY)
    const results = await writeBatchToRelayfile(
      relayfileClient,
      page.records,
      job,
    );
    totalWritten += results.written;
    totalDeleted += results.deleted;
    totalErrors += results.errors;

    cursor = page.next_cursor?.trim() || null;
  } while (cursor);

  logger.info("Nango sync completed", {
    area: "nango-sync-worker",
    provider: job.provider, workspaceId: job.workspaceId,
    connectionId: job.connectionId, syncName: job.syncName,
    model: job.model, written: totalWritten, deleted: totalDeleted, errors: totalErrors,
  });
}
```

#### `writeBatchToRelayfile` — parallel writes:

```typescript
async function writeBatchToRelayfile(
  client: RelayfileWriteClient,
  records: NangoRecord[],
  job: NangoSyncJob,
): Promise<{ written: number; deleted: number; errors: number }> {
  let written = 0, deleted = 0, errors = 0;

  // Process in chunks of WRITE_CONCURRENCY
  for (let i = 0; i < records.length; i += WRITE_CONCURRENCY) {
    const chunk = records.slice(i, i + WRITE_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((record) => writeOneRecord(client, record, job)),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value === "written") written++;
        else if (result.value === "deleted") deleted++;
      } else {
        errors++;
      }
    }
  }

  return { written, deleted, errors };
}
```

#### `writeOneRecord` — single record write (provider-specific path computation):

This function mirrors the generic provider writer path — computing the VFS path
from the record data and calling `client.writeFile()` or `client.deleteFile()`.

**Extract the existing per-provider record-writing logic** from
`nango-webhook-router.ts` into shared functions that both the (now-thin) router and
the worker can call. Suggested location: `packages/core/src/sync/record-writer.ts`.

Each provider needs:
- **github**: `parseGitHubRepoFromRecord`, `normalizeNangoGitHubModel`,
  `computeGitHubPath` (already exist in `@relayfile/adapter-github`)
- **linear**: `normalizeLinearObjectType`, `computeLinearPath`
  (already exist in `@relayfile/adapter-linear`)
- **slack**: `computeSlackPath`, `createSlackMessageObjectId`, etc.
  (already exist in `@relayfile/adapter-slack`)
- **notion**: Uses `handleNotionBulkIngest` from `@relayfile/provider-nango`

The adapter packages already have the path computation. The only logic that lives in
`nango-webhook-router.ts` is the for-loop that iterates records and calls write/delete.
Extract that into a `writeProviderRecord(client, record, provider, model, workspaceId)`
function.

#### `reenqueue` — cursor checkpoint:

```typescript
const sqs = new SQSClient({});

async function reenqueue(job: NangoSyncJob): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: Resource.NangoSyncQueue.url,
    MessageBody: JSON.stringify(job),
  }));
}
```

### 6. Relayfile Client in the Worker

The worker needs to create a relayfile write client. It uses `mintRelayfileToken`
from `packages/core/src/relayfile/client.ts` with `Resource.RelayJwtSecret.value`
and the workspace ID from the job message.

```typescript
import { RelayFileClient } from "@relayfile/sdk";
import { mintRelayfileToken } from "../relayfile/client.js";
import { Resource } from "sst";

function createWorkerRelayfileClient(workspaceId: string): RelayFileClient {
  const token = mintRelayfileToken(
    workspaceId,
    Resource.RelayJwtSecret.value,
    "nango-sync-worker",
  );
  return new RelayFileClient({
    baseUrl: process.env.RELAYFILE_URL ?? "https://api.relayfile.dev",
    token,
  });
}
```

**Note**: The RELAYFILE_URL env var needs to be added to the worker Lambda environment
in the infra definition, or the worker can read it from the SST link if it's already
a linked resource.

### 7. Nango Host Resolution

The worker needs the Nango base URL. In the current webhook router this comes from
`getNangoHost()`. The worker can:
- Use a hardcoded default (`https://api.nango.dev`)
- Or read from `Resource.NangoSecretKey` for the secret + env var for the host

Check the existing `getNangoHost()` function and replicate in the worker context.

## Files to Create / Modify

### New files:
| File | Purpose |
|------|---------|
| `infra/nango-sync-queue.ts` | SQS queue + DLQ + worker Lambda definition |
| `packages/core/src/sync/nango-sync-worker.ts` | Worker Lambda handler |
| `packages/core/src/sync/nango-sync-job.ts` | `NangoSyncJob` type definition |
| `packages/core/src/sync/record-writer.ts` | Extracted per-provider write logic |

### Modified files:
| File | Change |
|------|--------|
| `sst.config.ts` | Add `await import("./infra/nango-sync-queue")` |
| `infra/web.ts` | Add `nangoSyncQueue` to web Lambda `link` array |
| `packages/web/lib/integrations/nango-webhook-router.ts` | Replace `handleSyncEvent` body: resolve workspace + enqueue instead of process inline. Keep provider-specific record writing in shared `record-writer.ts` functions. |
| `packages/web/app/api/v1/webhooks/nango/route.ts` | No changes needed |

### Dependencies to add:
| Package | Where | Why |
|---------|-------|-----|
| `@aws-sdk/client-sqs` | `packages/web` | Send messages from webhook handler |
| `@aws-sdk/client-sqs` | `packages/core` | Re-enqueue from worker |
| `@nangohq/node` | `packages/core` | Fetch records in worker |
| `@relayfile/sdk` | `packages/core` | Write files in worker |
| `@relayfile/adapter-github` | `packages/core` | Path computation |
| `@relayfile/adapter-linear` | `packages/core` | Path computation |
| `@relayfile/adapter-slack` | `packages/core` | Path computation |

## Scaling Characteristics

| Scenario | Records | Estimated Time | Behavior |
|----------|---------|---------------|----------|
| Small sync (cloud issues) | 21 | ~10s | Single invocation, no checkpoint |
| Medium sync (cloud PRs) | 87 | ~30s | Single invocation, parallel writes |
| Large sync (popular repo) | 5,000 | ~5 min | Single invocation, parallel writes |
| Huge sync (kubernetes issues) | 70,000 | ~50 min | 3-4 checkpointed invocations |

With 10x parallel writes + 100 records per page:
- ~1s per page fetch from Nango
- ~1s per batch of 10 parallel writes to relayfile
- ~10 batches per page = ~11s per page of 100 records
- 70,000 records = 700 pages = ~2.1 hours (split across ~9 invocations)

## What This Does NOT Change

- `forward` webhooks (GitHub push, Slack events) — still processed synchronously
  in the webhook handler. These are single-event writes, not paginated record fetches.
- `auth` / `connection.created` webhooks — still synchronous (DB upsert only).
- Notion ingest — uses `handleNotionBulkIngest` which has its own flow. Include it
  in the async worker for consistency, but it already works differently from the
  other providers.

## Testing

1. **Unit tests** for `record-writer.ts` — mock relayfile client, verify correct paths
   and write/delete logic per provider.
2. **Unit tests** for worker handler — mock SQS event, mock Nango client, verify:
   - Normal completion (no re-enqueue)
   - Checkpoint re-enqueue when deadline approaches
   - Error handling (record write failures don't stop processing)
3. **Integration test** — deploy to staging, trigger a Nango resync, verify:
   - Webhook returns 200 immediately (< 1s)
   - SQS message appears in queue
   - Worker processes records and writes to VFS
   - All records appear in VFS tree
4. **Load test** — point at a repo with 1000+ issues, verify checkpointing works
   across multiple invocations.

import type {
  RecordBucketMap,
  SyncRecordBucketing,
} from "@relayfile/adapter-core/sync-bucketing";

export type { RecordBucketMap };
export type AdapterRecordBucketing = SyncRecordBucketing;

export interface ProviderBuckets {
  provider: string;
  buckets: RecordBucketMap;
}

export function bucketForAdapter(
  records: readonly unknown[],
  model: string,
  adapter: { id: string; recordBucketing?: AdapterRecordBucketing } | undefined,
): ProviderBuckets {
  if (!adapter?.recordBucketing) {
    return { provider: "unknown", buckets: {} };
  }
  return {
    provider: adapter.id,
    buckets: adapter.recordBucketing.bucketRecords(records.filter(isRecordObject), model),
  };
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

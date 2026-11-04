/**
 * Artifact uploads. The deployer only needs "put these bytes at this object
 * name and tell me the generation", so the GCS and S3 clients stay behind
 * {@link ArtifactStore} and tests use an in-memory store or a fake client.
 */
import { Storage } from "@google-cloud/storage"
import type { S3Client } from "@aws-sdk/client-s3"

import type { ArtifactStoreConfig } from "./config.ts"

export interface UploadedObject {
    /**
     * The object generation the control plane records, as a decimal string:
     * the GCS generation, or on S3 the `da-generation` user metadata (always
     * "1", since every object name is fresh).
     */
    generation: string
}

export interface ArtifactStore {
    upload(objectName: string, bytes: Uint8Array): Promise<UploadedObject>
}

const CONTENT_TYPES: Record<string, string> = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".pyz": "application/zip",
}

function contentType(objectName: string): string {
    const extension = objectName.slice(objectName.lastIndexOf("."))
    return CONTENT_TYPES[extension] ?? "application/octet-stream"
}

/**
 * Uploads into `bucket` with Application Default Credentials (Workload
 * Identity on GKE, `GOOGLE_APPLICATION_CREDENTIALS` elsewhere). Every object
 * name carries a fresh deployment UUID, so the upload insists the object does
 * not exist yet (`ifGenerationMatch: 0`) and the generation it returns is the
 * one just written.
 */
export function gcsArtifactStore(bucket: string, storage: Storage = new Storage()): ArtifactStore {
    const target = storage.bucket(bucket)
    return {
        async upload(objectName, bytes) {
            const file = target.file(objectName)
            await file.save(Buffer.from(bytes), {
                resumable: false,
                contentType: contentType(objectName),
                preconditionOpts: { ifGenerationMatch: 0 },
            })
            const generation = file.metadata.generation ?? (await file.getMetadata())[0].generation
            if (generation === undefined) throw new Error(`upload of ${objectName} reported no generation`)
            return { generation: String(generation) }
        },
    }
}

/** The generation every S3 artifact carries: names are never reused, so each object is written once. */
export const S3_GENERATION = "1"
/** The user metadata key durable-actors' S3 backend reads the generation from (`x-amz-meta-da-generation`). */
export const S3_GENERATION_METADATA = "da-generation"

/** The slice of `S3Client` the store uses (a test fake implements it, answering real command instances). */
export type S3ClientLike = Pick<S3Client, "send">

export interface S3ArtifactStoreOptions {
    region: string
    /** An S3-compatible endpoint (MinIO); unset for AWS. */
    endpoint?: string
    forcePathStyle: boolean
    /** Substitute client (tests); otherwise an `S3Client` with the SDK's default credential chain. */
    client?: S3ClientLike
}

/** The write lost to an existing object: 412 PreconditionFailed, or 409 ConditionalRequestConflict from a concurrent conditional write. */
function isAlreadyExists(error: unknown): boolean {
    const e = error as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null
    const name = e?.name ?? e?.Code
    return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || e?.$metadata?.httpStatusCode === 412
}

/**
 * Uploads into `bucket` with the AWS SDK's default credential chain (EKS Pod
 * Identity, IRSA, an instance role, `AWS_PROFILE`; never a configured key).
 * As on GCS, each object must not exist yet (`If-None-Match: *`); it carries
 * `x-amz-meta-da-generation: 1`, the generation the control plane records.
 * When the write loses to an existing object (a retried PUT that had in fact
 * landed), the object's own `da-generation` is the answer; an object without
 * one was not written by a deployer and fails the upload.
 *
 * The SDK is imported on first use, never for a GCS deploy.
 */
export function s3ArtifactStore(bucket: string, options: S3ArtifactStoreOptions): ArtifactStore {
    type Sdk = typeof import("@aws-sdk/client-s3")
    let loaded: Promise<{ sdk: Sdk; client: S3ClientLike }> | undefined
    const load = () =>
        (loaded ??= import("@aws-sdk/client-s3").then((sdk) => ({
            sdk,
            client:
                options.client ??
                new sdk.S3Client({
                    region: options.region,
                    endpoint: options.endpoint,
                    forcePathStyle: options.forcePathStyle,
                    // Non-AWS endpoints do not all accept the SDK's default CRC32
                    // trailers; only send checksums when the operation requires one.
                    ...(options.endpoint ? { requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" } : {}),
                }),
        })))
    return {
        async upload(objectName, bytes) {
            const { sdk, client } = await load()
            try {
                await client.send(
                    new sdk.PutObjectCommand({
                        Bucket: bucket,
                        Key: objectName,
                        Body: bytes,
                        ContentType: contentType(objectName),
                        IfNoneMatch: "*",
                        Metadata: { [S3_GENERATION_METADATA]: S3_GENERATION },
                    })
                )
                return { generation: S3_GENERATION }
            } catch (error) {
                if (!isAlreadyExists(error)) throw error
            }
            const head = await client.send(new sdk.HeadObjectCommand({ Bucket: bucket, Key: objectName }))
            const generation = head.Metadata?.[S3_GENERATION_METADATA]
            if (generation === undefined || generation === "")
                throw new Error(
                    `s3://${bucket}/${objectName} already exists without ${S3_GENERATION_METADATA} metadata; it was not uploaded by the deployer, so its generation is unknown`
                )
            return { generation }
        },
    }
}

/** The store `config` names, for a bundle in `bucket`. */
export function artifactStoreFor(bucket: string, config: ArtifactStoreConfig): ArtifactStore {
    return config.kind === "s3" ? s3ArtifactStore(bucket, config) : gcsArtifactStore(bucket)
}

/** How an object in `bucket` is named in log lines. */
export function objectUrl(config: ArtifactStoreConfig, bucket: string, objectName: string): string {
    return `${config.kind === "s3" ? "s3" : "gs"}://${bucket}/${objectName}`
}

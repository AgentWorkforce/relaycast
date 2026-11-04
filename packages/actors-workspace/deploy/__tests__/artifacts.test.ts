import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"
import { S3_GENERATION, type S3ClientLike, artifactStoreFor, objectUrl, s3ArtifactStore } from "../artifacts.ts"

interface StoredObject {
    bytes: Uint8Array
    contentType: string | undefined
    metadata: Record<string, string> | undefined
}

const s3Error = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

/**
 * An S3 bucket keyed by `<bucket>/<key>` that answers real command instances
 * and enforces `If-None-Match: *` the way S3 does (412 PreconditionFailed);
 * `conflict` makes the next conditional PUT answer 409 instead, as S3 does
 * for a concurrent conditional write.
 */
function fakeS3() {
    const objects = new Map<string, StoredObject>()
    const calls: string[] = []
    const puts: PutObjectCommand["input"][] = []
    let conflict = false
    const send = async (command: unknown): Promise<unknown> => {
        if (command instanceof PutObjectCommand) {
            const { Bucket, Key, Body, ContentType, Metadata, IfNoneMatch } = command.input
            const id = `${Bucket}/${Key}`
            calls.push(`put ${id}`)
            puts.push(command.input)
            if (conflict) {
                conflict = false
                throw s3Error("ConditionalRequestConflict", 409)
            }
            if (IfNoneMatch === "*" && objects.has(id)) throw s3Error("PreconditionFailed", 412)
            objects.set(id, { bytes: Body as Uint8Array, contentType: ContentType, metadata: Metadata })
            return { ETag: '"etag"' }
        }
        if (command instanceof HeadObjectCommand) {
            const id = `${command.input.Bucket}/${command.input.Key}`
            calls.push(`head ${id}`)
            const object = objects.get(id)
            if (!object) throw s3Error("NotFound", 404)
            return { ContentLength: object.bytes.byteLength, ContentType: object.contentType, Metadata: object.metadata }
        }
        throw new Error(`fake S3 client cannot answer ${(command as { constructor: { name: string } }).constructor.name}`)
    }
    return {
        objects,
        calls,
        puts,
        conflictNext: () => {
            conflict = true
        },
        client: { send: send as S3ClientLike["send"] },
    }
}

const OBJECT = "durable-actors/v3/artifacts/7d3b9a6e-9d1c-4f0a-8b58-2d6c4d7b2b61/actors.mjs"
const BYTES = new TextEncoder().encode("export const actors = {};")
const OPTIONS = { region: "us-east-1", forcePathStyle: false }

describe("s3ArtifactStore", () => {
    it("creates the object conditionally with da-generation metadata and reports generation 1", async () => {
        const fake = fakeS3()
        const store = s3ArtifactStore("acme-actors", { ...OPTIONS, client: fake.client })
        expect(await store.upload(OBJECT, BYTES)).toEqual({ generation: "1" })
        expect(S3_GENERATION).toBe("1")
        expect(fake.calls).toEqual([`put acme-actors/${OBJECT}`])
        expect(fake.puts[0]).toEqual({
            Bucket: "acme-actors",
            Key: OBJECT,
            Body: BYTES,
            ContentType: "text/javascript",
            IfNoneMatch: "*",
            Metadata: { "da-generation": "1" },
        })
        expect(fake.objects.get(`acme-actors/${OBJECT}`)).toEqual({ bytes: BYTES, contentType: "text/javascript", metadata: { "da-generation": "1" } })
    })

    it("uses the same content types as the GCS store", async () => {
        const fake = fakeS3()
        const store = s3ArtifactStore("b", { ...OPTIONS, client: fake.client })
        for (const name of ["a/x.json", "a/x.pyz", "a/x.bin"]) await store.upload(name, BYTES)
        expect(fake.puts.map((put) => put.ContentType)).toEqual(["application/json", "application/zip", "application/octet-stream"])
    })

    it("answers an existing object's da-generation after a 412", async () => {
        const fake = fakeS3()
        fake.objects.set(`acme-actors/${OBJECT}`, { bytes: BYTES, contentType: "text/javascript", metadata: { "da-generation": "1" } })
        const store = s3ArtifactStore("acme-actors", { ...OPTIONS, client: fake.client })
        expect(await store.upload(OBJECT, BYTES)).toEqual({ generation: "1" })
        expect(fake.calls).toEqual([`put acme-actors/${OBJECT}`, `head acme-actors/${OBJECT}`])
    })

    it("answers an existing object's da-generation after a 409 ConditionalRequestConflict", async () => {
        const fake = fakeS3()
        fake.objects.set(`acme-actors/${OBJECT}`, { bytes: BYTES, contentType: "text/javascript", metadata: { "da-generation": "7" } })
        fake.conflictNext()
        const store = s3ArtifactStore("acme-actors", { ...OPTIONS, client: fake.client })
        expect(await store.upload(OBJECT, BYTES)).toEqual({ generation: "7" })
        expect(fake.calls).toEqual([`put acme-actors/${OBJECT}`, `head acme-actors/${OBJECT}`])
    })

    it("fails clearly when the existing object has no da-generation metadata", async () => {
        const fake = fakeS3()
        fake.objects.set(`acme-actors/${OBJECT}`, { bytes: BYTES, contentType: "text/javascript", metadata: {} })
        const store = s3ArtifactStore("acme-actors", { ...OPTIONS, client: fake.client })
        await expect(store.upload(OBJECT, BYTES)).rejects.toThrow(
            `s3://acme-actors/${OBJECT} already exists without da-generation metadata; it was not uploaded by the deployer, so its generation is unknown`
        )
        fake.objects.set(`acme-actors/${OBJECT}`, { bytes: BYTES, contentType: "text/javascript", metadata: undefined })
        await expect(store.upload(OBJECT, BYTES)).rejects.toThrow("without da-generation metadata")
    })

    it("propagates any other S3 error without a HEAD", async () => {
        const send = async () => {
            throw s3Error("AccessDenied", 403)
        }
        const store = s3ArtifactStore("acme-actors", { ...OPTIONS, client: { send: send as S3ClientLike["send"] } })
        await expect(store.upload(OBJECT, BYTES)).rejects.toThrow("AccessDenied")
    })
})

describe("artifactStoreFor and objectUrl", () => {
    it("picks the store and the URL scheme from the config", () => {
        expect(artifactStoreFor("b", { kind: "s3", region: "us-east-1", forcePathStyle: false })).toHaveProperty("upload")
        expect(objectUrl({ kind: "s3", region: "us-east-1", forcePathStyle: false }, "b", "o/a.mjs")).toBe("s3://b/o/a.mjs")
        expect(objectUrl({ kind: "gcs" }, "b", "o/a.mjs")).toBe("gs://b/o/a.mjs")
    })
})

/**
 * Against a real S3-compatible server, only when one is named, e.g.:
 *   docker run -d -p 9000:9000 minio/minio server /data
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
 *   DURABLE_ACTORS_S3_TEST_ENDPOINT=http://127.0.0.1:9000 DURABLE_ACTORS_S3_TEST_BUCKET=artifacts npm test
 * The bucket must exist; credentials come from the SDK's default chain.
 */
const MINIO_ENDPOINT = process.env.DURABLE_ACTORS_S3_TEST_ENDPOINT
describe.skipIf(!MINIO_ENDPOINT)("s3ArtifactStore against an S3-compatible endpoint", () => {
    it("creates once, then answers the stored generation on a repeat upload", async () => {
        const bucket = process.env.DURABLE_ACTORS_S3_TEST_BUCKET ?? "artifacts"
        const store = s3ArtifactStore(bucket, { region: process.env.AWS_REGION ?? "us-east-1", endpoint: MINIO_ENDPOINT, forcePathStyle: true })
        const name = `durable-actors/v3/artifacts/${crypto.randomUUID()}/actors.mjs`
        expect(await store.upload(name, BYTES)).toEqual({ generation: "1" })
        expect(await store.upload(name, BYTES)).toEqual({ generation: "1" })
    })
})

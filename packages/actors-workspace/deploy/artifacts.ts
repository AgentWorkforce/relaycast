/**
 * Artifact uploads. The deployer only needs "put these bytes at this object
 * name and tell me the generation", so the GCS client stays behind
 * {@link ArtifactStore} and tests use an in-memory store.
 */
import { Storage } from "@google-cloud/storage"

export interface UploadedObject {
    /** The GCS object generation, as the client reports it (a decimal string). */
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

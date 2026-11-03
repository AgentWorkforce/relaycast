/**
 * Pure bundle arithmetic for a durable-actors deployment: artifact object
 * names, the base64url sha256 the control plane checks on install
 * (`src/bundle.rs`), the contract hash it records (`src/control_plane/contracts.rs`)
 * and the `PUT /v1/projects/{project}/deployment` body, which the server
 * parses with `deny_unknown_fields`.
 */
import { createHash } from "node:crypto"
import { z } from "zod"

/** Where the control plane expects compiled bundles (`src/bucket/access.rs`): `<prefix>/<uuid>/<path>`. */
export const DEFAULT_ARTIFACT_PREFIX = "durable-actors/v3/artifacts"

/** The compiled entrypoint; the only path the host loads from a bundle. */
export const ACTOR_ARTIFACT = "actors.mjs"

/** A file the compiler produced, keyed by its path inside the bundle. */
export interface ArtifactFile {
    path: string
    bytes: Uint8Array
}

/** An artifact file with the name and digest it gets in the bucket. */
export interface PlannedFile extends ArtifactFile {
    object: string
    sha256: string
}

/** `bundle.files[]` as the control plane stores it; `generation` is the GCS object generation. */
export const BundleFileSchema = z.strictObject({
    path: z.string().min(1),
    object: z.string().min(1),
    generation: z.number().int().positive(),
    sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "sha256 must be 32 bytes as unpadded base64url"),
})

const BundleSchema = z.strictObject({
    bucket: z.string().min(1).max(222).refine((bucket) => bucket.trim() === bucket && !bucket.includes("/"), "invalid storage bucket"),
    files: z.array(BundleFileSchema).min(1),
})

const LocalSourceSchema = z.strictObject({
    workingDirectory: z.string().startsWith("/").max(1024),
    actorEntrypoint: z.string().min(1).max(1024).optional(),
})

const SecretRefsSchema = z.array(z.string().min(1).max(255)).max(16)

/** `RegisterDeploymentRequest` (`src/control_plane/public_api.rs`): exactly one of `bundle` or `localSource`. */
export const DeploymentRequestSchema = z.strictObject({
    organizationId: z.string().min(1).max(64),
    bundle: BundleSchema.optional(),
    contract: z.record(z.string(), z.unknown()).optional(),
    localSource: LocalSourceSchema.optional(),
    secretRefs: SecretRefsSchema,
})

export type DeploymentRequest = z.infer<typeof DeploymentRequestSchema>
export type BundleFile = z.infer<typeof BundleFileSchema>

/** The 32-byte digest as unpadded base64url, the encoding `src/bundle.rs` compares on install. */
export function sha256Base64Url(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("base64url")
}

/**
 * The contract hash the control plane records: sha256 over the compact JSON
 * of the document with object keys sorted recursively (`canonical_json`).
 */
export function contractHash(contract: unknown): string {
    const digest = createHash("sha256").update(JSON.stringify(canonicalJson(contract))).digest("hex")
    return `sha256:${digest}`
}

function canonicalJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJson)
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
                .map(([key, entry]) => [key, canonicalJson(entry)])
        )
    }
    return value
}

/** `<prefix>/<deploymentId>/` with the prefix's surrounding slashes normalized. */
export function artifactPrefix(prefix: string, deploymentId: string): string {
    return `${prefix.replace(/^\/+|\/+$/g, "")}/${deploymentId}/`
}

/** The object name and digest of every compiled file under one artifact prefix. */
export function planArtifact(files: readonly ArtifactFile[], prefix: string, deploymentId: string): PlannedFile[] {
    const root = artifactPrefix(prefix, deploymentId)
    const paths = new Set<string>()
    const planned = files.map((file) => {
        if (!file.path || file.path.startsWith("/") || file.path.split("/").some((part) => part === "" || part === "." || part === ".."))
            throw new Error(`artifact path must stay inside the bundle: ${file.path}`)
        if (paths.has(file.path)) throw new Error(`duplicate artifact path: ${file.path}`)
        paths.add(file.path)
        return { ...file, object: `${root}${file.path}`, sha256: sha256Base64Url(file.bytes) }
    })
    if (planned.filter((file) => file.path === ACTOR_ARTIFACT).length !== 1)
        throw new Error(`the bundle must contain exactly one ${ACTOR_ARTIFACT}`)
    return planned
}

/** A GCS generation is an int64 the control plane reads as a JSON number; the client reports it as a string. */
export function parseGeneration(generation: string | number | undefined): number {
    const value = typeof generation === "string" ? Number(generation) : generation
    if (value === undefined || !Number.isSafeInteger(value) || value <= 0)
        throw new Error(`invalid object generation: ${String(generation)}`)
    return value
}

export interface BundleRequestInput {
    organizationId: string
    bucket: string
    files: readonly BundleFile[]
    contract: Record<string, unknown>
    secretRefs: readonly string[]
}

/** The hosted request: a compiled bundle plus its contract (a new bundle needs it) and the secret refs. */
export function bundleDeploymentRequest(input: BundleRequestInput): DeploymentRequest {
    return DeploymentRequestSchema.parse({
        organizationId: input.organizationId,
        bundle: { bucket: input.bucket, files: input.files.map((file) => ({ ...file })) },
        contract: input.contract,
        secretRefs: [...input.secretRefs],
    })
}

export interface LocalRequestInput {
    organizationId: string
    workingDirectory: string
    actorEntrypoint: string
}

/** The `durable-actors dev` request: the control plane compiles the sources itself and allows no secret refs. */
export function localDeploymentRequest(input: LocalRequestInput): DeploymentRequest {
    return DeploymentRequestSchema.parse({
        organizationId: input.organizationId,
        localSource: { workingDirectory: input.workingDirectory, actorEntrypoint: input.actorEntrypoint },
        secretRefs: [],
    })
}

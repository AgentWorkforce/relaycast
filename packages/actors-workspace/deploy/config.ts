/**
 * The deployer's configuration: its command from `argv`, everything else from
 * the environment. A bad value names the variable (never its content) and the
 * CLI exits with 64, like the gateway.
 */
import { z } from "zod"

import { DEFAULT_ARTIFACT_PREFIX } from "./bundle.ts"

export type Command = "deploy" | "local" | "status" | "delete"

export interface Options {
    command: Command
    dryRun: boolean
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "ConfigError"
    }
}

export const USAGE = `usage: deploy.ts [--dry-run] | --local [--dry-run] | --status | --delete

  (default)   compile the Workspace actor, upload the bundle to the artifact bucket
              and register it with the control plane
  --dry-run   compile and print the request body (no upload, no PUT; the files'
              generation is assigned by the upload and so is absent)
  --local     register this package as a localSource deployment with a
              \`durable-actors dev\` control plane (no bundle, no secret refs)
  --status    print the project's current deployment
  --delete    delete the project's deployment

environment:
  DURABLE_ACTORS_CONTROL_PLANE_URL   control plane origin (required)
  DURABLE_ACTORS_PROJECT_ID          project id (required)
  DURABLE_ACTORS_SECRET              admin key, sent as a bearer token (required unless --local)
  DURABLE_ACTORS_ORGANIZATION_ID     organization id (required for a bundle; "local" with --local)
  DURABLE_ACTORS_ARTIFACT_BUCKET     artifact bucket of the control plane (required for a bundle)
  DURABLE_ACTORS_SECRET_REFS         comma-separated Kubernetes Secret names for the actor's env (required for a bundle; at most 16)
  DURABLE_ACTORS_ARTIFACT_PREFIX     object prefix inside the bucket (default ${DEFAULT_ARTIFACT_PREFIX})
  DURABLE_ACTORS_ARTIFACT_STORE      gcs or s3: where the artifact bucket lives (default gcs)
  DURABLE_ACTORS_S3_REGION           the bucket's region (required for s3; falls back to AWS_REGION)
  DURABLE_ACTORS_S3_ENDPOINT         S3-compatible endpoint, e.g. MinIO (optional; unset for AWS)
  DURABLE_ACTORS_S3_FORCE_PATH_STYLE true or false: path-style bucket addressing (optional; default true with an endpoint)

  S3 credentials come from the AWS SDK's default chain (EKS Pod Identity, IRSA,
  instance role, AWS_PROFILE, ...); GCS uses Application Default Credentials.`

export function parseOptions(argv: readonly string[]): Options {
    let command: Command | undefined
    let dryRun = false
    for (const argument of argv) {
        switch (argument) {
            case "--dry-run":
                dryRun = true
                break
            case "--local":
            case "--status":
            case "--delete": {
                const next = argument.slice(2) as Command
                if (command && command !== next) throw new ConfigError(`--${command} and ${argument} are exclusive`)
                command = next
                break
            }
            default:
                throw new ConfigError(`unknown argument ${argument}`)
        }
    }
    command ??= "deploy"
    if (dryRun && (command === "status" || command === "delete")) throw new ConfigError(`--dry-run does not apply to --${command}`)
    return { command, dryRun }
}

const unsetIfBlank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value)
const optionalText = z.preprocess(unsetIfBlank, z.string().trim().optional())
const component = z.string().trim().min(1).max(64)

/** An http(s) origin: the deployer appends `/v1/projects/<id>/deployment`, and the gateway refuses anything else for the same variable. */
const origin = z.string().trim().refine((value) => {
    try {
        const url = new URL(value)
        // `URL` drops a bare trailing `?` or `#`, which the request path would land behind.
        return /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password && url.pathname === "/" && !/[?#]/.test(value)
    } catch {
        return false
    }
}, "must be an http(s) origin without credentials, path, query or fragment")

const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const region = z.string().trim().regex(REGION, "must be a region name such as us-east-1")

/** An http(s) S3 endpoint without credentials, query or fragment (static keys never go in config). */
const endpoint = z.string().trim().refine((value) => {
    try {
        const url = new URL(value)
        // `URL` drops a bare trailing `?` or `#`, so the raw value is checked too, as for the control plane origin.
        return /^https?:$/.test(url.protocol) && !!url.hostname && !url.username && !url.password && !/[?#]/.test(value)
    } catch {
        return false
    }
}, "must be an http(s) URL without credentials, query or fragment")

const EnvSchema = z.object({
    DURABLE_ACTORS_CONTROL_PLANE_URL: z.preprocess(unsetIfBlank, origin),
    DURABLE_ACTORS_PROJECT_ID: z.preprocess(unsetIfBlank, component),
    DURABLE_ACTORS_SECRET: z.preprocess(unsetIfBlank, z.string().refine((secret) => secret.trim() === secret, "has surrounding whitespace").optional()),
    DURABLE_ACTORS_ORGANIZATION_ID: z.preprocess(unsetIfBlank, component.optional()),
    DURABLE_ACTORS_ARTIFACT_BUCKET: z.preprocess(
        unsetIfBlank,
        z.string().trim().min(1).max(222).refine((bucket) => !bucket.includes("/"), "must be a bucket name, not a path").optional()
    ),
    DURABLE_ACTORS_SECRET_REFS: optionalText,
    DURABLE_ACTORS_ARTIFACT_PREFIX: z.preprocess(
        unsetIfBlank,
        z.string().trim().min(1).refine((prefix) => !/^\/|\/$|\/\//.test(prefix), "must be a relative object prefix").optional()
    ),
    DURABLE_ACTORS_ARTIFACT_STORE: z.preprocess(unsetIfBlank, z.enum(["gcs", "s3"]).optional()),
    DURABLE_ACTORS_S3_REGION: z.preprocess(unsetIfBlank, region.optional()),
    // Only read as the S3 region's fallback, so a value the deployer never uses cannot fail a GCS deploy.
    AWS_REGION: optionalText,
    DURABLE_ACTORS_S3_ENDPOINT: z.preprocess(unsetIfBlank, endpoint.optional()),
    DURABLE_ACTORS_S3_FORCE_PATH_STYLE: z.preprocess(unsetIfBlank, z.enum(["true", "false"]).optional()),
})

/** A DNS subdomain name, as Kubernetes requires of a Secret's name. */
function isKubernetesSecretName(name: string): boolean {
    return name.length <= 253 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/.test(name)
}

export interface ConnectionConfig {
    controlPlaneUrl: string
    projectId: string
    secret: string | undefined
}

/** Where the artifact bucket lives. Credentials are never configured here: GCS uses ADC, S3 the AWS SDK's default chain. */
export type ArtifactStoreConfig =
    | { kind: "gcs" }
    | {
          kind: "s3"
          region: string
          /** An S3-compatible endpoint (MinIO); unset for AWS. */
          endpoint?: string
          forcePathStyle: boolean
      }

export interface BundleConfig extends ConnectionConfig {
    organizationId: string
    bucket: string
    secretRefs: string[]
    artifactPrefix: string
    artifactStore: ArtifactStoreConfig
}

export interface LocalConfig extends ConnectionConfig {
    organizationId: string
}

function parseEnv(env: Record<string, string | undefined>, requireSecret: boolean): z.infer<typeof EnvSchema> {
    const parsed = EnvSchema.safeParse(env)
    if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`)
        throw new ConfigError(`invalid configuration: ${problems.join("; ")}`)
    }
    if (requireSecret && parsed.data.DURABLE_ACTORS_SECRET === undefined) throw new ConfigError("DURABLE_ACTORS_SECRET is not set")
    return parsed.data
}

function connection(values: z.infer<typeof EnvSchema>): ConnectionConfig {
    return {
        controlPlaneUrl: values.DURABLE_ACTORS_CONTROL_PLANE_URL,
        projectId: values.DURABLE_ACTORS_PROJECT_ID,
        secret: values.DURABLE_ACTORS_SECRET,
    }
}

/** `--status` and `--delete`: the connection plus the admin key. */
export function connectionConfigFromEnv(env: Record<string, string | undefined>): ConnectionConfig {
    return connection(parseEnv(env, true))
}

/** The default command: a compiled bundle in the artifact bucket. */
export function bundleConfigFromEnv(env: Record<string, string | undefined>): BundleConfig {
    const values = parseEnv(env, true)
    const missing = (["DURABLE_ACTORS_ORGANIZATION_ID", "DURABLE_ACTORS_ARTIFACT_BUCKET"] as const).filter((name) => values[name] === undefined)
    if (missing.length > 0) throw new ConfigError(`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} required for a bundle deployment`)
    const secretRefs = (values.DURABLE_ACTORS_SECRET_REFS ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
    // Checked here so a bad value fails before anything is compiled or
    // uploaded: the actor needs RELAYCAST_PUBLIC_URL and
    // RELAYCAST_FILE_SIGNING_SECRET from at least one Secret, and each name
    // must be a Kubernetes Secret name (a DNS subdomain), which the request
    // schema's 255-character limit alone does not guarantee.
    if (secretRefs.length === 0)
        throw new ConfigError("DURABLE_ACTORS_SECRET_REFS is required for a bundle deployment (the actor's environment comes from those Secrets)")
    if (secretRefs.length > 16) throw new ConfigError("DURABLE_ACTORS_SECRET_REFS allows at most 16 names")
    if (secretRefs.some((name) => !isKubernetesSecretName(name)))
        throw new ConfigError("DURABLE_ACTORS_SECRET_REFS names must be Kubernetes Secret names: at most 253 lowercase alphanumerics, '-' or '.', starting and ending with an alphanumeric")
    if (new Set(secretRefs).size !== secretRefs.length) throw new ConfigError("DURABLE_ACTORS_SECRET_REFS repeats a name")
    return {
        ...connection(values),
        organizationId: values.DURABLE_ACTORS_ORGANIZATION_ID!,
        bucket: values.DURABLE_ACTORS_ARTIFACT_BUCKET!,
        secretRefs,
        artifactPrefix: values.DURABLE_ACTORS_ARTIFACT_PREFIX ?? DEFAULT_ARTIFACT_PREFIX,
        artifactStore: artifactStoreConfig(values),
    }
}

/** S3's general purpose bucket naming rules (the checks that would otherwise fail only at upload). */
function isS3BucketName(name: string): boolean {
    return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) && !name.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(name)
}

function artifactStoreConfig(values: z.infer<typeof EnvSchema>): ArtifactStoreConfig {
    const s3Settings = (["DURABLE_ACTORS_S3_REGION", "DURABLE_ACTORS_S3_ENDPOINT", "DURABLE_ACTORS_S3_FORCE_PATH_STYLE"] as const).filter(
        (name) => values[name] !== undefined
    )
    if ((values.DURABLE_ACTORS_ARTIFACT_STORE ?? "gcs") === "gcs") {
        // A half-configured S3 setup would otherwise upload to GCS without a word.
        if (s3Settings.length > 0) throw new ConfigError(`${s3Settings.join(", ")} need DURABLE_ACTORS_ARTIFACT_STORE=s3`)
        return { kind: "gcs" }
    }
    if (!isS3BucketName(values.DURABLE_ACTORS_ARTIFACT_BUCKET!))
        throw new ConfigError(
            "DURABLE_ACTORS_ARTIFACT_BUCKET must be an S3 bucket name: 3-63 lowercase letters, digits, '.' or '-', starting and ending with a letter or digit, without '..' or the form of an IP address"
        )
    const s3Region = values.DURABLE_ACTORS_S3_REGION ?? values.AWS_REGION
    if (s3Region === undefined) throw new ConfigError("DURABLE_ACTORS_S3_REGION (or AWS_REGION) is required for DURABLE_ACTORS_ARTIFACT_STORE=s3")
    if (!REGION.test(s3Region)) throw new ConfigError("AWS_REGION must be a region name such as us-east-1")
    const s3Endpoint = values.DURABLE_ACTORS_S3_ENDPOINT
    const forcePathStyle =
        values.DURABLE_ACTORS_S3_FORCE_PATH_STYLE === undefined ? s3Endpoint !== undefined : values.DURABLE_ACTORS_S3_FORCE_PATH_STYLE === "true"
    return { kind: "s3", region: s3Region, ...(s3Endpoint === undefined ? {} : { endpoint: s3Endpoint }), forcePathStyle }
}

/** `--local`: the dev control plane compiles the sources itself and runs as organization `local`. */
export function localConfigFromEnv(env: Record<string, string | undefined>): LocalConfig {
    const values = parseEnv(env, false)
    if (values.DURABLE_ACTORS_SECRET_REFS !== undefined) throw new ConfigError("DURABLE_ACTORS_SECRET_REFS is unavailable in local mode")
    // The dev control plane runs one organization, `local`; any other value would be refused at registration.
    if (values.DURABLE_ACTORS_ORGANIZATION_ID !== undefined && values.DURABLE_ACTORS_ORGANIZATION_ID !== "local")
        throw new ConfigError('DURABLE_ACTORS_ORGANIZATION_ID must be "local" (or unset) in local mode')
    return { ...connection(values), organizationId: "local" }
}

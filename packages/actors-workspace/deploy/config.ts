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
  DURABLE_ACTORS_ARTIFACT_BUCKET     GCS artifact bucket of the control plane (required for a bundle)
  DURABLE_ACTORS_SECRET_REFS         comma-separated Kubernetes Secret names for the actor's env (at most 16)
  DURABLE_ACTORS_ARTIFACT_PREFIX     object prefix inside the bucket (default ${DEFAULT_ARTIFACT_PREFIX})`

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

const EnvSchema = z.object({
    DURABLE_ACTORS_CONTROL_PLANE_URL: z.preprocess(unsetIfBlank, z.url().trim()),
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
})

export interface ConnectionConfig {
    controlPlaneUrl: string
    projectId: string
    secret: string | undefined
}

export interface BundleConfig extends ConnectionConfig {
    organizationId: string
    bucket: string
    secretRefs: string[]
    artifactPrefix: string
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
    if (secretRefs.length > 16) throw new ConfigError("DURABLE_ACTORS_SECRET_REFS allows at most 16 names")
    if (new Set(secretRefs).size !== secretRefs.length) throw new ConfigError("DURABLE_ACTORS_SECRET_REFS repeats a name")
    return {
        ...connection(values),
        organizationId: values.DURABLE_ACTORS_ORGANIZATION_ID!,
        bucket: values.DURABLE_ACTORS_ARTIFACT_BUCKET!,
        secretRefs,
        artifactPrefix: values.DURABLE_ACTORS_ARTIFACT_PREFIX ?? DEFAULT_ARTIFACT_PREFIX,
    }
}

/** `--local`: the dev control plane compiles the sources itself and runs as organization `local`. */
export function localConfigFromEnv(env: Record<string, string | undefined>): LocalConfig {
    const values = parseEnv(env, false)
    if (values.DURABLE_ACTORS_SECRET_REFS !== undefined) throw new ConfigError("DURABLE_ACTORS_SECRET_REFS is unavailable in local mode")
    return { ...connection(values), organizationId: values.DURABLE_ACTORS_ORGANIZATION_ID ?? "local" }
}

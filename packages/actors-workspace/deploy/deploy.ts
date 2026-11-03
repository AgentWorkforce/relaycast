#!/usr/bin/env bun
/**
 * Deploys the relaycast Workspace actor to a self-hosted durable-actors
 * control plane: compile with the SDK compiler, upload the bundle to the
 * artifact bucket, register it with `PUT /v1/projects/{project}/deployment`.
 * Run with Bun (the SDK compiler targets Bun; Node 22 works too):
 *
 *   bun packages/actors-workspace/deploy/deploy.ts [--dry-run|--local|--status|--delete]
 */
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { type ArtifactStore, gcsArtifactStore } from "./artifacts.ts"
import {
    type BundleFile,
    artifactPrefix,
    bundleDeploymentRequest,
    contractHash,
    localDeploymentRequest,
    parseGeneration,
    planArtifact,
} from "./bundle.ts"
import { type ActorCompiler, compileActor } from "./compile.ts"
import {
    ConfigError,
    USAGE,
    bundleConfigFromEnv,
    connectionConfigFromEnv,
    localConfigFromEnv,
    parseOptions,
} from "./config.ts"
import { ControlPlaneError, DeploymentClient } from "./control-plane.ts"

/** The actor project: this package, with `src/actors.ts` as its entrypoint (what `durable-actors dev` resolves). */
export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const ACTOR_ENTRYPOINT = "src/actors.ts"

/** The dev control plane compiles inside the PUT; the SDK's own client allows it 150 s. */
const LOCAL_REGISTER_TIMEOUT_MS = 150_000

export const EXIT_USAGE = 64

export interface Dependencies {
    compile?: ActorCompiler
    artifactStore?: (bucket: string) => ArtifactStore
    fetch?: typeof fetch
    deploymentId?: () => string
    delay?: (attempt: number) => Promise<void>
    stdout?: (line: string) => void
    stderr?: (line: string) => void
    packageDir?: string
}

/** Runs the CLI and returns its exit code; `main` applies it to the process. */
export async function run(argv: readonly string[], env: Record<string, string | undefined>, deps: Dependencies = {}): Promise<number> {
    const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`))
    const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`))
    if (argv.includes("--help") || argv.includes("-h")) {
        stdout(USAGE)
        return 0
    }
    try {
        const options = parseOptions(argv)
        const client = (config: { controlPlaneUrl: string; projectId: string; secret: string | undefined }) =>
            new DeploymentClient({ ...config, fetch: deps.fetch, delay: deps.delay })
        switch (options.command) {
            case "status": {
                stdout(JSON.stringify(await client(connectionConfigFromEnv(env)).current()))
                return 0
            }
            case "delete": {
                stdout(JSON.stringify(await client(connectionConfigFromEnv(env)).delete()))
                return 0
            }
            case "local": {
                const config = localConfigFromEnv(env)
                const request = localDeploymentRequest({
                    organizationId: config.organizationId,
                    workingDirectory: realpathSync(deps.packageDir ?? PACKAGE_DIR),
                    actorEntrypoint: ACTOR_ENTRYPOINT,
                })
                if (options.dryRun) {
                    stdout(JSON.stringify({ dry_run: true, request }))
                    return 0
                }
                const { changed } = await client(config).register(request, LOCAL_REGISTER_TIMEOUT_MS)
                stdout(JSON.stringify({ changed, local_source: request.localSource }))
                return 0
            }
            case "deploy": {
                const config = bundleConfigFromEnv(env)
                const packageDir = deps.packageDir ?? PACKAGE_DIR
                stderr(`compiling ${path.join(packageDir, ACTOR_ENTRYPOINT)}`)
                const compiled = await (deps.compile ?? compileActor)(packageDir, ACTOR_ENTRYPOINT)
                const deploymentId = (deps.deploymentId ?? randomUUID)()
                const planned = planArtifact(compiled.files, config.artifactPrefix, deploymentId)
                const prefix = artifactPrefix(config.artifactPrefix, deploymentId)
                const summaryFiles = planned.map(({ path: filePath, object, sha256 }) => ({ path: filePath, object, sha256 }))
                const hash = contractHash(compiled.contract)
                if (options.dryRun) {
                    // The request as it will be sent, except that each file's generation comes from the upload.
                    const request = {
                        organizationId: config.organizationId,
                        bundle: { bucket: config.bucket, files: summaryFiles },
                        contract: compiled.contract,
                        secretRefs: config.secretRefs,
                    }
                    stdout(JSON.stringify({ dry_run: true, artifact_prefix: prefix, files: summaryFiles, contract_hash: hash, request }))
                    return 0
                }
                const store = (deps.artifactStore ?? gcsArtifactStore)(config.bucket)
                const files: BundleFile[] = []
                for (const file of planned) {
                    stderr(`uploading gs://${config.bucket}/${file.object} (${file.bytes.byteLength} bytes)`)
                    const { generation } = await store.upload(file.object, file.bytes)
                    files.push({ path: file.path, object: file.object, generation: parseGeneration(generation), sha256: file.sha256 })
                }
                const request = bundleDeploymentRequest({
                    organizationId: config.organizationId,
                    bucket: config.bucket,
                    files,
                    contract: compiled.contract,
                    secretRefs: config.secretRefs,
                })
                const { changed } = await client(config).register(request)
                stdout(JSON.stringify({ changed, artifact_prefix: prefix, files: summaryFiles, contract_hash: hash }))
                return 0
            }
        }
    } catch (error) {
        if (error instanceof ConfigError) {
            stderr(`deploy: ${error.message}`)
            return EXIT_USAGE
        }
        if (error instanceof ControlPlaneError) {
            stderr(`deploy: control plane ${error.status ? `${error.status} ${error.code}` : error.code}: ${error.message}`)
            return 1
        }
        stderr(`deploy: ${error instanceof Error ? error.message : String(error)}`)
        return 1
    }
}

async function main(): Promise<void> {
    process.exitCode = await run(process.argv.slice(2), process.env)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

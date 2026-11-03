/**
 * Compiles the Workspace actor with the SDK's own compiler, the way the
 * control plane's local build does (`src/control_plane/local_build.rs`): the
 * modules are not in the package's `exports`, so they are resolved relative to
 * `durable-actors/host` and loaded by URL. The hosted build keeps
 * `durable-actors` external (the runtime image provides it) and emits one
 * `actors.mjs`, which is the whole bundle.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { ACTOR_ARTIFACT, type ArtifactFile } from "./bundle.ts"

export interface CompiledActor {
    files: ArtifactFile[]
    contract: Record<string, unknown>
}

export type ActorCompiler = (packageDir: string, entrypoint: string) => Promise<CompiledActor>

interface SdkBuild {
    buildActor(entrypoint: string, outfile: string, options?: { configFile?: string; local?: boolean }): Promise<unknown>
}

interface SdkValidate {
    parsePublicContract(input: unknown): Record<string, unknown>
}

function sdkModule(file: string): string {
    return new URL(`compiler/${file}`, import.meta.resolve("durable-actors/host")).href
}

/** Builds `<packageDir>/<entrypoint>` into a temporary directory and returns its bytes and validated contract. */
export const compileActor: ActorCompiler = async (packageDir, entrypoint) => {
    const { buildActor } = (await import(sdkModule("actor-build.js"))) as SdkBuild
    const { parsePublicContract } = (await import(sdkModule("validate-public-contract.js"))) as SdkValidate
    const output = await mkdtemp(path.join(tmpdir(), "relaycast-actor-build-"))
    try {
        const artifact = path.join(output, ACTOR_ARTIFACT)
        const contract = parsePublicContract(
            await buildActor(path.resolve(packageDir, entrypoint), artifact, {
                configFile: path.join(packageDir, "tsconfig.json"),
            })
        )
        const bytes = await readFile(artifact)
        if (bytes.byteLength === 0) throw new Error("compiled actor code is empty")
        return { files: [{ path: ACTOR_ARTIFACT, bytes }], contract }
    } finally {
        await rm(output, { recursive: true, force: true })
    }
}

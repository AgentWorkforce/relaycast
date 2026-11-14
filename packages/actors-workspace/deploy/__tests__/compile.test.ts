import { describe, expect, it } from "vitest"
import { compileActor } from "../compile.ts"
import { ACTOR_ENTRYPOINT, PACKAGE_DIR } from "../deploy.ts"

interface Contract {
    version: number
    actors: Array<{
        actorName: string
        rpc: { methods: Array<{ name: string; parameters: unknown[]; result: { kind: string } }> }
        socket: { actorName: string; emittable: string[]; schema: { definitions: Record<string, unknown> } }
    }>
}

// The SDK compiler (TypeScript program + esbuild, both from node_modules; no network, no native durable-actors binary).
describe("compileActor", () => {
    it("compiles the Workspace actor into one actors.mjs with its public contract", { timeout: 120_000 }, async () => {
        const compiled = await compileActor(PACKAGE_DIR, ACTOR_ENTRYPOINT)
        expect(compiled.files.map((file) => file.path)).toEqual(["actors.mjs"])
        const source = new TextDecoder().decode(compiled.files[0]!.bytes)
        expect(source.length).toBeGreaterThan(0)
        // The host image provides the SDK: the bundle imports it by name instead of inlining this checkout's copy.
        expect(source).toMatch(/from "durable-actors"/)
        expect(source).not.toContain("node_modules/durable-actors")
        expect(source).toContain("export {")

        const contract = compiled.contract as unknown as Contract
        expect(contract.version).toBe(1)
        expect(contract.actors.map((actor) => actor.actorName)).toEqual(["Workspace"])
        const [workspace] = contract.actors
        expect(workspace!.rpc.methods.map((method) => [method.name, method.parameters.length, method.result.kind])).toEqual([
            ["create", 2, "value"],
            ["fileStored", 2, "value"],
            ["handle", 1, "value"],
            ["importData", 2, "value"],
        ])
        // The socket lifecycle (onConnect/onMessage/onDisconnect) is described by the socket contract, never as RPC.
        expect(workspace!.socket.actorName).toBe("Workspace")
        expect(Object.keys(workspace!.socket.schema.definitions)).toEqual(expect.arrayContaining(["Metadata", "Incoming", "Outgoing", "State"]))
        expect(workspace!.socket.emittable).toEqual([])
    })
})

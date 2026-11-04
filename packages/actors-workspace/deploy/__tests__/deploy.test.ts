import { createServer, type IncomingMessage, type Server } from "node:http"
import { realpathSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ArtifactStore } from "../artifacts.ts"
import type { ArtifactStoreConfig } from "../config.ts"
import { sha256Base64Url } from "../bundle.ts"
import type { CompiledActor } from "../compile.ts"
import { EXIT_USAGE, PACKAGE_DIR, run } from "../deploy.ts"

interface Seen {
    method: string
    url: string
    headers: IncomingMessage["headers"]
    body: unknown
}

type Reply = { status: number; body: unknown; raw?: string; cut?: boolean }

/** A control plane that records every request and answers from a queue (the last reply repeats). */
class FakeControlPlane {
    readonly requests: Seen[] = []
    readonly replies: Reply[] = []
    private server!: Server
    url = ""

    async start(): Promise<void> {
        this.server = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on("data", (chunk: Buffer) => chunks.push(chunk))
            request.on("end", () => {
                const text = Buffer.concat(chunks).toString()
                this.requests.push({ method: request.method!, url: request.url!, headers: request.headers, body: text ? JSON.parse(text) : undefined })
                const reply = this.replies.length > 1 ? this.replies.shift()! : (this.replies[0] ?? { status: 200, body: { changed: true } })
                response.writeHead(reply.status, { "content-type": "application/json" })
                if (reply.cut) {
                    // Headers and part of the body reach the client, then the connection drops.
                    response.flushHeaders()
                    response.write('{"chan', () => setTimeout(() => response.destroy(), 20))
                    return
                }
                response.end(reply.raw ?? JSON.stringify(reply.body))
            })
        })
        await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
        const address = this.server.address()
        if (typeof address !== "object" || !address) throw new Error("no address")
        this.url = `http://127.0.0.1:${address.port}`
    }

    async stop(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
    }
}

const UUID = "7d3b9a6e-9d1c-4f0a-8b58-2d6c4d7b2b61"
const ACTOR_BYTES = new TextEncoder().encode('import { Actor } from "durable-actors"; export const actors = {};')
const CONTRACT = { version: 1, typescript: { declarations: "export {}", dependencies: {} }, actors: [{ actorName: "Workspace" }] }

const compile = async (): Promise<CompiledActor> => ({ files: [{ path: "actors.mjs", bytes: ACTOR_BYTES }], contract: CONTRACT })

class MemoryArtifacts implements ArtifactStore {
    readonly objects = new Map<string, Uint8Array>()
    readonly bucket: string
    readonly config: ArtifactStoreConfig
    constructor(bucket: string, config: ArtifactStoreConfig) {
        this.bucket = bucket
        this.config = config
    }
    async upload(objectName: string, bytes: Uint8Array) {
        this.objects.set(objectName, bytes)
        return { generation: `17610000000000${this.objects.size}` }
    }
}

describe("deploy.ts", () => {
    const plane = new FakeControlPlane()
    let stores: MemoryArtifacts[]
    let out: string[]
    let err: string[]
    let env: Record<string, string>
    const delay = async () => {}

    const invoke = (argv: string[], overrides: Record<string, string | undefined> = {}) =>
        run(argv, { ...env, ...overrides }, {
            compile,
            artifactStore: (bucket, config) => {
                const store = new MemoryArtifacts(bucket, config)
                stores.push(store)
                return store
            },
            deploymentId: () => UUID,
            delay,
            stdout: (line) => out.push(line),
            stderr: (line) => err.push(line),
        })

    beforeEach(async () => {
        await plane.start()
        plane.requests.length = 0
        plane.replies.length = 0
        stores = []
        out = []
        err = []
        env = {
            DURABLE_ACTORS_CONTROL_PLANE_URL: plane.url,
            DURABLE_ACTORS_SECRET: "admin-key",
            DURABLE_ACTORS_PROJECT_ID: "relaycast",
            DURABLE_ACTORS_ORGANIZATION_ID: "acme",
            DURABLE_ACTORS_ARTIFACT_BUCKET: "acme-actors",
            DURABLE_ACTORS_SECRET_REFS: "relaycast-actor-env",
        }
    })

    afterEach(() => plane.stop())

    it("compiles, uploads under a fresh artifact prefix and registers the bundle with its contract", async () => {
        expect(await invoke([])).toBe(0)
        const object = `durable-actors/v3/artifacts/${UUID}/actors.mjs`
        expect(stores).toHaveLength(1)
        expect(stores[0]!.bucket).toBe("acme-actors")
        expect([...stores[0]!.objects.keys()]).toEqual([object])
        expect(plane.requests).toHaveLength(1)
        const [request] = plane.requests
        expect(request!.method).toBe("PUT")
        expect(request!.url).toBe("/v1/projects/relaycast/deployment")
        expect(request!.headers.authorization).toBe("Bearer admin-key")
        expect(request!.headers["content-type"]).toBe("application/json")
        expect(request!.body).toEqual({
            organizationId: "acme",
            bundle: { bucket: "acme-actors", files: [{ path: "actors.mjs", object, generation: 176100000000001, sha256: sha256Base64Url(ACTOR_BYTES) }] },
            contract: CONTRACT,
            secretRefs: ["relaycast-actor-env"],
        })
        expect(Object.keys(request!.body as object)).toEqual(["organizationId", "bundle", "contract", "secretRefs"])
        expect(JSON.parse(out[0]!)).toEqual({
            changed: true,
            artifact_prefix: `durable-actors/v3/artifacts/${UUID}/`,
            files: [{ path: "actors.mjs", object, sha256: sha256Base64Url(ACTOR_BYTES) }],
            contract_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        })
        expect(err.join("\n")).not.toContain("admin-key")
    })

    it("uploads through the S3 store when DURABLE_ACTORS_ARTIFACT_STORE=s3", async () => {
        expect(await invoke([], { DURABLE_ACTORS_ARTIFACT_STORE: "s3", AWS_REGION: "us-west-2" })).toBe(0)
        expect(stores[0]!.config).toEqual({ kind: "s3", region: "us-west-2", forcePathStyle: false })
        expect(err).toContain(`uploading s3://acme-actors/durable-actors/v3/artifacts/${UUID}/actors.mjs (${ACTOR_BYTES.byteLength} bytes)`)
        expect(plane.requests).toHaveLength(1)
    })

    it("--dry-run compiles and prints the request without uploading or registering", async () => {
        expect(await invoke(["--dry-run"])).toBe(0)
        expect(stores).toHaveLength(0)
        expect(plane.requests).toHaveLength(0)
        const summary = JSON.parse(out[0]!)
        expect(summary.dry_run).toBe(true)
        expect(summary.request).toEqual({
            organizationId: "acme",
            bundle: { bucket: "acme-actors", files: [{ path: "actors.mjs", object: `durable-actors/v3/artifacts/${UUID}/actors.mjs`, sha256: sha256Base64Url(ACTOR_BYTES) }] },
            contract: CONTRACT,
            secretRefs: ["relaycast-actor-env"],
        })
    })

    it("--local registers this package as a localSource without secret refs or an admin key", async () => {
        expect(await invoke(["--local"], { DURABLE_ACTORS_SECRET: undefined, DURABLE_ACTORS_SECRET_REFS: undefined, DURABLE_ACTORS_ORGANIZATION_ID: undefined })).toBe(0)
        const [request] = plane.requests
        expect(request!.method).toBe("PUT")
        expect(request!.headers.authorization).toBeUndefined()
        expect(request!.body).toEqual({
            organizationId: "local",
            localSource: { workingDirectory: realpathSync(PACKAGE_DIR), actorEntrypoint: "src/actors.ts" },
            secretRefs: [],
        })
        expect(JSON.parse(out[0]!)).toEqual({ changed: true, local_source: { workingDirectory: realpathSync(PACKAGE_DIR), actorEntrypoint: "src/actors.ts" } })
    })

    it("--status prints the current deployment and --delete deletes it", async () => {
        const current = { organizationId: "acme", bundle: { bucket: "acme-actors", files: [] }, secretRefs: [] }
        plane.replies.push({ status: 200, body: current })
        expect(await invoke(["--status"])).toBe(0)
        expect(plane.requests[0]).toMatchObject({ method: "GET", url: "/v1/projects/relaycast/deployment", body: undefined })
        expect(plane.requests[0]!.headers.authorization).toBe("Bearer admin-key")
        expect(JSON.parse(out[0]!)).toEqual(current)

        plane.replies.length = 0
        plane.replies.push({ status: 200, body: { changed: false } })
        expect(await invoke(["--delete"])).toBe(0)
        expect(plane.requests[1]).toMatchObject({ method: "DELETE", url: "/v1/projects/relaycast/deployment" })
        expect(JSON.parse(out[1]!)).toEqual({ changed: false })
    })

    it("reports the control plane's error code and message without retrying a 4xx", async () => {
        plane.replies.push({ status: 400, body: { error: { code: "invalid_request", message: "a new bundle requires its actor contract" } } })
        expect(await invoke([])).toBe(1)
        expect(plane.requests).toHaveLength(1)
        expect(err.at(-1)).toBe("deploy: control plane 400 invalid_request: a new bundle requires its actor contract")
        expect(out).toHaveLength(0)

        plane.replies.length = 0
        plane.replies.push({ status: 404, body: { error: { code: "not_found", message: "deployment not found" } } })
        expect(await invoke(["--status"])).toBe(1)
        expect(err.at(-1)).toBe("deploy: control plane 404 not_found: deployment not found")
    })

    it("retries a 5xx with backoff and then succeeds", async () => {
        plane.replies.push({ status: 503, body: { error: { code: "unavailable", message: "later" } } }, { status: 502, body: "bad gateway" }, { status: 200, body: { changed: true } })
        expect(await invoke([])).toBe(0)
        expect(plane.requests.map((request) => request.method)).toEqual(["PUT", "PUT", "PUT"])
        expect(JSON.parse(out[0]!).changed).toBe(true)
    })

    it("does not retry a 2xx whose body is not JSON", async () => {
        plane.replies.push({ status: 200, body: undefined, raw: "<html>not json</html>" })
        expect(await invoke(["--status"])).toBe(1)
        expect(plane.requests.map((request) => request.method)).toEqual(["GET"])
        expect(err.at(-1)).toMatch(/^deploy: control plane 200 malformed_response: GET .* answered 200 with a body that is not JSON$/)
    })

    it("does not retry a 2xx whose body could not be read, and keeps the status of a 4xx whose body was lost", async () => {
        plane.replies.push({ status: 200, body: undefined, cut: true })
        expect(await invoke([])).toBe(1)
        expect(plane.requests.map((request) => request.method)).toEqual(["PUT"])
        expect(err.at(-1)).toMatch(/^deploy: control plane 200 unreadable_response: PUT .* answered 200 with a body that could not be read/)
        plane.requests.length = 0
        plane.replies.length = 0
        plane.replies.push({ status: 404, body: undefined, cut: true })
        expect(await invoke(["--status"])).toBe(1)
        expect(plane.requests.map((request) => request.method)).toEqual(["GET"])
        expect(err.at(-1)).toBe("deploy: control plane 404 http_404: HTTP 404")
    })

    it("gives up on a persistent 5xx and on an unreachable control plane", async () => {
        plane.replies.push({ status: 500, body: { error: { code: "internal", message: "boom" } } })
        expect(await invoke(["--delete"])).toBe(1)
        expect(plane.requests).toHaveLength(4)
        expect(err.at(-1)).toBe("deploy: control plane 500 internal: boom")

        await plane.stop()
        expect(await invoke(["--status"])).toBe(1)
        expect(err.at(-1)).toMatch(/^deploy: control plane unreachable: GET http:\/\/127\.0\.0\.1:\d+\/v1\/projects\/relaycast\/deployment failed: /)
        await plane.start()
    })

    it("exits 64 with one line on bad configuration, before compiling or connecting", async () => {
        expect(await invoke([], { DURABLE_ACTORS_ARTIFACT_BUCKET: undefined })).toBe(EXIT_USAGE)
        expect(err).toEqual(["deploy: DURABLE_ACTORS_ARTIFACT_BUCKET is required for a bundle deployment"])
        expect(await invoke(["--status", "--delete"])).toBe(EXIT_USAGE)
        expect(await invoke([], { DURABLE_ACTORS_SECRET: undefined })).toBe(EXIT_USAGE)
        expect(err.at(-1)).toBe("deploy: DURABLE_ACTORS_SECRET is not set")
        expect(plane.requests).toHaveLength(0)
        expect(stores).toHaveLength(0)
    })
})

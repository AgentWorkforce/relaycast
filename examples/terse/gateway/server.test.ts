import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspaceIdSigner, signFileToken } from "@relaycast/engine/gateway"

const SECRET = "test-secret"
let dir: string
let serveFile: (request: Request) => Promise<Response>
let handleRequest: (request: Request) => Promise<Response>

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "relaycast-gateway-"))
    process.env.RELAYCAST_FILE_SIGNING_SECRET = SECRET
    process.env.RELAYCAST_FILE_DIR = dir
    process.env.RELAYCAST_WORKSPACE_ID_KEYRING = JSON.stringify({ current: "a", keys: { a: "test-workspace-id-secret" } })
    ;({ serveFile, handleRequest } = await import("./server.js"))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

function chunked(...parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part))
            controller.close()
        },
    })
}

async function put(key: string, size: number, body: BodyInit, headers: Record<string, string> = {}) {
    const exp = Math.floor(Date.now() / 1000) + 60
    const token = await signFileToken(SECRET, { key, op: "put", exp, size, type: "text/plain" })
    return serveFile(new Request(`http://gateway/_relayfiles?token=${token}`, {
        method: "PUT",
        headers: { "content-type": "text/plain", ...headers },
        body,
    }))
}

describe("/_relayfiles uploads", () => {
    it("accept a chunked body without Content-Length at the signed size", async () => {
        const response = await put("w/f1/f1.txt", 10, chunked("hello", "world"))
        expect(response.status).toBe(200)
        expect(await Bun.file(join(dir, "w/f1/f1.txt")).text()).toBe("helloworld")
    })

    it("refuse a chunked body that runs past the signed size", async () => {
        const response = await put("w/f2/f2.txt", 5, chunked("hello", "world"))
        expect(response.status).toBe(400)
        expect(await Bun.file(join(dir, "w/f2/f2.txt")).exists()).toBe(false)
    })

    it("refuse a declared Content-Length that differs from the signed size", async () => {
        const response = await put("w/f3/f3.txt", 5, "hello!", { "content-length": "6" })
        expect(response.status).toBe(400)
    })
})

describe("workspace routing", () => {
    it("refuses a credential naming a workspace this gateway never minted, without calling an actor", async () => {
        const realFetch = globalThis.fetch
        let invokes = 0
        globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
            invokes += 1
            return realFetch(...args)
        }) as typeof fetch
        try {
            const forged = `relaycast_ag_241764880589606912_${"c".repeat(64)}`
            const otherKey = await createWorkspaceIdSigner({ current: "a", keys: { a: "some-other-secret-value" } }).mint()
            for (const token of [forged, `relaycast_ag_${otherKey}_${"c".repeat(64)}`]) {
                const response = await handleRequest(new Request("http://gateway/v1/inbox", { headers: { authorization: `Bearer ${token}` } }))
                expect(response.status).toBe(401)
            }
            expect(invokes).toBe(0)
        } finally {
            globalThis.fetch = realFetch
        }
    })
})

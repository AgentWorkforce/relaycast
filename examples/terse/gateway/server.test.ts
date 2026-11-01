import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCredentialTagSigner, signFileToken } from "@relaycast/engine/gateway"
import { encodeArCredential } from "@relaycast/types"

const SECRET = "test-secret"
let dir: string
let serveFile: (request: Request) => Promise<Response>
let handleRequest: (request: Request) => Promise<Response>

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "relaycast-gateway-"))
    process.env.RELAYCAST_FILE_SIGNING_SECRET = SECRET
    process.env.RELAYCAST_FILE_DIR = dir
    process.env.RELAYCAST_CREDENTIAL_KEYRING = JSON.stringify({ current: "a", keys: { a: "test-credential-tag-secret" } })
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

describe("/_relayfiles deletes", () => {
    const remove = async (key: string) => {
        const token = await signFileToken(SECRET, { key, op: "delete", exp: Math.floor(Date.now() / 1000) + 60 })
        return serveFile(new Request(`http://gateway/_relayfiles?token=${token}`, { method: "DELETE" }))
    }

    it("remove the bytes and the type, and remove a leftover type on retry", async () => {
        expect((await put("w/f4/f4.txt", 5, "hello")).status).toBe(200)
        expect((await remove("w/f4/f4.txt")).status).toBe(204)
        expect(await Bun.file(join(dir, "w/f4/f4.txt")).exists()).toBe(false)
        expect(await Bun.file(join(dir, "w/f4/f4.txt.type")).exists()).toBe(false)

        // A retry after the bytes are already gone still removes the type.
        await Bun.write(join(dir, "w/f4/f4.txt.type"), "text/plain")
        expect((await remove("w/f4/f4.txt")).status).toBe(204)
        expect(await Bun.file(join(dir, "w/f4/f4.txt.type")).exists()).toBe(false)
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
            const workspaceId = "241764880589606912"
            const credential = (tag: string) =>
                encodeArCredential({ kind: "agent", workspaceId, tag, secret: new Uint8Array(32).fill(9) })
            const forged = credential("aAAAAAAAAAA")
            const otherKeyring = credential(await createCredentialTagSigner({ current: "a", keys: { a: "some-other-secret-value" } }).tag(workspaceId))
            const legacy = `at_live_${"c".repeat(32)}`
            for (const token of [forged, otherKeyring, legacy]) {
                const response = await handleRequest(new Request("http://gateway/v1/inbox", { headers: { authorization: `Bearer ${token}` } }))
                expect(response.status).toBe(401)
            }
            expect(invokes).toBe(0)
        } finally {
            globalThis.fetch = realFetch
        }
    })
})

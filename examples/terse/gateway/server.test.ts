import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { signFileToken } from "@relaycast/engine/gateway"

const SECRET = "test-secret"
let dir: string
let serveFile: (request: Request) => Promise<Response>

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "relaycast-gateway-"))
    process.env.RELAYCAST_FILE_SIGNING_SECRET = SECRET
    process.env.RELAYCAST_FILE_DIR = dir
    ;({ serveFile } = await import("./server.js"))
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

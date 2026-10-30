// A minimal gateway in front of the `Workspace` actors. It holds no workspace
// state: a `relaycast_<kind>_<workspace_id>_<secret>` credential names its
// workspace, and that workspace's actor authenticates it.
//
//   TERSE_ACTOR_URL   actors endpoint (default: local `terse actor dev`)
//   TERSE_API_KEY     required for a hosted Terse project
//   RELAYCAST_FILE_SIGNING_SECRET   shared with the actors
//   PORT              default 8787
import { mkdir } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import {
    ACTOR_FILE_ROUTE,
    callWorkspaceActor,
    generateWorkspaceId,
    parseSelfRoutingCredential,
    verifyFileToken,
    type ActorHttpCall,
    type ActorHttpRequest,
    type ActorHttpResponse,
} from "@relaycast/engine/gateway"
import { createActorStub } from "terse-sdk/actors"

interface WorkspaceStub {
    create: ActorHttpCall
    handle: ActorHttpCall
}

const methods = [
    { name: "create", result: "value" },
    { name: "handle", result: "value" },
] as const
const workspace = (id: string) => createActorStub<WorkspaceStub>("Workspace", id, methods)

const fileSecret = process.env.RELAYCAST_FILE_SIGNING_SECRET
if (!fileSecret) throw new Error("RELAYCAST_FILE_SIGNING_SECRET is not set")
const fileRoot = resolve(import.meta.dir, "files")

/** The file for a storage key, or null if the key would resolve outside `fileRoot`. */
function filePath(key: string): string | null {
    const path = resolve(fileRoot, ...key.split("/"))
    return path.startsWith(fileRoot + sep) ? path : null
}

function error(status: number, code: string, message: string): Response {
    return Response.json({ ok: false, error: { code, message } }, { status })
}

async function forward(call: ActorHttpCall, request: Request): Promise<Response> {
    const actorRequest: ActorHttpRequest = {
        method: request.method,
        url: request.url,
        headers: [...request.headers],
        body: request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
    }
    // Repeats a call that rolled back a failed write group (see the adapter's call-scope.ts).
    const response: ActorHttpResponse = await callWorkspaceActor(call, actorRequest)
    const empty = response.status === 204 || response.status === 304
    return new Response(empty ? null : response.body, { status: response.status, headers: response.headers })
}

// Signed file URLs: bytes live on this server's disk, never in an actor.
async function serveFile(request: Request): Promise<Response> {
    const token = await verifyFileToken(fileSecret!, new URL(request.url).searchParams.get("token"))
    if (!token) return error(403, "forbidden", "Invalid or expired token")
    // verifyFileToken already refuses keys outside `<workspace>/<file>/<name>`;
    // resolving against the root is the second fence.
    const path = filePath(token.key)
    if (!path) return error(403, "forbidden", "Invalid storage key")
    if (request.method === "PUT" && token.op === "put") {
        const bytes = await request.arrayBuffer()
        if (bytes.byteLength !== token.size || request.headers.get("content-type") !== token.type) {
            return error(400, "upload_mismatch", "Size or content type does not match the upload")
        }
        await mkdir(dirname(path), { recursive: true })
        await Bun.write(path, bytes)
        return Response.json({ ok: true })
    }
    if (request.method === "GET" && token.op === "get") {
        const file = Bun.file(path)
        return (await file.exists()) ? new Response(file) : error(404, "not_found", "File not found")
    }
    if (request.method === "DELETE" && token.op === "delete") {
        try {
            await Bun.file(path).delete()
        } catch (err) {
            // Already gone is success; anything else must fail so the engine's cleanup queue retries.
            if ((err as { code?: string }).code !== "ENOENT") return error(500, "delete_failed", "Could not delete the file")
        }
        return new Response(null, { status: 204 })
    }
    return error(405, "method_not_allowed", "Token/method mismatch")
}

const server = Bun.serve({
    port: Number(process.env.PORT ?? 8787),
    async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === ACTOR_FILE_ROUTE) return serveFile(request)
        if (request.method === "POST" && url.pathname === "/v1/workspaces") {
            const id = generateWorkspaceId()
            return forward((req, replay) => workspace(id).create(req, replay), request)
        }
        const header = request.headers.get("authorization")
        const credential = header?.startsWith("Bearer ") ? parseSelfRoutingCredential(header.slice(7)) : undefined
        if (!credential) return error(401, "unauthorized", "A relaycast_ credential is required")
        return forward((req, replay) => workspace(credential.workspaceId).handle(req, replay), request)
    },
})
console.log(`relaycast gateway on http://127.0.0.1:${server.port}`)

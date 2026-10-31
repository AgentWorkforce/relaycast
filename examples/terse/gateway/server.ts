// A minimal gateway in front of the `Workspace` actors. It holds no workspace
// state: an `ar_<kind>_<wsid>_<tag>_<secret><crc>` credential names its
// workspace, the keyring verifies its tag, and that workspace's actor
// authenticates it.
//
//   TERSE_ACTOR_URL   actors endpoint (default: local `durable-actors dev`)
//   TERSE_API_KEY     required for a hosted Terse project
//   RELAYCAST_FILE_SIGNING_SECRET   shared with the actors
//   RELAYCAST_CREDENTIAL_KEYRING  {"current":"a","keys":{"a":"<secret>"}}: signs
//                        credential tags. Rotate by adding a version and making it
//                        current; removing a version locks out its credentials.
//   RELAYCAST_FILE_DIR   where file bytes live (default ./files). Run one
//                        gateway instance on persistent storage, or replace
//                        serveFile with a shared object store.
//   PORT              default 8787
import { mkdir } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import {
    ACTOR_FILE_ROUTE,
    OBJECT_SIZE_HEADER,
    createCredentialTagSigner,
    generateWorkspaceId,
    parseArCredential,
    parseCredentialKeyring,
    verifyFileToken,
    type ActorHttpRequest,
    type ActorHttpResponse,
} from "@relaycast/engine/gateway"
import { createActorStub } from "terse-sdk/actors"

/** One actor call: `create` or `handle` on the workspace actor. */
type ActorHttpCall = (request: ActorHttpRequest) => Promise<ActorHttpResponse>

interface WorkspaceStub {
    create(request: ActorHttpRequest, credentialTag: string): Promise<ActorHttpResponse>
    handle: ActorHttpCall
}

const methods = [
    { name: "create", result: "value" },
    { name: "handle", result: "value" },
] as const
const workspace = (id: string) => createActorStub<WorkspaceStub>("Workspace", id, methods)

const fileSecret = process.env.RELAYCAST_FILE_SIGNING_SECRET
if (!fileSecret) throw new Error("RELAYCAST_FILE_SIGNING_SECRET is not set")
const credentialKeyring = process.env.RELAYCAST_CREDENTIAL_KEYRING
if (!credentialKeyring) throw new Error("RELAYCAST_CREDENTIAL_KEYRING is not set")
// Credentials carry a tag only this gateway's keyring signs, so a credential
// naming a made-up workspace is refused here and never creates an actor.
const credentialTags = createCredentialTagSigner(parseCredentialKeyring(credentialKeyring))
const fileRoot = resolve(process.env.RELAYCAST_FILE_DIR ?? resolve(import.meta.dir, "files"))
/**
 * Largest request body the gateway reads. Uploads are the largest bodies, and
 * the actors refuse to sign anything bigger (`maxUploadBytes` in
 * actor/src/workspace.ts), so keep the two equal.
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** The file for a storage key, or null if the key would resolve outside `fileRoot`. */
function filePath(key: string): string | null {
    const path = resolve(fileRoot, ...key.split("/"))
    const prefix = fileRoot.endsWith(sep) ? fileRoot : fileRoot + sep
    return path.startsWith(prefix) ? path : null
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
    const response = await call(actorRequest)
    const empty = response.status === 204 || response.status === 304
    return new Response(empty ? null : response.body, { status: response.status, headers: response.headers })
}

/** The request body, or null once it exceeds `limit` bytes (read stops there). */
async function readAtMost(request: Request, limit: number): Promise<Uint8Array | null> {
    const chunks: Uint8Array[] = []
    let length = 0
    for await (const chunk of request.body ?? []) {
        length += chunk.byteLength
        if (length > limit) return null
        chunks.push(chunk)
    }
    return Buffer.concat(chunks, length)
}

// Signed file URLs: bytes live on this server's disk, never in an actor.
export async function serveFile(request: Request): Promise<Response> {
    const token = await verifyFileToken(fileSecret!, new URL(request.url).searchParams.get("token"))
    if (!token) return error(403, "forbidden", "Invalid or expired token")
    // verifyFileToken already refuses keys outside `<workspace>/<file>/<name>`;
    // resolving against the root is the second fence.
    const path = filePath(token.key)
    if (!path) return error(403, "forbidden", "Invalid storage key")
    if (request.method === "PUT" && token.op === "put") {
        // The token signs the exact size: refuse a wrong declared length before
        // reading, and stop reading a chunked body as soon as it runs past it.
        const declared = request.headers.get("content-length")
        if (request.headers.get("content-type") !== token.type) {
            return error(400, "content_type_mismatch", "Content-Type does not match the upload")
        }
        if (declared !== null && Number(declared) !== token.size) {
            return error(400, "size_mismatch", "Body size does not match the upload")
        }
        const bytes = await readAtMost(request, token.size!)
        if (!bytes || bytes.byteLength !== token.size) {
            return error(400, "size_mismatch", "Body size does not match the upload")
        }
        await mkdir(dirname(path), { recursive: true })
        // Serve the signed type later, never one inferred from the key's extension.
        // The type goes first: a failed write leaves no bytes for HEAD to report.
        await Bun.write(`${path}.type`, token.type!)
        await Bun.write(path, bytes)
        return Response.json({ ok: true })
    }
    if (request.method === "GET" && token.op === "get") {
        const file = Bun.file(path)
        if (!(await file.exists())) return error(404, "not_found", "File not found")
        const type = await Bun.file(`${path}.type`).text().catch(() => "application/octet-stream")
        return new Response(file.stream(), {
            headers: { "content-type": type, "x-content-type-options": "nosniff", "content-length": String(file.size) },
        })
    }
    if (request.method === "HEAD" && token.op === "stat") {
        const file = Bun.file(path)
        if (!(await file.exists())) return new Response(null, { status: 404 })
        return new Response(null, { headers: { [OBJECT_SIZE_HEADER]: String(file.size) } })
    }
    if (request.method === "DELETE" && token.op === "delete") {
        // Bytes, then type, each already-gone-is-success, so a retry after the
        // bytes are gone still removes the type. Anything else fails, and the
        // engine's cleanup queue retries.
        for (const file of [path, `${path}.type`]) {
            try {
                await Bun.file(file).delete()
            } catch (err) {
                if ((err as { code?: string }).code !== "ENOENT") return error(500, "delete_failed", "Could not delete the file")
            }
        }
        return new Response(null, { status: 204 })
    }
    return error(405, "method_not_allowed", "Token/method mismatch")
}

export async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === ACTOR_FILE_ROUTE) return serveFile(request)
    if (request.method === "POST" && url.pathname === "/v1/workspaces") {
        const id = generateWorkspaceId()
        const tag = await credentialTags.tag(id)
        return forward((req) => workspace(id).create(req, tag), request)
    }
    const header = request.headers.get("authorization")
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined
    const credential = token ? parseArCredential(token) : undefined
    if (!credential || !(await credentialTags.verify(token!))) {
        return error(401, "unauthorized", "An ar_ credential issued by this deployment is required")
    }
    return forward((req) => workspace(credential.workspaceId).handle(req), request)
}

if (import.meta.main) {
    const server = Bun.serve({
        port: Number(process.env.PORT ?? 8787),
        maxRequestBodySize: MAX_BODY_BYTES,
        fetch: handleRequest,
    })
    console.log(`relaycast gateway on http://127.0.0.1:${server.port}`)
}

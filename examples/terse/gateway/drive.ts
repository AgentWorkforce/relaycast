// End-to-end drive of relaycast on Terse, through the gateway.
//
//   bun drive.ts [base-url]                 # full flow; prints the workspace key
//   bun drive.ts [base-url] --verify <key>  # read state back (after restarting the actors)
import { credentialWorkspaceId, encodeArCredential, parseCredential } from "@relaycast/types"

const args = process.argv.slice(2)
const verifyAt = args.indexOf("--verify")
const verifyKey = verifyAt >= 0 ? args[verifyAt + 1] : undefined
const BASE = (args.find((arg, index) => !arg.startsWith("--") && (verifyAt < 0 || index !== verifyAt + 1)) ?? "http://127.0.0.1:8787").replace(/\/$/, "")

type Json = { ok: boolean; data?: any; error?: { code: string; message: string } }

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Json | null }> {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    const started = performance.now()
    const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    const json = text ? (JSON.parse(text) as Json) : null
    const ms = (performance.now() - started).toFixed(0)
    console.log(`${method} ${path} -> ${response.status} (${ms}ms) ${JSON.stringify(json?.error ?? json?.data ?? null).slice(0, 160)}`)
    return { status: response.status, json }
}

function expect(condition: unknown, message: string): void {
    if (!condition) {
        console.error(`FAIL: ${message}`)
        process.exit(1)
    }
    console.log(`  ok: ${message}`)
}

if (verifyKey) {
    const agents = await call("GET", "/v1/agents", undefined, verifyKey)
    const names = (agents.json?.data ?? []).map((agent: { name: string }) => agent.name).sort()
    expect(agents.status === 200, "workspace key still authenticates")
    expect(JSON.stringify(names) === JSON.stringify(["alice", "bob", "owner", "recycled"]), `agents survived: ${names.join(", ")}`)
    const messages = await call("GET", "/v1/channels/general/messages?limit=10", undefined, verifyKey)
    expect((messages.json?.data ?? []).some((m: { text: string }) => m.text === "hello from inside a durable actor"), "channel message survived")
    process.exit(0)
}

const created = await call("POST", "/v1/workspaces", { name: "armadillo-e2e" })
const key: string = created.json?.data?.api_key
const workspaceId: string = created.json?.data?.workspace_id
expect(created.status === 201 && /^[0-9]+$/.test(workspaceId), "workspace id is a plain snowflake")
expect(/^ar_ws_[0-9A-Za-z]{11}_[a-z][0-9A-Za-z]{10}_[0-9A-Za-z]{49}$/.test(key), "workspace key is ar_ws_<wsid>_<tag>_<secret><crc>")
expect(parseCredential(key)?.family === "ar" && credentialWorkspaceId(key) === workspaceId, "the key names its workspace")

const alice = await call("POST", "/v1/agents", { name: "alice", type: "agent" }, key)
const bob = await call("POST", "/v1/agents", { name: "bob", type: "agent" }, key)
const aliceToken: string = alice.json?.data?.token
const bobToken: string = bob.json?.data?.token
expect(/^ar_ag_/.test(aliceToken) && /^ar_ag_/.test(bobToken), "agent tokens are ar_ag_")

// The gateway refuses, with no actor call, a typo (checksum), a forged tag and a legacy credential.
const typo = key.slice(0, 30) + (key[30] === "x" ? "y" : "x") + key.slice(31)
const forged = encodeArCredential({ kind: "workspace", workspaceId, tag: "aAAAAAAAAAA", secret: new Uint8Array(32).fill(1) })
for (const [token, what] of [[typo, "a one-character typo"], [forged, "a forged tag"], [`rk_live_${"0".repeat(32)}`, "a legacy key"]] as const) {
    expect((await call("GET", "/v1/agents", undefined, token)).status === 401, `the gateway refuses ${what}`)
}

const post = await call("POST", "/v1/channels/general/messages", { text: "hello from inside a durable actor" }, aliceToken)
expect(post.status === 201, "alice posts to #general")
const read = await call("GET", "/v1/channels/general/messages?limit=5", undefined, bobToken)
const first = read.json?.data?.[0]
expect(read.status === 200 && first?.agent_name === "alice" && first?.text === "hello from inside a durable actor", "bob reads it with the joined author name")

const dm = await call("POST", "/v1/dm", { to: "bob", text: "direct hello" }, aliceToken)
expect(dm.status === 201, "alice DMs bob")
const inbox = await call("GET", "/v1/inbox", undefined, bobToken)
expect(inbox.json?.data?.unread_dms?.[0]?.from === "alice", "bob's inbox shows the DM from alice")
const search = await call("GET", "/v1/search?q=durable", undefined, bobToken)
expect((search.json?.data ?? []).some((hit: { text: string }) => hit.text === "hello from inside a durable actor"), "FTS search finds the message")

// A write group that fails after writing: the registration inserts its direct
// node and agent, then the recovery verifier's unique index rejects the
// credential. That group rolls back alone; the client gets the engine's 409.
const verifier = "a".repeat(64)
expect((await call("POST", "/v1/agents", { name: "owner", recovery_proof_hash: verifier }, key)).status === 201, "owner enrolls a recovery verifier")
const thief = await call("POST", "/v1/agents", { name: "thief", recovery_proof_hash: verifier }, key)
expect(thief.status === 409 && thief.json?.error?.code === "agent_recovery_proof_conflict", "conflicting registration answers 409 agent_recovery_proof_conflict")
const thiefLookup = await call("GET", "/v1/agents/thief", undefined, key)
expect(thiefLookup.status === 404, "no partial agent row survived the rolled-back group")

// A failed group the engine recovers from in the same request: reclaim a
// released holder's verifier and register again.
const recycledVerifier = "c".repeat(64)
expect((await call("POST", "/v1/agents", { name: "recycled", recovery_proof_hash: recycledVerifier }, key)).status === 201, "recycled registers")
expect((await call("DELETE", "/v1/agents/recycled", undefined, key)).status === 204, "recycled is released")
const again = await call("POST", "/v1/agents", { name: "recycled", recovery_proof_hash: recycledVerifier }, key)
expect(again.status === 201, "recycled registers again after the engine reclaims the verifier")

// File bytes go through the gateway's signed /_relayfiles URLs, never through an actor.
const upload = await call("POST", "/v1/files/upload", { filename: "hello.txt", content_type: "text/plain", size_bytes: 11 }, aliceToken)
const uploadUrl: string = upload.json?.data?.upload_url
expect(upload.status === 201 && uploadUrl?.startsWith(`${BASE}/_relayfiles?token=`), "upload URL is a signed gateway URL")
const fileId: string = upload.json?.data?.id
// Completion asks the gateway for the stored size (a signed HEAD): before the PUT there is nothing stored.
const early = await call("POST", `/v1/files/${fileId}/complete`, {}, aliceToken)
expect(early.status === 409 && early.json?.error?.code === "upload_incomplete", "completing before the PUT answers 409 upload_incomplete (gateway stat)")
const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: "hello bytes" })
expect(put.status === 200, "PUT stores the bytes at the gateway")
const completed = await call("POST", `/v1/files/${fileId}/complete`, {}, aliceToken)
expect(completed.status === 200 && completed.json?.data?.size_bytes === 11, "upload completes once the gateway reports the declared size")
const file = await call("GET", `/v1/files/${fileId}`, undefined, bobToken)
const downloaded = await fetch(file.json?.data?.download_url)
expect((await downloaded.text()) === "hello bytes", "download URL serves the bytes back")


console.log(`\nworkspace_id=${workspaceId}\nworkspace_key=${key}`)

export {}

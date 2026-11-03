import { describe, expect, it } from "vitest"
import { workspaceConfigFromEnv } from "../workspace.js"

const BASE = { RELAYCAST_PUBLIC_URL: "https://relay.example.com", RELAYCAST_FILE_SIGNING_SECRET: "file-secret" }

describe("workspaceConfigFromEnv", () => {
    it("requires the public URL and the file signing secret", () => {
        expect(() => workspaceConfigFromEnv({})).toThrow("RELAYCAST_PUBLIC_URL is not set")
        expect(() => workspaceConfigFromEnv({ RELAYCAST_PUBLIC_URL: "https://relay.example.com" })).toThrow(
            "RELAYCAST_FILE_SIGNING_SECRET is not set"
        )
        expect(workspaceConfigFromEnv(BASE)).toEqual({
            publicUrl: "https://relay.example.com",
            fileSigningSecret: "file-secret",
            engine: { environment: "production", maxUploadBytes: 64 * 1024 * 1024, retention: { messageTtlDays: null } },
        })
    })

    it("passes the engine variables through with the self-host semantics", () => {
        const config = workspaceConfigFromEnv({
            ...BASE,
            RELAYCAST_ENV: "staging",
            RELAYCAST_MESSAGE_TTL_DAYS: "7",
            RELAYCAST_MAILBOX_DEPTH_CAP: "10",
            RELAYCAST_INTERNAL_SECRET: "an-internal-secret-of-thirty-two-chars!!",
        })
        expect(config.engine).toMatchObject({
            environment: "staging",
            retention: { messageTtlDays: 7 },
            mailbox: { depthCap: 10 },
            internalSecret: "an-internal-secret-of-thirty-two-chars!!",
        })
        expect(() => workspaceConfigFromEnv({ ...BASE, RELAYCAST_INTERNAL_SECRET: "short" })).toThrow(/RELAYCAST_INTERNAL_SECRET/)
    })
})

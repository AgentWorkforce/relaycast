import { describe, expect, it } from "vitest"
import { workspaceConfigFromEnv } from "../workspace.js"

const BASE = { RELAYCAST_PUBLIC_URL: "https://relay.example.com", RELAYCAST_FILE_SIGNING_SECRET: "file-secret-of-at-least-32-characters" }

describe("workspaceConfigFromEnv", () => {
    it("requires the public URL and the file signing secret", () => {
        expect(() => workspaceConfigFromEnv({})).toThrow("RELAYCAST_PUBLIC_URL is not set")
        expect(() => workspaceConfigFromEnv({ RELAYCAST_PUBLIC_URL: "https://relay.example.com" })).toThrow(
            "RELAYCAST_FILE_SIGNING_SECRET is not set"
        )
        expect(workspaceConfigFromEnv(BASE)).toEqual({
            publicUrl: "https://relay.example.com",
            fileSigningSecret: "file-secret-of-at-least-32-characters",
            engine: { environment: "production", maxUploadBytes: 64 * 1024 * 1024, retention: { messageTtlDays: null } },
        })
    })

    it("takes the public URL as an http(s) origin and a signing secret of at least 32 characters", () => {
        expect(workspaceConfigFromEnv({ ...BASE, RELAYCAST_PUBLIC_URL: "https://relay.example.com/" }).publicUrl).toBe("https://relay.example.com")
        expect(workspaceConfigFromEnv({ ...BASE, RELAYCAST_PUBLIC_URL: " http://127.0.0.1:8787 " }).publicUrl).toBe("http://127.0.0.1:8787")
        for (const bad of ["not-a-url", "ftp://relay.example.com", "https://relay.example.com/relay", "https://relay.example.com/?x=1", "https://u:p@relay.example.com"]) {
            expect(() => workspaceConfigFromEnv({ ...BASE, RELAYCAST_PUBLIC_URL: bad }), bad).toThrow(/RELAYCAST_PUBLIC_URL must be an/)
        }
        expect(() => workspaceConfigFromEnv({ ...BASE, RELAYCAST_FILE_SIGNING_SECRET: "x" })).toThrow("RELAYCAST_FILE_SIGNING_SECRET must be at least 32 characters")
    })

    it("passes the engine variables through with the self-host semantics", () => {
        const config = workspaceConfigFromEnv({
            ...BASE,
            RELAYCAST_ENV: "staging",
            RELAYCAST_MESSAGE_TTL_DAYS: "7",
            RELAYCAST_MAILBOX_DEPTH_CAP: "10",
            RELAYCAST_INTERNAL_SECRET: "an-internal-secret-of-thirty-two-chars!!",
            RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: "bootstrap-secret-exact-bytes",
            RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: "true",
        })
        expect(config.engine).toMatchObject({
            environment: "staging",
            retention: { messageTtlDays: 7 },
            mailbox: { depthCap: 10 },
            internalSecret: "an-internal-secret-of-thirty-two-chars!!",
            workspaceBootstrapSecret: "bootstrap-secret-exact-bytes",
            workspaceBootstrapProofRequired: true,
        })
        // Exact bytes: surrounding whitespace is kept when no proof travels in a header...
        expect(workspaceConfigFromEnv({ ...BASE, RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: " bootstrap-secret-exact-bytes " }).engine)
            .toMatchObject({ workspaceBootstrapSecret: " bootstrap-secret-exact-bytes " })
        // ...and refused when proof is required, since a header cannot carry it.
        expect(() => workspaceConfigFromEnv({ ...BASE, RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET: " bootstrap-secret-exact-bytes ", RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: "true" }))
            .toThrow(/RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET/)
        expect(() => workspaceConfigFromEnv({ ...BASE, RELAYCAST_INTERNAL_SECRET: "short" })).toThrow(/RELAYCAST_INTERNAL_SECRET/)
        expect(() => workspaceConfigFromEnv({ ...BASE, RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED: "yes" })).toThrow(/RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED/)
    })
})

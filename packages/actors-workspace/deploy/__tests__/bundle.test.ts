import { describe, expect, it } from "vitest"
import {
    ACTOR_ARTIFACT,
    DEFAULT_ARTIFACT_PREFIX,
    DeploymentRequestSchema,
    artifactPrefix,
    bundleDeploymentRequest,
    contractHash,
    localDeploymentRequest,
    parseGeneration,
    planArtifact,
    sha256Base64Url,
} from "../bundle.ts"

const UUID = "0f4c2c84-5f0b-4a16-9d66-2d4f3f4b4c0e"

describe("sha256Base64Url", () => {
    it("encodes the digest as unpadded base64url, as src/bundle.rs compares it", () => {
        // sha256("abc") = ba7816bf 8f01cfea 414140de 5dae2223 b00361a3 96177a9c b410ff61 f20015ad
        expect(sha256Base64Url(new TextEncoder().encode("abc"))).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
        expect(sha256Base64Url(new Uint8Array())).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
        expect(sha256Base64Url(new Uint8Array())).toHaveLength(43)
    })
})

describe("contractHash", () => {
    it("hashes the compact JSON with recursively sorted keys", () => {
        const hash = contractHash({ b: [{ z: 1, a: null }], a: "x" })
        expect(hash).toBe(contractHash({ a: "x", b: [{ a: null, z: 1 }] }))
        expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(hash).not.toBe(contractHash({ a: "x", b: [{ a: null, z: 2 }] }))
    })
})

describe("planArtifact", () => {
    const actor = { path: ACTOR_ARTIFACT, bytes: new TextEncoder().encode("export const actors = {}") }

    it("names every file under <prefix>/<uuid>/<path> and digests it", () => {
        const [file] = planArtifact([actor], DEFAULT_ARTIFACT_PREFIX, UUID)
        expect(file).toMatchObject({
            path: "actors.mjs",
            object: `durable-actors/v3/artifacts/${UUID}/actors.mjs`,
            sha256: sha256Base64Url(actor.bytes),
        })
        expect(artifactPrefix("/custom/prefix/", UUID)).toBe(`custom/prefix/${UUID}/`)
    })

    it("requires exactly one actors.mjs and paths inside the bundle", () => {
        expect(() => planArtifact([], DEFAULT_ARTIFACT_PREFIX, UUID)).toThrow("exactly one actors.mjs")
        expect(() => planArtifact([actor, actor], DEFAULT_ARTIFACT_PREFIX, UUID)).toThrow("duplicate artifact path")
        expect(() => planArtifact([actor, { path: "../x.json", bytes: new Uint8Array() }], DEFAULT_ARTIFACT_PREFIX, UUID)).toThrow(
            "inside the bundle"
        )
        expect(() => planArtifact([actor, { path: "/etc/x", bytes: new Uint8Array() }], DEFAULT_ARTIFACT_PREFIX, UUID)).toThrow(
            "inside the bundle"
        )
    })
})

describe("parseGeneration", () => {
    it("reads the client's decimal string as the control plane's i64", () => {
        expect(parseGeneration("1761000000000000")).toBe(1761000000000000)
        expect(parseGeneration(7)).toBe(7)
        for (const bad of ["0", "-1", "abc", "1.5", "99999999999999999999", "0x10", "1e3", " 7 ", "+7", "007", undefined]) expect(() => parseGeneration(bad), String(bad)).toThrow("invalid object generation")
    })
})

describe("deployment requests", () => {
    const file = { path: "actors.mjs", object: `durable-actors/v3/artifacts/${UUID}/actors.mjs`, generation: 1761000000000000, sha256: sha256Base64Url(new Uint8Array()) }

    it("requires exactly one of bundle or localSource", () => {
        const base = { organizationId: "org", secretRefs: [] }
        expect(DeploymentRequestSchema.safeParse(base).success).toBe(false)
        expect(DeploymentRequestSchema.safeParse({ ...base, bundle: { bucket: "b", files: [file] }, localSource: { workingDirectory: "/src" } }).success).toBe(false)
        expect(DeploymentRequestSchema.safeParse({ ...base, bundle: { bucket: "b", files: [file] } }).success).toBe(true)
        expect(DeploymentRequestSchema.safeParse({ ...base, localSource: { workingDirectory: "/src" } }).success).toBe(true)
    })

    it("builds the hosted body with only the fields RegisterDeploymentRequest accepts", () => {
        const request = bundleDeploymentRequest({ organizationId: "org", bucket: "bucket", files: [file], contract: { version: 1 }, secretRefs: ["env"] })
        expect(request).toEqual({ organizationId: "org", bundle: { bucket: "bucket", files: [file] }, contract: { version: 1 }, secretRefs: ["env"] })
        expect(Object.keys(request)).toEqual(["organizationId", "bundle", "contract", "secretRefs"])
        expect(Object.keys(request.bundle!.files[0]!)).toEqual(["path", "object", "generation", "sha256"])
    })

    it("builds the local body without a bundle or secret refs", () => {
        expect(localDeploymentRequest({ organizationId: "local", workingDirectory: "/work/actor", actorEntrypoint: "src/actors.ts" })).toEqual({
            organizationId: "local",
            localSource: { workingDirectory: "/work/actor", actorEntrypoint: "src/actors.ts" },
            secretRefs: [],
        })
    })

    it("refuses what the control plane refuses", () => {
        expect(() => bundleDeploymentRequest({ organizationId: "org", bucket: "a/b", files: [file], contract: {}, secretRefs: [] })).toThrow()
        expect(() => bundleDeploymentRequest({ organizationId: "org", bucket: "bucket", files: [{ ...file, generation: 0 }], contract: {}, secretRefs: [] })).toThrow()
        expect(() => bundleDeploymentRequest({ organizationId: "org", bucket: "bucket", files: [{ ...file, sha256: "abc=" }], contract: {}, secretRefs: [] })).toThrow()
        expect(() => bundleDeploymentRequest({ organizationId: "org", bucket: "bucket", files: [file], contract: {}, secretRefs: Array(17).fill("s") })).toThrow()
        expect(DeploymentRequestSchema.safeParse({ organizationId: "org", secretRefs: [], imageRef: "x" }).success).toBe(false)
    })
})

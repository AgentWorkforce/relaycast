import { describe, expect, it } from "vitest"
import { ConfigError, bundleConfigFromEnv, connectionConfigFromEnv, localConfigFromEnv, parseOptions } from "../config.ts"

const BASE = {
    DURABLE_ACTORS_CONTROL_PLANE_URL: "https://actors.example.com",
    DURABLE_ACTORS_SECRET: "admin-key",
    DURABLE_ACTORS_PROJECT_ID: "relaycast",
    DURABLE_ACTORS_ORGANIZATION_ID: "acme",
    DURABLE_ACTORS_ARTIFACT_BUCKET: "acme-actors",
    DURABLE_ACTORS_SECRET_REFS: "relaycast-env",
}

describe("parseOptions", () => {
    it("picks one command and the dry-run flag", () => {
        expect(parseOptions([])).toEqual({ command: "deploy", dryRun: false })
        expect(parseOptions(["--dry-run"])).toEqual({ command: "deploy", dryRun: true })
        expect(parseOptions(["--local", "--dry-run"])).toEqual({ command: "local", dryRun: true })
        expect(parseOptions(["--status"])).toEqual({ command: "status", dryRun: false })
        expect(() => parseOptions(["--status", "--delete"])).toThrow(ConfigError)
        expect(() => parseOptions(["--delete", "--dry-run"])).toThrow("does not apply")
        expect(() => parseOptions(["--bogus"])).toThrow("unknown argument --bogus")
    })
})

describe("bundleConfigFromEnv", () => {
    it("reads the bundle settings with defaults and parses the secret refs", () => {
        expect(bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: " relaycast-env, relaycast-internal ,, " })).toEqual({
            controlPlaneUrl: "https://actors.example.com",
            projectId: "relaycast",
            secret: "admin-key",
            organizationId: "acme",
            bucket: "acme-actors",
            secretRefs: ["relaycast-env", "relaycast-internal"],
            artifactPrefix: "durable-actors/v3/artifacts",
            artifactStore: { kind: "gcs" },
        })
        expect(bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: "env", DURABLE_ACTORS_ARTIFACT_PREFIX: "custom/artifacts" }).artifactPrefix).toBe("custom/artifacts")
    })

    it("names the missing or invalid variable without echoing values", () => {
        const withoutSecret = { ...BASE, DURABLE_ACTORS_SECRET: "" }
        expect(() => bundleConfigFromEnv(withoutSecret)).toThrow("DURABLE_ACTORS_SECRET is not set")
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_ORGANIZATION_ID: undefined, DURABLE_ACTORS_ARTIFACT_BUCKET: undefined })).toThrow(
            "DURABLE_ACTORS_ORGANIZATION_ID and DURABLE_ACTORS_ARTIFACT_BUCKET are required"
        )
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_CONTROL_PLANE_URL: "not a url" })).toThrow(/DURABLE_ACTORS_CONTROL_PLANE_URL/)
        // An origin, as the gateway takes the same variable: the deployer appends the deployment path itself.
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_CONTROL_PLANE_URL: "https://actors.example.com/admin" })).toThrow(/DURABLE_ACTORS_CONTROL_PLANE_URL must be an http\(s\) origin/)
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_CONTROL_PLANE_URL: "https://actors.example.com/?x=1" })).toThrow(/DURABLE_ACTORS_CONTROL_PLANE_URL/)
        expect(bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_CONTROL_PLANE_URL: "https://actors.example.com/" }).controlPlaneUrl).toBe("https://actors.example.com/")
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: `ok,${"n".repeat(254)}` })).toThrow("Kubernetes Secret names")
        for (const bad of ["bad/name", "Upper", "-leading", "trailing-", "under_score", "a..b", "bad-.name", "bad.-name", ".leading", "trailing."]) {
            expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: `ok,${bad}` }), bad).toThrow("Kubernetes Secret names")
        }
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: " , " })).toThrow("DURABLE_ACTORS_SECRET_REFS is required for a bundle deployment")
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: undefined })).toThrow("DURABLE_ACTORS_SECRET_REFS is required for a bundle deployment")
        for (const bare of ["https://actors.example.com?", "https://actors.example.com#", "https://actors.example.com/?"]) {
            expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_CONTROL_PLANE_URL: bare }), bare).toThrow(/DURABLE_ACTORS_CONTROL_PLANE_URL/)
        }
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_ARTIFACT_BUCKET: "bucket/path" })).toThrow(/DURABLE_ACTORS_ARTIFACT_BUCKET/)
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_ARTIFACT_PREFIX: "/abs/" })).toThrow(/DURABLE_ACTORS_ARTIFACT_PREFIX/)
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: Array(17).fill("s").join(",") })).toThrow("at most 16")
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: "a,a" })).toThrow("repeats a name")
        try {
            bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET: " padded " })
            expect.unreachable()
        } catch (error) {
            expect(String(error)).toContain("DURABLE_ACTORS_SECRET")
            expect(String(error)).not.toContain("padded")
        }
    })
})

describe("bundleConfigFromEnv artifact store", () => {
    const S3 = { ...BASE, DURABLE_ACTORS_ARTIFACT_STORE: "s3" }

    it("defaults to GCS and ignores AWS_REGION there", () => {
        expect(bundleConfigFromEnv(BASE).artifactStore).toEqual({ kind: "gcs" })
        expect(bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_ARTIFACT_STORE: "gcs", AWS_REGION: "not a region" }).artifactStore).toEqual({ kind: "gcs" })
        expect(bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_ARTIFACT_STORE: " " }).artifactStore).toEqual({ kind: "gcs" })
    })

    it("reads the S3 region, falling back to AWS_REGION, with virtual-hosted addressing on AWS", () => {
        expect(bundleConfigFromEnv({ ...S3, DURABLE_ACTORS_S3_REGION: "eu-west-1", AWS_REGION: "us-east-1" }).artifactStore).toEqual({
            kind: "s3",
            region: "eu-west-1",
            forcePathStyle: false,
        })
        expect(bundleConfigFromEnv({ ...S3, AWS_REGION: "us-east-2" }).artifactStore).toEqual({ kind: "s3", region: "us-east-2", forcePathStyle: false })
        expect(bundleConfigFromEnv({ ...S3, AWS_REGION: "us-east-2", DURABLE_ACTORS_S3_FORCE_PATH_STYLE: "true" }).artifactStore).toMatchObject({ forcePathStyle: true })
    })

    it("takes an S3-compatible endpoint with path-style addressing unless told otherwise", () => {
        const minio = { ...S3, DURABLE_ACTORS_S3_REGION: "us-east-1", DURABLE_ACTORS_S3_ENDPOINT: "http://minio.storage.svc:9000" }
        expect(bundleConfigFromEnv(minio).artifactStore).toEqual({ kind: "s3", region: "us-east-1", endpoint: "http://minio.storage.svc:9000", forcePathStyle: true })
        expect(bundleConfigFromEnv({ ...minio, DURABLE_ACTORS_S3_FORCE_PATH_STYLE: "false" }).artifactStore).toMatchObject({ forcePathStyle: false })
    })

    it("names the bad or missing S3 variable without echoing values", () => {
        expect(() => bundleConfigFromEnv(S3)).toThrow("DURABLE_ACTORS_S3_REGION (or AWS_REGION) is required for DURABLE_ACTORS_ARTIFACT_STORE=s3")
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_ARTIFACT_STORE: "azure" })).toThrow(/DURABLE_ACTORS_ARTIFACT_STORE/)
        expect(() => bundleConfigFromEnv({ ...S3, DURABLE_ACTORS_S3_REGION: "US East" })).toThrow(/DURABLE_ACTORS_S3_REGION must be a region name/)
        expect(() => bundleConfigFromEnv({ ...S3, AWS_REGION: "us_east_1" })).toThrow("AWS_REGION must be a region name")
        expect(() => bundleConfigFromEnv({ ...S3, AWS_REGION: "us-east-1", DURABLE_ACTORS_S3_FORCE_PATH_STYLE: "yes" })).toThrow(/DURABLE_ACTORS_S3_FORCE_PATH_STYLE/)
        for (const bad of ["minio:9000", "ftp://minio", "http://minio?x=1", "http://minio#f"]) {
            expect(() => bundleConfigFromEnv({ ...S3, AWS_REGION: "us-east-1", DURABLE_ACTORS_S3_ENDPOINT: bad }), bad).toThrow(/DURABLE_ACTORS_S3_ENDPOINT/)
        }
        try {
            bundleConfigFromEnv({ ...S3, AWS_REGION: "us-east-1", DURABLE_ACTORS_S3_ENDPOINT: "http://key:hunter2@minio:9000" })
            expect.unreachable()
        } catch (error) {
            expect(String(error)).toContain("DURABLE_ACTORS_S3_ENDPOINT")
            expect(String(error)).not.toContain("hunter2")
        }
    })

    it("refuses S3 settings without DURABLE_ACTORS_ARTIFACT_STORE=s3", () => {
        expect(() => bundleConfigFromEnv({ ...BASE, DURABLE_ACTORS_S3_REGION: "us-east-1", DURABLE_ACTORS_S3_ENDPOINT: "http://minio:9000" })).toThrow(
            "DURABLE_ACTORS_S3_REGION, DURABLE_ACTORS_S3_ENDPOINT need DURABLE_ACTORS_ARTIFACT_STORE=s3"
        )
    })
})

describe("localConfigFromEnv and connectionConfigFromEnv", () => {
    it("needs no admin key locally and defaults the organization to local", () => {
        expect(localConfigFromEnv({ DURABLE_ACTORS_CONTROL_PLANE_URL: "http://127.0.0.1:7100", DURABLE_ACTORS_PROJECT_ID: "local" })).toEqual({
            controlPlaneUrl: "http://127.0.0.1:7100",
            projectId: "local",
            secret: undefined,
            organizationId: "local",
        })
        expect(() => localConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET_REFS: "x" })).toThrow("unavailable in local mode")
        expect(localConfigFromEnv({ DURABLE_ACTORS_CONTROL_PLANE_URL: "http://127.0.0.1:7100", DURABLE_ACTORS_PROJECT_ID: "local", DURABLE_ACTORS_ORGANIZATION_ID: "local" }).organizationId).toBe("local")
        expect(() => localConfigFromEnv({ DURABLE_ACTORS_CONTROL_PLANE_URL: "http://127.0.0.1:7100", DURABLE_ACTORS_PROJECT_ID: "local", DURABLE_ACTORS_ORGANIZATION_ID: "acme" })).toThrow('must be "local"')
        expect(connectionConfigFromEnv(BASE)).toEqual({ controlPlaneUrl: BASE.DURABLE_ACTORS_CONTROL_PLANE_URL, projectId: "relaycast", secret: "admin-key" })
        expect(() => connectionConfigFromEnv({ ...BASE, DURABLE_ACTORS_SECRET: undefined })).toThrow("DURABLE_ACTORS_SECRET is not set")
    })
})

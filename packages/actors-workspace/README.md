# @relaycast/actors-workspace

The relaycast `Workspace` actor for [durable-actors](https://github.com/TerseAI/durable-actors)
(0.14.6): one workspace per actor, the engine running on the actor's own
SQLite through `@relaycast/engine/adapters/actor`. The gateway
(`packages/actors-gateway`) calls `create` for `POST /v1/workspaces`, `handle`
for every other request, `fileStored` after it stores a signed upload, and opens actor sockets for `/v1/ws` and `/v1/node/ws`;
the socket lifecycle (`onConnect`, `onMessage`, `onDisconnect`) and `onAlarm`
(outbound HTTP, maintenance) run the engine's realtime and background work.

## Environment

The actor reads its configuration from the process environment when it is
constructed (`src/workspace.ts`, `packages/engine/src/adapters/actor/config.ts`).
A blank variable counts as unset; a missing required value or an invalid one
makes the actor fail at construction instead of serving with defaults.

| Variable | Default | Meaning |
|---|---|---|
| `RELAYCAST_PUBLIC_URL` | required | Public http(s) origin clients reach the gateway on; signed file URLs point at its `/_relayfiles`. Credentials, a path other than `/`, a query or a fragment are rejected, and the value is normalized to its origin (a trailing slash is dropped) |
| `RELAYCAST_FILE_SIGNING_SECRET` | required | HMAC secret shared with the gateway, which serves `/_relayfiles`; at least 32 characters |
| `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` (or `_FILE`) | unset | Enables anonymous keyed workspace creates (`Idempotency-Key`), as on the self-host server: a direct value is used as-is (exact bytes: a whitespace-only value is a secret; only an empty string unsets), a `_FILE` value loses one trailing newline, an unreadable file fails construction. The gateway must hold the same bytes (it derives the actor id from them). Unset: a keyed create answers 503 `workspace_create_idempotency_unavailable` |
| `RELAYCAST_WORKSPACE_BOOTSTRAP_PROOF_REQUIRED` | `false` | The self-host server's proof policy: `true` makes an anonymous keyed create prove the secret with `X-Workspace-Bootstrap-Secret` (401 `workspace_create_bootstrap_secret_invalid` otherwise); the gateway reads the same variable and refuses at the edge first. Exactly `true` or `false`. With `true`, a secret an HTTP header cannot carry (anything but printable ASCII, or a leading or trailing space or tab) fails construction rather than being trimmed |
| `RELAYCAST_INTERNAL_SECRET` | unset | Enables `/internal/*`; trimmed, then at least 32 characters; the gateway (which also trims it) must hold the same value |
| `RELAYCAST_MAX_UPLOAD_BYTES` | `67108864` | Largest upload the engine signs a URL for (positive integer) |
| `RELAYCAST_MESSAGE_TTL_DAYS` | unset | Positive: prune messages after that many days; unset, `0` or negative: keep forever |
| `RELAYCAST_MAILBOX_TTL_MS` | engine default | Delivery TTL of the mailbox (positive number) |
| `RELAYCAST_MAILBOX_DEPTH_CAP` | engine default | Most undelivered items a mailbox holds (positive integer) |
| `RELAYCAST_RATE_LIMIT_PER_MINUTE` | engine default | Per-credential request limit (positive integer) |
| `RELAYCAST_ENV` | `production` | Environment label |

On a hosted control plane these come from Kubernetes Secrets named in the
deployment's `secretRefs` (below); under `durable-actors dev` the actor
process inherits the dev server's environment.

## Run locally

```sh
export RELAYCAST_PUBLIC_URL=http://127.0.0.1:8787
export RELAYCAST_FILE_SIGNING_SECRET=$(openssl rand -hex 32)
npm run dev -w @relaycast/actors-workspace      # durable-actors dev: project `local` on http://127.0.0.1:7100
```

`durable-actors dev` compiles `src/actors.ts` itself, registers it as a
`localSource` deployment and reloads on source changes (`DURABLE_ACTORS_PORT`
changes the port, `DURABLE_ACTORS_PROJECT_ID` the project). Then start the
gateway against it (`DURABLE_ACTORS_CONTROL_PLANE_URL=http://127.0.0.1:7100
DURABLE_ACTORS_PROJECT_ID=local`, see `packages/actors-gateway/README.md`).
`npm run deploy -w @relaycast/actors-workspace -- --local` re-registers the
same local deployment through the API, which is also what the dev control
plane accepts: `localSource` only, no secret refs, organization `local`.

## Deploy to a self-hosted control plane

A hosted (GKE) control plane refuses `localSource`; it runs only a compiled
bundle stored in its artifact bucket. `deploy/deploy.ts` does what the hosted
`terse deploy` command used to do:

1. compiles `src/actors.ts` with the SDK compiler (the control plane's own
   local build runs the same `compiler/actor-build` module) into one
   `actors.mjs`, which keeps `durable-actors` external because the runtime
   image provides it, and validates the public contract;
2. uploads it to `gs://<bucket>/durable-actors/v3/artifacts/<new uuid>/actors.mjs`
   with Application Default Credentials (or to `s3://` with
   `DURABLE_ACTORS_ARTIFACT_STORE=s3`, see below), recording the object
   generation and the sha256 (unpadded base64url) the host verifies on install;
3. `PUT /v1/projects/<project>/deployment` with
   `{organizationId, bundle: {bucket, files}, contract, secretRefs}` and the
   admin key, and prints `{changed, artifact_prefix, files, contract_hash}`.

Every run uploads under a fresh UUID; a repeated deploy of unchanged code
registers a new bundle and answers `changed: true` all the same.

```sh
cd packages/actors-workspace
bun deploy/deploy.ts --dry-run    # compile and print the request (no upload, no PUT)
bun deploy/deploy.ts              # deploy
bun deploy/deploy.ts --status     # GET the current deployment
bun deploy/deploy.ts --delete     # DELETE it
```

Bun is the intended runtime (the SDK compiler targets it); Node 22.18+ runs
the same files unchanged. A bad configuration prints one line and exits with
code 64; a rejected request prints the control plane's `code` and `message`
and exits with 1. Transient failures (5xx, connection errors, the 30 s
request timeout) retry three times with backoff. Secret values are never
printed.

| Variable | Meaning |
|---|---|
| `DURABLE_ACTORS_CONTROL_PLANE_URL` | Control plane origin (required) |
| `DURABLE_ACTORS_PROJECT_ID` | Project id (required) |
| `DURABLE_ACTORS_SECRET` | Admin key, sent as `Authorization: Bearer` (required unless `--local`) |
| `DURABLE_ACTORS_ORGANIZATION_ID` | Organization id the project runs under (required for a bundle) |
| `DURABLE_ACTORS_ARTIFACT_BUCKET` | The control plane's artifact bucket, its own `DURABLE_ACTORS_ARTIFACT_BUCKET` (required for a bundle; a bundle in any other bucket is refused) |
| `DURABLE_ACTORS_SECRET_REFS` | Comma-separated Kubernetes Secret names (DNS subdomains, at most 16) whose keys become the actor's environment; required for a bundle, since the actor needs `RELAYCAST_PUBLIC_URL` and `RELAYCAST_FILE_SIGNING_SECRET` from them |
| `DURABLE_ACTORS_ARTIFACT_PREFIX` | Object prefix in the bucket; the control plane only accepts the default `durable-actors/v3/artifacts` |
| `DURABLE_ACTORS_ARTIFACT_STORE` | `gcs` (default) or `s3`: the control plane's storage backend |
| `DURABLE_ACTORS_S3_REGION` | The bucket's region (required for `s3`; falls back to `AWS_REGION`) |
| `DURABLE_ACTORS_S3_ENDPOINT` | An S3-compatible endpoint such as MinIO (optional; unset for AWS) |
| `DURABLE_ACTORS_S3_FORCE_PATH_STYLE` | `true` or `false`: path-style bucket addressing (optional; defaults to `true` with an endpoint, `false` without) |

### S3 (AWS or MinIO)

With `DURABLE_ACTORS_ARTIFACT_STORE=s3` the deployer writes the same object
names into the S3 bucket `DURABLE_ACTORS_ARTIFACT_BUCKET`, as durable-actors'
S3 backend expects: a `PutObject` with `If-None-Match: *` and
`x-amz-meta-da-generation: 1`, recording generation `1` (every object name is
new). If the object already exists (412, e.g. a retried PUT that had
landed), the deployer reads its `da-generation` with `HeadObject`, and fails
when that metadata is absent; a 409 (a concurrent conditional write still
settling) first retries the PUT with backoff (4 attempts in all), and a 409
that persists reads `da-generation` with `HeadObject` the same way, failing
when the object is absent. In s3 mode the bucket must
follow S3's bucket naming rules. Credentials come from the AWS SDK's default
chain; on EKS, give the Job's service account an EKS Pod Identity association
with `s3:PutObject` and `s3:GetObject` (for the `HeadObject` fallback) on
`arn:aws:s3:::<bucket>/durable-actors/v3/artifacts/*`. No keys go in the
deployer's configuration. Setting a `DURABLE_ACTORS_S3_*` variable without
`DURABLE_ACTORS_ARTIFACT_STORE=s3` is a configuration error.

### The actor's secrets

The control plane resolves `secretRefs` as Secrets in its sandbox namespace
(the chart's `sandboxNamespace`) and only accepts those labelled
`terse.ai/customer-secret=true`; each key of each Secret becomes one
environment variable, and a key present in two Secrets is an error. No API
creates them:

```sh
kubectl -n "$SANDBOX_NAMESPACE" create secret generic relaycast-actor-env \
  --from-literal=RELAYCAST_PUBLIC_URL=https://relay.example.com \
  --from-literal=RELAYCAST_FILE_SIGNING_SECRET="$(openssl rand -hex 32)" \
  --from-literal=RELAYCAST_INTERNAL_SECRET="$(openssl rand -hex 32)"
kubectl -n "$SANDBOX_NAMESPACE" label secret relaycast-actor-env terse.ai/customer-secret=true
```

and deploy with `DURABLE_ACTORS_SECRET_REFS=relaycast-actor-env`. The gateway
needs the same `RELAYCAST_FILE_SIGNING_SECRET` and `RELAYCAST_INTERNAL_SECRET`.

### Running the deployer as a Job

`docker/actors-deployer.Dockerfile` builds an image whose entrypoint is the
deployer (`docker build -f docker/actors-deployer.Dockerfile .` from the
repository root). On GKE, give the Job a Kubernetes service account bound by
Workload Identity to a Google service account with `roles/storage.objectCreator`
on the artifact bucket; the deployer then needs no key file.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: relaycast-actors-deployer
  annotations:
    iam.gke.io/gcp-service-account: relaycast-deployer@PROJECT.iam.gserviceaccount.com
---
apiVersion: batch/v1
kind: Job
metadata:
  name: relaycast-actors-deploy
spec:
  backoffLimit: 0
  template:
    spec:
      serviceAccountName: relaycast-actors-deployer
      restartPolicy: Never
      containers:
        - name: deploy
          image: ghcr.io/agentworkforce/relaycast-actors-deployer:12.7.0
          env:
            - name: DURABLE_ACTORS_CONTROL_PLANE_URL
              value: http://durable-actors.actors.svc:8080
            - name: DURABLE_ACTORS_PROJECT_ID
              value: relaycast
            - name: DURABLE_ACTORS_ORGANIZATION_ID
              value: acme
            - name: DURABLE_ACTORS_ARTIFACT_BUCKET
              value: acme-durable-actors
            - name: DURABLE_ACTORS_SECRET_REFS
              value: relaycast-actor-env
            - name: DURABLE_ACTORS_SECRET
              valueFrom:
                secretKeyRef:
                  name: actors-credentials      # the chart's credentialsSecret
                  key: DURABLE_ACTORS_SECRET
```

In a Helm chart, annotate the Job with `helm.sh/hook: post-install,post-upgrade`
so every release re-registers the actor, and read the control plane URL,
bucket and credentials Secret from the durable-actors chart's values.

## Scripts

- `npm run check`: type-check the actor and the deployer.
- `npm test`: unit tests, including one that runs the real SDK compiler on
  the actor (no network; about ten seconds). With
  `DURABLE_ACTORS_S3_TEST_ENDPOINT` (and optionally
  `DURABLE_ACTORS_S3_TEST_BUCKET`, default `artifacts`) set, one more test
  uploads to that S3-compatible server (e.g. MinIO) with the SDK's default
  credentials.
- `npm run lint`.

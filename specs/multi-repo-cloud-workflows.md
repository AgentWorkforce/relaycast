# Spec: Multi-repo cloud workflows

## Status

Proposed.

## Problem

Today every `agent-relay cloud run` tarballs exactly *one* directory (the
caller's `cwd`), uploads it to S3, and mounts it at `/project` in the
Daytona sandbox. The workflow can only see one repo's worth of files.

Workflows that need to coordinate changes across multiple repos —
cross-repo refactors, platform migrations, anything where one PR isn't
enough — have no way to express that in cloud. Locally, the relay SDK
already has the contract:

```yaml
# relay/packages/sdk/src/workflows/schema.json — PathDefinition
paths:
  - name: relayauth
    path: ../relayauth
  - name: cloud
    path: ../cloud
```

The local runner validates these in preflight, lets agents reference
them via `workdir`. Cloud's `runInCloud` and `/api/v1/workflows/run`
ignore the field. Workflows that declare `paths` and try to run in
cloud get a sandbox with only the workflow author's `cwd` mounted —
the other declared paths simply don't exist inside the sandbox.

The user-visible failure that surfaced this: the api-keys + RS256
migration in `relayauth/specs/api-keys-and-rs256-migration.md` touches
both relayauth and cloud. The local-mode runner branches both repos via
local `git` + `gh`. Cloud-mode is blocked because the sandbox has no
way to mount the second repo, and no auth path to push back.

## Goals

1. Honor the existing workflow-level `paths` contract in cloud. No new
   user-facing flag; if the workflow declares `paths`, cloud honors them.
2. Each declared path becomes its own tarball, mounted at a stable
   per-name location in the sandbox.
3. Per-repo patches at the end of the run, returnable to the caller and
   (when configured) automatically applied as commits + PRs to the
   corresponding GitHub repo.
4. Push-back uses the workspace's existing GitHub App installation
   (Nango) — no PATs vendored into the sandbox, no SSH keys.
5. The workspace must explicitly opt a workflow run into touching a
   given repo (allowlist). The original Phase A design defaulted to
   strict: no repo can be pushed to unless the workspace owner approved
   it. **The runtime gate is currently relaxed** — see the next section.

## Current state — Phase A relaxation (2026-05)

The strict per-repo allowlist gate from Phase A (cloud#296) has been
deliberately relaxed. The schema, CRUD API, and dashboard UI from
Phase A still exist unchanged; only the runtime enforcement has been
softened.

**Observed behavior today:**

| Scenario | Outcome |
|---|---|
| Workspace has a GitHub App install + workflow declares a repo in `paths` + no explicit allowlist row + the install can reach the repo | **Submit succeeds. Phase C opens a PR on completion.** Synthetic record uses the workspace's `installationId`. |
| Workspace has a GitHub App install + explicit allowlist row exists | Explicit row is honored verbatim. `pushAllowed=false` rows still skip push-back. The submit-time access probe is skipped — the explicit row stands in for consent. |
| Workspace has a GitHub App install + no explicit row + the install cannot reach the specific repo (e.g. installed on "selected repos" and this one isn't in the set) | Submit fails 400 `repo_not_allowlisted`. The relaxed path probes `GET /repos/{owner}/{repo}` with the installation token at submit time and returns null on 404/403, preserving Phase A's "fail at the door" contract. |
| Workspace has *no* GitHub App install at all | Submit fails 400 `repo_not_allowlisted`. (Phase C can't mint a token without an `installationId`, so failing at submit time keeps the failure surface honest.) |
| GitHub returns a transient error (5xx, network blip) during the access probe | Submit fails with the underlying error rather than masquerading as `repo_not_allowlisted`, so transient flakiness is distinguishable from a real consent failure. |

**Why relaxed:** for small workspaces with a fixed set of repos all
under one App install, requiring a manual dashboard toggle on every
new repo was more friction than protection. The App install scope is
already the upstream consent boundary (org admin chose what the App
can reach); making the workspace owner re-affirm that per-repo on top
just to run a workflow added clicks without changing the security
model in a meaningful way.

**Why not delete the table / API / UI:** because we want a one-flip
revert. If a future workspace needs the original strict behavior — for
example a workspace whose App is installed org-wide but only a subset
of repos should be cloud-pushable — the operator sets:

```
CLOUD_REPO_ALLOWLIST_ENFORCED=true
```

and the runtime gate becomes strict again. No code change. The
existing rows in `workflow_repository_allowlists` immediately become
load-bearing again, and the dashboard is the management surface.

**Implementation pointer:** `resolveRepoAllowlistOrRelaxed()` in
`packages/web/lib/integrations/workflow-repository-allowlists.ts` is
the single place enforcement decisions live. The two callsites that
go through it are `/api/v1/workflows/run/route.ts` (submit) and
`/api/v1/workflows/callback/route.ts` (push-back). Reverting to strict
is either flipping the env var or reverting that helper to delegate
straight to `getAllowedRepo()`.

**Provider naming:** the integration row that backs both the resolver
and `mintInstallationToken` is looked up via the `"github"` alias in
`getWorkspaceIntegrationByProviderAlias`, which matches any provider
value starting with `github` (today: `github`; planned:
`github-ricky` and similar workspace-suffixed variants, mirroring the
existing `slack-sage` / `slack-my-senior-dev` fanout). When more than
one `github*` row exists for a workspace, `mintInstallationToken`
disambiguates by `(workspaceId, installationId)` via
`findWorkspaceGithubIntegrationByInstallation`, so Nango proxy calls
always go through the connection that actually owns the install.

The relaxed resolver in
`resolveRepoAllowlistOrRelaxed` enumerates every github-family
integration (most-recently-updated first) and runs the access probe
against each in turn, accepting the repo as soon as any one
installation can reach it. A workspace with both `github` and
`github-ricky` connected therefore isn't bottlenecked on whichever
row sorts first — a repo reachable only by the older install still
resolves. A transient probe failure (5xx, network) on any candidate
propagates immediately so operators see the real error instead of a
misleading `repo_not_allowlisted`.

**What this does NOT change about the rest of the spec.** Phase B
(multi-tarball plumbing) and Phase C (push-back via GitHub App) are
unchanged. The CLI, the bootstrap, the per-repo patch generation, the
GitHub App token mint — all still work exactly as Phases B/C describe
below. Only the gate at the door has been opened wider.

## Non-goals

- Allowing a workflow to *discover* repos at runtime. The set of
  reachable repos is decided up front, declared in the workflow's
  `paths`, and validated against the allowlist.
- Cross-workspace repo access. A workflow runs in one workspace; the
  GitHub App installation belongs to that workspace.
- Submodule / monorepo-internal multi-package handling. A `path` is one
  directory tree; if your monorepo has multiple packages, that's still
  one path.

## Architecture

### Existing surfaces (no changes needed)

- **Workflow-level `paths` declaration** — already specified in
  `relay/packages/sdk/src/workflows/schema.json:29`. Workflows declare:
  ```yaml
  paths:
    - { name: relayauth, path: ../relayauth }
    - { name: cloud,     path: ../cloud }
  ```
- **GitHub App installation per workspace** — already stored.
  `cloud/packages/web/lib/integrations/integration-route-handler.ts:214`
  persists `connectionId` + `installationId` + `providerConfigKey` in
  `workspace_integrations` table. Nango can mint an installation token
  on demand.
- **Patch generation** —
  `cloud/packages/core/src/bootstrap/script-generator.ts:1276-1385`
  already snapshots git state at workflow start and emits
  `changes.patch` to S3 at end. Single-repo today; needs per-repo
  fanout.

### New surfaces

#### 1. Repo allowlist data model

New table:

```sql
CREATE TABLE workflow_repository_allowlists (
  id              TEXT PRIMARY KEY,
  workspaceId     TEXT NOT NULL REFERENCES workspaces(id),
  -- Scope: per-workspace allowlist applies to every workflow run in
  -- that workspace. Future: per-workflow rows by adding workflowName.
  repoOwner       TEXT NOT NULL,
  repoName        TEXT NOT NULL,
  installationId  TEXT NOT NULL,  -- copied from workspace_integrations
                                  -- at allow time so revoking the
                                  -- integration doesn't silently
                                  -- broaden the allowlist
  allowedAt       TIMESTAMP NOT NULL,
  allowedBy       TEXT NOT NULL,  -- user id
  pushAllowed     BOOLEAN NOT NULL DEFAULT FALSE,  -- separate
                                                   -- read-only vs
                                                   -- write opt-in
  UNIQUE(workspaceId, repoOwner, repoName)
);
```

Read-only (`pushAllowed = FALSE`): the workflow can mount the repo and
generate a patch, but the platform won't push. Caller fetches the patch
themselves.

Write-allowed (`pushAllowed = TRUE`): the platform creates branch +
commit + PR via the workspace's GitHub App on workflow success.

#### 2. CLI: read `paths` from the workflow, tarball each

`relay/packages/cloud/src/workflows.ts`:

- After parsing the workflow YAML/TS, enumerate `config.paths[]`.
- For each declared path, call `createTarball` rooted at that path.
- Upload N tarballs to S3 with keys `code-{name}.tar.gz`.
- Build the existing `s3CodeKey` for the primary `cwd` if no `paths`
  declared OR if the workflow's `cwd` is itself one of the paths;
  otherwise upload the workflow file location separately.

Submit shape change for `POST /api/v1/workflows/run`:

```ts
interface RunRequestBody {
  workflow: string;
  fileType: WorkflowFileType;
  // Existing single-tarball form, unchanged for backwards compat:
  s3CodeKey?: string;
  workflowPath?: string;
  // New multi-repo form:
  paths?: Array<{
    name: string;        // matches PathDefinition.name
    s3CodeKey: string;   // tarball for this path
    repoOwner?: string;  // optional GitHub coordinates if push-back is wanted
    repoName?: string;
  }>;
  // ... existing fields
}
```

CLI infers `repoOwner`/`repoName` from each path's `git remote get-url
origin` parse. If parse fails (path isn't a git repo), the path mounts
read-only with no push-back possibility.

#### 3. Web: validate against allowlist

`cloud/packages/web/app/api/v1/workflows/run/route.ts`:

- For each `paths[]` entry:
  - If the CLI was unable to resolve `repoOwner` / `repoName` from the
    path's git remote (non-git path, unparseable remote, no `origin`),
    the entry is accepted as a **read-only** mount — no allowlist check,
    no push-back possible.
  - If `repoOwner` / `repoName` are present, look up
    `workflow_repository_allowlists` by `(workspaceId, repoOwner, repoName)`.
    Reject the run with a clear error if no row exists. Error message
    points to the dashboard URL where the user can allow the repo.
  - If a row exists, capture the `installationId` for later push-back.
- Pass the validated paths + installation IDs (where present) into the
  launcher.

#### 4. Launcher: per-repo mount

`cloud/packages/core/src/bootstrap/launcher.ts`:

- Today: `S3_CODE_KEY` env + extraction to `/project`.
- New: `S3_PATHS` env (JSON array of `{name, s3CodeKey, repoOwner, repoName}`).
- Bootstrap downloads each tarball and extracts to
  `/workspace/{name}/`. The workflow's `cwd` is the tarball whose
  declared path was the workflow author's working dir (preserved via
  `WORKFLOW_PATH`).
- A small manifest at `/workspace/.relay/paths.json` lists the mounted
  paths so workflow code can resolve `{{paths.relayauth}}` to
  `/workspace/relayauth/` etc.

#### 5. Bootstrap: per-repo patch generation

`cloud/packages/core/src/bootstrap/script-generator.ts`:

- Today: one `git init` + baseline at `/project`, one diff at end.
- New: for each path with `repoOwner`/`repoName`:
  - Set up a git baseline inside `/workspace/{name}/` at workflow start
  - Capture `git diff` per path at workflow end
  - Upload to S3 as `changes-{name}.patch`
- The existing single-patch path is preserved when the workflow only
  has one mounted path (current behavior unchanged).

#### 6. Push-back: extend the writeback bridge

`cloud/packages/web/lib/integrations/relayfile-writeback-bridge.ts`:

- Today: PR review + comment writebacks (lines 758-774).
- New: `commitPatch(installationId, repoOwner, repoName, patchContent, options)`:
  - Mint installation token via Nango
  - Resolve the repo's **default branch** at push time via
    `GET /repos/{owner}/{repo}` (the `default_branch` field). Use the
    workflow-specified base (`paths[].pushBase`) if provided; otherwise
    use the resolved default branch. Never assume `main`.
  - Create branch (`agent-relay/run-{runId}` or workflow-specified name),
    rooted at the resolved base branch's tip
  - Apply patch — preferred path is the GitHub Contents API per file
    (parse patch hunks → `PUT /repos/{owner}/{repo}/contents/{path}`),
    fallback to Git Database API for binary diffs
  - Open PR from branch to the resolved base branch
  - Return PR URL

Hook this into the workflow callback path: when a workflow completes,
for each path with `pushAllowed = TRUE` and a non-empty patch, call
`commitPatch` and accumulate PR URLs.

#### 7. CLI surfaces the result

`/api/v1/workflows/runs/{runId}` response shape extension:

```ts
{
  runId: string;
  status: "completed" | "failed" | ...;
  patches: Record<string /* path name */, {
    s3Url: string;       // existing single-patch S3 URL, generalized
    pushedTo?: {         // present iff pushAllowed = TRUE and push succeeded
      branch: string;
      prUrl: string;
      sha: string;
    };
  }>;
}
```

CLI prints PR URLs at the end:

```
Workflow completed.
  relayauth → https://github.com/AgentWorkforce/relayauth/pull/234
  cloud     → https://github.com/AgentWorkforce/cloud/pull/290
  Pull patch:    agent-relay cloud patch <runId> --path relayauth
```

### Repo registration UX

New page `/integrations/github/repos`:

- Lists repos accessible to the workspace's GitHub App installation
  (call Nango with the installationId, hit
  `GET /installation/repositories`).
- Each row has two checkboxes:
  - "Allow workflows to read this repo" → inserts allowlist row with
    `pushAllowed = FALSE`
  - "Allow workflows to push (branches + PRs)" → upgrades existing row
    or inserts with `pushAllowed = TRUE`
- Audit log entry per change.

### Auth flow walkthrough (push case)

```
Workflow finishes in sandbox
       │
       ▼
bootstrap uploads changes-relayauth.patch to S3
       │
       ▼
bootstrap POSTs callback to /api/v1/workflows/callback with status="completed"
       │
       ▼
Web side: for each path with pushAllowed = TRUE:
   1. Read installationId from the captured allowlist
   2. POST to Nango → mints fresh GitHub App installation token (~1h TTL)
   3. Use that token to:
        - Resolve base branch: paths[].pushBase if set, else
          GET /repos/{owner}/{repo}.default_branch
        - createBranch('agent-relay/run-<runId>', from: <resolved base>)
        - For each file in the patch: createFile / updateFile / deleteFile
        - createPR(head: branch, base: <resolved base>, title, body)
   4. Persist PR URL alongside the run row
       │
       ▼
CLI poll sees patches[].pushedTo populated
       │
       ▼
Print PR URLs to operator
```

The installation token never leaves the web side — sandbox doesn't
need it, doesn't see it, doesn't have a way to ask for it.

## Implementation plan

Phased so each PR is independently reviewable and shippable.

### Phase A — Repo allowlist (no behavior change)
- Schema: `workflow_repository_allowlists` migration
- CRUD API: `GET/POST/DELETE /api/v1/workspaces/{ws}/integrations/github/allowed-repos`
- Dashboard page
- Tests
- **At end of phase A:** workspace can opt repos in/out, but nothing reads the table yet.

> **Note (2026-05):** the strict runtime gate that Phases B and C
> originally consulted has been relaxed. See the "Current state —
> Phase A relaxation" section near the top of this document. The
> schema, CRUD API, and dashboard from this phase are still in place;
> only the runtime check has changed.

### Phase B — Multi-tarball plumbing (read-only)
- CLI: tarball each path, send `paths[]` array
- Web: validate `paths[]` entries against allowlist (read-only check; `pushAllowed` not yet consulted)
- Launcher: per-repo mount under `/workspace/{name}/`
- Bootstrap: per-repo patch generation
- Run response: `patches[]` map
- Tests + e2e: a workflow declares `paths` and the sandbox has all of them mounted; patches generated per repo
- **At end of phase B:** multi-repo cloud workflows work with patch-pull semantics, just like single-repo today.

### Phase C — Push-back via GitHub App
- Writeback bridge: `commitPatch` + Nango installation-token mint
- Callback handler: for each path with `pushAllowed = TRUE`, push + PR
- Run response: `patches[].pushedTo` populated
- CLI: print PR URLs
- Tests: end-to-end with a real GitHub App on a test repo
- **At end of phase C:** the migration spec's cloud-mode is unblocked. Any workflow with `paths` declared + repos allowlisted ships PRs unattended.

## Open questions

1. **Branch naming.** Default to `agent-relay/run-{runId}` for traceability, allow override via workflow config (`paths[].pushBranch`)?
2. **PR body.** Should the platform compose a default body (linking to the run + the patch download), or does the workflow author supply it?
3. **Failure handling.** If push to one repo fails after pushing to another, do we leave the partial state? Roll forward (operator merges what landed), document, no auto-rollback.
4. **Conflict on push.** If the target branch advanced after the sandbox started, the patch may not apply cleanly. First version: fail loud, surface conflict in run output. Future: rebase-on-conflict via the GitHub Apps merge endpoints.
5. **Patch size limits.** GitHub Contents API has a 100MB file size limit per call. For large diffs, fall back to Git Database API or refuse with a clear error.

## Acceptance criteria

This spec is complete when:
- A workflow with `paths: [{name: "relayauth", path: "../relayauth"}, {name: "cloud", path: "../cloud"}]` runs in cloud (`agent-relay cloud run`) without errors.
- The sandbox has `/workspace/relayauth/` and `/workspace/cloud/` populated from the operator's local working trees.
- After the run, both repos' allowlist rows show `pushAllowed = TRUE` and the run response includes two PR URLs.
- Both PRs exist on GitHub, contain the workflow's changes, and are openable for human review.
- A workflow trying to push to a repo *not* in the allowlist fails loud at submit time with a dashboard-link error — *when* `CLOUD_REPO_ALLOWLIST_ENFORCED=true`. Under the current relaxed default, the same submission succeeds as long as the workspace has a GitHub App install.
- The api-keys + RS256 migration (relayauth#18) becomes a single workflow file using this capability instead of the local-mode bash runner.

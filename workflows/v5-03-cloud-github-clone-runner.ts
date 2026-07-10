/**
 * V5-03 (cloud side): GitHub Repo Clone Runner via Nango Proxy → Relayfile (80-to-100 hardened)
 *
 * Pairs with sage/workflows/v5/03-sage-github-migration.ts (reader-only migration).
 *
 * Creates the cloud-side pipeline that takes an initial snapshot of a
 * GitHub repo's working tree into relayfile:
 *
 *   user connects GitHub via Nango in dashboard
 *     → workspace_integrations row has connectionId + providerConfigKey
 *     → cloud POST /api/v1/github/clone { workspaceId, owner, repo, ref? }
 *     → route pulls integration row, calls Nango proxy GET /repos/{o}/{r}/tarball/{ref}
 *     → Nango injects fresh GitHub App installation token server-side
 *     → cloud streams tar.gz, walks entries, filters ignore-list
 *     → chunks writes into relayfile via @relayfile/sdk bulkWrite
 *     → writes /github/repos/{o}/{r}/meta.json LAST (signals complete)
 *     → merges /github/repos/index.json (read-merge-write, never blind overwrite)
 *     → records structured audit row in Postgres
 *
 * What this workflow DOES NOT cover (scoped out intentionally):
 *   - GitHub App private key / @octokit/auth-app (Nango holds it).
 *   - Commit history, PR metadata, issue metadata — those flow through
 *     sage's nango-integrations/github-app-oauth/syncs/*.ts independently.
 *   - Webhook re-clone on push (follow-up workflow, wires into existing
 *     v5-01 Nango webhook router).
 *
 * 80-to-100 hardening (mirrors v5-01 pattern):
 *   - regression-author writes a contract test BEFORE any impl lands,
 *     using in-process mock Nango proxy + mock relayfile HTTP servers
 *     plus a pre-captured small-repo.tar.gz fixture. No network.
 *   - Every impl step is followed by a verify-<wave> deterministic gate
 *     that greps literal strings (never \s — BSD grep).
 *   - test-fix-rerun triplet: first-run (soft) → fixer (test-only) → rerun (hard).
 *   - Global safety gates: no token leak in logs, no unbounded Promise.all,
 *     meta.json is written LAST, .git/node_modules/lockfiles are skipped,
 *     no hardcoded providerConfigKey, index.json updated by merge not blind
 *     overwrite, partial failure leaves meta.json missing.
 *
 * Repos touched:  cloud/packages/web
 * Requires before: v5-01 Slack proxy merged (reuses CLOUD_API_TOKEN + audit logger pattern).
 * Unblocks:        v5-03 sage github migration (reader-only) which depends
 *                  on the volume being populated.
 *
 * Independent-validation preconditions (flagged in final-review, not asserted
 * by the workflow because they require a real Nango tenant):
 *   1. User has connected a GitHub App installation via Nango.
 *   2. Nango's github-app-oauth provider config allows the
 *      /repos/{owner}/{repo}/tarball/{ref} endpoint through its proxy.
 *   3. @relayfile/sdk bulkWrite is reachable from cloud (verified in v5-02 E2E).
 */

import { workflow } from '@relayflows/core';

const READ_GLOBS = [
  'packages/web/app/api/v1/**',
  'packages/web/lib/integrations/**',
  'packages/web/lib/auth/**',
  'packages/web/lib/db/**',
  'packages/web/lib/**',
  'packages/web/tests/**',
  'tests/**',
  'packages/web/package.json',
  'packages/web/tsconfig.json',
  'packages/core/src/storage/**',
  'packages/core/src/code-sync/**',
  'packages/core/package.json',
  '../relayfile/packages/sdk/typescript/src/client.ts',
  '../relayfile/packages/sdk/typescript/src/types.ts',
  '../relayfile-adapters/packages/github/src/**',
  '../sage-slack-envelope/src/integrations/relayfile-reader.ts',
];

const DENY_GLOBS = [
  '.env*',
  'packages/web/.next/**',
  'packages/web/.open-next/**',
  '../sage-slack-envelope/src/proactive/**',
  '../relayfile/**',
  '../relay-cloud/**',
  'packages/web/app/api/v1/proxy/slack/**',
  'packages/web/lib/integrations/slack-proxy-*.ts',
];

async function main() {
  const result = await workflow('cloud-v5-03-github-clone-runner')
    .description('Add cloud-side GitHub clone runner (tarball via Nango → relayfile bulkWrite) — 80-to-100 hardened')
    .pattern('dag')
    .channel('wf-cloud-v5-03')
    .maxConcurrency(4)
    .timeout(7_200_000) // 2h — multi-module impl + mock servers + test-fix-rerun + regression

    // ----- agents --------------------------------------------------------

    .agent('lead', {
      cli: 'claude',
      role: 'Architect: specs the clone runner, Nango proxy contract, tarball walker, bulk-write chunker, route, audit, and review gate',
      preset: 'lead',
      retries: 1,
      permissions: {
        access: 'readonly',
        files: { read: READ_GLOBS, write: [], deny: DENY_GLOBS },
        exec: ['git diff *', 'git status', 'cat *', 'ls *', 'grep *'],
      },
    })

    .agent('regression-author', {
      cli: 'codex',
      role: 'Writes in-process mock servers + fixture + contract test BEFORE impl lands',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'tests/github-clone-runner.contract.test.ts',
            'tests/helpers/mock-nango-proxy-server.ts',
            'tests/helpers/mock-relayfile-server.ts',
            'tests/helpers/github-clone-db.ts',
            'tests/fixtures/github/build-small-repo-fixture.ts',
            'tests/fixtures/github/small-repo.tar.gz',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('nango-impl', {
      cli: 'codex',
      role: 'Implements the Nango proxy client wrapper (Bearer secret, never logs installation tokens)',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['packages/web/lib/integrations/github-nango-proxy-client.ts'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('tarball-impl', {
      cli: 'codex',
      role: 'Implements the in-memory tarball walker with ignore-list and encoding discrimination',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['packages/web/lib/integrations/github-tarball-walker.ts'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('writer-impl', {
      cli: 'codex',
      role: 'Implements the bulk-write chunker and meta.json-last orchestrator',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'packages/web/lib/integrations/github-clone-writer.ts',
            'packages/web/lib/integrations/github-clone-orchestrator.ts',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('route-impl', {
      cli: 'codex',
      role: 'Implements POST /api/v1/github/clone + schema + auth reuse',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'packages/web/app/api/v1/github/clone/route.ts',
            'packages/web/lib/integrations/github-clone-schema.ts',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('audit-impl', {
      cli: 'codex',
      role: 'Builds the clone audit logger — never logs tokens, never logs file contents',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['packages/web/lib/integrations/github-clone-audit.ts'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('test-impl', {
      cli: 'codex',
      role: 'Writes unit tests for tarball walker + bulk-write chunker + audit module',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: [
            'tests/github-tarball-walker.test.ts',
            'tests/github-clone-writer.test.ts',
            'tests/github-clone-audit.test.ts',
          ],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    .agent('test-fixer', {
      cli: 'codex',
      role: 'Reads failing test output and fixes ONLY test wiring (never product code)',
      preset: 'worker',
      retries: 2,
      permissions: {
        access: 'restricted',
        files: {
          read: READ_GLOBS,
          write: ['tests/**'],
          deny: DENY_GLOBS,
        },
        exec: [],
      },
    })

    // ----- read context --------------------------------------------------

    .step('read-package-deps', {
      type: 'deterministic',
      command: [
        'echo "=== packages/web deps ==="',
        'cat packages/web/package.json',
        'echo "=== packages/core deps (tar lives here) ==="',
        'cat packages/core/package.json 2>/dev/null || echo "(no packages/core)"',
        'echo "=== @relayfile/sdk installed? ==="',
        'node -e "try{const p=require(\'@relayfile/sdk/package.json\');console.log(p.name,p.version)}catch(e){console.log(\'MISSING\')}" 2>/dev/null || echo MISSING',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('read-workspace-integrations', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/workspace-integrations.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-nango-slack-pattern', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/nango-slack.ts',
      captureOutput: true,
      failOnError: true,
    })

    .step('read-nango-service', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/nango-service.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-slack-proxy-route', {
      type: 'deterministic',
      command: 'cat packages/web/app/api/v1/proxy/slack/route.ts 2>/dev/null || echo "NOT_FOUND (v5-01 not merged)"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-slack-proxy-auth', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/slack-proxy-auth.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-slack-proxy-audit', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/slack-proxy-audit.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-github-relayfile', {
      type: 'deterministic',
      command: 'cat packages/web/lib/integrations/github-relayfile.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-relayfile-client', {
      type: 'deterministic',
      command: 'cat ../relayfile/packages/sdk/typescript/src/client.ts 2>/dev/null | head -400 || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-tar-usage-precedent', {
      type: 'deterministic',
      command: [
        'echo "=== tar precedent in packages/core ==="',
        'cat packages/core/src/storage/code-transfer.ts 2>/dev/null | head -80 || echo "NOT_FOUND"',
        'echo "---"',
        'cat packages/core/src/code-sync/sync.ts 2>/dev/null | head -80 || echo "NOT_FOUND"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-test-runner-pattern', {
      type: 'deterministic',
      command: [
        'echo "=== dominant test runner ==="',
        'head -30 tests/slack-proxy-contract.test.ts 2>/dev/null || head -30 tests/slack-identity.test.ts 2>/dev/null || echo "NOT_FOUND"',
        'echo "---"',
        'grep -rln "node:test\\|@electric-sql/pglite\\|vitest" tests packages/web/tests 2>/dev/null | head -20 || echo "(none)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    .step('read-sage-relayfile-reader', {
      type: 'deterministic',
      command: 'grep -n "GITHUB_ROOT\\|buildRepoRoot\\|buildGitHubContentPath" ../sage-slack-envelope/src/integrations/relayfile-reader.ts 2>/dev/null || echo "NOT_FOUND"',
      captureOutput: true,
      failOnError: false,
    })

    .step('read-cloud-api-token', {
      type: 'deterministic',
      command: [
        'echo "=== CLOUD_API_TOKEN references (must already exist from v5-01) ==="',
        'grep -rn "CLOUD_API_TOKEN" packages/web/lib/integrations/ packages/web/app/api/v1/ 2>/dev/null | head -10 || echo "(not yet wired)"',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ----- lead: architecture spec ---------------------------------------

    .step('spec', {
      agent: 'lead',
      dependsOn: [
        'read-package-deps',
        'read-workspace-integrations',
        'read-nango-slack-pattern',
        'read-nango-service',
        'read-slack-proxy-route',
        'read-slack-proxy-auth',
        'read-slack-proxy-audit',
        'read-github-relayfile',
        'read-relayfile-client',
        'read-tar-usage-precedent',
        'read-test-runner-pattern',
        'read-sage-relayfile-reader',
        'read-cloud-api-token',
      ],
      task: `Design the GitHub clone runner pipeline for cloud's Next.js app.

Goal: a cloud-side POST /api/v1/github/clone route that takes a snapshot
of a GitHub repo's working tree and writes it into relayfile's virtual
filesystem under /github/repos/{owner}/{repo}/contents/{path}@{ref}.json.
The installation token never leaves Nango — we go through Nango's proxy
endpoint with our Nango secret. This workflow does NOT mint GitHub App
tokens directly, does NOT use @octokit/auth-app, does NOT store a private
key.

Existing context you must reuse:

  packages/web + packages/core deps (tar is in core):
  {{steps.read-package-deps.output}}

  workspace-integrations.ts (connectionId + providerConfigKey source):
  {{steps.read-workspace-integrations.output}}

  nango-slack.ts (proxyRequest helper pattern — we build a GitHub sibling):
  {{steps.read-nango-slack-pattern.output}}

  nango-service.ts:
  {{steps.read-nango-service.output}}

  v5-01 slack proxy route (pattern to mirror for auth + audit):
  {{steps.read-slack-proxy-route.output}}

  v5-01 slack proxy auth (reuse timingSafeEqual + CLOUD_API_TOKEN):
  {{steps.read-slack-proxy-auth.output}}

  v5-01 slack proxy audit (audit pattern — no payload leakage):
  {{steps.read-slack-proxy-audit.output}}

  github-relayfile.ts (existing github-from-relayfile reader — we do not edit):
  {{steps.read-github-relayfile.output}}

  @relayfile/sdk client (bulkWrite is our write primitive):
  {{steps.read-relayfile-client.output}}

  tar precedent in packages/core (pattern to mirror for in-memory extract):
  {{steps.read-tar-usage-precedent.output}}

  Test runner pattern:
  {{steps.read-test-runner-pattern.output}}

  Sage relayfile reader path constants (our writes must match these reads):
  {{steps.read-sage-relayfile-reader.output}}

  CLOUD_API_TOKEN wiring (must be live from v5-01):
  {{steps.read-cloud-api-token.output}}

Produce a spec covering:

1. Route shape (packages/web/app/api/v1/github/clone/route.ts)
   - POST only. Export async function POST(request: Request): Promise<Response>.
   - Request schema (Zod):
       workspaceId: string (cloud workspace UUID)
       owner: string  (GitHub owner, regex ^[a-zA-Z0-9-_.]+$)
       repo: string   (GitHub repo,  regex ^[a-zA-Z0-9-_.]+$)
       ref?: string   (branch/tag/sha, default 'HEAD')
   - Response envelope:
       success: { ok: true, data: { filesWritten: number, headSha: string, durationMs: number } }
       error:   { ok: false, error: string, code: Code }
     where Code = 'unauthorized' | 'forbidden' | 'not_found' | 'upstream_error' | 'bad_request' | 'partial_failure'
   - Status codes: 200 ok, 400 bad schema, 401 missing auth, 403 wrong token, 404 missing workspace or repo not in installation, 502 Nango/GitHub/relayfile upstream failure.
   - NOTE: this is a write route. It is NOT rate-limited per-channel — repo clones are slow by nature. A single-flight lock keyed on (workspaceId, owner, repo) prevents concurrent clones of the same repo.

2. Auth (reuse v5-01 slack-proxy-auth.ts if it exports a generic helper;
   else copy the pattern into packages/web/lib/integrations/github-clone-schema.ts
   as a small wrapper — do NOT duplicate the timingSafeEqual logic).
   - Require header "Authorization: Bearer <CLOUD_API_TOKEN>".
   - Missing header → 401 'unauthorized'. Wrong token → 403 'unauthorized'.
   - Log every auth failure via github-clone-audit (workspaceId='(unknown)').

3. Workspace resolution
   - workspaceId is the cloud workspace UUID.
   - Look up workspace_integrations row WHERE provider='github'.
   - If not present → 404 'not_found'.
   - The row provides connectionId + providerConfigKey. Pass BOTH to the
     nango proxy call, NEVER hardcode either.

4. Nango proxy client (packages/web/lib/integrations/github-nango-proxy-client.ts)
   - Signature:
       export async function nangoGithubTarball(input: {
         connectionId: string;
         providerConfigKey: string;
         owner: string;
         repo: string;
         ref: string;
         signal?: AbortSignal;
       }): Promise<{ stream: ReadableStream<Uint8Array>; headSha: string; defaultBranch: string; contentLength?: number }>
   - Under the hood:
       POST https://api.nango.dev/proxy
       Authorization: Bearer \${NANGO_SECRET_KEY}
       Connection-Id: \${connectionId}
       Provider-Config-Key: \${providerConfigKey}
       Body: { method: 'GET', endpoint: '/repos/{owner}/{repo}/tarball/{ref}' }
       (or whatever shape matches nango-slack.ts proxyRequest helper — match the existing pattern)
   - Response is gzipped tarball. Stream, do not buffer eagerly.
   - headSha is extracted from the Nango proxy response header 'x-github-sha' OR from a follow-up GET /repos/{o}/{r} meta call (one request, small). Implementer decides — MUST document the choice in a top-of-file comment.
   - defaultBranch similarly from meta call.
   - NEVER log the Nango secret or any Authorization header value.
   - NEVER log response bytes.

5. Tarball walker (packages/web/lib/integrations/github-tarball-walker.ts)
   - Signature:
       export interface WalkedEntry {
         path: string;        // normalized repo-relative path, no leading slash, no top-level dir
         content: Buffer;     // file bytes (binary-safe)
         isBinary: boolean;
         size: number;
       }
       export async function* walkGithubTarball(stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream): AsyncGenerator<WalkedEntry>
   - Uses the 'tar' package from packages/core (or add to packages/web deps
     — prefer reusing the core package via the workspace import if one exists).
   - Strips the leading tarball directory (GitHub wraps as '{owner}-{repo}-{sha}/').
   - Ignore-list (hard-coded constants exported for tests):
       export const GITHUB_CLONE_IGNORE_DIRS = ['.git', 'node_modules', '.next', '.open-next', 'dist', 'build', 'coverage', '.turbo', '.yarn'];
       export const GITHUB_CLONE_IGNORE_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
       export const GITHUB_CLONE_IGNORE_EXTS = ['.min.js', '.min.css', '.map'];
   - Binary detection: if the first 8KB of content contains a NUL byte OR
     if the filename matches a known-binary extension (.png, .jpg, .jpeg,
     .gif, .webp, .ico, .pdf, .zip, .tar, .gz, .woff, .woff2, .ttf, .otf,
     .eot, .mp4, .mov, .wasm), treat as binary → base64 encode.
   - Text files: decode as utf-8. If decoding fails (invalid UTF-8), fall
     back to binary.
   - Max file size: 1 MiB. Files exceeding cap are YIELDED with a flag
     (so the caller can skip), not swallowed silently — this is tested.
   - Export the max constant:
       export const GITHUB_CLONE_MAX_FILE_BYTES = 1024 * 1024;

6. Bulk-write chunker (packages/web/lib/integrations/github-clone-writer.ts)
   - Signature:
       export interface ChunkedWriteInput {
         client: RelayFileClient;
         workspaceId: string;
         files: Array<{ path: string; content: string; contentType?: string; encoding: 'utf-8' | 'base64' }>;
         chunkSize?: number;       // default 200
         maxConcurrent?: number;   // default 4
         signal?: AbortSignal;
       }
       export interface ChunkedWriteResult {
         written: number;
         errors: Array<{ path: string; code: string; message: string }>;
       }
       export async function chunkedBulkWrite(input: ChunkedWriteInput): Promise<ChunkedWriteResult>
   - Concurrency via an in-module semaphore (no p-limit dep). Max 4 parallel bulkWrite calls.
   - If ANY chunk returns errorCount > 0, the call does NOT throw — it
     accumulates errors and returns them. Orchestrator decides if the
     clone is partial.
   - NEVER unbounded Promise.all. The semaphore is tested.

7. Clone orchestrator (packages/web/lib/integrations/github-clone-orchestrator.ts)
   - Signature:
       export interface CloneRequest {
         workspaceId: string;
         owner: string;
         repo: string;
         ref?: string;
       }
       export interface CloneOutcome {
         filesWritten: number;
         headSha: string;
         defaultBranch: string;
         durationMs: number;
         skipped: Array<{ path: string; reason: 'binary' | 'too-large' | 'ignored' }>;
         errors: Array<{ path: string; code: string; message: string }>;
       }
       export async function runGithubClone(deps: {
         nango: typeof nangoGithubTarball;
         writer: typeof chunkedBulkWrite;
         relayfile: RelayFileClient;
         connectionId: string;
         providerConfigKey: string;
       }, req: CloneRequest): Promise<CloneOutcome>
   - Order of operations (THIS IS THE HARDEST INVARIANT — tested):
     a. Start wall clock.
     b. nango.tarball() → stream, headSha, defaultBranch.
     c. Walk tarball → collect entries (generator yields, orchestrator
        buffers into an array bounded by a memory guard — if cumulative
        size > 200 MiB, abort with code 'too_large_repo').
     d. Build the FileWriteRequest array under
        /github/repos/{encodeURIComponent(owner)}/{encodeURIComponent(repo)}/contents/{entry.path}@{headSha}.json
        — the @sha suffix IS REQUIRED (matches sage reader).
     e. Call chunkedBulkWrite. Collect errors.
     f. IF errors.length === 0 AND filesWritten > 0:
          - Read current /github/repos/index.json (treat 404 as empty list).
          - Merge this repo entry into the list (upsert by {owner, repo}).
          - Write the merged list back.
          - Write /github/repos/{owner}/{repo}/meta.json with
            { defaultBranch, headSha, clonedAt: ISO string, filesWritten,
              cloneSource: 'github-tarball-via-nango' }.
        ELSE:
          - DO NOT write meta.json. DO NOT update index.json.
          - Return CloneOutcome with errors populated. Consumers detect
            partial clone by meta.json absence.
     g. Return outcome with durationMs.
   - The order {contents → index.json → meta.json LAST} is the partial-failure
     contract. Tested.

8. Audit logger (packages/web/lib/integrations/github-clone-audit.ts)
   - Entry schema (exported):
       export interface GithubCloneAuditEntry {
         workspaceId: string;
         owner: string;
         repo: string;
         ref: string;
         httpStatus: number;
         outcome: 'ok' | 'unauthorized' | 'forbidden' | 'not_found' | 'upstream_error' | 'bad_request' | 'partial_failure';
         filesWritten: number;
         durationMs: number;
         errorCount: number;
       }
       export function recordGithubCloneCall(entry: GithubCloneAuditEntry): void;
   - Use the dominant logger pattern already in packages/web (match v5-01 slack-proxy-audit.ts).
   - NEVER include token, Nango secret, tarball bytes, file contents,
     Authorization header, connectionId, or providerConfigKey in the log.
   - MUST NOT accept spread args.

9. Regression test (tests/github-clone-runner.contract.test.ts — written
   FIRST by regression-author, before any impl)
   Spec:
   - Boot two in-process HTTP servers on random ports via http.createServer:
       * mock-nango-proxy-server.ts — asserts Authorization: Bearer matches
         a test NANGO_SECRET_KEY, asserts the request body specifies
         /repos/acme/demo/tarball/main, streams back
         tests/fixtures/github/small-repo.tar.gz.
       * mock-relayfile-server.ts — records every POST /v1/workspaces/.../fs/bulk
         into an array (workspace-scoped) and returns { written, errorCount: 0, errors: [] }.
         Also responds to single-file writes for meta.json + index.json.
   - Pre-capture the fixture tarball via tests/fixtures/github/build-small-repo-fixture.ts
     (this is a helper that builds a deterministic 8-entry tar.gz in memory
     and writes it to disk). The fixture MUST include:
       * README.md (text)
       * src/hello.ts (text)
       * src/logo.png (binary)
       * package.json (text)
       * package-lock.json (must be SKIPPED by walker)
       * .git/HEAD (must be SKIPPED by walker)
       * node_modules/foo/index.js (must be SKIPPED by walker)
       * a file over 1 MiB (must be YIELDED with too-large flag)
   - The orchestrator is driven directly (not via HTTP route) for the
     contract cases 1-7, then via the real route handler for cases 8-10.
   - If PGlite is available (check read-test-runner-pattern), use it for
     the audit assertion. Else use an inline fake.

   Required cases (EXACT test names):

     1. 'full clone of small fixture writes expected 3 text files + 1 binary'
        - asserts 4 writes: README.md, src/hello.ts, package.json, src/logo.png
        - asserts src/logo.png encoding is 'base64'
        - asserts src/hello.ts encoding is 'utf-8'
        - asserts paths match /github/repos/acme/demo/contents/<path>@<sha>.json
        - asserts 3 files skipped: package-lock.json, .git/HEAD, node_modules/foo/index.js
        - asserts 1 file skipped with reason 'too-large'

     2. 'meta.json is written LAST — after all contents + index.json'
        - asserts mock-relayfile-server call order: all /contents/ writes,
          then /index.json, then /meta.json
        - asserts meta.json body has { defaultBranch, headSha, clonedAt, filesWritten, cloneSource }

     3. 'connectionId and providerConfigKey come from dependency injection, not hardcoded'
        - reads packages/web/lib/integrations/github-clone-orchestrator.ts from disk
        - asserts file does NOT contain the substring 'sage-github'
        - asserts file does NOT contain the substring 'github-app-oauth' as a literal fallback
          (it may appear in comments; the check is for: an argument default like
           "providerConfigKey = 'github-app-oauth'" or a require-style fallback.
           Implementer: use the exact line-pattern grep from the verify gate.)

     4. 'Authorization header to Nango is Bearer + NANGO_SECRET_KEY and never the installation token'
        - mock-nango-proxy-server captures every Authorization header value
        - asserts all captured values start with 'Bearer '
        - asserts NONE contain 'ghs_' (GitHub installation token prefix)
        - asserts NONE contain 'ghp_' (PAT prefix)

     5. 'partial failure (mock relayfile returns errors on 2nd chunk) leaves meta.json UNWRITTEN'
        - configure mock-relayfile-server to return errorCount: 1 on the 2nd bulkWrite
        - assert outcome.errors.length > 0
        - assert mock-relayfile-server recorded NO write to meta.json
        - assert mock-relayfile-server recorded NO write to index.json

     6. 'second clone merges index.json (does not overwrite)'
        - seed mock-relayfile-server with existing index.json containing { owner: 'other', repo: 'existing' }
        - run clone for acme/demo
        - assert final index.json GET returns both entries
        - assert the write was a read → merge → write, not a blind PUT

     7. 'bulkWrite chunker caps concurrency at 4'
        - instrument mock-relayfile-server with a concurrent-calls counter
        - feed the orchestrator a 1000-file fixture (reuse build-small-repo-fixture.ts with a size knob)
        - assert peak concurrent bulkWrite calls observed is <= 4
        - assert total calls = ceil(1000 / 200) = 5

     8. 'route: missing Authorization returns 401 unauthorized'
     9. 'route: wrong CLOUD_API_TOKEN returns 403 unauthorized'
    10. 'route: unknown workspaceId returns 404 not_found'

   Non-case assertion that lives in the test file:
     * Source-defense grep: import fs and assert the walker, writer,
       orchestrator, and nango-proxy-client source files do NOT contain
       any of: 'console.log(.*token', 'console.log(.*secret',
       'console.log(.*Authorization', '.slice(0,10).*token'.

10. Unit tests (written by test-impl in Wave B, NOT Wave 0)
    - tests/github-tarball-walker.test.ts — 10+ cases per file type, encoding, ignore-list, too-large, leading-dir strip, invalid-utf8 fallback.
    - tests/github-clone-writer.test.ts — chunking math, error accumulation, semaphore bound, aborted signal propagation.
    - tests/github-clone-audit.test.ts — records each outcome, never logs tokens/secrets/connectionId/Authorization.

11. Wave plan:
    Wave 0 (after spec): regression test authoring (regression-author agent)
                         + fixture build (deterministic step that runs the fixture builder)
    Wave A (all parallel after verify-regression-test):
      - impl-nango-proxy-client
      - impl-tarball-walker
      - impl-writer
      - impl-route
      - impl-audit
    Wave B (after all Wave A verifies pass):
      - impl-tests (unit tests for walker, writer, audit)
    Wave C (after impl-tests):
      - typecheck
      - run-tests triplet (first-run, fix, rerun)
      - verify-no-token-leak
      - verify-ignore-list
      - verify-meta-last
      - verify-bounded-concurrency
      - verify-no-hardcoded-provider-key
    Wave D: final-review

For each worker, list exact files written and cross-worker imported symbols.
Be explicit about which module owns which constant.

End with: SPEC_COMPLETE`,
      verification: { type: 'output_contains', value: 'SPEC_COMPLETE' },
    })

    // ----- Wave 0: regression test + fixture first -----------------------

    .step('write-regression-tests', {
      agent: 'regression-author',
      dependsOn: ['spec'],
      task: `Write the contract test + mock servers + fixture builder per the spec.

Spec:
{{steps.spec.output}}

Create these files (write to disk only, DO NOT print file contents to stdout):

  1. tests/fixtures/github/build-small-repo-fixture.ts
     - Uses node:zlib + the 'tar' package to build a deterministic tar.gz
       in memory, then writes it to tests/fixtures/github/small-repo.tar.gz.
     - Exports a buildFixture({ extraFiles?: number }) function the test can
       call to regenerate.
     - Has a main function so it can be run standalone:
         npx tsx tests/fixtures/github/build-small-repo-fixture.ts
     - Required entries (see spec case 1):
         acme-demo-abc123/README.md  (text, "Hello World\\n")
         acme-demo-abc123/src/hello.ts  (text, "export const hello = 'world';\\n")
         acme-demo-abc123/src/logo.png  (binary — 16 bytes of PNG magic + zeros)
         acme-demo-abc123/package.json  (text, '{"name":"demo"}\\n')
         acme-demo-abc123/package-lock.json  (text, '{}')
         acme-demo-abc123/.git/HEAD  (text, "ref: refs/heads/main\\n")
         acme-demo-abc123/node_modules/foo/index.js  (text, "module.exports = 1;\\n")
         acme-demo-abc123/big.bin  (binary, EXACTLY 1_048_577 bytes = 1 MiB + 1)
     - Total size well under 10 MiB uncompressed.

  2. tests/fixtures/github/small-repo.tar.gz
     - Run the builder at author time so this file lands on disk. The
       deterministic step that follows this one will rebuild it if missing.

  3. tests/helpers/mock-nango-proxy-server.ts
     - Exports startMockNangoProxy({ secret, fixturePath }: { secret: string; fixturePath: string }): Promise<{
         url: string;
         capturedRequests: Array<{ authorization: string; connectionId: string; providerConfigKey: string; endpoint: string }>;
         close: () => Promise<void>;
       }>
     - Uses http.createServer listening on 127.0.0.1:0 (random port).
     - Validates Authorization: Bearer <secret>. On mismatch, returns 401.
     - For endpoint matching /repos/:owner/:repo/tarball/:ref, streams back
       the tar.gz file with Content-Type: application/x-gzip and a header
       x-github-sha: 'abc123'.
     - For endpoint /repos/:owner/:repo (meta), returns JSON
       { default_branch: 'main', head_sha: 'abc123' } (defaultBranch + headSha source path).

  4. tests/helpers/mock-relayfile-server.ts
     - Exports startMockRelayfile(): Promise<{
         url: string;
         writes: Array<{ path: string; content: string; encoding: string; contentType?: string }>;
         seed: (path: string, content: string) => void;
         setErrorOnBulkNumber: (n: number, errorCount: number) => void;
         concurrentPeak: () => number;
         close: () => Promise<void>;
       }>
     - Minimal relayfile surface: POST /v1/workspaces/:ws/fs/bulk (bulk write),
       POST /v1/workspaces/:ws/fs/write (single write for meta/index),
       GET /v1/workspaces/:ws/fs/read?path=... (for read-merge-write of index.json).
     - Tracks in-flight bulk calls for concurrentPeak().
     - setErrorOnBulkNumber lets case 5 simulate a mid-clone failure.
     - Accepts the RelayFileClient's Authorization header but does NOT validate
       it — we're testing cloud's clone logic, not relayfile's auth.

  5. tests/helpers/github-clone-db.ts
     - If the existing test-runner already uses PGlite (check the dominant
       pattern from read-test-runner-pattern), export createGithubCloneTestDb()
       that returns { db, seedWorkspace, cleanup }.
     - Minimum schema: workspace_integrations(workspace_id uuid, provider text,
       connection_id text, provider_config_key text).
     - If no PGlite in repo, export a tiny in-memory fake with the same
       surface the route's workspace-integrations lookup calls.

  6. tests/github-clone-runner.contract.test.ts
     - Uses node:test if that's the dominant runner, else vitest.
     - Boots both mock servers in beforeEach, closes in afterEach.
     - Cases 1-7 drive the orchestrator directly (runGithubClone(deps, req)).
     - Cases 8-10 drive the real route handler by importing POST from
       packages/web/app/api/v1/github/clone/route.ts and calling it with
       real Request objects.
     - Case test names MUST be EXACTLY as listed in the spec (case 1 through case 10).
     - Source-defense sub-test: read walker/writer/orchestrator/nango-proxy-client
       files via node:fs and assert they do NOT contain:
         * 'console.log' lines that include 'token', 'secret', or 'Authorization'
         * the literal string 'sage-github' or 'ghs_' or 'ghp_'

Rules:
  - The contract test MUST FAIL until impl lands (tests-first — intentional).
  - Match the dominant test runner style from tests/slack-proxy-contract.test.ts.
  - No new runtime deps in packages/web/package.json.
  - Mocks go in tests/helpers/, fixtures in tests/fixtures/github/.

Write files to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'tests/github-clone-runner.contract.test.ts' },
    })

    .step('build-fixture-if-missing', {
      type: 'deterministic',
      dependsOn: ['write-regression-tests'],
      command: [
        'test -f tests/fixtures/github/small-repo.tar.gz || npx tsx tests/fixtures/github/build-small-repo-fixture.ts',
        'test -f tests/fixtures/github/small-repo.tar.gz',
        'echo FIXTURE_READY',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-regression-test', {
      type: 'deterministic',
      dependsOn: ['build-fixture-if-missing'],
      command: [
        'test -f tests/github-clone-runner.contract.test.ts',
        'test -f tests/helpers/mock-nango-proxy-server.ts',
        'test -f tests/helpers/mock-relayfile-server.ts',
        'test -f tests/helpers/github-clone-db.ts',
        'test -f tests/fixtures/github/build-small-repo-fixture.ts',
        'test -f tests/fixtures/github/small-repo.tar.gz',
        'grep -q "full clone of small fixture writes expected 3 text files + 1 binary" tests/github-clone-runner.contract.test.ts',
        'grep -q "meta.json is written LAST" tests/github-clone-runner.contract.test.ts',
        'grep -q "connectionId and providerConfigKey come from dependency injection" tests/github-clone-runner.contract.test.ts',
        'grep -q "Authorization header to Nango is Bearer" tests/github-clone-runner.contract.test.ts',
        'grep -q "partial failure" tests/github-clone-runner.contract.test.ts',
        'grep -q "second clone merges index.json" tests/github-clone-runner.contract.test.ts',
        'grep -q "bulkWrite chunker caps concurrency at 4" tests/github-clone-runner.contract.test.ts',
        'grep -q "missing Authorization returns 401 unauthorized" tests/github-clone-runner.contract.test.ts',
        'grep -q "wrong CLOUD_API_TOKEN returns 403 unauthorized" tests/github-clone-runner.contract.test.ts',
        'grep -q "unknown workspaceId returns 404 not_found" tests/github-clone-runner.contract.test.ts',
        'grep -q "startMockNangoProxy" tests/helpers/mock-nango-proxy-server.ts',
        'grep -q "startMockRelayfile" tests/helpers/mock-relayfile-server.ts',
        'grep -q "concurrentPeak" tests/helpers/mock-relayfile-server.ts',
        'echo REGRESSION_TEST_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- Wave A (parallel) ---------------------------------------------

    .step('impl-nango-proxy-client', {
      agent: 'nango-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the Nango proxy client wrapper.

Spec:
{{steps.spec.output}}

Create: packages/web/lib/integrations/github-nango-proxy-client.ts

Exports (used by the orchestrator):
  export async function nangoGithubTarball(input: {
    connectionId: string;
    providerConfigKey: string;
    owner: string;
    repo: string;
    ref: string;
    signal?: AbortSignal;
  }): Promise<{
    stream: NodeJS.ReadableStream;
    headSha: string;
    defaultBranch: string;
    contentLength?: number;
  }>;

Hard rules (verified by a gate after this step):
  - File imports process.env.NANGO_SECRET_KEY (reading is OK; logging is NOT).
  - File does NOT contain any of:
      console.log(...token...)
      console.log(...secret...)
      console.log(...Authorization...)
      token.slice(
      secret.slice(
  - File does NOT contain the literal 'sage-github'.
  - File does NOT contain the literal 'github-app-oauth' as a default value
    (a comment mention is OK, but do NOT write '= "github-app-oauth"' anywhere).
  - File does NOT hard-code a default for providerConfigKey — it MUST come
    from the caller.
  - File contains 'Bearer ' as a string literal (for the Authorization header).
  - Network call is plain global fetch (no axios, no new deps).

Nango proxy contract (match packages/web/lib/integrations/nango-slack.ts style):
  - Endpoint: https://api.nango.dev/proxy
  - Headers: Authorization: Bearer \${process.env.NANGO_SECRET_KEY}, Connection-Id: \${connectionId}, Provider-Config-Key: \${providerConfigKey}
  - Body: { method: 'GET', endpoint: '/repos/{owner}/{repo}/tarball/{ref}' }
  - The response is a gzipped tar stream. Return the Web ReadableStream as-is
    (or convert to Node stream via Readable.fromWeb). The walker accepts both.

For headSha + defaultBranch:
  - Issue a second Nango proxy call: method 'GET', endpoint '/repos/{owner}/{repo}'.
  - Parse the JSON response for default_branch + (a HEAD SHA from any convenient source
    — commits[0].sha via /repos/{o}/{r}/commits/{ref} is simplest, ONE extra call).
  - Document the choice in a top-of-file comment.

For tests: the mock Nango server in tests/helpers/mock-nango-proxy-server.ts
uses a non-https base URL. The client MUST respect an override:
  - Read process.env.NANGO_PROXY_URL_OVERRIDE first, fall back to 'https://api.nango.dev/proxy'.
  - This lets the test point the client at the mock server without mocking global fetch.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/github-nango-proxy-client.ts' },
    })

    .step('verify-nango-proxy-client', {
      type: 'deterministic',
      dependsOn: ['impl-nango-proxy-client'],
      command: [
        'test -f packages/web/lib/integrations/github-nango-proxy-client.ts',
        'grep -q "nangoGithubTarball" packages/web/lib/integrations/github-nango-proxy-client.ts',
        'grep -q "NANGO_SECRET_KEY" packages/web/lib/integrations/github-nango-proxy-client.ts',
        'grep -q "NANGO_PROXY_URL_OVERRIDE" packages/web/lib/integrations/github-nango-proxy-client.ts',
        'grep -q "Bearer " packages/web/lib/integrations/github-nango-proxy-client.ts',
        'grep -q "Connection-Id" packages/web/lib/integrations/github-nango-proxy-client.ts',
        'grep -q "Provider-Config-Key" packages/web/lib/integrations/github-nango-proxy-client.ts',
        '! grep -q "sage-github" packages/web/lib/integrations/github-nango-proxy-client.ts',
        '! grep -q "= \\"github-app-oauth\\"" packages/web/lib/integrations/github-nango-proxy-client.ts',
        '! grep -q "= .github-app-oauth." packages/web/lib/integrations/github-nango-proxy-client.ts',
        '! grep -q "token.slice" packages/web/lib/integrations/github-nango-proxy-client.ts',
        '! grep -q "secret.slice" packages/web/lib/integrations/github-nango-proxy-client.ts',
        '! grep -n "console.log" packages/web/lib/integrations/github-nango-proxy-client.ts | grep -Ei "token|secret|authorization"',
        'echo NANGO_PROXY_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-tarball-walker', {
      agent: 'tarball-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the in-memory tarball walker.

Spec:
{{steps.spec.output}}

Create: packages/web/lib/integrations/github-tarball-walker.ts

Required exports (used by orchestrator + tests):
  export const GITHUB_CLONE_IGNORE_DIRS: readonly string[];
  export const GITHUB_CLONE_IGNORE_FILES: readonly string[];
  export const GITHUB_CLONE_IGNORE_EXTS: readonly string[];
  export const GITHUB_CLONE_MAX_FILE_BYTES: number; // 1 MiB
  export const GITHUB_CLONE_BINARY_EXTS: readonly string[];

  export type WalkSkipReason = 'binary-oversized' | 'ignored' | 'too-large';
  export interface WalkedEntry {
    repoPath: string;           // relative to repo root, no leading slash
    content: Buffer;
    isBinary: boolean;
    size: number;
    skipped?: WalkSkipReason;   // present when the walker wants to signal skip
  }

  export async function* walkGithubTarball(
    stream: NodeJS.ReadableStream,
  ): AsyncGenerator<WalkedEntry>;

Hard rules (verified after this step):
  - Uses the 'tar' package (already in packages/core; if packages/web does
    not have it, add it to packages/web/package.json dependencies — use
    the EXACT version pinned in packages/core). Check first, then install
    or reuse accordingly.
  - Strips the leading directory (GitHub wraps as {owner}-{repo}-{sha}/).
    repoPath MUST NOT start with that prefix.
  - Ignore-list values EXACTLY per spec (the test asserts these literals):
      GITHUB_CLONE_IGNORE_DIRS = ['.git', 'node_modules', '.next', '.open-next', 'dist', 'build', 'coverage', '.turbo', '.yarn']
      GITHUB_CLONE_IGNORE_FILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']
      GITHUB_CLONE_IGNORE_EXTS = ['.min.js', '.min.css', '.map']
  - Binary detection:
      GITHUB_CLONE_BINARY_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mov', '.wasm']
      AND: if extension not in list, inspect first 8 KiB for NUL byte.
  - Too-large: file size > GITHUB_CLONE_MAX_FILE_BYTES → yield entry with
    skipped: 'too-large' and content: Buffer.alloc(0) (do NOT buffer the full file).
    (implementation hint: use a streaming size counter on the tar entry;
     once over the cap, discard further chunks and yield the skip entry.)
  - Ignored files (matched against ignore lists) are yielded with
    skipped: 'ignored' and content: empty buffer.
  - The walker MUST NOT write to stdout or log tarball contents.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/github-tarball-walker.ts' },
    })

    .step('verify-tarball-walker', {
      type: 'deterministic',
      dependsOn: ['impl-tarball-walker'],
      command: [
        'test -f packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "walkGithubTarball" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "GITHUB_CLONE_IGNORE_DIRS" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "GITHUB_CLONE_IGNORE_FILES" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "GITHUB_CLONE_IGNORE_EXTS" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "GITHUB_CLONE_BINARY_EXTS" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "GITHUB_CLONE_MAX_FILE_BYTES" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "\\.git" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "node_modules" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "package-lock.json" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "1048576\\|1024 \\* 1024\\|1_048_576" packages/web/lib/integrations/github-tarball-walker.ts',
        '! grep -n "console.log" packages/web/lib/integrations/github-tarball-walker.ts | grep -Ei "content|buffer|token"',
        'echo TARBALL_WALKER_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-writer', {
      agent: 'writer-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the bulk-write chunker + clone orchestrator.

Spec:
{{steps.spec.output}}

Create:
  packages/web/lib/integrations/github-clone-writer.ts
  packages/web/lib/integrations/github-clone-orchestrator.ts

Required exports in github-clone-writer.ts:
  export const GITHUB_CLONE_CHUNK_SIZE: number;      // 200
  export const GITHUB_CLONE_MAX_CONCURRENT: number;  // 4
  export interface ChunkedWriteInput { ... per spec ... }
  export interface ChunkedWriteResult { written: number; errors: Array<{ path: string; code: string; message: string }>; }
  export async function chunkedBulkWrite(input: ChunkedWriteInput): Promise<ChunkedWriteResult>;

Required exports in github-clone-orchestrator.ts:
  export interface CloneRequest { workspaceId: string; owner: string; repo: string; ref?: string; }
  export interface CloneOutcome { filesWritten: number; headSha: string; defaultBranch: string; durationMs: number; skipped: Array<{ path: string; reason: 'binary' | 'too-large' | 'ignored' }>; errors: Array<{ path: string; code: string; message: string }>; }
  export interface CloneDeps { nango: typeof nangoGithubTarball; writer: typeof chunkedBulkWrite; relayfile: RelayFileClient; connectionId: string; providerConfigKey: string; }
  export async function runGithubClone(deps: CloneDeps, req: CloneRequest): Promise<CloneOutcome>;

Hard rules (verified after this step):
  - Writer: concurrency is enforced by a module-level semaphore (integer counter).
    NO unbounded Promise.all over all chunks. NO p-limit dep.
  - Writer: the file contains the literal 'GITHUB_CLONE_MAX_CONCURRENT' and
    a guard like 'while (inFlight >= GITHUB_CLONE_MAX_CONCURRENT)' or similar.
  - Orchestrator: the write-order is verifiable by reading the source —
    the code block that writes meta.json must textually come AFTER the block
    that writes index.json, which must come AFTER the chunkedBulkWrite call.
    A comment '// meta.json LAST — partial-failure contract' on the meta write.
  - Orchestrator: if chunkedBulkWrite returns errors.length > 0, the code
    path MUST skip writing index.json AND meta.json. There must be a
    grep-visible guard like 'if (writeResult.errors.length === 0)' wrapping
    both writes.
  - Orchestrator: connectionId and providerConfigKey come from the deps
    argument. Neither is read from process.env. Neither has a default value.
  - Orchestrator: the relayfile path uses buildPath helpers that encode
    owner/repo with encodeURIComponent. Write a small helper
    buildContentPath(owner, repo, entryPath, headSha) and reuse it.
  - Orchestrator: the cloneSource constant in meta.json is the literal
    'github-tarball-via-nango'.
  - No console.log of token, secret, connectionId, providerConfigKey, or
    file contents anywhere in either file.

Imports:
  import { nangoGithubTarball } from './github-nango-proxy-client.js';
  import { walkGithubTarball, GITHUB_CLONE_MAX_FILE_BYTES } from './github-tarball-walker.js';
  import type { RelayFileClient } from '@relayfile/sdk';

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/github-clone-orchestrator.ts' },
    })

    .step('verify-writer', {
      type: 'deterministic',
      dependsOn: ['impl-writer'],
      command: [
        'test -f packages/web/lib/integrations/github-clone-writer.ts',
        'test -f packages/web/lib/integrations/github-clone-orchestrator.ts',
        'grep -q "chunkedBulkWrite" packages/web/lib/integrations/github-clone-writer.ts',
        'grep -q "GITHUB_CLONE_CHUNK_SIZE" packages/web/lib/integrations/github-clone-writer.ts',
        'grep -q "GITHUB_CLONE_MAX_CONCURRENT" packages/web/lib/integrations/github-clone-writer.ts',
        '! grep -q "Promise.all" packages/web/lib/integrations/github-clone-writer.ts',
        '! grep -q "p-limit\\|pLimit" packages/web/lib/integrations/github-clone-writer.ts',
        'grep -q "runGithubClone" packages/web/lib/integrations/github-clone-orchestrator.ts',
        'grep -q "meta.json LAST" packages/web/lib/integrations/github-clone-orchestrator.ts',
        'grep -q "github-tarball-via-nango" packages/web/lib/integrations/github-clone-orchestrator.ts',
        'grep -q "errors.length === 0" packages/web/lib/integrations/github-clone-orchestrator.ts',
        'grep -q "encodeURIComponent" packages/web/lib/integrations/github-clone-orchestrator.ts',
        '! grep -q "sage-github" packages/web/lib/integrations/github-clone-orchestrator.ts',
        '! grep -q "= .github-app-oauth." packages/web/lib/integrations/github-clone-orchestrator.ts',
        '! grep -n "console.log" packages/web/lib/integrations/github-clone-orchestrator.ts | grep -Ei "token|secret|connection|authorization"',
        'echo WRITER_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-route', {
      agent: 'route-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the POST /api/v1/github/clone route + schema.

Spec:
{{steps.spec.output}}

Create:
  packages/web/app/api/v1/github/clone/route.ts
  packages/web/lib/integrations/github-clone-schema.ts

Hard rules (verified after this step):
  - route.ts exports: async function POST(request: Request): Promise<Response>.
  - route.ts imports runGithubClone from '@/lib/integrations/github-clone-orchestrator'.
  - route.ts imports nangoGithubTarball from '@/lib/integrations/github-nango-proxy-client'.
  - route.ts imports chunkedBulkWrite from '@/lib/integrations/github-clone-writer'.
  - route.ts imports recordGithubCloneCall from '@/lib/integrations/github-clone-audit'.
  - route.ts reads workspace_integrations via the existing workspace-integrations
    helper module (do NOT invent a new one). If the row is missing → 404 not_found.
  - route.ts validates the body with Zod. Missing/invalid fields → 400 bad_request.
  - Auth: reuse v5-01's slack-proxy-auth.ts helper if it exports a general
    verifyBearer function; otherwise import timingSafeEqual from 'node:crypto'
    directly and compare against process.env.CLOUD_API_TOKEN. NO plain-string
    ===. The file MUST contain 'timingSafeEqual' (either directly or via
    the shared helper it imports).
  - route.ts wraps the orchestrator call in try/catch and maps errors to
    the stable envelope.
  - route.ts records an audit entry on every outcome path.
  - route.ts does NOT import from 'nango-slack' (that is Slack-specific —
    use the GitHub proxy client instead).
  - Single-flight lock: use a Map<string, Promise<...>> keyed on
    \`\${workspaceId}:\${owner}/\${repo}\`. If a clone is in-flight for the same
    key, the second request awaits the same promise (same response body).

github-clone-schema.ts exports:
  export const GithubCloneRequestSchema = z.object({ ... });
  export type GithubCloneRequest = z.infer<typeof GithubCloneRequestSchema>;
  export type GithubCloneResponse = { ok: true; data: { filesWritten: number; headSha: string; durationMs: number } } | { ok: false; error: string; code: 'unauthorized' | 'forbidden' | 'not_found' | 'upstream_error' | 'bad_request' | 'partial_failure' };

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/app/api/v1/github/clone/route.ts' },
    })

    .step('verify-route', {
      type: 'deterministic',
      dependsOn: ['impl-route'],
      command: [
        'test -f packages/web/app/api/v1/github/clone/route.ts',
        'test -f packages/web/lib/integrations/github-clone-schema.ts',
        'grep -q "export async function POST" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "github-clone-orchestrator" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "github-nango-proxy-client" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "github-clone-writer" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "github-clone-audit" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "workspace-integrations" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "timingSafeEqual\\|slack-proxy-auth" packages/web/app/api/v1/github/clone/route.ts',
        '! grep -q "nango-slack" packages/web/app/api/v1/github/clone/route.ts',
        '! grep -q "token ===" packages/web/app/api/v1/github/clone/route.ts',
        '! grep -q "sage-github" packages/web/app/api/v1/github/clone/route.ts',
        'grep -q "GithubCloneRequestSchema" packages/web/lib/integrations/github-clone-schema.ts',
        'grep -q "partial_failure" packages/web/lib/integrations/github-clone-schema.ts',
        'echo ROUTE_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-audit', {
      agent: 'audit-impl',
      dependsOn: ['verify-regression-test'],
      task: `Implement the clone audit logger.

Spec:
{{steps.spec.output}}

Create: packages/web/lib/integrations/github-clone-audit.ts

Required exports:
  export interface GithubCloneAuditEntry {
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    httpStatus: number;
    outcome: 'ok' | 'unauthorized' | 'forbidden' | 'not_found' | 'upstream_error' | 'bad_request' | 'partial_failure';
    filesWritten: number;
    durationMs: number;
    errorCount: number;
  }
  export function recordGithubCloneCall(entry: GithubCloneAuditEntry): void;

Hard rules (verified after this step):
  - Match the logger pattern in packages/web/lib/integrations/slack-proxy-audit.ts.
  - NEVER include or reference: token, secret, Authorization, connectionId,
    providerConfigKey, tarball, fileContent, body, payload.
  - NEVER accept spread args — only GithubCloneAuditEntry.
  - For auth failures where workspaceId is unknown, callers pass '(unknown)'.
  - No new deps.

Write to disk. Do NOT print file contents to stdout.`,
      verification: { type: 'file_exists', value: 'packages/web/lib/integrations/github-clone-audit.ts' },
    })

    .step('verify-audit', {
      type: 'deterministic',
      dependsOn: ['impl-audit'],
      command: [
        'test -f packages/web/lib/integrations/github-clone-audit.ts',
        'grep -q "GithubCloneAuditEntry" packages/web/lib/integrations/github-clone-audit.ts',
        'grep -q "recordGithubCloneCall" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "token" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "secret" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "Authorization" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "connectionId" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "providerConfigKey" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "tarball" packages/web/lib/integrations/github-clone-audit.ts',
        '! grep -q "\\.\\.\\.entry\\|\\.\\.\\.rest\\|\\.\\.\\.args" packages/web/lib/integrations/github-clone-audit.ts',
        'echo AUDIT_VERIFY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- Wave B (after all of Wave A) ----------------------------------

    .step('impl-tests', {
      agent: 'test-impl',
      dependsOn: ['verify-nango-proxy-client', 'verify-tarball-walker', 'verify-writer', 'verify-route', 'verify-audit'],
      task: `Write unit tests for tarball walker, writer, and audit.

Spec:
{{steps.spec.output}}

Create:
  tests/github-tarball-walker.test.ts
  tests/github-clone-writer.test.ts
  tests/github-clone-audit.test.ts

Match the test runner pattern used by the existing contract test
(tests/github-clone-runner.contract.test.ts).

github-tarball-walker.test.ts cases:
  1. 'strips leading owner-repo-sha/ directory from entries'
  2. 'text file is decoded as utf-8'
  3. 'png file is detected as binary by extension'
  4. 'file with NUL byte in first 8KB is detected as binary by content sniff'
  5. '.git entries are yielded with skipped=ignored'
  6. 'node_modules entries are yielded with skipped=ignored'
  7. 'package-lock.json is yielded with skipped=ignored'
  8. 'file over 1 MiB is yielded with skipped=too-large and empty content buffer'
  9. '.min.js is yielded with skipped=ignored'
  10. 'invalid UTF-8 text file falls back to binary'
  Drive each case by synthesizing a tiny tar.gz in memory (reuse the fixture
  builder where possible, or inline a per-case tar with node:zlib + tar.pack).

github-clone-writer.test.ts cases:
  1. 'chunks 450 files into 3 calls of [200, 200, 50]' (GITHUB_CLONE_CHUNK_SIZE=200)
  2. 'peak concurrent bulkWrite calls never exceeds GITHUB_CLONE_MAX_CONCURRENT'
  3. 'returns accumulated errors without throwing'
  4. 'propagates aborted signal — subsequent chunks are not started'
  5. 'returns written count as sum of successful chunk written counts'
  Use an inline fake RelayFileClient with a controllable bulkWrite.

github-clone-audit.test.ts cases:
  1. 'records ok outcome with all fields'
  2. 'records partial_failure with errorCount'
  3. 'captured log line contains workspaceId and outcome'
  4. 'captured log line NEVER contains the string "token"'
  5. 'captured log line NEVER contains the string "Authorization"'
  6. 'function rejects spread/extra fields at the type level' (compile-time,
     use @ts-expect-error on a bad call to document the boundary)

Use the module's real code under test — no mocking of the modules themselves.

Write files to disk. Do NOT print contents to stdout.`,
      verification: { type: 'file_exists', value: 'tests/github-tarball-walker.test.ts' },
    })

    .step('verify-tests-present', {
      type: 'deterministic',
      dependsOn: ['impl-tests'],
      command: [
        'test -f tests/github-clone-runner.contract.test.ts',
        'test -f tests/github-tarball-walker.test.ts',
        'test -f tests/github-clone-writer.test.ts',
        'test -f tests/github-clone-audit.test.ts',
        'test -f tests/helpers/mock-nango-proxy-server.ts',
        'test -f tests/helpers/mock-relayfile-server.ts',
        'test -f tests/fixtures/github/small-repo.tar.gz',
        'echo TESTS_PRESENT_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    // ----- typecheck -----------------------------------------------------

    .step('typecheck', {
      type: 'deterministic',
      dependsOn: ['verify-tests-present'],
      command: 'npx tsc -p packages/web/tsconfig.json --noEmit',
      captureOutput: true,
      failOnError: true,
    })

    // ----- test-fix-rerun triplet ----------------------------------------

    .step('test-first-run', {
      type: 'deterministic',
      dependsOn: ['typecheck'],
      command: 'mkdir -p .logs && npx tsx --test tests/github-clone-runner.contract.test.ts tests/github-tarball-walker.test.ts tests/github-clone-writer.test.ts tests/github-clone-audit.test.ts 2>&1 | tee .logs/v5-03-cloud-test-first-run.log',
      captureOutput: true,
      failOnError: false,
    })

    .step('test-fix', {
      agent: 'test-fixer',
      dependsOn: ['test-first-run'],
      task: `Read the test first-run output below. If all tests passed,
print "NO_FIX_NEEDED" and do nothing. If any test failed, decide whether
the failure is TEST WIRING (import path, mock server port, PGlite setup,
fixture regeneration, assertion wording) or PRODUCT CODE.

  - If the failure points at product code, DO NOT fix it. Print
    "PRODUCT_BUG: <file>:<line> <reason>" and stop. The rerun will fail
    loudly, which is the correct outcome — we don't paper over bugs in
    product code by patching tests.
  - If the failure is test wiring only, fix the test file(s) in place.
    You may rebuild tests/fixtures/github/small-repo.tar.gz by running
    'npx tsx tests/fixtures/github/build-small-repo-fixture.ts'.
    Print "FIXED: <files>".
  - You may edit only files under tests/. You may NOT edit anything under
    packages/web/.

First-run output:
{{steps.test-first-run.output}}

Write fixes to disk. Do NOT print full file contents to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('test-rerun', {
      type: 'deterministic',
      dependsOn: ['test-fix'],
      command: 'npx tsx --test tests/github-clone-runner.contract.test.ts tests/github-tarball-walker.test.ts tests/github-clone-writer.test.ts tests/github-clone-audit.test.ts',
      captureOutput: true,
      failOnError: true,
    })

    // ----- global safety gates -------------------------------------------

    .step('verify-no-token-leak', {
      type: 'deterministic',
      dependsOn: ['test-rerun'],
      command: [
        'echo "=== no token/secret/Authorization in log lines across clone runner sources ==="',
        '! grep -n "console.log" packages/web/lib/integrations/github-nango-proxy-client.ts | grep -Ei "token|secret|authorization"',
        '! grep -n "console.log" packages/web/lib/integrations/github-clone-orchestrator.ts | grep -Ei "token|secret|authorization|connection|provider"',
        '! grep -n "console.log" packages/web/lib/integrations/github-clone-writer.ts | grep -Ei "token|secret|authorization|content"',
        '! grep -n "console.log" packages/web/lib/integrations/github-tarball-walker.ts | grep -Ei "content|buffer|token"',
        '! grep -n "logger" packages/web/lib/integrations/github-clone-audit.ts | grep -Ei "token|secret|authorization"',
        '! grep -rn "ghs_\\|ghp_" packages/web/lib/integrations/github-clone-*.ts packages/web/lib/integrations/github-nango-proxy-client.ts packages/web/lib/integrations/github-tarball-walker.ts',
        '! grep -rn "NANGO_SECRET_KEY" packages/web/lib/integrations/github-clone-orchestrator.ts packages/web/lib/integrations/github-clone-writer.ts packages/web/lib/integrations/github-tarball-walker.ts packages/web/lib/integrations/github-clone-audit.ts',
        'echo NO_TOKEN_LEAK_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-ignore-list', {
      type: 'deterministic',
      dependsOn: ['verify-no-token-leak'],
      command: [
        'echo "=== ignore-list constants are canonical ==="',
        'grep -q "\\.git" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "node_modules" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "package-lock.json" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "yarn.lock" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "pnpm-lock.yaml" packages/web/lib/integrations/github-tarball-walker.ts',
        'grep -q "\\.min\\.js" packages/web/lib/integrations/github-tarball-walker.ts',
        'echo IGNORE_LIST_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-meta-last', {
      type: 'deterministic',
      dependsOn: ['verify-ignore-list'],
      command: [
        'echo "=== meta.json LAST contract is grep-visible ==="',
        'grep -q "meta.json LAST" packages/web/lib/integrations/github-clone-orchestrator.ts',
        'grep -q "errors.length === 0" packages/web/lib/integrations/github-clone-orchestrator.ts',
        'echo "=== orchestrator writes meta after index (line-order sanity check) ==="',
        'python3 -c "import re,sys; s=open(\'packages/web/lib/integrations/github-clone-orchestrator.ts\').read(); m=[i.start() for i in re.finditer(r\'meta\\.json\', s)]; idx=[i.start() for i in re.finditer(r\'index\\.json\', s)]; assert m and idx and min(m) > min(idx), f\'meta must be written after index: meta first at {min(m) if m else None}, index first at {min(idx) if idx else None}\'; print(\'ORDER_OK\')"',
        'echo META_LAST_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-bounded-concurrency', {
      type: 'deterministic',
      dependsOn: ['verify-meta-last'],
      command: [
        'echo "=== writer uses bounded concurrency, not Promise.all ==="',
        '! grep -q "Promise.all" packages/web/lib/integrations/github-clone-writer.ts',
        '! grep -q "p-limit\\|pLimit" packages/web/lib/integrations/github-clone-writer.ts',
        'grep -q "GITHUB_CLONE_MAX_CONCURRENT" packages/web/lib/integrations/github-clone-writer.ts',
        'echo BOUNDED_CONCURRENCY_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-no-hardcoded-provider-key', {
      type: 'deterministic',
      dependsOn: ['verify-bounded-concurrency'],
      command: [
        'echo "=== no hardcoded providerConfigKey or sage-github fallback ==="',
        '! grep -rn "sage-github" packages/web/lib/integrations/github-clone-*.ts packages/web/lib/integrations/github-nango-proxy-client.ts packages/web/app/api/v1/github/clone/route.ts packages/web/lib/integrations/github-tarball-walker.ts',
        '! grep -rn "= .github-app-oauth." packages/web/lib/integrations/github-clone-*.ts packages/web/lib/integrations/github-nango-proxy-client.ts packages/web/app/api/v1/github/clone/route.ts',
        'echo NO_HARDCODED_PROVIDER_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: true,
    })

    .step('verify-no-new-runtime-deps', {
      type: 'deterministic',
      dependsOn: ['verify-no-hardcoded-provider-key'],
      command: [
        'echo "=== packages/web package.json diff (only tar may be added) ==="',
        'git diff main -- packages/web/package.json || true',
        'echo NO_NEW_DEPS_CHECK_OK',
      ].join(' && '),
      captureOutput: true,
      failOnError: false,
    })

    // ----- final review --------------------------------------------------

    .step('final-review', {
      agent: 'lead',
      dependsOn: ['verify-no-new-runtime-deps'],
      task: `Review the github clone runner landing.

Typecheck:
{{steps.typecheck.output}}

Test first-run:
{{steps.test-first-run.output}}

Test fix outcome:
{{steps.test-fix.output}}

Test rerun:
{{steps.test-rerun.output}}

Gates:
  no-token-leak: {{steps.verify-no-token-leak.output}}
  ignore-list: {{steps.verify-ignore-list.output}}
  meta-last: {{steps.verify-meta-last.output}}
  bounded-concurrency: {{steps.verify-bounded-concurrency.output}}
  no-hardcoded-provider-key: {{steps.verify-no-hardcoded-provider-key.output}}
  no-new-runtime-deps: {{steps.verify-no-new-runtime-deps.output}}

Run these verifications yourself and report:
  git diff --stat main
  git diff main -- packages/web/app/api/v1/github/clone/
  git diff main -- packages/web/lib/integrations/github-*.ts
  grep -rn "github-clone\\|github-nango-proxy\\|github-tarball" packages/web/
  grep -n "meta.json LAST" packages/web/lib/integrations/github-clone-orchestrator.ts

For each invariant, report PASS or FAIL with file:line evidence:
  1. POST /api/v1/github/clone exists, Bearer-gated via CLOUD_API_TOKEN.
  2. Auth uses timingSafeEqual (directly or via v5-01 shared helper).
  3. Nango proxy client reads NANGO_SECRET_KEY and NANGO_PROXY_URL_OVERRIDE.
  4. Nango proxy client never logs token, secret, or Authorization.
  5. Tarball walker strips leading directory, applies the exact ignore lists.
  6. Walker yields too-large files with skipped flag (never buffers >1 MiB).
  7. Writer chunks at 200 per call, max 4 concurrent, no Promise.all.
  8. Orchestrator writes contents → index.json → meta.json, in that order.
  9. On any write error, orchestrator skips BOTH index.json and meta.json.
 10. Audit logger records every outcome and NEVER logs token/secret/connectionId/Authorization/tarball/content.
 11. No hardcoded 'sage-github' or default providerConfigKey anywhere.
 12. Typecheck passes.
 13. Contract test passes (full clone of small fixture, all 10 cases green).
 14. Three unit test files pass.
 15. Response envelope:
     { ok: true, data: { filesWritten, headSha, durationMs } }
     | { ok: false, error, code }

Independent-validation preconditions (do NOT assert in the workflow —
document for the operator):
  A. User has connected a GitHub App installation via Nango (dashboard flow).
  B. Nango's github-app-oauth provider config allows
     /repos/{owner}/{repo}/tarball/{ref} AND /repos/{owner}/{repo} through
     the proxy.
  C. @relayfile/sdk bulkWrite is reachable from cloud in the v5-02 E2E stack.
  D. Sage's nango-integrations/github-app-oauth/syncs/*.ts must be deployed
     separately before the volume contains PRs / issues / commits. This
     workflow only provides the working-tree snapshot.

If all 15 invariants pass, end with: CLONE_RUNNER_READY_FOR_SAGE`,
      verification: { type: 'output_contains', value: 'CLONE_RUNNER_READY_FOR_SAGE' },
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: process.cwd() });

  console.log('Workflow status:', result.status);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

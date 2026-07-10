#!/usr/bin/env node
// Auto-generated bootstrap script — do not edit.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { WorkflowRunner } from '@relayflows/core';
import { Daytona } from '@daytonaio/sdk';
import { CloudApiClient } from './lib/auth/api-token-client.js';
import { ScopedS3Client } from './lib/storage/client.js';
import { downloadAndExtractCode } from './lib/storage/code-transfer.js';
import { writeRunManifest } from './lib/storage/metadata.js';
import { SandboxedStepExecutor } from './lib/executor/executor.js';
// Import DaytonaRuntime directly, not via ./lib/runtime/index.js, because
// the barrel re-exports E2BRuntime which eagerly imports the 'e2b' npm
// package — and that package isn't in the sandbox snapshot.
import { DaytonaRuntime } from './lib/runtime/daytona.js';
import { LocalHttpRuntime } from './lib/runtime/local-http.js';
import { Reporter } from './lib/reporter/reporter.js';
import { parseCredentialExpiry } from './lib/auth/credential-expiry.js';
import { refreshCredential } from './lib/auth/credential-refresher.js';
import { parseCredentialProxyTokens } from './lib/auth/proxy-token.js';
import { getSnapshotName } from './lib/config/snapshot.js';

const env = process.env;
const runId = env.RUN_ID ?? 'unknown';
const codeMountPath = __CLOUD_BOOTSTRAP_CODE_MOUNT_PATH_JSON__;
const configuredExecutionMode = __CLOUD_BOOTSTRAP_CONFIGURED_EXECUTION_MODE_JSON__;
const executionMode = env.WORKFLOW_EXECUTION_MODE === 'shared-sandbox'
  ? 'shared-sandbox'
  : configuredExecutionMode;
const sharedSandbox = executionMode === 'shared-sandbox';
// Multi-path mount root. The daytona sandbox image pre-creates
// /project (and a few other blessed paths) with the daytona user as
// owner; / is root-owned, so 'mkdir -p /workspace' fails with EACCES.
// Anchor at /home/daytona — the daytona image's stable HOME — so the
// bootstrap can create it without elevated perms. Hardcoded (not
// derived from $HOME) so it matches launcher.ts's
// resolveMultiPathWorkflowFile output character-for-character.
const workspaceMountPath = '/home/daytona/workspace';
const type = __CLOUD_BOOTSTRAP_FILE_TYPE_JSON__;
const interactive = __CLOUD_BOOTSTRAP_INTERACTIVE_JSON__;
const gitDir = (env.HOME ?? '/home/daytona') + '/.project-git';
const relayfileMountStateDir = '/home/daytona/.relayfile-mount-state';
const relayfileBaseUrl =
  (env.RelayfileUrl ?? env.RELAYFILE_URL)?.replace(/\/$/, '') ?? '';
const relayfileWorkspaceId =
  env.RELAYFILE_WORKSPACE_ID
  ?? env.RELAYFILE_WORKSPACE
  ?? env.RELAY_WORKSPACE_ID
  ?? '';
const relayfileEnabled = Boolean(relayfileBaseUrl && env.RELAYFILE_TOKEN);
const relayAgentTokens = env.RELAY_AGENT_TOKENS ?? '';
const submittedPaths = parseSubmittedPaths();
const hasPathMounts = submittedPaths.length > 0;
const RELAYFILE_MOUNT_ONCE_TIMEOUT_MS = 300_000;

function parseSubmittedPaths() {
  const raw = env.S3_PATHS;
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid S3_PATHS JSON: ' + (error?.message ?? error));
  }
  if (!Array.isArray(parsed)) {
    throw new Error('S3_PATHS must be a JSON array');
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('S3_PATHS entries must be objects');
    }
    const name = String(entry.name ?? '');
    const s3CodeKey = String(entry.s3CodeKey ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || !s3CodeKey) {
      throw new Error('Invalid S3_PATHS entry for path "' + name + '"');
    }
    return {
      name,
      s3CodeKey,
      mountPath: workspaceMountPath + '/' + name,
      ...(typeof entry.repoOwner === 'string' ? { repoOwner: entry.repoOwner } : {}),
      ...(typeof entry.repoName === 'string' ? { repoName: entry.repoName } : {}),
    };
  });
}

function gitDirForPath(pathName) {
  return (env.HOME ?? '/home/daytona') + '/.project-git-' + pathName;
}

// ── Log flusher: periodically uploads runner.log to S3 ──────────────
const LOG_KEY = 'runner.log';
const LOG_FLUSH_INTERVAL_MS = 10_000;
let logFlusher = null;
const AGENT_LOG_FLUSH_INTERVAL_MS = 10_000;
let agentLogFlusher = null;
const agentLogUploadedSizes = new Map();
let agentLogFlushInProgress = false;

function startLogFlusher(s3) {
  const logPath = (env.HOME ?? '/home/daytona') + '/runner.log';
  let lastSize = 0;
  let lastErrorName = '';

  logFlusher = setInterval(async () => {
    try {
      const content = await readFile(logPath);
      if (content.length > lastSize) {
        await s3.putObject(LOG_KEY, content, 'text/plain');
        lastSize = content.length;
      }
    } catch (error) {
      // runner.log not existing yet (ENOENT) is expected before the shell
      // redirect creates it. Anything else is a real upload failure that
      // would otherwise be invisible — log it once per distinct error so
      // the next tick doesn't spam, but we can still see what went wrong.
      if (error?.code === 'ENOENT') {
        return;
      }
      const errName = error?.name ?? error?.code ?? 'Error';
      if (errName !== lastErrorName) {
        lastErrorName = errName;
        console.error('[bootstrap] log flusher upload failed (' + errName + '):', error?.message ?? error);
      }
    }
  }, LOG_FLUSH_INTERVAL_MS);
  logFlusher.unref?.();
}

async function stopLogFlusher(s3) {
  if (logFlusher) {
    clearInterval(logFlusher);
    logFlusher = null;
  }
  // Final flush
  try {
    const logPath = (env.HOME ?? '/home/daytona') + '/runner.log';
    const content = await readFile(logPath);
    if (content.length > 0) {
      await s3.putObject(LOG_KEY, content, 'text/plain');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error('[bootstrap] final log flush failed:', error?.message ?? error);
    }
  }
}

async function flushAgentLogsOnce(s3, brokerCwd, force = false) {
  if (agentLogFlushInProgress) {
    if (!force) {
      return;
    }
    while (agentLogFlushInProgress) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  agentLogFlushInProgress = true;
  try {
    const { join } = await import('node:path');
    const logsDir = join(brokerCwd, '.agent-relay', 'team', 'worker-logs');
    const files = await readdir(logsDir);

    for (const file of files) {
      if (!file.endsWith('.log')) {
        continue;
      }

      try {
        const content = await readFile(join(logsDir, file));
        const lastUploadedSize = agentLogUploadedSizes.get(file);
        if (!force && lastUploadedSize === content.length) {
          continue;
        }

        const agentName = file.replace(/\.log$/, '');
        await s3.putObject(agentName + '/agent.log', content, 'text/plain');
        agentLogUploadedSizes.set(file, content.length);
      } catch (error) {
        // EPERM is expected on FUSE/S3-backed volumes while the write stream is open.
        // The final uploadAgentLogs() runs after write streams close and will succeed.
        if (error?.code !== 'EPERM') {
          console.warn('[bootstrap] agent log flush failed for ' + file + ':', error?.message ?? error);
        }
      }
    }
  } catch {
    // worker-logs may not exist yet
  } finally {
    agentLogFlushInProgress = false;
  }
}

function startAgentLogFlusher(s3, brokerCwd) {
  if (agentLogFlusher) {
    return async () => {
      clearInterval(agentLogFlusher);
      agentLogFlusher = null;
      await flushAgentLogsOnce(s3, brokerCwd, true);
    };
  }

  agentLogFlusher = setInterval(() => {
    void flushAgentLogsOnce(s3, brokerCwd);
  }, AGENT_LOG_FLUSH_INTERVAL_MS);
  agentLogFlusher.unref?.();

  return async () => {
    if (agentLogFlusher) {
      clearInterval(agentLogFlusher);
      agentLogFlusher = null;
    }
    await flushAgentLogsOnce(s3, brokerCwd, true);
  };
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

const relayfileMountShellTemplate = __CLOUD_BOOTSTRAP_RELAYFILE_MOUNT_SHELL_TEMPLATE_JSON__;

function relayfileMountShellFromTemplate(template, localDir) {
  return template
    .replace(shellEscape(relayfileMountShellTemplate.placeholders.baseUrl), shellEscape(relayfileBaseUrl))
    .replace(shellEscape(relayfileMountShellTemplate.placeholders.workspaceId), shellEscape(relayfileWorkspaceId))
    .replace(shellEscape(relayfileMountShellTemplate.placeholders.localDir), shellEscape(localDir))
    .replace(shellEscape(relayfileMountShellTemplate.placeholders.token), shellEscape(env.RELAYFILE_TOKEN ?? ''))
    .replace(relayfileMountShellTemplate.pathArgsPlaceholderArg, relayfileMountPathArgs());
}

function relayfileMountBaseArgs(localDir) {
  return [
    '--base-url ' + shellEscape(relayfileBaseUrl),
    '--workspace ' + shellEscape(relayfileWorkspaceId),
    '--local-dir ' + shellEscape(localDir),
    '--state-dir ' + shellEscape(relayfileMountStateDir),
    '--token ' + shellEscape(env.RELAYFILE_TOKEN ?? ''),
    '--websocket=false',
  ].join(' ');
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  '.wasm', '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.zst',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.pyc', '.pyo', '.class', '.jar', '.war',
  '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
  '.ds_store',
]);

function detectMimeType(filePath) {
  const lower = filePath.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx !== -1 && BINARY_EXTENSIONS.has(lower.slice(dotIdx))) {
    return 'application/octet-stream';
  }
  return 'text/plain; charset=utf-8';
}

async function relayfileFetch(pathname, init = {}) {
  if (!relayfileEnabled) {
    throw new Error('Relayfile is not configured');
  }

  const headers = {
    Authorization: 'Bearer ' + env.RELAYFILE_TOKEN,
    'X-Correlation-Id': 'corr_bootstrap_' + runId + '_' + Date.now(),
    ...(init.headers ?? {}),
  };
  const response = await fetch(relayfileBaseUrl + pathname, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error('Relayfile request failed (' + response.status + ' ' + response.statusText + '): ' + pathname + (body ? ' - ' + body.slice(0, 500) : ''));
  }

  return response;
}

async function collectWorkspaceFiles(rootDir) {
  const { join, relative } = await import('node:path');
  const { readdir: rd, readFile: rf } = await import('node:fs/promises');
  const files = [];

  async function walk(dir) {
    const entries = await rd(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agent-relay') {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relativePath = relative(rootDir, fullPath).replace(/\\/g, '/');
      const mimeType = detectMimeType(relativePath);
      if (mimeType === 'application/octet-stream') continue; // skip binary files
      const content = await rf(fullPath, 'utf8');
      files.push({
        path: relativePath,
        contentType: mimeType,
        content,
      });
    }
  }

  await walk(rootDir);
  return files;
}

async function seedRelayfileWorkspace(rootDir) {
  if (!relayfileEnabled) {
    return 0;
  }

  const files = await collectWorkspaceFiles(rootDir);
  for (const file of files) {
    await relayfileFetch('/v1/workspaces/' + encodeURIComponent(relayfileWorkspaceId) + '/fs/file?path=' + encodeURIComponent(file.path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '*' },
      body: JSON.stringify({
        contentType: file.contentType,
        content: file.content,
      }),
    });
  }

  console.log('[bootstrap] Seeded ' + files.length + ' files to relayfile workspace ' + relayfileWorkspaceId);
  return files.length;
}

function relayfileMountPathArgs() {
  return relayfileMountRemoteRoots()
    .map((path) => relayfileMountShellTemplate.pathArgTemplate.replace(
      shellEscape(relayfileMountShellTemplate.placeholders.path),
      shellEscape(path),
    ))
    .join('');
}

function relayfileMountRemoteRoots() {
  const raw = env.RELAYFILE_MOUNT_PATHS;
  if (!raw) {
    return [];
  }
  try {
    const paths = JSON.parse(raw);
    if (!Array.isArray(paths)) {
      return [];
    }
    const roots = new Set();
    for (const rawPath of paths) {
      if (typeof rawPath !== 'string') continue;
      const root = relayfileMountRemoteRoot(rawPath);
      if (root) roots.add(root);
    }
    return Array.from(roots).sort();
  } catch {
    return [];
  }
}

function relayfileMountRemoteRoot(path) {
  const trimmed = String(path).trim();
  if (!trimmed.startsWith('/')) return null;
  const withoutGlob = trimmed.endsWith('/**') ? trimmed.slice(0, -3) : trimmed;
  const normalized = withoutGlob.replace(/\/+/g, '/').replace(/\/$/, '');
  if (!normalized || normalized === '/' || normalized.includes('*')) return null;
  return normalized;
}

function githubMaterializeOwnerRootsForMountRoots(roots) {
  const owners = new Set();
  for (const root of roots) {
    const segments = String(root).split('/').filter(Boolean);
    if (segments[0] !== 'github' || segments[1] !== 'repos') {
      continue;
    }
    const owner = segments[2];
    if (!owner || owner.includes('*')) {
      continue;
    }
    const repo = segments[3];
    if (segments.length === 3 || repo === '*' || repo === '**') {
      owners.add(owner);
    }
  }
  return Array.from(owners).sort((left, right) => left.localeCompare(right));
}

function githubRepoName(row) {
  if (!row || typeof row !== 'object') return '';
  if (typeof row.repo === 'string' && row.repo.trim()) return row.repo.trim();
  if (typeof row.name === 'string' && row.name.trim()) return row.name.trim();
  if (typeof row.title === 'string' && row.title.trim()) return row.title.trim();
  if (typeof row.id === 'string' && row.id.trim()) return row.id.trim();
  return '';
}

function githubRepoIdentity(row, defaultOwner = '') {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const fullName = typeof row.full_name === 'string' ? row.full_name.trim() : '';
  const combined = id.includes('/') ? id : fullName;
  if (combined.includes('/')) {
    const [owner, repo] = combined.split('/');
    return owner && repo ? { owner, repo } : null;
  }
  const owner = typeof row.owner === 'string' && row.owner.trim() ? row.owner.trim() : defaultOwner;
  const repo = githubRepoName(row);
  return owner && repo && !repo.includes('/') ? { owner, repo } : null;
}

function githubRepoUpdatedMs(row) {
  const value = row && (row.updated || row.updated_at || row.pushed_at);
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === 'undefined') {
    return undefined;
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function relayfileFetchWithTimeout(pathname, init, timeoutMs) {
  return relayfileFetch(pathname, {
    ...(init ?? {}),
    signal: timeoutSignal(timeoutMs),
  });
}

async function runLimited(items, limit, deadlineMs, fn) {
  let next = 0;
  let stoppedForTimeout = false;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (Date.now() >= deadlineMs) {
        stoppedForTimeout = true;
        break;
      }
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
  return { stoppedForTimeout, started: next };
}

async function readGithubCatalogRows(path, label, requestTimeoutMs, deadlineMs) {
  try {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error('github materialize total timeout exceeded before catalog read');
    }
    const catalogResponse = await relayfileFetchWithTimeout(
      '/v1/workspaces/' + encodeURIComponent(relayfileWorkspaceId) + '/fs/file?path=' + encodeURIComponent(path),
      undefined,
      Math.min(requestTimeoutMs, remainingMs),
    );
    const catalog = await catalogResponse.json();
    const rows = JSON.parse(String(catalog.content || '[]'));
    if (!Array.isArray(rows)) {
      throw new Error(path + ' is not an array');
    }
    return rows;
  } catch (error) {
    console.warn('[bootstrap] GitHub materialize catalog read failed', {
      catalog: label,
      path,
      error: error?.message ?? String(error),
    });
    return [];
  }
}

async function materializeGithubReposForRelayfileMountRoots() {
  if (!relayfileEnabled) {
    return;
  }
  const owners = new Set(githubMaterializeOwnerRootsForMountRoots(relayfileMountRemoteRoots()));
  if (owners.size === 0) {
    return;
  }
  try {
    // Default covers daily and weekly digests; longer-cadence scans must
    // override RELAYFILE_GITHUB_MATERIALIZE_LOOKBACK_HOURS to match their
    // handler window.
    const lookbackHoursRaw = Number(env.RELAYFILE_GITHUB_MATERIALIZE_LOOKBACK_HOURS || '192');
    const lookbackHours = Number.isFinite(lookbackHoursRaw) && lookbackHoursRaw > 0 ? lookbackHoursRaw : 192;
    const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000;
    const concurrencyRaw = Number(env.RELAYFILE_GITHUB_MATERIALIZE_CONCURRENCY || '6');
    const concurrency = Math.max(1, Math.min(16, Math.floor(Number.isFinite(concurrencyRaw) ? concurrencyRaw : 6)));
    const requestTimeoutRaw = Number(env.RELAYFILE_GITHUB_MATERIALIZE_REQUEST_TIMEOUT_MS || '60000');
    const requestTimeoutMs = Number.isFinite(requestTimeoutRaw) && requestTimeoutRaw > 0 ? requestTimeoutRaw : 60000;
    const totalTimeoutRaw = Number(env.RELAYFILE_GITHUB_MATERIALIZE_TOTAL_TIMEOUT_MS || '240000');
    const totalTimeoutMs = Number.isFinite(totalTimeoutRaw) && totalTimeoutRaw > 0 ? totalTimeoutRaw : 240000;
    const deadlineMs = Date.now() + totalTimeoutMs;
    const ownerRows = new Map();
    for (const owner of owners) {
      if (Date.now() >= deadlineMs) {
        break;
      }
      ownerRows.set(owner, await readGithubCatalogRows('/github/repos/' + owner + '/_index.json', owner, requestTimeoutMs, deadlineMs));
    }
    const catalogTimedOut = Date.now() >= deadlineMs;
    const topLevelRows = catalogTimedOut ? [] : await readGithubCatalogRows('/github/repos/_index.json', 'top-level', requestTimeoutMs, deadlineMs);
    const reposByKey = new Map();
    let skippedMissingIdentity = 0;
    let skippedMissingUpdated = 0;

    function addRows(rows, defaultOwner = '') {
      for (const row of rows) {
        const identity = githubRepoIdentity(row, defaultOwner);
        if (!identity) {
          skippedMissingIdentity += 1;
          continue;
        }
        if (!owners.has(identity.owner)) continue;
        const updatedMs = githubRepoUpdatedMs(row);
        if (updatedMs === null) {
          skippedMissingUpdated += 1;
          continue;
        }
        if (updatedMs < sinceMs) continue;
        reposByKey.set(identity.owner + '/' + identity.repo, { ...identity, updatedMs });
      }
    }

    for (const [owner, rows] of ownerRows.entries()) {
      addRows(rows, owner);
    }
    addRows(topLevelRows);
    const repos = Array.from(reposByKey.values()).sort((left, right) =>
      (right.updatedMs || 0) - (left.updatedMs || 0)
        || (left.owner + '/' + left.repo).localeCompare(right.owner + '/' + right.repo)
    );
    if (skippedMissingIdentity || skippedMissingUpdated) {
      console.warn('[bootstrap] GitHub materialize skipped catalog rows', {
        missingIdentity: skippedMissingIdentity,
        missingUpdated: skippedMissingUpdated,
      });
    }
    if (repos.length === 0) {
      console.log(catalogTimedOut || Date.now() >= deadlineMs
        ? '[bootstrap] GitHub materialize incomplete'
        : '[bootstrap] GitHub materialize found no recently updated repos', {
        owners: Array.from(owners),
        lookbackHours,
        catalogTimedOut: catalogTimedOut || Date.now() >= deadlineMs,
      });
      return;
    }
    const started = Date.now();
    let failures = 0;
    const limited = await runLimited(repos, concurrency, deadlineMs, async (repo) => {
      try {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          throw new Error('github materialize total timeout exceeded before repo request');
        }
        await relayfileFetchWithTimeout(
          '/v1/workspaces/' + encodeURIComponent(relayfileWorkspaceId)
            + '/integrations/github/repos/' + encodeURIComponent(repo.owner)
            + '/' + encodeURIComponent(repo.repo) + '/materialize',
          { method: 'POST' },
          Math.min(requestTimeoutMs, remainingMs),
        );
      } catch (error) {
        failures += 1;
        console.warn('[bootstrap] GitHub repo materialize failed', {
          repo: repo.owner + '/' + repo.repo,
          error: error?.message ?? String(error),
        });
      }
    });
    const incomplete = limited.stoppedForTimeout || Date.now() >= deadlineMs;
    console.log('[bootstrap] GitHub materialize complete', {
      requested: repos.length,
      started: limited.started,
      failures,
      incomplete,
      owners: Array.from(owners),
      durationMs: Date.now() - started,
    });
    if (incomplete || failures > 0) {
      console.warn('[bootstrap] GitHub materialize incomplete', {
        requested: repos.length,
        started: limited.started,
        failures,
        timedOut: incomplete,
      });
    }
  } catch (error) {
    console.warn('[bootstrap] GitHub materialize skipped:', error?.message ?? String(error));
  }
}

function extractAnthropicOauthToken(credentialJson) {
  try {
    const parsed = JSON.parse(credentialJson);
    if (
      parsed
      && typeof parsed === 'object'
      && parsed.type === 'oauth_token'
      && (parsed.modelProvider === undefined || parsed.modelProvider === 'anthropic')
      && typeof parsed.token === 'string'
      && parsed.token.length > 0
    ) {
      return parsed.token;
    }
  } catch {
    // Not a setup-token credential.
  }
  return null;
}

function relayfileMountUnscopedLocalDir(localDir, remoteRoots) {
  let normalizedLocalDir = localDir.replace(/\/+$/g, '');
  const suffixes = remoteRoots
    .map((remoteRoot) => String(remoteRoot).replace(/^\/+/g, '').replace(/\/+$/g, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const suffix of suffixes) {
    if (!suffix) continue;
    if (normalizedLocalDir === suffix) {
      normalizedLocalDir = '';
      continue;
    }
    if (normalizedLocalDir.endsWith('/' + suffix)) {
      normalizedLocalDir = normalizedLocalDir.slice(0, -suffix.length).replace(/\/+$/g, '');
      continue;
    }
    const nestedSuffix = '/' + suffix + '/';
    const nestedIndex = normalizedLocalDir.indexOf(nestedSuffix);
    if (nestedIndex !== -1) {
      normalizedLocalDir = normalizedLocalDir.slice(0, nestedIndex).replace(/\/+$/g, '');
    }
  }
  return normalizedLocalDir || '/';
}

function relayfileMountSupportsMultiPath() {
  try {
    // paths-file is the new-daemon sentinel: relayfile #206 ships it
    // together with repeated --remote-path support. Go flag help prints the
    // flag as -paths-file while the command accepts --paths-file, so probe for
    // the flag name without assuming dash style.
    return execSync('relayfile-mount --help 2>&1', { encoding: 'utf8', shell: '/bin/sh' }).includes('paths-file');
  } catch {
    return false;
  }
}

function relayfileMountFallbackStartShell(localDir, roots) {
  const mountLocalDir = relayfileMountUnscopedLocalDir(localDir, roots);
  const starts = roots
      .filter((path) => typeof path === 'string' && path.trim().length > 0)
      .map((path) => [
        // Pin scoped layout for v0.8.11+ binaries (exact-by-default after
        // relayfile#243); pre-v0.8.11 binaries ignore the env var. Keeps the
        // daemon appending the remote path under the unscoped local dir,
        // matching relayfileMountUnscopedLocalDir's expectation.
        'env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount',
        relayfileMountBaseArgs(mountLocalDir),
        '--remote-path ' + shellEscape(path),
        "--interval '3s'",
        ">> '/tmp/relayfile-mount.log' 2>&1 &",
        'relayfile_mount_pids="$relayfile_mount_pids $!";',
      ].join(' '));
  return [
    '(',
    "relayfile_mount_pids='';",
    ...starts,
    "trap 'kill $relayfile_mount_pids 2>/dev/null || true; wait' INT TERM EXIT;",
    'wait',
    ") >/dev/null 2>&1 & echo $!",
  ].join(' ');
}

function startRelayfileMountDaemon(localDir) {
  if (!relayfileEnabled) {
    return null;
  }

  const roots = relayfileMountRemoteRoots();
  const mountLocalDir = relayfileMountUnscopedLocalDir(localDir, roots);
  const startShell = roots.length > 1 && !relayfileMountSupportsMultiPath()
    ? relayfileMountFallbackStartShell(mountLocalDir, roots)
    : relayfileMountShellFromTemplate(relayfileMountShellTemplate.startShellTemplate, mountLocalDir);
  const pidText = execSync(
    startShell,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: '/bin/sh',
    },
  ).trim();
  const pid = Number.parseInt(pidText, 10);

  console.log('[bootstrap] Started relayfile-mount daemon');
  return Number.isFinite(pid) ? pid : null;
}

function stopRelayfileMountDaemon(pid) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // best effort
  }
}

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function startFleetServe(cwd) {
  if (!envFlagEnabled(env.AGENT_RELAY_FLEET_SERVE)) {
    return null;
  }

  const args = ['fleet', 'serve'];
  const nodeName = env.AGENT_RELAY_FLEET_NODE_NAME || env.AGENT_RELAY_NODE_NAME;
  const wsUrl = env.AGENT_RELAY_FLEET_WS_URL || env.AGENT_RELAY_NODE_WS_URL;
  if (nodeName) args.push('--name', nodeName);
  if (env.AGENT_RELAY_FLEET_ENROLLMENT_TOKEN) {
    args.push('--enrollment-token', env.AGENT_RELAY_FLEET_ENROLLMENT_TOKEN);
  }
  if (env.AGENT_RELAY_FLEET_ENROLLMENT_URL) {
    args.push('--enrollment-url', env.AGENT_RELAY_FLEET_ENROLLMENT_URL);
  }
  if (env.AGENT_RELAY_NODE_TOKEN) {
    args.push('--node-token', env.AGENT_RELAY_NODE_TOKEN);
  }
  if (wsUrl) args.push('--ws-url', wsUrl);

  const logPath = (env.HOME ?? '/home/daytona') + '/fleet-serve.log';
  const command = ['agent-relay', ...args].map(shellEscape).join(' ');
  const pidText = execSync(
    'nohup ' + command + ' > ' + shellEscape(logPath) + ' 2>&1 & echo $!',
    {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: '/bin/sh',
    },
  ).trim();
  const pid = Number.parseInt(pidText, 10);
  console.log('[bootstrap] Started agent-relay fleet serve');
  return Number.isFinite(pid) ? pid : null;
}

function stopFleetServe(pid) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // best effort
  }
}

async function flushRelayfileMountOnce(localDir) {
  if (!relayfileEnabled) {
    return;
  }

  const roots = relayfileMountRemoteRoots();
  const mountLocalDir = relayfileMountUnscopedLocalDir(localDir, roots);
  execSync(
    relayfileMountShellFromTemplate(relayfileMountShellTemplate.flushShellTemplate, mountLocalDir),
    {
      stdio: 'pipe',
      shell: '/bin/sh',
      timeout: RELAYFILE_MOUNT_ONCE_TIMEOUT_MS,
    },
  );
}

// Refresh any CLI credentials expiring within 2 hours before the workflow starts.
// Writes the updated credential back to the Cloud API so future runs get fresh tokens.
const CREDENTIAL_REFRESH_BUFFER_MS = 2 * 60 * 60 * 1000; // refresh if expiring within 2h
async function refreshExpiringCredentials() {
  if (!env.CLI_CREDENTIALS || !cloudApi) return;
  // CLI_CREDENTIALS is either:
  //   single-provider (backwards compat): raw credential JSON e.g. {"claudeAiOauth":{...}}
  //   multi-provider bundle: {"anthropic": "<credJson>", "openai": "<credJson>"}
  let parsed;
  try {
    parsed = JSON.parse(env.CLI_CREDENTIALS);
  } catch {
    return;
  }
  // Build a { provider -> credJson } map regardless of which format we got
  const credMap = {};
  if (typeof parsed.anthropic === 'string') {
    credMap['anthropic'] = parsed.anthropic;
  }
  if (typeof parsed.openai === 'string') {
    credMap['openai'] = parsed.openai;
  }
  if (Object.keys(credMap).length === 0) {
    // Single-provider plain credential — detect provider from shape
    if (parsed.claudeAiOauth) {
      credMap['anthropic'] = env.CLI_CREDENTIALS;
    } else if (parsed.tokens || parsed.access_token) {
      credMap['openai'] = env.CLI_CREDENTIALS;
    }
  }
  const now = Date.now();
  let singleProviderRefreshed = null;
  for (const provider of Object.keys(credMap)) {
    // Anthropic in-sandbox pre-run refresh is retired. New Anthropic
    // connections use a long-lived setup-token (auth_type 'oauth_token',
    // no expiry, injected as CLAUDE_CODE_OAUTH_TOKEN) and must never be
    // refreshed; legacy provider_oauth Anthropic creds are refreshed
    // server-side by the credential sweep, not here. OpenAI is unaffected.
    if (provider === 'anthropic') continue;
    const credJson = credMap[provider];
    let expiresAt = null;
    try {
      expiresAt = parseCredentialExpiry(credJson);
    } catch { continue; }
    if (!expiresAt || expiresAt.getTime() - now > CREDENTIAL_REFRESH_BUFFER_MS) continue;
    console.log('[bootstrap] Credential expiring soon for ' + provider + ', refreshing pre-run...');
    try {
      const result = await refreshCredential(provider, credJson);
      const writeBackResp = await cloudApi.fetch('/api/v1/credentials/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, credentials: JSON.parse(result.credentialJson) }),
      });
      if (!writeBackResp.ok) {
        console.warn('[bootstrap] Credential write-back returned ' + writeBackResp.status);
      }
      credMap[provider] = result.credentialJson;
      singleProviderRefreshed = provider;
      console.log('[bootstrap] Refreshed ' + provider + ' credential pre-run.');
    } catch (err) {
      console.warn('[bootstrap] Pre-run credential refresh failed for ' + provider + ' (non-fatal):', err?.message ?? err);
    }
  }
  // Write updated credentials back to env so agents get the fresh token
  if (singleProviderRefreshed !== null) {
    const isSingleProvider = !parsed.anthropic && !parsed.openai;
    if (isSingleProvider) {
      env.CLI_CREDENTIALS = credMap[singleProviderRefreshed];
    } else {
      env.CLI_CREDENTIALS = JSON.stringify(credMap);
    }
  }
}

const reporter =
  env.CALLBACK_URL && env.CALLBACK_TOKEN
    ? new Reporter({
        callbackUrl: env.CALLBACK_URL,
        callbackToken: env.CALLBACK_TOKEN,
      })
    : null;
const cloudApi = CloudApiClient.fromEnv(env);
const REPORT_COMPLETION_TIMEOUT_MS = 60_000;

const manifest = {
  runId,
  userId: env.USER_ID ?? 'unknown',
  workspaceId: env.RELAY_WORKSPACE_ID ?? 'unknown',
  workflowName: 'unknown',
  status: 'running',
  startTime: new Date().toISOString(),
  steps: [],
};

async function emitMsdSharedSandboxReviewEvent(type, details = {}) {
  if (!sharedSandbox || !cloudApi) {
    return;
  }

  const sandboxId = env.DAYTONA_SANDBOX_ID ?? env.SANDBOX_ID ?? '';
  const workdir = details.workdir ?? codeMountPath;
  const payload = {
    runId,
    executionMode: 'shared-sandbox',
    type,
    createdAt: new Date().toISOString(),
    sandboxId,
    workdir,
    ...(env.WORKFLOW_OBSERVER_URL ? { observerUrl: env.WORKFLOW_OBSERVER_URL } : {}),
    ...details,
  };

  delete payload.providerCredentials;
  delete payload.githubToken;
  delete payload.GITHUB_TOKEN;

  await cloudApi.fetch('/api/v1/workflows/runs/' + runId + '/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventType: type,
      sandboxId,
      stepName: details.stepId,
      payload,
    }),
  }).catch((err) => {
    console.warn('[bootstrap] shared-sandbox event emit failed for ' + type + ':', err?.message ?? err);
  });
}

const sandboxFs = {
  fs: {
    async uploadFile(source, remotePath) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(remotePath, source);
    },
    async downloadFile(remotePath) {
      const fs = await import('node:fs/promises');
      return fs.readFile(remotePath);
    },
  },
  process: {
    async executeCommand(command, cwd) {
      try {
        const result = execSync(command, {
          cwd,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024,
          stdio: 'pipe',
        });
        return { exitCode: 0, result };
      } catch (error) {
        const message = error?.stdout?.toString?.() ?? String(error);
        return { exitCode: error?.status ?? 1, result: message };
      }
    },
  },
};

async function writePathsManifest(paths) {
  if (paths.length === 0) return;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const manifestDir = workspaceMountPath + '/.relay';
  const pathMap = Object.fromEntries(paths.map((entry) => [entry.name, entry.mountPath]));
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    manifestDir + '/paths.json',
    JSON.stringify({
      paths: pathMap,
      entries: paths.map((entry) => ({
        name: entry.name,
        path: entry.mountPath,
        s3CodeKey: entry.s3CodeKey,
        ...(entry.repoOwner ? { repoOwner: entry.repoOwner } : {}),
        ...(entry.repoName ? { repoName: entry.repoName } : {}),
      })),
    }, null, 2),
  );
}

async function writeMsdReviewInputContext(brokerCwd) {
  if (!sharedSandbox || !env.MSD_REVIEW_INPUT_JSON) {
    return null;
  }

  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const contextDir = join(brokerCwd, '.agent-workforce', 'msd-review');
  const contextPath = join(contextDir, 'input.json');
  let parsed;
  try {
    parsed = JSON.parse(env.MSD_REVIEW_INPUT_JSON);
  } catch (error) {
    throw new Error('Invalid MSD_REVIEW_INPUT_JSON: ' + (error?.message ?? error));
  }

  await mkdir(contextDir, { recursive: true });
  await writeFile(contextPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  process.env.MSD_REVIEW_INPUT_PATH = contextPath;
  process.env.AGENT_WORKFORCE_SHARED_SANDBOX_ID = env.DAYTONA_SANDBOX_ID ?? env.SANDBOX_ID ?? '';
  process.env.AGENT_WORKFORCE_SHARED_WORKDIR = brokerCwd;
  console.log('[bootstrap] Wrote MSD review context to .agent-workforce/msd-review/input.json');
  return contextPath;
}

function isMsdRelayReviewArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const severities = new Set(['critical', 'high', 'medium', 'low', 'info']);
  const sides = new Set(['LEFT', 'RIGHT']);
  return value.schemaVersion === '2026-05-07'
    && typeof value.repositoryFullName === 'string'
    && typeof value.pullRequestNumber === 'number'
    && typeof value.commitSha === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.findings)
    && value.findings.every((finding) => {
      if (!finding || typeof finding !== 'object') return false;
      if (typeof finding.path !== 'string') return false;
      if (!severities.has(finding.severity)) return false;
      if (typeof finding.title !== 'string') return false;
      if (typeof finding.body !== 'string') return false;
      if (finding.line !== undefined && typeof finding.line !== 'number') return false;
      if (finding.side !== undefined && !sides.has(finding.side)) return false;
      if (finding.suggestedFix !== undefined && typeof finding.suggestedFix !== 'string') return false;
      return true;
    })
    && Array.isArray(value.evidence)
    && value.evidence.every((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (typeof entry.agentId !== 'string') return false;
      if (typeof entry.stepId !== 'string') return false;
      if (typeof entry.note !== 'string') return false;
      if (entry.artifactPath !== undefined && typeof entry.artifactPath !== 'string') return false;
      return true;
    });
}

async function collectMsdReviewArtifact(brokerCwd) {
  if (!sharedSandbox) {
    return null;
  }

  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const artifactPath = join(brokerCwd, '.agent-workforce', 'msd-review', 'final-artifact.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(artifactPath, 'utf8'));
  } catch (readErr) {
    // Shared-sandbox MSD review runs MUST produce a validated final artifact.
    // A missing or unreadable file here means the workflow either skipped
    // the review or crashed before writing it; surfacing the failure stops
    // a partial run from reporting completion to MSD.
    throw new Error(
      'MSD review final artifact is missing at .agent-workforce/msd-review/final-artifact.json: ' +
      (readErr?.message ?? readErr),
    );
  }

  if (!isMsdRelayReviewArtifact(parsed)) {
    throw new Error('MSD review final artifact is invalid: .agent-workforce/msd-review/final-artifact.json');
  }

  return {
    artifactPath: '.agent-workforce/msd-review/final-artifact.json',
    artifact: parsed,
  };
}

async function setupGitBaselineForMountedPath(entry) {
  const brokerCwd = entry.mountPath;
  const pathGitDir = gitDirForPath(entry.name);
  const gitCmd = 'GIT_DIR=' + pathGitDir + ' GIT_WORK_TREE=' + brokerCwd;
  try {
    console.log('[bootstrap] Setting up git baseline for path "' + entry.name + '" in ' + brokerCwd + '...');
    execSync('mkdir -p ' + brokerCwd, { stdio: 'pipe' });
    execSync('mkdir -p ' + pathGitDir, { stdio: 'pipe' });
    execSync(gitCmd + ' git init -q', { stdio: 'pipe' });
    execSync(gitCmd + ' git config user.email "agent@agent-relay.com"', { stdio: 'pipe' });
    execSync(gitCmd + ' git config user.name "Agent Relay"', { stdio: 'pipe' });

    const { writeFile: writeBaselineFile, mkdir: mkdirBaseline, stat: statBaseline } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');
    const gitPath = pathJoin(brokerCwd, '.git');
    let existingGit = null;
    try { existingGit = await statBaseline(gitPath); } catch { /* doesn't exist */ }
    if (!existingGit || !existingGit.isDirectory()) {
      await writeBaselineFile(gitPath, 'gitdir: ' + pathGitDir + '\n');
    } else {
      console.log('[bootstrap] .git already exists as a directory in ' + brokerCwd + '; keeping user repo intact');
    }

    const excludeLines = [
      '# auto-generated by agent-relay cloud bootstrap',
      '.agent-relay/',
      '.relay/',
      '.relayfile-mount-state.json',
      '',
    ].join('\n');
    const excludeDir = pathJoin(pathGitDir, 'info');
    await mkdirBaseline(excludeDir, { recursive: true });
    await writeBaselineFile(pathJoin(excludeDir, 'exclude'), excludeLines);

    const baselineManifest = {};
    async function walkDir(dir, prefix) {
      const { readdir: rd, stat: st } = await import('node:fs/promises');
      try {
        const entries = await rd(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agent-relay') continue;
          const rel = prefix ? prefix + '/' + entry.name : entry.name;
          const full = pathJoin(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(full, rel);
          } else {
            try {
              const s = await st(full);
              baselineManifest[rel] = s.mtimeMs;
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
    await walkDir(brokerCwd, '');
    await writeBaselineFile(pathJoin(pathGitDir, 'baseline-manifest.json'), JSON.stringify(baselineManifest));

    try {
      execSync(gitCmd + ' git add -A', { stdio: 'pipe', timeout: 120_000 });
      execSync(gitCmd + ' git commit -q -m "baseline" --allow-empty', { stdio: 'pipe', timeout: 30_000 });
      console.log('[bootstrap] Baseline committed for path "' + entry.name + '" with ' + Object.keys(baselineManifest).length + ' tracked files.');
    } catch (addErr) {
      console.warn('[bootstrap] Full-tree baseline timed out for path "' + entry.name + '"; falling back to empty baseline:', addErr?.message ?? addErr);
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(pathJoin(pathGitDir, 'index.lock'));
      } catch {
        // no stale lock
      }
      execSync(gitCmd + ' git commit -q --allow-empty -m "baseline"', { stdio: 'pipe', timeout: 10000 });
    }
  } catch (gitErr) {
    console.warn('[bootstrap] git baseline setup failed for path "' + entry.name + '" (non-fatal):', gitErr?.message ?? gitErr);
  }
}

async function uploadPatchForMountedPath(entry) {
  const brokerCwd = entry.mountPath;
  const pathGitDir = gitDirForPath(entry.name);
  const patchGitCmd = 'GIT_DIR=' + pathGitDir + ' GIT_WORK_TREE=' + brokerCwd;
  try {
    let hasBaseline = false;
    try {
      execSync(patchGitCmd + ' git rev-parse HEAD', { stdio: 'pipe' });
      hasBaseline = true;
    } catch {
      console.log('[bootstrap] No git baseline for path "' + entry.name + '" — creating one now for patch generation...');
      try {
        execSync('mkdir -p ' + pathGitDir, { stdio: 'pipe' });
        execSync(patchGitCmd + ' git init -q', { stdio: 'pipe' });
        execSync(patchGitCmd + ' git config user.email "agent@agent-relay.com"', { stdio: 'pipe' });
        execSync(patchGitCmd + ' git config user.name "Agent Relay"', { stdio: 'pipe' });
        execSync(patchGitCmd + ' git commit --allow-empty -q -m "empty baseline"', { stdio: 'pipe' });
        hasBaseline = true;
      } catch (initErr) {
        console.warn('[bootstrap] Late git init failed for path "' + entry.name + '":', initErr?.message ?? initErr);
      }
    }
    if (!hasBaseline) return;

    try {
      execSync(patchGitCmd + ' git add -A', { stdio: 'pipe', cwd: brokerCwd, timeout: 120_000 });
    } catch (addErr) {
      console.warn('[bootstrap] git add -A timed out during patch generation for path "' + entry.name + '":', addErr?.message ?? addErr);
    }
    const baselineHash = execSync(patchGitCmd + ' git rev-list --max-parents=0 HEAD 2>/dev/null || echo HEAD', { encoding: 'utf8' }).trim();
    const patchPath = '/tmp/changes-' + entry.name + '.patch';
    execSync(patchGitCmd + ' git diff --cached ' + baselineHash + ' > ' + patchPath + ' 2>/dev/null || true');
    const { readFile: readPatch } = await import('node:fs/promises');
    const patchContent = await readPatch(patchPath);
    if (patchContent.length > 0) {
      await s3.putObject('changes-' + entry.name + '.patch', patchContent, 'text/plain');
    }
  } catch (patchErr) {
    console.warn('[bootstrap] patch upload failed for path "' + entry.name + '" (non-fatal):', patchErr?.message ?? patchErr);
  }
}

// S3 client created early so the log flusher can start before code extraction.
// This ensures any crash during initialization is captured in runner.log.
const s3 = new ScopedS3Client({
  backend: env.WORKFLOW_STORAGE_BACKEND === 'cloud-api' ? 'cloud-api' : 's3',
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  sessionToken: env.S3_SESSION_TOKEN,
  bucket: env.S3_BUCKET,
  prefix: env.S3_PREFIX,
  cloudApiUrl: env.WORKFLOW_STORAGE_CLOUD_API_URL || env.CLOUD_API_URL,
  cloudApiAccessToken: env.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN || env.CLOUD_API_ACCESS_TOKEN,
  cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,
});

async function initializeWorkflow() {
  const codeKey = env.S3_CODE_KEY;
  if (hasPathMounts) {
    console.log('[bootstrap] Downloading ' + submittedPaths.length + ' path tarball(s) from S3...');
    execSync('mkdir -p ' + workspaceMountPath, { stdio: 'pipe' });
    for (const entry of submittedPaths) {
      console.log('[bootstrap] Downloading path "' + entry.name + '" from S3 (' + entry.s3CodeKey + ')...');
      await downloadAndExtractCode(s3, entry.s3CodeKey, sandboxFs, entry.mountPath);
      console.log('[bootstrap] Path "' + entry.name + '" extracted to ' + entry.mountPath);
    }
    await writePathsManifest(submittedPaths);
    console.log('[bootstrap] Wrote path manifest to ' + workspaceMountPath + '/.relay/paths.json');
  } else if (codeKey) {
    console.log('[bootstrap] Downloading code from S3 (' + codeKey + ')...');
    await downloadAndExtractCode(s3, codeKey, sandboxFs, codeMountPath);
    console.log('[bootstrap] Code extracted to ' + codeMountPath);
    // Skip relayfile seeding — files are already on disk from S3 extraction
    // and the relayfile mount daemon (started later) will sync them to the
    // remote workspace automatically. Seeding re-uploads every file one-by-one
    // via HTTP PUT which is extremely slow for large repos (728+ files).
  }

  // For multi-path runs (hasPathMounts) cwd must be the parent of the
  // mounts (workspaceMountPath), not the first mount. Two reasons:
  //
  //   (1) The SDK runner's resolvePathDefinitions() validates each
  //       paths[].path by path.resolve(cwd, declaredPath). Local-mode
  //       semantics: cwd is the workflow file's parent and declared
  //       paths are relative to it. Setting cwd to paths[0].mountPath
  //       makes 'alpha' resolve to /home/daytona/workspace/alpha/alpha
  //       and validation throws "Path 'alpha' resolves to ... which
  //       does not exist (required)".
  //   (2) /home/daytona/workspace contains the .relay/paths.json
  //       manifest and is the symmetric peer of how the local runner
  //       sees a multi-repo project root.
  //
  // Only fall back to $HOME for truly empty config-only runs (no code
  // tarball AND no path mounts). $HOME has nothing extracted there so
  // relative imports break — the comment that used to live here was
  // worried about that case for multi-path runs too, but
  // workspaceMountPath does NOT have the $HOME emptiness problem (it
  // contains every path mount as a direct child).
  const brokerCwd = type === 'config' && !codeKey && !hasPathMounts
    ? (env.HOME ?? '/home/daytona')
    : (hasPathMounts ? workspaceMountPath : codeMountPath);
  const relayfileRoot = hasPathMounts ? workspaceMountPath : codeMountPath;
  await writeMsdReviewInputContext(brokerCwd);

  // Mount CLI credentials to filesystem locations that each CLI expects.
  // CLI_CREDENTIALS is either a single provider JSON string or a bundled
  // { provider: credentialJson } object. Write each provider's credentials
  // to its expected path so CLIs work regardless of workflow format.
  if (env.CLI_CREDENTIALS) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const home = env.HOME ?? '/home/daytona';
    const PROVIDER_PATHS = {
      anthropic: join(home, '.claude', '.credentials.json'),
      openai: join(home, '.codex', 'auth.json'),
      google: join(home, '.config', 'gemini', 'credentials.json'),
      opencode: join(home, '.local', 'share', 'opencode', 'auth.json'),
    };
    try {
      let credMap = {};
      const parsed = JSON.parse(env.CLI_CREDENTIALS);
      if (typeof parsed === 'object' && !Array.isArray(parsed) && parsed !== null) {
        // Check if it's a bundle { provider: credJson } or a single credential
        const keys = Object.keys(parsed);
        if (keys.some(k => k in PROVIDER_PATHS)) {
          credMap = parsed;
        } else {
          // Single credential — detect provider from actual credential shape
          if (parsed.type === 'oauth_token') credMap.anthropic = env.CLI_CREDENTIALS;
          else if (parsed.claudeAiOauth) credMap.anthropic = env.CLI_CREDENTIALS;
          else if (parsed.tokens || parsed.access_token) credMap.openai = env.CLI_CREDENTIALS;
          else if (keys.some(k => k.startsWith('opencode'))) credMap.opencode = env.CLI_CREDENTIALS;
          else credMap.anthropic = env.CLI_CREDENTIALS; // fallback
        }
      }
      for (const [provider, credJson] of Object.entries(credMap)) {
        const targetPath = PROVIDER_PATHS[provider];
        if (!targetPath) continue;
        try {
          const credentialText = typeof credJson === 'string' ? credJson : JSON.stringify(credJson);
          const setupToken = provider === 'anthropic'
            ? extractAnthropicOauthToken(credentialText)
            : null;
          if (setupToken) {
            env.CLAUDE_CODE_OAUTH_TOKEN = setupToken;
            console.log('[bootstrap] Mounted setup-token env for anthropic');
            continue;
          }
          const dir = targetPath.substring(0, targetPath.lastIndexOf('/'));
          mkdirSync(dir, { recursive: true });
          writeFileSync(targetPath, credentialText);
          console.log('[bootstrap] Mounted credentials for ' + provider + ' at ' + targetPath);
        } catch (mountErr) {
          console.warn('[bootstrap] Failed to mount credentials for ' + provider + ':', mountErr?.message ?? mountErr);
        }
      }
    } catch (parseErr) {
      console.warn('[bootstrap] Failed to parse CLI_CREDENTIALS:', parseErr?.message ?? parseErr);
    }
  }

  // Install any CLIs required by the workflow that aren't pre-baked in the image
  if (interactive && env.WORKFLOW_CONFIG) {
    try {
      const config = JSON.parse(env.WORKFLOW_CONFIG);
      const preInstalled = new Set(['claude', 'codex', 'opencode']);
      const installCommands = { gemini: 'npm install -g @google/gemini-cli', droid: 'npm install -g @anthropic-ai/droid' };
      for (const agent of config.agents ?? []) {
        const cli = agent.cli;
        if (cli && !preInstalled.has(cli) && installCommands[cli]) {
          console.log('[bootstrap] Installing ' + cli + '...');
          execSync(installCommands[cli], { stdio: 'inherit', timeout: 120000 });
        }
      }
    } catch { /* best effort */ }
  }

  // Ensure working directory exists and is a git repo. Two consumers rely
  // on this: codex / other CLIs that require a git repo at cwd, and user
  // workflows that run git status / git diff against their code.
  //
  // Layout: .git lives at $HOME/.project-git (regular filesystem, supports
  // flock even if $brokerCwd is on a volume). A .git pointer file at
  // $brokerCwd/.git links to that gitdir so plain git invocations from
  // $brokerCwd work without needing GIT_DIR in the env. This is the
  // standard git linked-worktree mechanism.
  //
  // Baseline tries two strategies:
  //   1) Full "git add -A" + commit. Makes "git status --porcelain"
  //      return clean on a fresh run, so workflows that guard on a clean
  //      tree pass as they would on a dev machine. Can be slow on huge
  //      volumes; bounded by a generous timeout, falls through to (2).
  //   2) Empty commit + manifest diff. Preserves the legacy fast path
  //      for pathological filesystems. Patch generation later uses the
  //      manifest to stage only changed files.
  if (hasPathMounts) {
    // Sentinel git repo at workspaceMountPath. cloud#437 made the
    // broker cwd /home/daytona/workspace (parent of every path mount)
    // so the SDK runner's resolvePathDefinitions() resolves declared
    // paths correctly. But agents and CLIs that auto-detect git
    // context (codex CLI runs 'git rev-parse' on startup, claude
    // checks 'git status', etc.) inherit that cwd by default and
    // would crash with "fatal: not a git repository" because per-mount
    // baselines live INSIDE each mountPath, not at the parent.
    //
    // Initialize an empty repo at the workspace root so those tools
    // succeed without claiming any of the per-mount tracked files.
    // The .git here is a real directory (not a gitdir pointer file),
    // so it doesn't collide with the per-mount .git pointer files
    // setupGitBaselineForMountedPath writes.
    // Probe HEAD specifically (not just is-inside-work-tree). A
    // partially initialized state from a prior crashed bootstrap (git
    // init succeeded but the empty commit didn't) leaves a repo with
    // no HEAD; agents that auto-probe via 'git rev-parse HEAD' would
    // still fail on retry. We only skip when HEAD resolves to a real
    // commit. If init/config already happened, re-running them is a
    // no-op, so the recovery path is safe.
    try {
      execSync('mkdir -p ' + workspaceMountPath, { stdio: 'pipe' });
      execSync('git -C ' + workspaceMountPath + ' rev-parse --verify HEAD', { stdio: 'pipe' });
      console.log('[bootstrap] Workspace root sentinel repo healthy; skipping init');
    } catch {
      try {
        execSync('git -C ' + workspaceMountPath + ' init -q', { stdio: 'pipe' });
        execSync('git -C ' + workspaceMountPath + ' config user.email "agent@agent-relay.com"', { stdio: 'pipe' });
        execSync('git -C ' + workspaceMountPath + ' config user.name "Agent Relay"', { stdio: 'pipe' });
        execSync('git -C ' + workspaceMountPath + ' commit -q --allow-empty -m "workspace-root sentinel"', { stdio: 'pipe' });
        console.log('[bootstrap] Initialized sentinel git repo at ' + workspaceMountPath);
      } catch (sentinelErr) {
        console.warn('[bootstrap] Sentinel git init at workspace root failed (non-fatal):', sentinelErr?.message ?? sentinelErr);
      }
    }

    for (const entry of submittedPaths) {
      await setupGitBaselineForMountedPath(entry);
    }
  } else {
  const gitCmd = 'GIT_DIR=' + gitDir + ' GIT_WORK_TREE=' + brokerCwd;
  try {
    console.log('[bootstrap] Setting up git baseline in ' + brokerCwd + '...');
    execSync('mkdir -p ' + brokerCwd, { stdio: 'pipe' });
    execSync('mkdir -p ' + gitDir, { stdio: 'pipe' });
    execSync(gitCmd + ' git init -q', { stdio: 'pipe' });
    execSync(gitCmd + ' git config user.email "agent@agent-relay.com"', { stdio: 'pipe' });
    execSync(gitCmd + ' git config user.name "Agent Relay"', { stdio: 'pipe' });

    const { writeFile: writeBaselineFile, mkdir: mkdirBaseline, stat: statBaseline } = await import('node:fs/promises');
    const { join: pathJoin } = await import('node:path');

    // .git pointer file so git commands from $brokerCwd resolve to the
    // baseline without needing GIT_DIR in the env. Standard linked-worktree
    // syntax. Skip if $brokerCwd/.git already exists as a real directory
    // (user brought a pre-cloned repo in their tarball) — otherwise the
    // writeFile below throws EISDIR and aborts the whole baseline block.
    const gitPath = pathJoin(brokerCwd, '.git');
    let existingGit = null;
    try { existingGit = await statBaseline(gitPath); } catch { /* doesn't exist */ }
    if (!existingGit || !existingGit.isDirectory()) {
      await writeBaselineFile(gitPath, 'gitdir: ' + gitDir + '\n');
    } else {
      console.log('[bootstrap] .git already exists as a directory in ' + brokerCwd + '; keeping user repo intact');
    }

    // Bootstrap ignore rules live in gitDir/info/exclude, not in
    // $brokerCwd/.gitignore. Writing to .gitignore would clobber the
    // user's ignore rules (extracted from S3 alongside their code).
    // info/exclude is the standard git per-repo local exclude file —
    // honored by git status/add/etc just like .gitignore but stored in
    // the gitdir so it doesn't touch the worktree.
    const excludeLines = [
      '# auto-generated by agent-relay cloud bootstrap',
      '.agent-relay/',
      '.relay/',
      '.relayfile-mount-state.json',
      '',
    ].join('\n');
    const excludeDir = pathJoin(gitDir, 'info');
    const excludePath = pathJoin(excludeDir, 'exclude');
    await mkdirBaseline(excludeDir, { recursive: true });
    await writeBaselineFile(excludePath, excludeLines);

    // File manifest used by the diff fallback (stage 2) and by patch
    // generation at end-of-workflow to avoid a full "git add -A" rescan.
    console.log('[bootstrap] Creating file manifest for baseline...');
    const baselineManifest = {};
    async function walkDir(dir, prefix) {
      const { readdir: rd, stat: st } = await import('node:fs/promises');
      try {
        const entries = await rd(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agent-relay') continue;
          const rel = prefix ? prefix + '/' + entry.name : entry.name;
          const full = pathJoin(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(full, rel);
          } else {
            try {
              const s = await st(full);
              baselineManifest[rel] = s.mtimeMs;
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* skip unreadable dirs */ }
    }
    await walkDir(brokerCwd, '');
    await writeBaselineFile(pathJoin(gitDir, 'baseline-manifest.json'), JSON.stringify(baselineManifest));

    // Stage 1: real baseline commit of the full worktree. Fast on regular
    // filesystems (~1-5s for typical repos); bounded at 120s so we don't
    // hang if /project is volume-backed and pathologically slow.
    let committedFull = false;
    try {
      execSync(gitCmd + ' git add -A', { stdio: 'pipe', timeout: 120_000 });
      execSync(gitCmd + ' git commit -q -m "baseline" --allow-empty', { stdio: 'pipe', timeout: 30_000 });
      committedFull = true;
      console.log('[bootstrap] Baseline committed with ' + Object.keys(baselineManifest).length + ' tracked files (clean tree).');
    } catch (addErr) {
      console.warn('[bootstrap] Full-tree baseline timed out; falling back to empty baseline + manifest diff:', addErr?.message ?? addErr);
      // When execSync times out on a slow volume, git may be SIGTERM'd
      // before it can remove $GIT_DIR/index.lock — Stage 2's git commit
      // then fails with "Unable to create index.lock: File exists" and
      // poisons the whole baseline path. Drop the stale lock so the
      // fallback (and later patch-generation baseline) can acquire it.
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(pathJoin(gitDir, 'index.lock'));
      } catch {
        // Lock didn't exist or couldn't be removed — no-op; the next git
        // command will surface any real problem with a clearer error.
      }
    }

    // Stage 2: empty baseline fallback.
    if (!committedFull) {
      execSync(gitCmd + ' git commit -q --allow-empty -m "baseline"', { stdio: 'pipe', timeout: 10000 });
      console.log('[bootstrap] Baseline manifest created (' + Object.keys(baselineManifest).length + ' files, untracked).');
    }
  } catch (gitErr) {
    console.warn('[bootstrap] git baseline setup failed (non-fatal):', gitErr?.message ?? gitErr);
  }
  }

  if (!relayfileEnabled) {
    throw new Error('Relayfile is required for executor-based workflows');
  }
  if (!/^rw_[a-z0-9]{8}$/.test(relayfileWorkspaceId)) {
    throw new Error('RELAYFILE_WORKSPACE_ID must be a unified rw_ workspace ID');
  }
  // Per-step mode uses SandboxedStepExecutor so each agent runs in its own
  // sandbox. Shared-sandbox mode deliberately leaves the executor null so the
  // SDK runner starts the broker and agent processes inside this orchestrator
  // sandbox and every step sees the same workdir.
  const localSandboxUrl = (env.LOCAL_SANDBOX_URL || env.LOCAL_SANDBOX_RUNNER_URL || '').trim();
  const useLocalSandbox = Boolean((env.SANDBOX_PROVIDER === 'local' || env.SANDBOX_PROVIDER === 'local-docker') && localSandboxUrl);
  const daytona = useLocalSandbox ? null : new Daytona({ apiKey: env.DAYTONA_API_KEY ?? '' });
  const runtime = useLocalSandbox
    ? new LocalHttpRuntime({ baseUrl: localSandboxUrl })
    : new DaytonaRuntime({ daytona, snapshot: await getSnapshotName() });
  const credentials = {
    s3Credentials: {
      backend: env.WORKFLOW_STORAGE_BACKEND === 'cloud-api' ? 'cloud-api' : 's3',
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      sessionToken: env.S3_SESSION_TOKEN ?? '',
      bucket: env.S3_BUCKET ?? '',
      prefix: env.S3_PREFIX ?? '',
      cloudApiUrl: env.WORKFLOW_STORAGE_CLOUD_API_URL || env.CLOUD_API_URL,
      cloudApiAccessToken: env.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN || env.CLOUD_API_ACCESS_TOKEN,
      cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,
    },
    cliCredentials: env.CLI_CREDENTIALS ?? '',
    credentialProxyUrl: env.CREDENTIAL_PROXY_URL ?? undefined,
    credentialProxyTokens: parseCredentialProxyTokens(env.CREDENTIAL_PROXY_TOKENS),
    workspaceId: env.RELAY_WORKSPACE_ID ?? '',
    relayApiKey: env.RELAY_API_KEY ?? '',
    runId,
    userId: env.USER_ID ?? '',
    cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,
  };

  // Collect user-provided envSecrets from process.env (keys not in the internal set)
  const INTERNAL_ENV_KEYS = new Set([
    'RUN_ID', 'WORKFLOW_STORAGE_BACKEND', 'WORKFLOW_STORAGE_CLOUD_API_URL', 'WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN',
    'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN',
    'S3_BUCKET', 'S3_PREFIX', 'S3_CODE_KEY', 'S3_PATHS', 'RELAY_API_KEY', 'RELAY_WORKSPACE_ID',
    'USER_ID', 'CLOUD_API_URL', 'CLOUD_API_ACCESS_TOKEN', 'CLOUD_API_REFRESH_TOKEN',
    'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT', 'AWS_REGION', 'CALLBACK_URL', 'CALLBACK_TOKEN',
    'WORKFLOW_CONFIG', 'CLI_CREDENTIALS', 'WORKFLOW_FILE', 'INTERACTIVE',
    'WORKFLOW_EXECUTION_MODE', 'WORKFLOW_OBSERVER_URL', 'MSD_REVIEW_INPUT_JSON',
    'MSD_REVIEW_INPUT_PATH', 'AGENT_WORKFORCE_SHARED_SANDBOX_ID', 'AGENT_WORKFORCE_SHARED_WORKDIR',
    'RESUME_RUN_ID', 'START_FROM', 'PREVIOUS_RUN_ID',
    'CREDENTIAL_PROXY_URL', 'CREDENTIAL_PROXY_TOKENS',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY', 'GOOGLE_API_BASE',
    'RELAYFILE_URL', 'RELAYFILE_TOKEN', 'RELAYFILE_WORKSPACE', 'RELAYFILE_WORKSPACE_ID',
    'DAYTONA_API_KEY', 'DAYTONA_JWT_TOKEN', 'DAYTONA_ORGANIZATION_ID', 'DAYTONA_SANDBOX_ID',
    'SANDBOX_PROVIDER', 'LOCAL_SANDBOX_URL', 'LOCAL_SANDBOX_RUNNER_URL',
    'RELAY_LLM_PROXY', 'RELAY_LLM_PROXY_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
    'GOOGLE_API_BASE', 'OPENAI_API_BASE', 'CREDENTIAL_PROXY_TOKEN', 'RELAY_LLM_PROXY_TOKEN',
    'SANDBOX_ID',
    'HOME', 'PATH', 'NODE_ENV', 'NODE_PATH', 'SHELL', 'TERM', 'USER', 'LANG',
  ]);
  const envSecrets = {};
  for (const [k, v] of Object.entries(env)) {
    if (!INTERNAL_ENV_KEYS.has(k) && v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      envSecrets[k] = v;
    }
  }
  if (relayAgentTokens) {
    // Preserve the per-agent relayfile token bundle for worker sandboxes.
    envSecrets.RELAY_AGENT_TOKENS = relayAgentTokens;
  }
  const forwardedEnvKeys = [
    'RELAY_LLM_PROXY',
    'RELAY_LLM_PROXY_URL',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'GOOGLE_API_BASE',
    'OPENAI_API_BASE',
    'CREDENTIAL_PROXY_TOKEN',
    'RELAY_LLM_PROXY_TOKEN',
  ];
  for (const key of forwardedEnvKeys) {
    if (env[key]) {
      envSecrets[key] = env[key];
    }
  }
  const executorCodeMountPath = hasPathMounts ? workspaceMountPath : codeMountPath;

  // The orchestrator sandbox is the current sandbox we're running in.
  // Register it with the runtime so deterministic steps stay on runtime.exec
  // without tearing down the active orchestrator sandbox.
  let orchestratorRuntimeHandle = null;
  if (env.DAYTONA_SANDBOX_ID) {
    try {
      if (useLocalSandbox) {
        orchestratorRuntimeHandle = runtime.attachSandbox(
          {
            sandboxId: env.DAYTONA_SANDBOX_ID,
            homeDir: env.HOME ?? '/home/daytona',
            workdir: executorCodeMountPath,
          },
          {
            homeDir: env.HOME ?? '/home/daytona',
            workdir: executorCodeMountPath,
          },
        );
      } else {
        const orchestratorSandbox = await daytona.get(env.DAYTONA_SANDBOX_ID);
        orchestratorRuntimeHandle = runtime.attachSandbox(orchestratorSandbox, {
          homeDir: env.HOME ?? '/home/daytona',
          workdir: executorCodeMountPath,
        });
      }
    } catch (e) {
      console.warn('[bootstrap] Failed to get orchestrator sandbox (non-fatal):', e?.message ?? e);
    }
  }

  const executor = sharedSandbox
    ? null
    : new SandboxedStepExecutor({
        runtime,
        credentials,
        s3,
        relayfileUrl: relayfileBaseUrl,
        relayfileToken: env.RELAYFILE_TOKEN ?? '',
        relayfileWorkspaceId,
        codeMountPath: executorCodeMountPath,
        orchestratorRuntimeHandle,
        ...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),
      });

  return { executor, brokerCwd, relayfileRoot };
}

function buildStandaloneWorkflowWrapperSource(workflowFile) {
  return [
    "import { pathToFileURL } from 'node:url';",
    "import { WorkflowBuilder } from '@relayflows/core';",
    "import { Daytona } from '@daytonaio/sdk';",
    "import { ScopedS3Client } from './lib/storage/client.js';",
    "import { SandboxedStepExecutor } from './lib/executor/executor.js';",
    "import { DaytonaRuntime } from './lib/runtime/daytona.js';",
    "import { LocalHttpRuntime } from './lib/runtime/local-http.js';",
    "import { getSnapshotName } from './lib/config/snapshot.js';",
    "",
    "const env = process.env;",
    "const runId = env.RUN_ID ?? 'unknown';",
    "const executionMode = env.WORKFLOW_EXECUTION_MODE === 'shared-sandbox' ? 'shared-sandbox' : 'per-step-sandbox';",
    "const sharedSandbox = executionMode === 'shared-sandbox';",
    // Must match script-generator.ts:145 and launcher.ts:resolveMultiPathWorkflowFile.
    "const workspaceMountPath = '/home/daytona/workspace';",
    "const codeMountPath = env.S3_PATHS ? workspaceMountPath : " + JSON.stringify(codeMountPath) + ";",
    "const workflowFile = " + JSON.stringify(workflowFile) + ";",
    "const relayfileBaseUrl = (env.RelayfileUrl ?? env.RELAYFILE_URL)?.replace(/\\/$/, '') ?? '';",
    "const relayfileWorkspaceId = env.RELAYFILE_WORKSPACE_ID ?? env.RELAYFILE_WORKSPACE ?? env.RELAY_WORKSPACE_ID ?? '';",
    "const relayAgentTokens = env.RELAY_AGENT_TOKENS ?? '';",
    "",
    "async function createCloudExecutor() {",
    "  if (sharedSandbox) {",
    "    return null;",
    "  }",
    "  if (!env.DAYTONA_SANDBOX_ID) {",
    "    return null;",
    "  }",
    "  if (!relayfileBaseUrl || !env.RELAYFILE_TOKEN) {",
    "    throw new Error('Relayfile is required for standalone TS cloud workflows');",
    "  }",
    "  if (!/^rw_[a-z0-9]{8}$/.test(relayfileWorkspaceId)) {",
    "    throw new Error('RELAYFILE_WORKSPACE_ID must be a unified rw_ workspace ID');",
    "  }",
    "",
    "  const s3 = new ScopedS3Client({",
    "    backend: env.WORKFLOW_STORAGE_BACKEND === 'cloud-api' ? 'cloud-api' : 's3',",
    "    accessKeyId: env.S3_ACCESS_KEY_ID,",
    "    secretAccessKey: env.S3_SECRET_ACCESS_KEY,",
    "    sessionToken: env.S3_SESSION_TOKEN,",
    "    bucket: env.S3_BUCKET,",
    "    prefix: env.S3_PREFIX,",
    "    cloudApiUrl: env.WORKFLOW_STORAGE_CLOUD_API_URL || env.CLOUD_API_URL,",
    "    cloudApiAccessToken: env.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN || env.CLOUD_API_ACCESS_TOKEN,",
    "    cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,",
    "  });",
    "  const localSandboxUrl = (env.LOCAL_SANDBOX_URL || env.LOCAL_SANDBOX_RUNNER_URL || '').trim();",
    "  const useLocalSandbox = Boolean((env.SANDBOX_PROVIDER === 'local' || env.SANDBOX_PROVIDER === 'local-docker') && localSandboxUrl);",
    "  const daytona = useLocalSandbox ? null : new Daytona({ apiKey: env.DAYTONA_API_KEY ?? '' });",
    "  const runtime = useLocalSandbox",
    "    ? new LocalHttpRuntime({ baseUrl: localSandboxUrl })",
    "    : new DaytonaRuntime({ daytona, snapshot: await getSnapshotName() });",
    "  const credentials = {",
    "    s3Credentials: {",
    "      backend: env.WORKFLOW_STORAGE_BACKEND === 'cloud-api' ? 'cloud-api' : 's3',",
    "      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',",
    "      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',",
    "      sessionToken: env.S3_SESSION_TOKEN ?? '',",
    "      bucket: env.S3_BUCKET ?? '',",
    "      prefix: env.S3_PREFIX ?? '',",
    "      cloudApiUrl: env.WORKFLOW_STORAGE_CLOUD_API_URL || env.CLOUD_API_URL,",
    "      cloudApiAccessToken: env.WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN || env.CLOUD_API_ACCESS_TOKEN,",
    "      cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,",
    "    },",
    "    cliCredentials: env.CLI_CREDENTIALS ?? '',",
    "    workspaceId: env.RELAY_WORKSPACE_ID ?? '',",
    "    relayApiKey: env.RELAY_API_KEY ?? '',",
    "    relayBaseUrl: (env.RELAY_BASE_URL?.trim()) || 'https://api.relaycast.dev',",
    "    runId,",
    "    userId: env.USER_ID ?? '',",
    "    cloudApiRefreshToken: env.CLOUD_API_REFRESH_TOKEN,",
    "  };",
    "",
    "  const INTERNAL_ENV_KEYS = new Set([",
    "    'RUN_ID', 'WORKFLOW_STORAGE_BACKEND', 'WORKFLOW_STORAGE_CLOUD_API_URL', 'WORKFLOW_STORAGE_CLOUD_API_ACCESS_TOKEN',",
    "    'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_SESSION_TOKEN',",
    "    'S3_BUCKET', 'S3_PREFIX', 'S3_CODE_KEY', 'S3_PATHS', 'RELAY_API_KEY', 'RELAY_BASE_URL',",
    "    'RELAY_WORKSPACE_ID',",
    "    'USER_ID', 'CLOUD_API_URL', 'CLOUD_API_ACCESS_TOKEN', 'CLOUD_API_REFRESH_TOKEN',",
    "    'CLOUD_API_ACCESS_TOKEN_EXPIRES_AT', 'AWS_REGION', 'CALLBACK_URL', 'CALLBACK_TOKEN',",
    "    'WORKFLOW_CONFIG', 'CLI_CREDENTIALS', 'WORKFLOW_FILE', 'INTERACTIVE',",
    "    'WORKFLOW_EXECUTION_MODE', 'WORKFLOW_OBSERVER_URL', 'MSD_REVIEW_INPUT_JSON',",
    "    'MSD_REVIEW_INPUT_PATH', 'AGENT_WORKFORCE_SHARED_SANDBOX_ID', 'AGENT_WORKFORCE_SHARED_WORKDIR',",
    "    'RESUME_RUN_ID', 'START_FROM', 'PREVIOUS_RUN_ID',",
    "    'RELAYFILE_URL', 'RELAYFILE_TOKEN', 'RELAYFILE_WORKSPACE', 'RELAYFILE_WORKSPACE_ID',",
    "    'DAYTONA_API_KEY', 'DAYTONA_JWT_TOKEN', 'DAYTONA_ORGANIZATION_ID', 'DAYTONA_SANDBOX_ID',",
    "    'SANDBOX_PROVIDER', 'LOCAL_SANDBOX_URL', 'LOCAL_SANDBOX_RUNNER_URL',",
    "    'SANDBOX_ID',",
    "    'HOME', 'PATH', 'NODE_ENV', 'NODE_PATH', 'SHELL', 'TERM', 'USER', 'LANG',",
    "  ]);",
    "  const envSecrets = {};",
    "  for (const [k, v] of Object.entries(env)) {",
    "    if (!INTERNAL_ENV_KEYS.has(k) && v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {",
    "      envSecrets[k] = v;",
    "    }",
    "  }",
    "  if (relayAgentTokens) {",
    "    envSecrets.RELAY_AGENT_TOKENS = relayAgentTokens;",
    "  }",
    "",
    "  let orchestratorRuntimeHandle = null;",
    "  try {",
    "    if (useLocalSandbox) {",
    "      orchestratorRuntimeHandle = runtime.attachSandbox(",
    "        { sandboxId: env.DAYTONA_SANDBOX_ID, homeDir: env.HOME ?? '/home/daytona', workdir: codeMountPath },",
    "        { homeDir: env.HOME ?? '/home/daytona', workdir: codeMountPath },",
    "      );",
    "    } else {",
    "      const orchestratorSandbox = await daytona.get(env.DAYTONA_SANDBOX_ID);",
    "      orchestratorRuntimeHandle = runtime.attachSandbox(orchestratorSandbox, {",
    "        homeDir: env.HOME ?? '/home/daytona',",
    "        workdir: codeMountPath,",
    "      });",
    "    }",
    "  } catch (e) {",
    "    console.warn('[bootstrap] Failed to get orchestrator sandbox for standalone wrapper (non-fatal):', e?.message ?? e);",
    "  }",
    "",
    "  return new SandboxedStepExecutor({",
    "    runtime,",
    "    credentials,",
    "    s3,",
    "    relayfileUrl: relayfileBaseUrl,",
    "    relayfileToken: env.RELAYFILE_TOKEN ?? '',",
    "    relayfileWorkspaceId,",
    "    codeMountPath,",
    "    orchestratorRuntimeHandle,",
    "    ...(Object.keys(envSecrets).length > 0 ? { envSecrets } : {}),",
    "  });",
    "}",
    "",
    "async function patchWorkflowBuilderRun() {",
    "  const originalRun = WorkflowBuilder?.prototype?.run;",
    "  if (typeof originalRun !== 'function') {",
    "    console.warn('[bootstrap] WorkflowBuilder.run was not found; standalone TS workflow will use SDK defaults');",
    "    return;",
    "  }",
    "  const executor = await createCloudExecutor();",
    "  if (!executor && !sharedSandbox) {",
    "    return;",
    "  }",
    "  const binaryArgs = [];",
    "  if (env.RELAY_BROKER_API_PORT) {",
    "    binaryArgs.push('--api-port', env.RELAY_BROKER_API_PORT, '--api-bind', '0.0.0.0');",
    "  }",
    "",
    "  WorkflowBuilder.prototype.run = function patchedCloudRun(options = {}) {",
    "    const patchedOptions = {",
    "      ...options,",
    "      cwd: options.cwd ?? codeMountPath,",
    "      relay: options.relay ?? { apiKey: env.RELAY_API_KEY ?? '', binaryArgs },",
    "      ...(executor ? { executor: options.executor ?? executor, processBackend: options.processBackend ?? executor } : {}),",
    "    };",
    "    return originalRun.call(this, patchedOptions);",
    "  };",
    "}",
    "",
    "process.env.RELAYFILE_URL = relayfileBaseUrl;",
    "process.env.RELAYFILE_BASE_URL = relayfileBaseUrl;",
    "process.env.RELAY_CLOUD_PROVISIONING_DONE = '1';",
    "await patchWorkflowBuilderRun();",
    "process.argv[1] = workflowFile;",
    "await import(pathToFileURL(workflowFile).href);",
    "",
  ].join('\n');
}

function applyMountedPathsToConfig(config) {
  if (!hasPathMounts || !config || !Array.isArray(config.paths)) {
    return config;
  }
  const mountByName = new Map(submittedPaths.map((entry) => [entry.name, entry.mountPath]));
  config.paths = config.paths.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      return entry;
    }
    const mountedPath = mountByName.get(entry.name);
    return mountedPath ? { ...entry, path: mountedPath } : entry;
  });
  return config;
}

async function executeWorkflow(executor, brokerCwd) {
  // When RELAY_BROKER_API_PORT is set (by the launcher), expose the
  // broker's HTTP/WS API so the desktop app can connect remotely.
  const binaryArgs = [];
  if (env.RELAY_BROKER_API_PORT) {
    binaryArgs.push('--api-port', env.RELAY_BROKER_API_PORT, '--api-bind', '0.0.0.0');
  }

  // Set RELAYFILE_URL in process.env so the relay SDK and broker inherit it
  // naturally. Do NOT pass relay.env — the SDK's getRelayEnv() uses it as a
  // replacement for process.env (not a merge), which strips PATH, HOME, etc.
  process.env.RELAYFILE_URL = relayfileBaseUrl;
  process.env.RELAYFILE_BASE_URL = relayfileBaseUrl;

  // Signal to the SDK that the cloud launcher already compiled and seeded
  // relayfile ACLs. The SDK provisioner (added in v4.0.9) must skip its own
  // createWorkspaceIfNeeded() call — the relayfile API has no POST /v1/workspaces
  // route, so attempting it causes a fatal 404. This env var covers ALL execution
  // paths including standalone TS scripts that create their own WorkflowRunner.
  process.env.RELAY_CLOUD_PROVISIONING_DONE = '1';

  const workflowExecuteOptions = env.START_FROM
    ? {
        startFrom: env.START_FROM,
        ...(env.PREVIOUS_RUN_ID ? { previousRunId: env.PREVIOUS_RUN_ID } : {}),
      }
    : undefined;
  const runWorkflow = (runner, config) => env.RESUME_RUN_ID
    ? runner.resume(env.RESUME_RUN_ID, undefined, config)
    : runner.execute(config, undefined, undefined, workflowExecuteOptions);

  // In shared-sandbox mode the SandboxedStepExecutor is intentionally
  // disabled (one sandbox, all agents share it). Without it, MSD has no
  // per-agent visibility into the run. Subscribe to the SDK runner's
  // step lifecycle and re-emit MSD-shaped events that carry the same
  // sandboxId and workdir for every agent in the run, satisfying the
  // shared-sandbox event contract.
  function attachSharedSandboxStepListeners(runner, brokerCwd) {
    if (!sharedSandbox || typeof runner?.on !== 'function') {
      return;
    }
    runner.on((event) => {
      if (!event || typeof event.type !== 'string') {
        return;
      }
      const stepId = typeof event.stepName === 'string' ? event.stepName : undefined;
      const baseDetails = {
        workdir: brokerCwd,
        ...(stepId ? { stepId, agentId: stepId } : {}),
      };
      switch (event.type) {
        case 'step:started':
          void emitMsdSharedSandboxReviewEvent('agent.started', baseDetails);
          return;
        case 'step:completed':
          void emitMsdSharedSandboxReviewEvent('agent.message', {
            ...baseDetails,
            message: 'step completed',
          });
          return;
        case 'step:failed':
          void emitMsdSharedSandboxReviewEvent('agent.message', {
            ...baseDetails,
            message: 'step failed' + (event.error ? ': ' + event.error : ''),
          });
          return;
        case 'step:retrying':
          void emitMsdSharedSandboxReviewEvent('agent.message', {
            ...baseDetails,
            message: 'step retrying',
          });
          return;
        case 'step:agent-report':
          void emitMsdSharedSandboxReviewEvent('agent.message', {
            ...baseDetails,
            message: 'agent report received',
          });
          return;
        default:
          return;
      }
    });
  }

  if (type === 'yaml' || type === 'config') {
    const workflowText = env.WORKFLOW_CONFIG;
    if (!workflowText) {
      throw new Error('Missing WORKFLOW_CONFIG');
    }

    const parsedConfig = applyMountedPathsToConfig(JSON.parse(workflowText));
    // Strip agent permissions — the cloud launcher already compiled and
    // seeded ACLs via relayfile. Leaving them triggers the SDK provisioner
    // which calls POST /v1/workspaces (doesn't exist on relayfile API).
    if (Array.isArray(parsedConfig.agents)) {
      for (const agent of parsedConfig.agents) {
        delete agent.permissions;
      }
    }

    const runner = new WorkflowRunner({
      ...(executor ? { executor, processBackend: executor } : {}),
      cwd: brokerCwd,
      relay: { apiKey: env.RELAY_API_KEY ?? '', binaryArgs },
      workspaceId: env.RELAY_WORKSPACE_ID,
    });
    attachSharedSandboxStepListeners(runner, brokerCwd);

    return runWorkflow(runner, parsedConfig);
  }

  let workflowFile = env.WORKFLOW_FILE;
  if (!workflowFile) {
    throw new Error('Missing WORKFLOW_FILE');
  }

  // When the caller uploaded the workflow source to $HOME but ALSO synced the
  // repo tarball (S3_CODE_KEY) to codeMountPath, the uploaded copy is orphaned
  // from its sibling files — relative imports like '../shared/models.js'
  // resolve against $HOME instead of the repo. If we can locate a byte-
  // identical file inside the synced tree, prefer it so relative imports work.
  const workflowSearchRoot = hasPathMounts ? workspaceMountPath : codeMountPath;
  if ((env.S3_CODE_KEY || hasPathMounts) && !workflowFile.startsWith(workflowSearchRoot)) {
    try {
      const resolved = await findWorkflowFileInSyncedTree(workflowFile, workflowSearchRoot);
      if (resolved && resolved !== workflowFile) {
        console.log('[bootstrap] Resolved workflow file to ' + resolved + ' in synced tree (relative imports will resolve against repo)');
        workflowFile = resolved;
      } else {
        // Reaching this branch means the launcher couldn't point
        // WORKFLOW_FILE at an in-tree file directly (no `workflowPath`
        // hint matched a path root) AND the byte-rediscovery fallback
        // didn't find a match either. The most common modern cause is
        // multi-path workflows (`paths[]` declared) whose workflow
        // source lives OUTSIDE every declared path root — there's
        // nowhere in the synced tree for it to land, so it stays at
        // $HOME and sibling-relative imports from it cannot reach the
        // mount tree. The original 4.0.37 upgrade hint is obsolete:
        // CLIs since at least 5.x send `workflowPath` whenever the
        // workflow file is reachable from a tarballed root.
        const hint = hasPathMounts
          ? 'multi-path runs: move the workflow file under one of the declared paths[].path roots, or stop relying on relative imports from it. The workflow source landed at $HOME because it was not under any tarballed path.'
          : 'legacy single-tarball runs: the workflow file content does not byte-match any file inside the extracted tarball (rare; usually means the upload diverged from the local source).';
        console.warn(
          '[bootstrap] findWorkflowFileInSyncedTree: no byte-match for ' + workflowFile + ' in ' + workflowSearchRoot + '. Sibling-relative imports from the workflow file will not resolve. ' + hint,
        );
      }
    } catch (resolveErr) {
      console.warn('[bootstrap] Could not resolve workflow file in synced tree (non-fatal):', resolveErr?.message ?? resolveErr);
    }
  }

  if (type === 'typescript') {
    // Extract the exported config from the TS file (if any).
    // The try/catch is narrow — it only wraps the extraction logic, not
    // the runner construction/execution. This ensures:
    //   - Extraction errors (no config export, parse errors) fall through
    //     to standalone script execution.
    //   - Runner construction/execution errors propagate correctly to the
    //     caller instead of being silently swallowed and re-executed.
    let hasConfigExport = false;
    try {
      const sourceText = readFileSync(workflowFile, 'utf-8');
      // NOTE: this entire function body is inside a template literal in
      // packages/core/src/bootstrap/script-generator.ts. Template literals
      // process escape sequences before the string is rendered, which means
      // \s would become a literal "s" and \b would become a backspace
      // character (\u0008) in the generated bootstrap.mjs. The double
      // backslashes below render to single backslashes in the output,
      // producing a correct regex at runtime.
      hasConfigExport = /^export\s+(?:const\s+config\b|default\b)/m.test(sourceText);
    } catch (readErr) {
      console.warn(
        '[bootstrap] Could not read workflow file for static check, skipping config extraction:',
        readErr?.message ?? readErr,
      );
    }

    let tsConfig = null;
    if (hasConfigExport) {
      try {
        // Use a sentinel wrapper so npx/tsx noise on stdout doesn't break parsing.
        const SENTINEL_START = '___RELAY_CONFIG_START___';
        const SENTINEL_END = '___RELAY_CONFIG_END___';
        const extractScript = [
          'import(process.argv[1]).then(m => {',
          '  const c = m.config ?? m.default?.config ?? m.default;',
          '  if (c && typeof c === "object" && c.version && c.swarm)',
          '    process.stdout.write("' + SENTINEL_START + '" + JSON.stringify(c) + "' + SENTINEL_END + '");',
          '}).catch(() => {});',
        ].join(' ');
        const rawOutput = execFileSync('npx', ['tsx', '-e', extractScript, workflowFile], {
          cwd: brokerCwd,
          env,
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Extract config JSON between sentinels to ignore any npx/tsx noise.
        const startIdx = rawOutput.indexOf(SENTINEL_START);
        const endIdx = rawOutput.indexOf(SENTINEL_END);
        const configJson = startIdx !== -1 && endIdx !== -1
          ? rawOutput.slice(startIdx + SENTINEL_START.length, endIdx).trim()
          : '';
        if (configJson) {
          try {
            tsConfig = applyMountedPathsToConfig(JSON.parse(configJson));
          } catch (parseErr) {
            console.log('[bootstrap] TS config JSON parse failed, falling back to script execution:', parseErr?.message);
          }
        }
      } catch (extractErr) {
        console.log('[bootstrap] Could not extract TS config, falling back to script execution:', extractErr?.message ?? extractErr);
      }
    }

    // Runner construction/execution is OUTSIDE the try/catch above so that
    // errors here propagate correctly instead of falling through to the
    // standalone script fallback (which would cause double execution).
    if (tsConfig) {
      // Strip permissions (same as YAML path)
      if (Array.isArray(tsConfig.agents)) {
        for (const agent of tsConfig.agents) {
          delete agent.permissions;
        }
      }
      const runner = new WorkflowRunner({
        ...(executor ? { executor, processBackend: executor } : {}),
        cwd: brokerCwd,
        relay: { apiKey: env.RELAY_API_KEY ?? '', binaryArgs },
        workspaceId: env.RELAY_WORKSPACE_ID,
      });
      attachSharedSandboxStepListeners(runner, brokerCwd);
      return runWorkflow(runner, tsConfig);
    }

    // Fallback: run as a standalone script (no exported config found).
    // Uses bun instead of npx tsx because tsx 4.21.0 lazy-installed by
    // npx in the sandbox + Node 25 + esbuild CJS transform mode reports
    // a spurious top-level-await error against TS files with escaped
    // backticks inside template literals. bun is pre-installed in the
    // daytonaio/sandbox base image and runs TS natively without going
    // through esbuild CJS transforms.
    try {
      let standaloneWorkflowFile = workflowFile;
      if (env.DAYTONA_SANDBOX_ID) {
        const { writeFileSync } = await import('node:fs');
        standaloneWorkflowFile = (env.HOME ?? '/home/daytona') + '/.relay-standalone-wrapper.mjs';
        writeFileSync(standaloneWorkflowFile, buildStandaloneWorkflowWrapperSource(workflowFile));
        console.log('[bootstrap] DAYTONA_SANDBOX_ID detected; running standalone TS workflow through cloud executor wrapper');
      }

      execFileSync('bun', ['run', standaloneWorkflowFile], {
        cwd: brokerCwd,
        env,
        stdio: 'inherit',
        timeout: 30 * 60 * 1000,
      });
    } catch (execErr) {
      throw new Error(
        'Standalone TS workflow execution failed for "' + workflowFile + '": ' + (execErr?.message ?? execErr),
      );
    }
    return { status: 'completed' };
  }

  execFileSync('python3', [workflowFile], {
    cwd: brokerCwd,
    env,
    stdio: 'inherit',
    timeout: 30 * 60 * 1000,
  });
  return { status: 'completed' };
}

/**
 * Locate a byte-identical copy of `uploadedFile` inside `rootDir`.
 *
 * Used to map the orphaned $HOME/workflow.ts (uploaded standalone by the
 * launcher) back to its position inside the synced repo at codeMountPath so
 * relative imports like '../shared/models.js' resolve correctly.
 *
 * Skips heavy dirs (node_modules, .git, dist) and only considers .ts/.tsx/.py
 * to keep the scan cheap on large repos.
 */
async function findWorkflowFileInSyncedTree(uploadedFile, rootDir) {
  const { createHash } = await import('node:crypto');
  const { readdir, readFile, stat } = await import('node:fs/promises');
  try {
    const rootStat = await stat(rootDir);
    if (!rootStat.isDirectory()) return null;
  } catch {
    return null;
  }
  const targetBuf = await readFile(uploadedFile);
  const targetHash = createHash('sha256').update(targetBuf).digest('hex');
  const targetSize = targetBuf.length;
  const SKIP_DIRS = new Set(['node_modules', '.git', '.agent-relay', '.next', 'dist', 'build', '.turbo', '.cache']);
  const ALLOWED_EXT = /\.(ts|tsx|py|mts|cts)$/;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = dir + '/' + entry.name;
      if (entry.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (entry.isFile() && ALLOWED_EXT.test(entry.name)) {
        try {
          const s = await stat(full);
          if (s.size !== targetSize) continue;
          const buf = await readFile(full);
          const h = createHash('sha256').update(buf).digest('hex');
          if (h === targetHash) return full;
        } catch {
          // skip unreadable files
        }
      }
    }
    return null;
  }
  return walk(rootDir);
}

async function uploadAgentLogs(s3, brokerCwd) {
  const { join } = await import('node:path');
  const logsDir = join(brokerCwd, '.agent-relay', 'team', 'worker-logs');
  try {
    const files = await readdir(logsDir);
    for (const file of files) {
      if (file.endsWith('.log')) {
        const content = await readFile(join(logsDir, file));
        const agentName = file.replace(/\.log$/, '');
        await s3.putObject(agentName + '/agent.log', content, 'text/plain');
      }
    }
  } catch {
    // logs dir may not exist
  }
}

(async () => {
  let brokerCwd = codeMountPath;
  let relayfileRoot = codeMountPath;
  let stopAgentLogFlusher = null;
  let relayfileMountPid = null;
  let fleetServePid = null;

  // Start streaming runner.log to S3 immediately — before code extraction —
  // so any crash during initializeWorkflow() is captured in logs.
  startLogFlusher(s3);

  try {
    // Transition the DB row out of 'pending' as the very first step, before
    // any setup work that could exceed STUCK_RUN_TIMEOUT_MINUTES (credential
    // refresh, initializeWorkflow, relayfile seeding+retries, manifest write).
    // The stuck-run-reaper filters WHERE status = 'pending', so once we flip
    // to 'running' the run is safe from false reaping. Best-effort: a failed
    // heartbeat must not block execution — the reaper is a backstop, not the
    // primary failure path. The callback handler also rejects flips out of a
    // terminal status, so a delayed heartbeat that loses to the reaper can't
    // resurrect a 'failed' row back to 'running'.
    if (reporter) {
      await reporter.reportStatus(runId, 'running').catch((err) => {
        console.warn('[bootstrap] running-status heartbeat failed (non-fatal):', err?.message ?? err);
      });
    }

    // Refresh any expiring CLI credentials before initializeWorkflow() so
    // DaytonaStepExecutor is constructed with the latest env.CLI_CREDENTIALS.
    await refreshExpiringCredentials();

    const init = await initializeWorkflow();
    brokerCwd = init.brokerCwd;
    relayfileRoot = init.relayfileRoot;
    // Emit lifecycle events only after brokerCwd is finalized so observers
    // see a single, consistent workdir across workflow.started and
    // sandbox.created. Emitting workflow.started before initializeWorkflow
    // would report the placeholder codeMountPath ("/project") even when the
    // shared sandbox actually executes under /home/daytona/workspace.
    await emitMsdSharedSandboxReviewEvent('workflow.started', { workdir: brokerCwd });
    await emitMsdSharedSandboxReviewEvent('sandbox.created', { workdir: brokerCwd });

    if (relayfileEnabled) {
      // Seed the relayfile workspace with the S3-extracted code BEFORE
      // starting the watching daemon and BEFORE any agent step spawns its
      // own per-agent sandbox. Per-agent sandboxes run relayfile-mount
      // --once to populate /project from relayfile; if this initial push
      // hasn't happened, they see an empty /project and can't read the
      // user's code.
      //
      // The daemon (started below) watches local FS events and won't
      // push pre-existing files, so the baseline has to be pushed
      // explicitly. --once is the same batched protocol the daemon uses
      // and is much faster than the per-file HTTP seeding we removed.
      // Retry-then-fail-fast: the daemon below does NOT push pre-existing
      // files, so if the initial seed fails every per-agent sandbox starts
      // with an empty /project and every downstream step is guaranteed to
      // fail in confusing ways. Better to surface it here than debug
      // "missing files" errors five steps later.
      await materializeGithubReposForRelayfileMountRoots();
      let seedAttempt = 0;
      const SEED_MAX_ATTEMPTS = 3;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        seedAttempt += 1;
        try {
          console.log('[bootstrap] Seeding relayfile workspace with initial code (attempt ' + seedAttempt + '/' + SEED_MAX_ATTEMPTS + ')...');
          const t0 = Date.now();
          await flushRelayfileMountOnce(relayfileRoot);
          console.log('[bootstrap] Relayfile seed complete in ' + (Date.now() - t0) + 'ms');
          break;
        } catch (seedErr) {
          if (seedAttempt >= SEED_MAX_ATTEMPTS) {
            console.error('[bootstrap] Relayfile initial seed failed after ' + SEED_MAX_ATTEMPTS + ' attempts — aborting; per-agent sandboxes would otherwise start with empty /project:', seedErr?.message ?? seedErr);
            throw seedErr;
          }
          const backoffMs = 1000 * seedAttempt;
          console.warn('[bootstrap] Relayfile initial seed attempt ' + seedAttempt + ' failed (' + (seedErr?.message ?? seedErr) + '), retrying in ' + backoffMs + 'ms');
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }

      relayfileMountPid = startRelayfileMountDaemon(relayfileRoot);
    }

    fleetServePid = startFleetServe(brokerCwd);

    if (interactive) {
      stopAgentLogFlusher = startAgentLogFlusher(s3, brokerCwd);
    }

    await writeRunManifest(s3, manifest);

    // Wrap executeWorkflow with a hard timeout — runner.execute() may hang
    // during relay shutdown even after the workflow itself completes.
    const HARD_TIMEOUT_MS = interactive ? 3600_000 : 3600_000;
    let timeoutHandle;
    let result;
    try {
      await emitMsdSharedSandboxReviewEvent('agent.started', {
        workdir: brokerCwd,
        agentId: 'workflow-runner',
        stepId: 'workflow',
      });
      result = await Promise.race([
        executeWorkflow(init.executor, brokerCwd),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Bootstrap hard timeout')), HARD_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      // If the hard timeout fired in interactive mode, check if agents actually ran
      // by looking for log files. If logs exist, treat as completed (agent did work
      // but relay shutdown hung). If no logs, propagate as failure.
      if (interactive && err?.message === 'Bootstrap hard timeout') {
        const { join } = await import('node:path');
        const logsDir = join(brokerCwd, '.agent-relay', 'team', 'worker-logs');
        let hasLogs = false;
        try {
          const files = await readdir(logsDir);
          hasLogs = files.some(f => f.endsWith('.log'));
        } catch { /* dir doesn't exist */ }

        if (hasLogs) {
          console.error('Hard timeout fired — agent logs found, treating as completed');
          result = { status: 'completed' };
        } else {
          console.error('Hard timeout fired — no agent logs found, treating as failed');
          throw err;
        }
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    await emitMsdSharedSandboxReviewEvent('agent.message', {
      workdir: brokerCwd,
      agentId: 'workflow-runner',
      stepId: 'workflow',
      message: 'workflow runner completed',
    });
    const msdReviewArtifact = await collectMsdReviewArtifact(brokerCwd);
    if (sharedSandbox) {
      if (!msdReviewArtifact) {
        // Defensive — collectMsdReviewArtifact already throws on missing
        // input in shared mode, but guarding here prevents a future
        // refactor from silently regressing the contract.
        throw new Error('MSD review final artifact was not collected for shared-sandbox run');
      }
      await emitMsdSharedSandboxReviewEvent('artifact.updated', {
        workdir: brokerCwd,
        artifactPath: msdReviewArtifact.artifactPath,
      });
      result = {
        ...(result && typeof result === 'object' ? result : { status: 'completed' }),
        msdReviewArtifact: msdReviewArtifact.artifact,
      };
      await emitMsdSharedSandboxReviewEvent('artifact.finalized', {
        workdir: brokerCwd,
        artifactPath: msdReviewArtifact.artifactPath,
      });
    } else if (msdReviewArtifact) {
      await emitMsdSharedSandboxReviewEvent('artifact.updated', {
        workdir: brokerCwd,
        artifactPath: msdReviewArtifact.artifactPath,
      });
      result = {
        ...(result && typeof result === 'object' ? result : { status: 'completed' }),
        msdReviewArtifact: msdReviewArtifact.artifact,
      };
      await emitMsdSharedSandboxReviewEvent('artifact.finalized', {
        workdir: brokerCwd,
        artifactPath: msdReviewArtifact.artifactPath,
      });
    }

    // Upload PTY agent logs to S3 in interactive mode
    if (interactive) {
      await stopAgentLogFlusher?.().catch(() => undefined);
      stopAgentLogFlusher = null;
      await uploadAgentLogs(s3, brokerCwd);
    }

    // Generate and upload a patch of all changes made by agents.
    try {
      if (relayfileEnabled) {
        stopRelayfileMountDaemon(relayfileMountPid);
        relayfileMountPid = null;
        try {
          await flushRelayfileMountOnce(relayfileRoot);
        } catch (flushErr) {
          console.warn('[bootstrap] relayfile flush before patch generation failed (non-fatal):', flushErr?.message ?? flushErr);
        }
      }

      if (hasPathMounts) {
        for (const entry of submittedPaths) {
          await uploadPatchForMountedPath(entry);
        }
      } else {
      const patchGitCmd = 'GIT_DIR=' + gitDir + ' GIT_WORK_TREE=' + brokerCwd;
      // If the baseline setup failed earlier, try to create it now.
      // The workflow is done so the volume should be quiescent.
      let hasBaseline = false;
      try {
        execSync(patchGitCmd + ' git rev-parse HEAD', { stdio: 'pipe' });
        hasBaseline = true;
      } catch {
        console.log('[bootstrap] No git baseline — creating one now for patch generation...');
        try {
          execSync('mkdir -p ' + gitDir, { stdio: 'pipe' });
          execSync(patchGitCmd + ' git init -q', { stdio: 'pipe' });
          execSync(patchGitCmd + ' git config user.email "agent@agent-relay.com"', { stdio: 'pipe' });
          execSync(patchGitCmd + ' git config user.name "Agent Relay"', { stdio: 'pipe' });
          execSync(patchGitCmd + ' git commit --allow-empty -q -m "empty baseline"', { stdio: 'pipe' });
          hasBaseline = true;
        } catch (initErr) {
          console.warn('[bootstrap] Late git init failed:', initErr?.message ?? initErr);
        }
      }
      if (hasBaseline) {
        // Instead of git add -A (slow on volumes), diff against the file manifest
        // to find only files that were added, modified, or deleted.
        const { readFile: readManifestFile, stat: statFile, readdir: readDirFiles } = await import('node:fs/promises');
        const { join: pJoin } = await import('node:path');
        let manifestJson = {};
        try {
          manifestJson = JSON.parse(await readManifestFile(pJoin(gitDir, 'baseline-manifest.json'), 'utf8'));
        } catch { /* no manifest — fall back to adding everything */ }

        const changedFiles = [];
        const deletedFiles = [];
        if (Object.keys(manifestJson).length > 0) {
          function shouldIgnorePatchPath(rel) {
            return (
              rel === '.relayfile.acl' ||
              rel === '.relayfile-mount-state.json' ||
              rel.startsWith('..relayfile-mount-state.json.tmp-') ||
              rel.startsWith('.agent-bin/') ||
              rel.startsWith('.agent-relay/') ||
              rel.startsWith('.trajectories/') ||
              rel.startsWith('.workflow-context/')
            );
          }

          // Find modified/new files by comparing mtimes
          async function findChanged(dir, prefix) {
            try {
              const entries = await readDirFiles(dir, { withFileTypes: true });
              for (const entry of entries) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agent-relay') continue;
                const rel = prefix ? prefix + '/' + entry.name : entry.name;
                if (shouldIgnorePatchPath(rel) || shouldIgnorePatchPath(rel + '/')) continue;
                const full = pJoin(dir, entry.name);
                if (entry.isDirectory()) {
                  await findChanged(full, rel);
                } else {
                  try {
                    const s = await statFile(full);
                    if (!manifestJson[rel] || s.mtimeMs !== manifestJson[rel]) {
                      changedFiles.push(rel);
                    }
                  } catch { /* skip */ }
                }
              }
            } catch { /* skip */ }
          }
          await findChanged(brokerCwd, '');

          // Detect deleted files: in manifest but no longer on disk
          for (const manifestPath of Object.keys(manifestJson)) {
            if (shouldIgnorePatchPath(manifestPath)) continue;
            try {
              await statFile(pJoin(brokerCwd, manifestPath));
            } catch {
              deletedFiles.push(manifestPath);
            }
          }

          console.log('[bootstrap] ' + changedFiles.length + ' files changed, ' + deletedFiles.length + ' files deleted since baseline');
        }

        if (changedFiles.length > 0 || deletedFiles.length > 0) {
          // Only add changed files — fast even on volumes
          for (const f of changedFiles) {
            try {
              execSync(patchGitCmd + ' git add ' + JSON.stringify(f), { stdio: 'pipe', cwd: brokerCwd, timeout: 10000 });
            } catch { /* skip unaddable files */ }
          }
          // Stage deleted files
          for (const f of deletedFiles) {
            try {
              execSync(patchGitCmd + ' git rm --cached ' + JSON.stringify(f), { stdio: 'pipe', cwd: brokerCwd, timeout: 10000 });
            } catch { /* already removed or not tracked */ }
          }
        } else if (Object.keys(manifestJson).length === 0) {
          // No manifest — fall back to git add -A with timeout
          try {
            execSync(patchGitCmd + ' git add -A', { stdio: 'pipe', timeout: 60000 });
          } catch { console.warn('[bootstrap] git add -A timed out during patch generation'); }
        }

        const baselineHash = execSync(patchGitCmd + ' git rev-list --max-parents=0 HEAD 2>/dev/null || echo HEAD', { encoding: 'utf8' }).trim();
        execSync(patchGitCmd + ' git diff --cached ' + baselineHash + ' > /tmp/changes.patch 2>/dev/null || true');
        const { readFile: readPatch } = await import('node:fs/promises');
        const patchContent = await readPatch('/tmp/changes.patch');
        if (patchContent.length > 0) {
          await s3.putObject('changes.patch', patchContent, 'text/plain');
        }
      }
      }
    } catch {
      // best effort — patch upload failure should not block completion
    }

    manifest.status = 'completed';
    await writeRunManifest(s3, manifest);

    await stopLogFlusher(s3);
    await cloudApi?.fetch('/api/v1/workflows/runs/' + runId).catch(() => undefined);
    if (reporter) {
      let reportCompletionTimeoutHandle;
      try {
        await Promise.race([
          reporter.reportCompletion(runId, result),
          new Promise((_, reject) => {
            reportCompletionTimeoutHandle = setTimeout(() => reject(new Error('Completion callback timeout')), REPORT_COMPLETION_TIMEOUT_MS);
          }),
        ]);
      } catch (reportErr) {
        console.error('[bootstrap] Completion callback failed (non-fatal):', reportErr?.message ?? reportErr);
      } finally {
        clearTimeout(reportCompletionTimeoutHandle);
      }
    }
    await emitMsdSharedSandboxReviewEvent('workflow.completed', { workdir: brokerCwd });
  } catch (error) {
    manifest.status = 'failed';
    await emitMsdSharedSandboxReviewEvent('workflow.failed', {
      workdir: brokerCwd,
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);

    stopRelayfileMountDaemon(relayfileMountPid);
    relayfileMountPid = null;
    await stopAgentLogFlusher?.().catch(() => undefined);
    stopAgentLogFlusher = null;
    await stopLogFlusher(s3).catch(() => undefined);
    await writeRunManifest(s3, manifest).catch(() => undefined);

    console.error('Bootstrap fatal error:', error);
    await cloudApi?.fetch('/api/v1/workflows/runs/' + runId).catch(() => undefined);
    await reporter?.reportError(runId, error instanceof Error ? error : String(error)).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    stopFleetServe(fleetServePid);
    fleetServePid = null;
    await emitMsdSharedSandboxReviewEvent('sandbox.stopping', { workdir: brokerCwd }).catch(() => undefined);
    await emitMsdSharedSandboxReviewEvent('sandbox.stopped', { workdir: brokerCwd }).catch(() => undefined);
    await cloudApi?.revoke().catch(() => undefined);
  }
})();

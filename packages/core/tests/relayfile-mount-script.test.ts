import assert from "node:assert/strict";
import { test } from "node:test";

import { BOOTSTRAP_INNER_TEMPLATE } from "../src/bootstrap/templates.generated.js";
import {
  DEFAULT_RELAYFILE_MOUNT_STATE_DIR,
  buildRelayfileMountCleanupFlushShell,
  buildRelayfileMountFlushShell,
  buildRelayfileMountInitialSyncBackgroundShell,
  buildRelayfileMountInitialSyncKillShell,
  buildRelayfileMountInitialSyncShell,
  buildRelayfileMountInitialSyncStatusShell,
  buildRelayfileMountPathArgsShell,
  buildRelayfileMountShellTemplate,
  buildRelayfileMountStartShell,
  parseRelayfileMountInitialSyncStatus,
} from "../src/relayfile/mount-script.js";

test("buildRelayfileMountStartShell: includes all required flags + interval + log redirect", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
  });
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped nohup relayfile-mount /);
  assert.match(out, /--base-url 'https:\/\/api\.relayfile\.dev'/);
  assert.match(out, /--workspace 'rw_abc'/);
  assert.match(out, /--local-dir '\/home\/daytona\/workspace'/);
  assert.match(out, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.match(out, /--token 'relay_pa_xyz'/);
  assert.match(out, /--interval '1s'/);
  assert.match(out, /> '\/tmp\/relayfile-mount\.log' 2>&1 & echo \$!/);
});

test("buildRelayfileMountStartShell: honours interval and logPath overrides", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    interval: "5s",
    logPath: "/var/log/mount.log",
  });
  assert.match(out, /--interval '5s'/);
  assert.match(out, /> '\/var\/log\/mount\.log'/);
});

test("buildRelayfileMountStartShell: honours stateDir override", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    stateDir: "/tmp/private state",
    token: "t",
  });
  assert.match(out, /--state-dir '\/tmp\/private state'/);
  assert.doesNotMatch(out, new RegExp(DEFAULT_RELAYFILE_MOUNT_STATE_DIR.replaceAll("/", "\\/")));
});

test("buildRelayfileMountStartShell: can disable the WebSocket event stream", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    websocket: false,
  });
  assert.match(out, /--websocket=false/);
});

test("buildRelayfileMountStartShell: points the daemon at a creds file via env, not a flag", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
  });
  // env var spelling (relayfile#243 precedent): pre-creds binaries reject an
  // unknown --creds-file flag but ignore the env var.
  assert.match(
    out,
    /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped RELAYFILE_MOUNT_CREDS_FILE='\/home\/daytona\/\.relayfile-mount-creds\.json' nohup relayfile-mount /,
  );
  assert.doesNotMatch(out, /--creds-file/);
  // Launch token stays for old binaries and as the initial credential.
  assert.match(out, /--token 't'/);
});

test("buildRelayfileMountStartShell: omits the creds env without credsFilePath", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
  });
  assert.doesNotMatch(out, /RELAYFILE_MOUNT_CREDS_FILE/);
});

test("buildRelayfileMountFlushShell: carries the creds env so a stale-token flush can heal", () => {
  const out = buildRelayfileMountFlushShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    credsFilePath: "/home/daytona/.relayfile-mount-creds.json",
  });
  assert.match(
    out,
    /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped RELAYFILE_MOUNT_CREDS_FILE='\/home\/daytona\/\.relayfile-mount-creds\.json' relayfile-mount --once /,
  );
});

test("buildRelayfileMountStartShell: can enable lazy GitHub repo materialization", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    lazyRepos: true,
  });
  assert.match(out, /--lazy-repos/);
});

// relayfile v0.8.11 (#243) made local layout explicit: the binary defaults to
// `exact` (local-dir IS the mirror root) and hard-errors on multiple
// --remote-path values without `--local-layout=scoped`. Cloud's builders
// pre-compute an UNSCOPED local dir and rely on the daemon appending the
// remote path under it (the implicit #206 behavior), so every invocation must
// pin the scoped layout. We pin via the RELAYFILE_MOUNT_LOCAL_LAYOUT env var
// rather than the flag: pre-v0.8.11 binaries reject the unknown flag but
// ignore the env var, so one spelling yields an identical on-disk layout
// across every binary version cloud sandboxes may carry.
test("buildRelayfileMountStartShell: pins scoped local layout via env for v0.8.11+ binaries", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    paths: ["/github/**", "/notion/databases/abc/**"],
  });
  assert.match(out, /env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped nohup relayfile-mount /);
  // The fail-closed fallback daemons need the pin too.
  assert.match(out, /env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --base-url/);
  assert.doesNotMatch(out, /--local-layout/);
});

test("buildRelayfileMountFlushShell: pins scoped local layout via env", () => {
  const out = buildRelayfileMountFlushShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    paths: ["/github/**"],
  });
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once /);
});

test("buildRelayfileMountCleanupFlushShell: flushes via $relayfile_mount_flush_mode, not a hardcoded --once (cloud#2029 #6c)", () => {
  const out = buildRelayfileMountCleanupFlushShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    paths: ["/slack/channels/C/messages"],
  });
  // The mode flag is the probed shell var (so it can be --flush-outbox-once on
  // v0.8.20+), NOT a hardcoded --once. Mutation guard: reverting the cleanup
  // builder to buildRelayfileMountFlushShell drops the var → this fails.
  assert.match(out, /relayfile-mount "\$relayfile_mount_flush_mode" /);
  assert.doesNotMatch(out, /relayfile-mount --once /);
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount /);
});

test("buildRelayfileMountInitialSyncShell: pins scoped local layout via env on per-root once syncs", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    // Non-provider-root paths: initial sync's scopedRemoteRoots() drops bare
    // provider roots like /github/** by design, so use two scoped roots.
    paths: ["/github/repos/acme/cloud/**", "/linear/issues/**"],
  });
  const pinned = out.match(/env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once /g);
  assert.equal(pinned?.length, 2);
});

test("buildRelayfileMountStartShell: emits repeated remote-path filters", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/z",
    token: "t",
    paths: ["/github/**", "/notion/databases/abc/**"],
  });
  assert.doesNotMatch(out, /--paths\s/);
  assert.match(out, /--remote-path '\/github'/);
  assert.match(out, /--remote-path '\/notion\/databases\/abc'/);
});

test("buildRelayfileMountStartShell: fail-closed probe falls back to one daemon per path", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/workspace",
    token: "t",
    paths: ["/github/**", "/linear/issues/**"],
  });
  assert.match(out, /^if relayfile-mount --help 2>&1 \| grep -q -- 'paths-file'; then/);
  assert.match(out, /multi-path filters unsupported; starting one daemon per remote path/);
  assert.match(out, /--local-dir '\/workspace' --state-dir '\/home\/daytona\/\.relayfile-mount-state' --token 't' --remote-path '\/github'/);
  assert.match(out, /--local-dir '\/workspace' --state-dir '\/home\/daytona\/\.relayfile-mount-state' --token 't' --remote-path '\/linear\/issues'/);
});

test("buildRelayfileMountStartShell: fallback does not double-scope an already scoped issue local dir", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/home/daytona/workspace/github/repos/acme/cloud/issues/42__bug",
    token: "t",
    paths: [
      "/github/repos/acme/cloud/issues/42__bug/**",
      "/slack/channels/proj/messages/**",
    ],
  });
  assert.match(out, /multi-path filters unsupported; starting one daemon per remote path/);
  assert.match(out, /--local-dir '\/home\/daytona\/workspace' --state-dir/);
  assert.doesNotMatch(out, /issues\/42__bug\/github\/repos\/acme\/cloud\/issues\/42__bug/);
});

test("buildRelayfileMountStartShell: modern daemon start does not double-scope a scoped local dir", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/home/daytona/workspace/github/repos/acme/cloud/issues/42__bug",
    token: "t",
    paths: ["/github/repos/acme/cloud/issues/42__bug/**"],
  });
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped nohup relayfile-mount /);
  assert.match(out, /--local-dir '\/home\/daytona\/workspace' --state-dir/);
  assert.doesNotMatch(out, /issues\/42__bug\/github\/repos\/acme\/cloud\/issues\/42__bug/);
});

test("buildRelayfileMountStartShell: broad roots unscope a deeper local dir", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/home/daytona/workspace/github/repos/acme/cloud/issues/42__bug",
    token: "t",
    paths: ["/github/**"],
  });
  assert.match(out, /--local-dir '\/home\/daytona\/workspace' --state-dir/);
  assert.doesNotMatch(out, /issues\/42__bug\/github/);
});

test("buildRelayfileMountStartShell: probe matches Go flag help spelling", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "x",
    workspaceId: "y",
    localDir: "/workspace",
    token: "t",
    paths: ["/github/**", "/linear/issues/**"],
  });
  const goFlagHelp = "  -paths-file string\n\tpath to a JSON file containing remote paths";
  const bashProbe = out.match(/^if relayfile-mount --help 2>&1 \| grep -q -- '([^']+)'; then/);
  assert.ok(bashProbe, "expected relayfile-mount capability probe");
  assert.match(goFlagHelp, new RegExp(bashProbe[1]));
});

test("bootstrap template: probe matches Go flag help spelling", () => {
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /\.includes\('paths-file'\)/);
  assert.doesNotMatch(BOOTSTRAP_INNER_TEMPLATE, /\.includes\('--paths-file'\)/);
});

test("bootstrap template: cloud mount uses polling on the fallback path", () => {
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /'--websocket=false'/);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /"--interval '3s'"/);
});

test("bootstrap template: relayfile-mount keeps private state outside workspace", () => {
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /const relayfileMountStateDir = '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /'--state-dir ' \+ shellEscape\(relayfileMountStateDir\)/);
});

test("bootstrap template: flush unscope matches daemon start", () => {
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /const mountLocalDir = relayfileMountUnscopedLocalDir\(localDir, roots\)/);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /relayfileMountShellFromTemplate\(relayfileMountShellTemplate\.flushShellTemplate, mountLocalDir\)/);
});

test("bootstrap template: materializes broad GitHub owner mounts before initial sync", () => {
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /function materializeGithubReposForRelayfileMountRoots\(\)/);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /\/github\/repos\/' \+ owner \+ '\/_index\.json/);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /\/github\/repos\/_index\.json/);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /\/integrations\/github\/repos\//);
  assert.match(BOOTSTRAP_INNER_TEMPLATE, /RELAYFILE_GITHUB_MATERIALIZE_TOTAL_TIMEOUT_MS/);
  const materializeIdx = BOOTSTRAP_INNER_TEMPLATE.indexOf("await materializeGithubReposForRelayfileMountRoots();");
  const seedAttemptIdx = BOOTSTRAP_INNER_TEMPLATE.indexOf("let seedAttempt = 0;");
  const flushIdx = BOOTSTRAP_INNER_TEMPLATE.indexOf("await flushRelayfileMountOnce(relayfileRoot);");
  assert.ok(materializeIdx > -1);
  assert.ok(seedAttemptIdx > materializeIdx);
  assert.ok(flushIdx > seedAttemptIdx);
});

test("buildRelayfileMountPathArgsShell: emits remote-path filters for the bootstrap template", () => {
  assert.equal(
    buildRelayfileMountPathArgsShell([
      "/github/**",
      "/notion/databases/abc/**",
    ]),
    " --remote-path '/github' --remote-path '/notion/databases/abc'",
  );
});

test("buildRelayfileMountShellTemplate: rendered template matches concrete builders", () => {
  const template = buildRelayfileMountShellTemplate({}, {
    interval: "3s",
    websocket: false,
  });
  const opts = {
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
    paths: ["/github/**", "/linear/issues/**"],
    interval: "3s",
    websocket: false,
  };
  const render = (source: string) => source
    .replace(shellQuote(template.placeholders.baseUrl), shellQuote(opts.baseUrl))
    .replace(shellQuote(template.placeholders.workspaceId), shellQuote(opts.workspaceId))
    .replace(shellQuote(template.placeholders.localDir), shellQuote(opts.localDir))
    .replace(shellQuote(template.placeholders.token), shellQuote(opts.token))
    .replace(
      template.pathArgsPlaceholderArg,
      buildRelayfileMountPathArgsShell(opts.paths),
    );

  assert.match(render(template.startShellTemplate), /--remote-path '\/github'/);
  assert.match(render(template.startShellTemplate), /--remote-path '\/linear\/issues'/);
  assert.equal(render(template.flushShellTemplate), buildRelayfileMountFlushShell(opts));
});

test("buildRelayfileMountFlushShell: --once + same arg shape, no --interval", () => {
  const out = buildRelayfileMountFlushShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
  });
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once /);
  assert.match(out, /--base-url 'https:\/\/api\.relayfile\.dev'/);
  assert.match(out, /--workspace 'rw_abc'/);
  assert.match(out, /--local-dir '\/home\/daytona\/workspace'/);
  assert.match(out, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.match(out, /--token 'relay_pa_xyz'/);
  assert.doesNotMatch(out, /--interval/);
  assert.doesNotMatch(out, />/);  // no redirect — caller handles
});

test("buildRelayfileMountFlushShell: includes lazy repos flag when requested", () => {
  const out = buildRelayfileMountFlushShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
    lazyRepos: true,
  });
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once /);
  assert.match(out, /--lazy-repos/);
});

test("buildRelayfileMountFlushShell: does not double-scope an already scoped local dir", () => {
  const out = buildRelayfileMountFlushShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace/github/repos/acme/cloud/issues/42__bug",
    token: "relay_pa_xyz",
    paths: ["/github/repos/acme/cloud/issues/42__bug/**"],
  });
  assert.match(out, /^env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once /);
  assert.match(out, /--local-dir '\/home\/daytona\/workspace'/);
  assert.match(out, /--remote-path '\/github\/repos\/acme\/cloud\/issues\/42__bug'/);
  assert.doesNotMatch(out, /--local-dir '\/home\/daytona\/workspace\/github\/repos\/acme\/cloud\/issues\/42__bug'/);
});

test("buildRelayfileMountInitialSyncShell: wraps scoped once sync in timeout when requested", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
    paths: ["/github/repos/acme/cloud/issues/42__bug/**"],
    timeoutSeconds: 20,
    lazyRepos: true,
  });
  assert.match(out, /command -v timeout/);
  assert.match(out, /timeout '20s' env RELAYFILE_MOUNT_LOCAL_LAYOUT=scoped relayfile-mount --once/);
  assert.match(out, /timeout command unavailable/);
  assert.doesNotMatch(out, /--paths\b/);
  assert.match(out, /--local-dir '\/home\/daytona\/workspace'/);
  assert.match(out, /--state-dir '\/home\/daytona\/\.relayfile-mount-state'/);
  assert.match(out, /--lazy-repos/);
  assert.match(out, /--remote-path '\/github\/repos\/acme\/cloud\/issues\/42__bug'/);
  assert.match(out, /--state-file '\/tmp\/relayfile-mount-initial-sync-0\.json'/);
});

test("buildRelayfileMountInitialSyncShell: does not double-scope an already scoped issue local dir", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace/github/repos/acme/cloud/issues/42__bug",
    token: "relay_pa_xyz",
    paths: ["/github/repos/acme/cloud/issues/42__bug/**"],
    idleTimeoutSeconds: 90,
  });
  assert.match(out, /--local-dir '\/home\/daytona\/workspace'/);
  assert.doesNotMatch(out, /issues\/42__bug\/github\/repos\/acme\/cloud\/issues\/42__bug/);
  assert.match(out, /--remote-path '\/github\/repos\/acme\/cloud\/issues\/42__bug'/);
});

test("buildRelayfileMountInitialSyncShell: runs one scoped pull per concrete subtree", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
    paths: [
      "/github/repos/acme/cloud/issues/42__bug/**",
      "/linear/issues/ENG-123__fix/**",
      "/github/**",
    ],
  });
  assert.doesNotMatch(out, /--paths\b/);
  assert.doesNotMatch(out, /--remote-path '\/github'/);
  assert.match(out, /--remote-path '\/github\/repos\/acme\/cloud\/issues\/42__bug'/);
  assert.match(out, /--remote-path '\/linear\/issues\/ENG-123__fix'/);
});

test("buildRelayfileMountInitialSyncShell: idle timeout watches private state dir for unscoped sync", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    stateDir: "/home/daytona/.relayfile-mount-state/",
    token: "relay_pa_xyz",
    idleTimeoutSeconds: 30,
  });
  assert.match(out, /--state-dir '\/home\/daytona\/\.relayfile-mount-state\/'/);
  assert.match(out, /set -- '\/home\/daytona\/\.relayfile-mount-state\/\.relayfile-mount-state\.json'/);
  assert.doesNotMatch(out, /set -- '\/home\/daytona\/workspace\/\.relayfile-mount-state\.json'/);
});

test("buildRelayfileMountInitialSyncShell: idle timeout watches sync progress", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
    paths: ["/github/repos/acme/cloud/issues/42__bug/**"],
    idleTimeoutSeconds: 90,
    websocket: false,
  });
  assert.doesNotMatch(out, /timeout '90s'/);
  assert.match(out, /mktemp \/tmp\/relayfile-mount-progress\.XXXXXX/);
  assert.match(out, /relayfile initial sync made no progress for 90s; canceling/);
  assert.match(out, /--websocket=false/);
  assert.match(out, /--state-file '\/tmp\/relayfile-mount-initial-sync-0\.json'/);
  assert.match(out, /set -- '\/tmp\/relayfile-mount-initial-sync-0\.json'/);
  assert.match(out, /for relayfile_mount_progress_file in "\$@"; do/);
  assert.doesNotMatch(out, /for relayfile_mount_progress_file in '\/tmp\/relayfile-mount-initial-sync-0\.json'; do/);
  assert.match(out, /^\(/);
  assert.match(out, /\)$/);
  assert.doesNotMatch(out, /^\{/);
});

test("buildRelayfileMountInitialSyncBackgroundShell: records run-specific pid, log, and exit sentinels", () => {
  const out = buildRelayfileMountInitialSyncBackgroundShell(
    {
      baseUrl: "https://api.relayfile.dev",
      workspaceId: "rw_abc",
      localDir: "/home/daytona/workspace",
      token: "relay_pa_xyz",
      paths: ["/github/repos/acme/cloud/issues/42__bug/**"],
      idleTimeoutSeconds: 90,
    },
    { runId: "run_1" },
  );
  assert.match(out, /relayfile-initial-sync\.sh\.run_1/);
  assert.match(out, /relayfile-initial-sync\.log\.run_1/);
  assert.match(out, /relayfile-initial-sync\.exit\.run_1/);
  assert.match(out, /relayfile-initial-sync\.pid\.run_1/);
  assert.match(out, /command -v setsid/);
  assert.match(out, /setsid sh/);
  assert.match(out, /relayfile_initial_sync_pid=\$!/);
  assert.match(out, /wait "\$relayfile_initial_sync_pid"/);
  assert.match(out, /nohup sh -c /);
});

test("buildRelayfileMountInitialSyncStatusShell: detects missing exit sentinel after pid death", () => {
  const out = buildRelayfileMountInitialSyncStatusShell({ runId: "run_1" });
  assert.match(out, /relayfile-initial-sync\.exit\.run_1/);
  assert.match(out, /relayfile-initial-sync\.pid\.run_1/);
  assert.match(out, /kill -0 "\$relayfile_initial_sync_pid"/);
  assert.match(out, /relayfile-initial-sync-exit:127/);
});

test("buildRelayfileMountInitialSyncKillShell: kills only the recorded run pid", () => {
  const out = buildRelayfileMountInitialSyncKillShell({ runId: "run_1" });
  assert.match(out, /relayfile-initial-sync\.pid\.run_1/);
  assert.match(out, /kill -TERM -- "-\$relayfile_initial_sync_pid"/);
  assert.match(out, /kill "\$relayfile_initial_sync_pid"/);
  assert.doesNotMatch(out, /pkill/);
});

test("parseRelayfileMountInitialSyncStatus: parses exit marker and otherwise reports running", () => {
  assert.deepEqual(parseRelayfileMountInitialSyncStatus("relayfile-initial-sync-exit:124\n"), {
    state: "exited",
    exitCode: 124,
  });
  assert.deepEqual(parseRelayfileMountInitialSyncStatus("relayfile-initial-sync-running\n"), {
    state: "running",
  });
});

test("shellQuote (via builder): single-quotes inside values are escaped", () => {
  const out = buildRelayfileMountStartShell({
    baseUrl: "https://api.example.com",
    workspaceId: "rw_with'quote",
    localDir: "/dir",
    token: "t",
  });
  // POSIX form for value containing a single quote is `'foo'\''bar'` —
  // close quote, escaped quote, reopen quote.
  assert.match(out, /--workspace 'rw_with'\\''quote'/);
});

test("shellQuote (via builder): values with spaces / shell metacharacters are safe", () => {
  const out = buildRelayfileMountFlushShell({
    baseUrl: "https://api.example.com",
    workspaceId: "rw_with $payload",
    localDir: "/dir with space",
    token: "t",
  });
  // Conservative quoting: spaces and `$` end up inside single-quotes,
  // never expanded by the shell.
  assert.match(out, /--workspace 'rw_with \$payload'/);
  assert.match(out, /--local-dir '\/dir with space'/);
});

// cloud #1516 regression guard: the OUTER idle watchdog watches the SAME
// per-root file the daemon receives as `--state-file`. The relayfile daemon's
// resumable-tree fix relies on bumping the `--state-file` mtime per page to
// satisfy this outer wrapper; if a refactor ever pointed the watched file and
// the `--state-file` at different paths, the wrapper would 124-kill the
// now-resumable pull mid-flight. Pin the per-index equality for multiple roots.
test("buildRelayfileMountInitialSyncShell: outer watchdog watches the daemon --state-file per root (cloud #1516)", () => {
  const out = buildRelayfileMountInitialSyncShell({
    baseUrl: "https://api.relayfile.dev",
    workspaceId: "rw_abc",
    localDir: "/home/daytona/workspace",
    token: "relay_pa_xyz",
    paths: [
      "/github/repos/acme/cloud/issues/1__a/**",
      "/github/repos/acme/cloud/issues/2__b/**",
    ],
    idleTimeoutSeconds: 90,
    websocket: false,
  });
  for (const index of [0, 1]) {
    const stateFile = `/tmp/relayfile-mount-initial-sync-${index}.json`;
    // the daemon is launched with this exact --state-file...
    assert.ok(
      out.includes(`--state-file '${stateFile}'`),
      `expected --state-file ${stateFile}`,
    );
    // ...and the outer idle watchdog watches that same path for progress.
    assert.ok(
      out.includes(`'${stateFile}'`)
        && new RegExp(`set -- (?:'[^']+' )*'${stateFile.replace(/[/.]/g, "\\$&")}'`).test(out),
      `expected outer watchdog to watch ${stateFile}`,
    );
  }
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

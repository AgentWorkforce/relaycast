import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Daytona } from '@daytonaio/sdk';

import * as pkg from './index.js';
import {
  DaytonaRuntime,
  SnapshotNotFoundError,
  applyDaytonaAuthEnv,
  resolveDaytonaAuthCredentials,
} from './index.js';
import type { RuntimeHandle } from './index.js';

describe('public barrel', () => {
  it('exports DaytonaRuntime as a class', () => {
    assert.equal(typeof pkg.DaytonaRuntime, 'function');
    assert.equal(typeof DaytonaRuntime, 'function');
    assert.equal(typeof pkg.SnapshotNotFoundError, 'function');
    assert.equal(typeof SnapshotNotFoundError, 'function');
  });

  it('exports resolveDaytonaAuthCredentials and applyDaytonaAuthEnv', () => {
    assert.equal(typeof pkg.resolveDaytonaAuthCredentials, 'function');
    assert.equal(typeof resolveDaytonaAuthCredentials, 'function');
    assert.equal(typeof pkg.applyDaytonaAuthEnv, 'function');
    assert.equal(typeof applyDaytonaAuthEnv, 'function');
  });

  it('resolveDaytonaAuthCredentials normalises an apiKey-only input', () => {
    const resolved = resolveDaytonaAuthCredentials({ apiKey: 'sk-test' });
    assert.ok('apiKey' in resolved, 'expected apiKey-mode result');
    assert.equal(resolved.apiKey, 'sk-test');
  });

  it('resolveDaytonaAuthCredentials rejects empty input', () => {
    assert.throws(() => resolveDaytonaAuthCredentials({}));
  });

  it('applyDaytonaAuthEnv writes DAYTONA_API_KEY into the supplied env bag', () => {
    const env: Record<string, string> = {};
    applyDaytonaAuthEnv(env, { apiKey: 'sk-test' });
    assert.equal(env.DAYTONA_API_KEY, 'sk-test');
  });
});

describe('DaytonaRuntime shared primitives', () => {
  it('launches with snapshot, labels and create timeout without language', async () => {
    const created: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const sandbox = fakeSandbox({ id: 'sbx-created', state: 'STARTED' });
    const daytona = {
      create: async (params: Record<string, unknown>, options?: unknown) => {
        created.push({ params, options });
        return sandbox;
      },
    };
    const runtime = new DaytonaRuntime({
      daytona: daytona as never,
      snapshot: 'relay-orchestrator-sdk-test',
    });

    const handle = await runtime.launch({
      name: 'issue-greeter',
      labels: { purpose: 'workforce-deploy', agentId: 'agent-1' },
      env: { WORKFORCE_AGENT_ID: 'agent-1' },
      createTimeoutSeconds: 120,
    });

    assert.equal(handle.id, 'sbx-created');
    assert.deepEqual(created, [
      {
        params: {
          snapshot: 'relay-orchestrator-sdk-test',
          envVars: { WORKFORCE_AGENT_ID: 'agent-1' },
          name: 'issue-greeter',
          labels: { purpose: 'workforce-deploy', agentId: 'agent-1' },
        },
        options: { timeout: 120 },
      },
    ]);
    assert.equal('language' in created[0].params, false);
  });

  it('launchDetached creates through the raw sandbox API and returns before SDK waitUntilStarted', async () => {
    const createCalls: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const daytona = {
      target: 'us',
      sandboxApi: {
        createSandbox: async (
          params: Record<string, unknown>,
          _organizationId?: string,
          options?: unknown,
        ) => {
          createCalls.push({ params, options });
          return { data: { id: 'sbx-starting', state: 'STARTING' } };
        },
      },
      get: async (id: string) => fakeSandbox({ id, state: 'STARTING' }),
    };
    const runtime = new DaytonaRuntime({
      daytona: daytona as never,
      snapshot: 'relay-orchestrator-sdk-test',
    });

    const handle = await runtime.launchDetached({
      name: 'issue-greeter',
      labels: { purpose: 'workforce-deploy', agentId: 'agent-1' },
      env: { WORKFORCE_AGENT_ID: 'agent-1' },
      createTimeoutSeconds: 5,
    });

    assert.deepEqual(handle, { id: 'sbx-starting', state: 'STARTING' });
    assert.deepEqual(createCalls, [
      {
        params: {
          snapshot: 'relay-orchestrator-sdk-test',
          env: { WORKFORCE_AGENT_ID: 'agent-1' },
          name: 'issue-greeter',
          labels: {
            purpose: 'workforce-deploy',
            agentId: 'agent-1',
            'code-toolbox-language': 'python',
          },
          target: 'us',
        },
        options: { timeout: 5000 },
      },
    ]);
  });

  it('launchDetached throws on snapshot-not-found instead of falling back to a typescript base sandbox', async () => {
    const createCalls: Array<{ params: Record<string, unknown>; options?: unknown }> = [];
    const daytona = {
      target: 'us',
      sandboxApi: {
        createSandbox: async (
          params: Record<string, unknown>,
          _organizationId?: string,
          options?: unknown,
        ) => {
          createCalls.push({ params, options });
          throw Object.assign(new Error('snapshot missing-snapshot not found'), { status: 404 });
        },
      },
      get: async () => fakeSandbox({ id: 'unused', state: 'STARTED' }),
    };
    const runtime = new DaytonaRuntime({
      daytona: daytona as never,
      snapshot: 'missing-snapshot',
    });

    await assert.rejects(
      () => runtime.launchDetached({
        name: 'issue-greeter',
        env: { WORKFORCE_AGENT_ID: 'agent-1' },
      }),
      (err: unknown) => {
        assert.ok(err instanceof SnapshotNotFoundError);
        assert.equal(err.snapshot, 'missing-snapshot');
        assert.equal(
          err.message,
          "Snapshot not found in Daytona: 'missing-snapshot'. Refusing silent fallback to typescript base — fix DEFAULT_SNAPSHOT or rebuild/publish the snapshot before retrying.",
        );
        return true;
      },
    );
    assert.deepEqual(createCalls, [
      {
        params: {
          snapshot: 'missing-snapshot',
          env: { WORKFORCE_AGENT_ID: 'agent-1' },
          name: 'issue-greeter',
          labels: { 'code-toolbox-language': 'python' },
          target: 'us',
        },
        options: undefined,
      },
    ]);
  });

  it('getById attaches an existing sandbox without taking ownership by default', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-existing', state: 'STARTED' });
    let deleted = false;
    const daytona = {
      get: async (id: string) => {
        assert.equal(id, 'sbx-existing');
        return sandbox;
      },
      delete: async () => {
        deleted = true;
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handle = await runtime.getById('sbx-existing');

    assert.deepEqual(handle, { id: 'sbx-existing', state: 'STARTED' });
    await runtime.destroy(handle!);
    assert.equal(deleted, false);
  });

  it('getById filters by requested sandbox states', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const daytona = {
      get: async (id: string) => {
        assert.equal(id, 'sbx-stopped');
        return sandbox;
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    assert.equal(await runtime.getById('sbx-stopped', { states: ['STARTED'] }), null);
    assert.deepEqual(
      await runtime.getById('sbx-stopped', { states: null }),
      { id: 'sbx-stopped', state: 'STOPPED' },
    );
  });

  it('getById returns null when Daytona reports the sandbox is gone', async () => {
    const daytona = {
      get: async () => {
        throw Object.assign(new Error('Sandbox with ID or name sbx-gone not found'), {
          name: 'DaytonaNotFoundError',
          statusCode: 404,
        });
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    assert.equal(await runtime.getById('sbx-gone'), null);
  });

  it('getById rethrows non-404 Daytona errors', async () => {
    const upstream = Object.assign(new Error('Daytona rate limit'), { statusCode: 429 });
    const daytona = {
      get: async () => {
        throw upstream;
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    await assert.rejects(() => runtime.getById('sbx-rate-limited'), upstream);
  });

  it('launchDetached registers an immediately started sandbox for uploads', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-started-now', state: 'STARTED' });
    const daytona = {
      target: 'us',
      sandboxApi: {
        createSandbox: async () => ({ data: { id: 'sbx-started-now', state: 'STARTED' } }),
      },
      get: async () => sandbox,
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handle = await runtime.launchDetached();
    await runtime.uploadFile(handle, Buffer.from('ready'), '/workspace/ready.txt');

    assert.deepEqual(sandbox.uploads, [
      { source: Buffer.from('ready'), destination: '/workspace/ready.txt' },
    ]);
  });

  it('findByLabels registers the first started sandbox and skips stopped matches', async () => {
    const stopped = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const started = fakeSandbox({ id: 'sbx-started', state: 'STARTED' });
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([stopped, started]);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handle = await runtime.findByLabels({ agentId: 'agent-1' });
    assert.equal(handle?.id, 'sbx-started');
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 10, states: ['started'] }]);

    await runtime.uploadFile(handle!, Buffer.from('ok'), '/workspace/ok.txt');
    assert.deepEqual(started.uploads, [{ source: Buffer.from('ok'), destination: '/workspace/ok.txt' }]);
    assert.deepEqual(stopped.uploads, []);
  });

  it('findByLabels consumes the cursor-backed Daytona iterator until a started sandbox appears', async () => {
    const archived = fakeSandbox({ id: 'sbx-archived', state: 'ARCHIVED' });
    const started = fakeSandbox({ id: 'sbx-page-2', state: 'STARTED' });
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([archived, archived, started]);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handle = await runtime.findByLabels({ agentId: 'agent-1' }, { limit: 2 });

    assert.equal(handle?.id, 'sbx-page-2');
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2, states: ['started'] }]);
  });

  it('findAllByLabels returns every started sandbox from the cursor-backed Daytona iterator', async () => {
    const stopped = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const first = fakeSandbox({
      id: 'sbx-first',
      state: 'STARTED',
      createdAt: '2026-05-31T01:00:00.000Z',
      updatedAt: '2026-05-31T01:05:00.000Z',
      lastActivityAt: '2026-05-31T01:06:00.000Z',
    });
    const second = fakeSandbox({ id: 'sbx-second', state: 'STARTED' });
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([stopped, first, second]);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { limit: 2 });

    assert.deepEqual(handles.map((handle) => handle.id), ['sbx-first', 'sbx-second']);
    assert.deepEqual(handles[0], {
      id: 'sbx-first',
      state: 'STARTED',
      createdAt: '2026-05-31T01:00:00.000Z',
      updatedAt: '2026-05-31T01:05:00.000Z',
      lastActivityAt: '2026-05-31T01:06:00.000Z',
    });
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2, states: ['started'] }]);
  });

  it('findAllByLabels drains cursor-backed iterators beyond one page-size', async () => {
    const sandboxes = Array.from({ length: 250 }, (_, index) =>
      fakeSandbox({
        id: `sbx-page-${index}`,
        state: 'STOPPED',
        createdAt: '2026-05-31T01:00:00.000Z',
      }),
    );
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return pagedSandboxIterator(sandboxes, 100);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handles = await runtime.findAllByLabels(
      { purpose: 'workforce-deploy' },
      { states: ['STOPPED'], pageSize: 100, owned: true },
    );

    assert.equal(handles.length, 250);
    assert.deepEqual(handles.slice(0, 3).map((handle) => handle.id), [
      'sbx-page-0',
      'sbx-page-1',
      'sbx-page-2',
    ]);
    assert.equal(handles.at(-1)?.id, 'sbx-page-249');
    assert.deepEqual(listed, [
      { labels: { purpose: 'workforce-deploy' }, limit: 100, states: ['stopped'] },
    ]);
  });

  it('findAllByLabels returns an empty list when the Daytona iterator has no matches', async () => {
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([]);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { limit: 2 });

    assert.deepEqual(handles, []);
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2, states: ['started'] }]);
  });

  it('findAllByLabels passes null states through without filtering the cursor-backed Daytona iterator', async () => {
    const first = fakeSandbox({ id: 'sbx-first', state: 'STARTED' });
    const stopped = fakeSandbox({ id: 'sbx-stopped', state: 'STOPPED' });
    const listed: unknown[] = [];
    const daytona = {
      list: (query: unknown) => {
        listed.push(query);
        return sandboxIterator([first, stopped]);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handles = await runtime.findAllByLabels({ agentId: 'agent-1' }, { states: null, limit: 2 });

    assert.deepEqual(handles.map((handle) => handle.id), ['sbx-first', 'sbx-stopped']);
    assert.deepEqual(listed, [{ labels: { agentId: 'agent-1' }, limit: 2 }]);
  });

  it('runScript defaults to session exec and preserves missing exitCode as null', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-session',
      state: 'STARTED',
      sessionResult: { output: 'timed out' },
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    const result = await runtime.runScript(handle, {
      command: 'node runner.mjs',
      cwd: '/workspace',
      env: { TOKEN: "a'b" },
      sessionId: 'tick-deployment-1',
      timeoutMs: 120_000,
    });

    assert.equal(result.exitCode, null);
    assert.equal(result.output, 'timed out');
    assert.deepEqual(sandbox.sessions, ['tick-deployment-1']);
    assert.deepEqual(sandbox.sessionCommands, [
      {
        sessionId: 'tick-deployment-1',
        req: {
          command: "cd '/workspace'\nexport TOKEN='a'\\''b'\nnode runner.mjs",
          runAsync: false,
          suppressInputEcho: undefined,
        },
        timeout: 120,
      },
    ]);
    assert.deepEqual(sandbox.commands, []);
  });

  it('runScript requires session exec by default but allows explicit one-shot exec', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-no-session',
      state: 'STARTED',
      supportsSession: false,
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.runScript(handle, { command: 'node runner.mjs' }),
      /session execution is not available/,
    );
    assert.deepEqual(sandbox.commands, []);

    const result = await runtime.runScript(handle, {
      command: 'node runner.mjs',
      useSession: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, 'ok');
    assert.deepEqual(sandbox.commands, [
      {
        command: 'node runner.mjs',
        cwd: undefined,
        env: undefined,
        timeout: 1,
      },
    ]);
  });

  it('starts session scripts asynchronously and exposes poll/log helpers', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-123', output: null, stdout: '', stderr: '', exitCode: null },
      sessionCommand: { id: 'cmd-123', command: 'node runner.mjs' },
      sessionLogs: { stdout: 'done', stderr: '', output: 'prefix-bytes done' },
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    const started = await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'tick-deployment-1',
      timeoutMs: 15_000,
      suppressInputEcho: true,
    });
    const running = await runtime.getScriptStatus(handle, 'tick-deployment-1', 'cmd-123');
    const logs = await runtime.getScriptLogs(handle, 'tick-deployment-1', 'cmd-123');

    assert.deepEqual(started, { sessionId: 'tick-deployment-1', commandId: 'cmd-123' });
    assert.deepEqual(running, { exitCode: null });
    assert.equal(logs.stdout, 'done');
    assert.equal(logs.output, 'prefix-bytes done');
    // startScript redirects combined stdout+stderr for the run command group to
    // a per-session log file (cloud #1516) so runAsync output is retrievable on
    // the Worker without redirecting later session commands.
    assert.deepEqual(sandbox.sessionCommands, [
      {
        sessionId: 'tick-deployment-1',
        req: {
          command:
            "{\nnode runner.mjs\n} > '/tmp/.daytona-run-tick-deployment-1.log' 2>&1",
          runAsync: true,
          suppressInputEcho: true,
        },
        timeout: 15,
      },
    ]);
    assert.deepEqual(sandbox.polledCommands, [
      { sessionId: 'tick-deployment-1', commandId: 'cmd-123' },
    ]);
    assert.deepEqual(sandbox.polledLogs, [
      { sessionId: 'tick-deployment-1', commandId: 'cmd-123' },
    ]);
  });

  it('getScriptLogs falls back to the captured log file when the runAsync snapshot is empty (cloud #1516)', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async-empty',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-async', output: null, stdout: '', stderr: '', exitCode: null },
      // Daytona returns an EMPTY snapshot for runAsync commands.
      sessionLogs: { output: '', stdout: '', stderr: '' },
      // The sync `tail -c` read of the redirect file returns the real output.
      sessionSyncResult: { exitCode: 0, output: 'TypeError: cannot read x\nrunner exited 1' },
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'tick-deployment-2',
      timeoutMs: 15_000,
    });
    const logs = await runtime.getScriptLogs(handle, 'tick-deployment-2', 'cmd-async');

    // The empty snapshot is replaced by the file content.
    assert.equal(logs.output, 'TypeError: cannot read x\nrunner exited 1');
    // The fallback issued a bounded `tail -c` of the per-session redirect file,
    // as a SYNC (runAsync:false) command on the same session.
    const tailCmd = (sandbox.sessionCommands as Array<{ req: Record<string, unknown> }>).find(
      (entry) => typeof entry.req.command === 'string' && (entry.req.command as string).startsWith('tail -c'),
    );
    assert.ok(tailCmd, 'expected a tail -c fallback read');
    assert.equal(tailCmd!.req.runAsync, false);
    assert.equal(
      tailCmd!.req.command,
      "tail -c 262144 '/tmp/.daytona-run-tick-deployment-2.log' 2>/dev/null || true",
    );
  });

  it('startScript scopes log redirection to the async command group', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-scoped-redirection',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-scoped', output: null, stdout: '', stderr: '', exitCode: null },
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'tick-deployment-scoped',
      timeoutMs: 15_000,
    });

    assert.equal(
      (sandbox.sessionCommands[0] as { req: { command: string } }).req.command,
      "{\nnode runner.mjs\n} > '/tmp/.daytona-run-tick-deployment-scoped.log' 2>&1",
    );
  });

  it('getScriptLogs returns the snapshot without a file read when it is non-empty (cloud #1516)', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-async-nonempty',
      state: 'STARTED',
      sessionResult: { cmdId: 'cmd-async', output: null, stdout: '', stderr: '', exitCode: null },
      sessionLogs: { output: 'snapshot has it', stdout: 'snapshot has it', stderr: '' },
      sessionSyncResult: { exitCode: 0, output: 'SHOULD NOT BE READ' },
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.startScript(handle, {
      command: 'node runner.mjs',
      sessionId: 'tick-deployment-3',
      timeoutMs: 15_000,
    });
    const logs = await runtime.getScriptLogs(handle, 'tick-deployment-3', 'cmd-async');

    assert.equal(logs.output, 'snapshot has it');
    const tailCmd = (sandbox.sessionCommands as Array<{ req: Record<string, unknown> }>).find(
      (entry) => typeof entry.req.command === 'string' && (entry.req.command as string).startsWith('tail -c'),
    );
    assert.equal(tailCmd, undefined, 'non-empty snapshot must not trigger a file read');
  });

  it('uploadBundle writes all files and an optional manifest', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-upload', state: 'STARTED' });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await runtime.uploadBundle(handle, {
      files: [
        { source: Buffer.from('runner'), destination: '/workspace/runner.mjs' },
        { source: Buffer.from('agent'), destination: '/workspace/agent.bundle.mjs' },
      ],
      manifest: { files: 2 },
      manifestPath: '/workspace/bundle-manifest.json',
    });

    assert.equal(sandbox.sessions.length, 2);
    assert.match(sandbox.sessions[0], /^mkdir-sbx-upload-\d+$/);
    assert.match(sandbox.sessions[1], /^verify-upload-sbx-upload-\d+$/);
    assert.deepEqual(sandbox.sessionCommands, [
      {
        sessionId: sandbox.sessions[0],
        req: {
          command: "mkdir -p '/workspace'",
          runAsync: false,
          suppressInputEcho: undefined,
        },
        timeout: 30,
      },
      {
        sessionId: sandbox.sessions[1],
        req: {
          command: "test -f '/workspace/runner.mjs' && test -f '/workspace/agent.bundle.mjs' && test -f '/workspace/bundle-manifest.json'",
          runAsync: false,
          suppressInputEcho: undefined,
        },
        timeout: 30,
      },
    ]);
    assert.deepEqual(sandbox.uploads.map(({ destination }) => destination), [
      '/workspace/runner.mjs',
      '/workspace/agent.bundle.mjs',
      '/workspace/bundle-manifest.json',
    ]);
    assert.equal(String(sandbox.uploads[2].source), '{\n  "files": 2\n}');
  });

  it('uploadBundle verifies runner.mjs exists after upload before callers start it', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-upload-missing-runner',
      state: 'STARTED',
      sessionResults: [
        { exitCode: 0, output: 'ok' },
        { exitCode: 1, output: 'missing /home/daytona/workforce-runtime/runner.mjs' },
      ],
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.uploadBundle(handle, {
        files: [
          { source: Buffer.from('runner'), destination: '/home/daytona/workforce-runtime/runner.mjs' },
          { source: Buffer.from('agent'), destination: '/home/daytona/workforce-runtime/agent.bundle.mjs' },
        ],
      }),
      /Failed to verify uploaded bundle files: missing \/home\/daytona\/workforce-runtime\/runner\.mjs/,
    );

    assert.deepEqual(sandbox.uploads.map(({ destination }) => destination), [
      '/home/daytona/workforce-runtime/runner.mjs',
      '/home/daytona/workforce-runtime/agent.bundle.mjs',
    ]);
    assert.equal(sandbox.sessionCommands.length, 2);
    assert.equal(
      (sandbox.sessionCommands[1] as { req: { command: string } }).req.command,
      "test -f '/home/daytona/workforce-runtime/runner.mjs' && test -f '/home/daytona/workforce-runtime/agent.bundle.mjs'",
    );
  });

  it('uploadBundle fails before upload when parent directory creation fails', async () => {
    const sandbox = fakeSandbox({
      id: 'sbx-upload-fail',
      state: 'STARTED',
      sessionResult: { exitCode: 1, output: 'mkdir: permission denied' },
    });
    const runtime = new DaytonaRuntime({ daytona: {} as never });
    const handle = runtime.attachSandbox(sandbox as never);

    await assert.rejects(
      () => runtime.uploadBundle(handle, {
        files: [
          { source: Buffer.from('runner'), destination: '/workspace/runner.mjs' },
        ],
      }),
      /Failed to create upload directories: mkdir: permission denied/,
    );

    assert.deepEqual(sandbox.uploads, []);
  });

  it('destroy keeps owned handles registered when remote deletion fails', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-delete-fails', state: 'STARTED' });
    const daytona = {
      delete: async () => {
        throw new Error('delete failed');
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });
    const handle = runtime.attachSandbox(sandbox as never, { owned: true });

    await assert.rejects(() => runtime.destroy(handle), /delete failed/);
    await runtime.uploadFile(handle, Buffer.from('still-registered'), '/workspace/retry.txt');

    assert.deepEqual(sandbox.uploads, [
      { source: Buffer.from('still-registered'), destination: '/workspace/retry.txt' },
    ]);
  });

  it('stops owned handles without deleting them', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-stop', state: 'STARTED' });
    const stopped: string[] = [];
    const deleted: string[] = [];
    const daytona = {
      get: async () => sandbox,
      stop: async (value: unknown) => {
        stopped.push((value as { id: string }).id);
      },
      delete: async (value: unknown) => {
        deleted.push((value as { id: string }).id);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handle = await runtime.getById('sbx-stop', { owned: true });
    await runtime.stop(handle!);

    assert.deepEqual(stopped, ['sbx-stop']);
    assert.deepEqual(deleted, []);
    await runtime.destroy(handle!);
    assert.deepEqual(deleted, ['sbx-stop']);
  });

  it('starts owned handles without deleting them', async () => {
    const sandbox = fakeSandbox({ id: 'sbx-start', state: 'STOPPED' });
    const started: string[] = [];
    const deleted: string[] = [];
    const daytona = {
      get: async () => sandbox,
      start: async (value: unknown) => {
        started.push((value as { id: string }).id);
      },
      delete: async (value: unknown) => {
        deleted.push((value as { id: string }).id);
      },
    };
    const runtime = new DaytonaRuntime({ daytona: daytona as never });

    const handle = await runtime.getById('sbx-start', { owned: true });
    const startedHandle = await runtime.start(handle!);

    assert.equal(startedHandle.state, 'STARTED');
    assert.deepEqual(started, ['sbx-start']);
    assert.deepEqual(deleted, []);
  });
});

function fakeSandbox(input: {
  id: string;
  state: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  sessionResult?: Record<string, unknown>;
  sessionResults?: Array<Record<string, unknown>>;
  // Result for a SYNCHRONOUS (runAsync:false) session command — e.g. the
  // `tail -c` log-file read getScriptLogs falls back to (cloud #1516). When
  // unset, sync commands reuse sessionResult.
  sessionSyncResult?: Record<string, unknown>;
  sessionCommand?: Record<string, unknown>;
  sessionLogs?: Record<string, unknown>;
  supportsSession?: boolean;
}) {
  const uploads: Array<{ source: Buffer | string; destination: string }> = [];
  const commands: Array<unknown> = [];
  const sessions: string[] = [];
  const sessionCommands: Array<unknown> = [];
  const polledCommands: Array<unknown> = [];
  const polledLogs: Array<unknown> = [];
  const process: {
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => Promise<{ exitCode: number; result: string }>;
    createSession?: (sessionId: string) => Promise<void>;
    executeSessionCommand?: (
      sessionId: string,
      req: Record<string, unknown>,
      timeout?: number,
    ) => Promise<Record<string, unknown>>;
    getSessionCommand?: (
      sessionId: string,
      commandId: string,
    ) => Promise<Record<string, unknown>>;
    getSessionCommandLogs?: (
      sessionId: string,
      commandId: string,
    ) => Promise<Record<string, unknown>>;
  } = {
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => {
      commands.push({ command, cwd, env, timeout });
      return { exitCode: 0, result: 'ok' };
    },
  };
  if (input.supportsSession !== false) {
    process.createSession = async (sessionId: string) => {
      sessions.push(sessionId);
    };
    process.executeSessionCommand = async (
      sessionId: string,
      req: Record<string, unknown>,
      timeout?: number,
    ) => {
      sessionCommands.push({ sessionId, req, timeout });
      if (req.runAsync === false && input.sessionSyncResult !== undefined) {
        return input.sessionSyncResult;
      }
      if (input.sessionResults && input.sessionResults.length > 0) {
        return input.sessionResults.shift()!;
      }
      return input.sessionResult ?? { exitCode: 0, output: 'ok' };
    };
    process.getSessionCommand = async (
      sessionId: string,
      commandId: string,
    ) => {
      polledCommands.push({ sessionId, commandId });
      return input.sessionCommand ?? { id: commandId, command: 'true', exitCode: 0 };
    };
    process.getSessionCommandLogs = async (
      sessionId: string,
      commandId: string,
    ) => {
      polledLogs.push({ sessionId, commandId });
      return input.sessionLogs ?? { output: 'ok', stdout: 'ok', stderr: '' };
    };
  }

  return {
    id: input.id,
    state: input.state,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
    uploads,
    commands,
    sessions,
    sessionCommands,
    polledCommands,
    polledLogs,
    getUserHomeDir: async () => '/home/daytona',
    fs: {
      uploadFile: async (source: Buffer | string, destination: string) => {
        uploads.push({ source, destination });
      },
      downloadFile: async () => Buffer.from(''),
    },
    process,
  };
}

async function* sandboxIterator(sandboxes: Array<ReturnType<typeof fakeSandbox>>) {
  for (const sandbox of sandboxes) {
    yield sandbox;
  }
}

async function* pagedSandboxIterator(
  sandboxes: Array<ReturnType<typeof fakeSandbox>>,
  pageSize: number,
) {
  for (let i = 0; i < sandboxes.length; i += pageSize) {
    for (const sandbox of sandboxes.slice(i, i + pageSize)) {
      yield sandbox;
    }
  }
}

const daytonaApiKey = process.env.DAYTONA_API_KEY?.trim();
const HAS_DAYTONA = Boolean(daytonaApiKey);
const SMOKE_LABEL = 'daytona-runner-smoke';

describe('DaytonaRuntime smoke', { concurrency: false }, () => {
  let runtime: DaytonaRuntime | undefined;
  let handle: RuntimeHandle | undefined;

  before(() => {
    if (!HAS_DAYTONA) return;
    const auth = resolveDaytonaAuthCredentials({
      apiKey: daytonaApiKey,
      jwtToken: process.env.DAYTONA_JWT_TOKEN,
      organizationId: process.env.DAYTONA_ORGANIZATION_ID,
    });
    const daytona = new Daytona(auth);
    runtime = new DaytonaRuntime({ daytona });
  });

  after(async () => {
    if (runtime && handle) {
      try {
        await runtime.destroy(handle);
      } catch {
        // best-effort cleanup; sandbox leaks surface via Daytona dashboard
      }
    }
  });

  it(
    'launches a sandbox, runs node -e, and destroys it',
    { skip: HAS_DAYTONA ? false : 'DAYTONA_API_KEY is not set', timeout: 120_000 },
    async () => {
      assert.ok(runtime, 'runtime should be initialised when DAYTONA_API_KEY is set');
      handle = await runtime.launch({ label: SMOKE_LABEL });
      const result = await runtime.exec(handle, "node -e 'console.log(\"ok\")'");
      assert.equal(
        result.exitCode,
        0,
        `expected exitCode 0, got ${result.exitCode}: ${result.output}`,
      );
      assert.match(
        result.output,
        /\bok\b/,
        `expected output to contain "ok", got: ${result.output}`,
      );
    },
  );
});

# @cloud/daytona-runner

Daytona-backed `WorkflowRuntime` adapter for Cloud deploy workflows. This package owns the Cloud-local Daytona runtime implementation, auth helpers, and runtime contract types.

This is intentionally a Cloud workspace package. It is not the upstream `@agentworkforce/daytona-runner` npm package, which avoids two repositories publishing or importing different source trees under the same package identity.

## Workspace Use

Cloud packages consume this workspace package through a local `file:../daytona-runner` dependency.

`@daytonaio/sdk` is a peer dependency. Consumers bring their own version matching `>=0.148.0 <0.175.0`.

## Usage

```ts
import { Buffer } from 'node:buffer';
import { Daytona } from '@daytonaio/sdk';
import {
  DaytonaRuntime,
  resolveDaytonaAuthCredentials,
} from '@cloud/daytona-runner';

const auth = resolveDaytonaAuthCredentials({
  apiKey: process.env.DAYTONA_API_KEY,
  jwtToken: process.env.DAYTONA_JWT_TOKEN,
  organizationId: process.env.DAYTONA_ORGANIZATION_ID,
});

const daytona = new Daytona(auth);
const runtime = new DaytonaRuntime({ daytona });

const handle = await runtime.findByLabels(
  { purpose: 'workforce-deploy', agentId: 'agent-1' },
  { states: ['STARTED'] },
) ?? await runtime.launch({
  name: 'agent-1',
  labels: { purpose: 'workforce-deploy', agentId: 'agent-1' },
});

await runtime.uploadBundle(handle, {
  files: [
    { source: Buffer.from('console.log("ok")'), destination: '/workspace/runner.mjs' },
  ],
});

const result = await runtime.runScript(handle, {
  cwd: '/workspace',
  command: 'node runner.mjs',
  sessionId: 'tick-agent-1',
  timeoutMs: 120_000,
});

await runtime.destroy(handle);
```

## Exports

- `DaytonaRuntime` — the `WorkflowRuntime` implementation.
- `DaytonaRuntime.findByLabels` — paginated sandbox lookup with optional state filtering. It defaults to `STARTED` sandboxes.
- `DaytonaRuntime.runScript` — session-backed command execution that preserves missing SDK exit codes as `null`.
- `DaytonaRuntime.uploadBundle` — uploads multiple files after creating destination parent directories in the sandbox.
- `resolveDaytonaAuthCredentials` / `applyDaytonaAuthEnv` — Daytona auth helpers (apiKey vs JWT+org).
- `WorkflowRuntime`, `RuntimeHandle`, `LaunchOptions`, `ExecOptions`, `ExecResult`, `RuntimeCapabilities` — runtime contract types.

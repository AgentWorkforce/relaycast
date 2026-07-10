import { DaytonaRuntime, type DaytonaRuntimeOptions } from './daytona.js';
import { defaultRegistry } from './registry.js';

defaultRegistry.register({
  descriptor: {
    id: 'daytona',
    displayName: 'Daytona',
    status: 'stable',
    capabilities: {
      pty: false,
      snapshots: true,
      isolation: 'strong',
      persistentHandle: true,
      streamingLogs: true,
    },
    description: 'Daytona cloud sandboxes (default)',
    configSchema: {
      required: ['daytona'],
      optional: ['snapshot', 'defaultHomeDir'],
      envVars: [],
    },
    docsUrl: 'docs/runtimes/daytona.md',
  },
  factory: (config) => new DaytonaRuntime(config as DaytonaRuntimeOptions),
});

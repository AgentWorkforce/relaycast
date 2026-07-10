import {
  buildRelayfileMountShellTemplate,
} from '../relayfile/mount-script.js';
import {
  BOOTSTRAP_INNER_TEMPLATE,
  BOOTSTRAP_WRAPPER_TEMPLATE,
} from './templates.generated.js';

export interface BootstrapConfig {
  fileType: 'yaml' | 'typescript' | 'python' | 'config';
  workflowConfig?: string;
  workflowFile?: string;
  codeMountPath?: string;
  interactive?: boolean;
  executionMode?: 'per-step-sandbox' | 'shared-sandbox';
}

export interface BootstrapScripts {
  wrapper: string;
  inner: string;
}

export const BOOTSTRAP_STATIC_LIB_IMPORTS = [
  {
    module: './lib/auth/api-token-client.js',
    statement: "import { CloudApiClient } from './lib/auth/api-token-client.js';",
  },
  {
    module: './lib/storage/client.js',
    statement: "import { ScopedS3Client } from './lib/storage/client.js';",
  },
  {
    module: './lib/storage/code-transfer.js',
    statement: "import { downloadAndExtractCode } from './lib/storage/code-transfer.js';",
  },
  {
    module: './lib/storage/metadata.js',
    statement: "import { writeRunManifest } from './lib/storage/metadata.js';",
  },
  {
    module: './lib/executor/executor.js',
    statement: "import { SandboxedStepExecutor } from './lib/executor/executor.js';",
  },
  {
    module: './lib/runtime/daytona.js',
    statement: [
      '// Import DaytonaRuntime directly, not via ./lib/runtime/index.js, because',
      "// the barrel re-exports E2BRuntime which eagerly imports the 'e2b' npm",
      "// package — and that package isn't in the sandbox snapshot.",
      "import { DaytonaRuntime } from './lib/runtime/daytona.js';",
    ].join('\n'),
  },
  {
    module: './lib/runtime/local-http.js',
    statement: "import { LocalHttpRuntime } from './lib/runtime/local-http.js';",
  },
  {
    module: './lib/reporter/reporter.js',
    statement: "import { Reporter } from './lib/reporter/reporter.js';",
  },
  {
    module: './lib/auth/credential-expiry.js',
    statement: "import { parseCredentialExpiry } from './lib/auth/credential-expiry.js';",
  },
  {
    module: './lib/auth/credential-refresher.js',
    statement: "import { refreshCredential } from './lib/auth/credential-refresher.js';",
  },
  {
    module: './lib/auth/proxy-token.js',
    statement: "import { parseCredentialProxyTokens } from './lib/auth/proxy-token.js';",
  },
  {
    module: './lib/config/snapshot.js',
    statement: "import { getSnapshotName } from './lib/config/snapshot.js';",
  },
] as const;

const RELAYFILE_MOUNT_SHELL_TEMPLATE = buildRelayfileMountShellTemplate(
  {},
  { interval: "3s", websocket: false },
);

const BOOTSTRAP_TEMPLATE_TOKENS = [
  '__CLOUD_BOOTSTRAP_CODE_MOUNT_PATH_JSON__',
  '__CLOUD_BOOTSTRAP_CONFIGURED_EXECUTION_MODE_JSON__',
  '__CLOUD_BOOTSTRAP_FILE_TYPE_JSON__',
  '__CLOUD_BOOTSTRAP_INTERACTIVE_JSON__',
  '__CLOUD_BOOTSTRAP_RELAYFILE_MOUNT_SHELL_TEMPLATE_JSON__',
] as const;

type BootstrapTemplateToken = typeof BOOTSTRAP_TEMPLATE_TOKENS[number];

function replaceAllLiteral(value: string, token: BootstrapTemplateToken, replacement: string): string {
  return value.split(token).join(replacement);
}

function renderBootstrapInnerScript(config: BootstrapConfig): string {
  const replacements: Record<BootstrapTemplateToken, string> = {
    __CLOUD_BOOTSTRAP_CODE_MOUNT_PATH_JSON__: JSON.stringify(config.codeMountPath ?? '/project'),
    __CLOUD_BOOTSTRAP_CONFIGURED_EXECUTION_MODE_JSON__: JSON.stringify(
      config.executionMode === 'shared-sandbox' ? 'shared-sandbox' : 'per-step-sandbox',
    ),
    __CLOUD_BOOTSTRAP_FILE_TYPE_JSON__: JSON.stringify(config.fileType),
    __CLOUD_BOOTSTRAP_INTERACTIVE_JSON__: JSON.stringify(!!config.interactive),
    __CLOUD_BOOTSTRAP_RELAYFILE_MOUNT_SHELL_TEMPLATE_JSON__: JSON.stringify(RELAYFILE_MOUNT_SHELL_TEMPLATE),
  };

  let rendered = BOOTSTRAP_INNER_TEMPLATE;
  for (const token of BOOTSTRAP_TEMPLATE_TOKENS) {
    rendered = replaceAllLiteral(rendered, token, replacements[token]);
  }
  return rendered;
}

export function generateBootstrapScript(config: BootstrapConfig): BootstrapScripts {
  return {
    wrapper: BOOTSTRAP_WRAPPER_TEMPLATE,
    inner: renderBootstrapInnerScript(config),
  };
}

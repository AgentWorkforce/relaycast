import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createRelayMcpServer,
  parseWorkspaceEnv,
  type McpServerOptions,
} from '@relaycast/mcp';
import { CLI_VERSION } from './version.js';

type WritableStreamLike = { write(chunk: string): unknown };
type EnvLike = Record<string, string | undefined>;
type JsonObject = Record<string, unknown>;
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};
type ToolDefinition = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
};
type CliIo = {
  stdout: WritableStreamLike;
  stderr: WritableStreamLike;
  env?: EnvLike;
};
type ParsedArgs = {
  command: string | null;
  commandArgs: string[];
  config: CliConfig;
  outputJson: boolean;
  help: boolean;
};
type CliConfig = {
  apiKey?: string;
  baseUrl?: string;
  agentToken?: string;
  agentName?: string;
  agentType?: 'agent' | 'human';
  strictAgentName?: boolean;
  workspacesJson?: string;
  defaultWorkspace?: string;
};

const GLOBAL_FLAG_NAMES = new Set([
  'relay-api-key',
  'relay-base-url',
  'relay-agent-token',
  'relay-agent-name',
  'relay-agent-type',
  'relay-strict-agent-name',
  'relay-workspaces-json',
  'relay-default-workspace',
  'json',
  'help',
  'h',
]);

const TOOL_JSON_FLAG_NAMES = new Set(['json-args', 'args-json']);

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    if (argv.length === 1 && (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v')) {
      io.stdout.write(`@relaycast/cli ${CLI_VERSION}\n`);
      return 0;
    }

    const parsed = parseCliArgs(argv, io.env ?? process.env);
    if (parsed.command === 'version') {
      io.stdout.write(`@relaycast/cli ${CLI_VERSION}\n`);
      return 0;
    }

    const session = await createCliMcpSession(parsed.config);
    try {
      const tools = await session.listTools();
      const toolDefinitions = tools.tools as ToolDefinition[];

      if (!parsed.command || parsed.command === 'help' || parsed.command === '--help' || parsed.command === '-h') {
        io.stdout.write(formatHelp(toolDefinitions));
        return 0;
      }

      if (parsed.command === 'tools' || parsed.command === 'tool.list') {
        if (parsed.outputJson) {
          io.stdout.write(`${JSON.stringify(toolDefinitions, null, 2)}\n`);
        } else {
          io.stdout.write(formatToolList(toolDefinitions));
        }
        return 0;
      }

      const tool = toolDefinitions.find((candidate) => candidate.name === parsed.command);
      if (parsed.help) {
        io.stdout.write(formatToolHelp(parsed.command, tool));
        return 0;
      }

      const toolArgs = parseToolArgs(parsed.commandArgs, tool?.inputSchema);
      const result = await session.callTool(parsed.command, toolArgs);
      writeToolResult(io.stdout, result, parsed.outputJson);
      return isToolErrorResult(result) ? 1 : 0;
    } finally {
      await session.close();
    }
  } catch (err) {
    io.stderr.write(`${formatError(err)}\n`);
    return 1;
  }
}

export async function listCliTools(config: CliConfig = {}): Promise<ToolDefinition[]> {
  const session = await createCliMcpSession(config);
  try {
    const tools = await session.listTools();
    return tools.tools as ToolDefinition[];
  } finally {
    await session.close();
  }
}

export async function callCliTool(
  name: string,
  args: JsonObject,
  config: CliConfig = {},
): Promise<unknown> {
  const session = await createCliMcpSession(config);
  try {
    return await session.callTool(name, args);
  } finally {
    await session.close();
  }
}

function parseCliArgs(argv: string[], env: EnvLike): ParsedArgs {
  const config: CliConfig = {
    apiKey: env.RELAY_API_KEY,
    baseUrl: env.RELAY_BASE_URL,
    agentToken: env.RELAY_AGENT_TOKEN,
    agentName: env.RELAY_AGENT_NAME,
    agentType: parseAgentType(env.RELAY_AGENT_TYPE),
    strictAgentName: parseBooleanFlag(env.RELAY_STRICT_AGENT_NAME),
    workspacesJson: env.RELAY_WORKSPACES_JSON,
    defaultWorkspace: env.RELAY_DEFAULT_WORKSPACE,
  };
  let outputJson = false;
  let help = false;
  let command: string | null = null;
  const commandArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!command && isFlag(token)) {
      const { name, inlineValue, negated } = splitFlag(token);
      if (negated || !GLOBAL_FLAG_NAMES.has(name)) {
        throw new Error(`Unknown global option "${token}". Put tool arguments after the tool name.`);
      }
      const value = readGlobalFlagValue(argv, i, name, inlineValue);
      if (value.consumed) i += 1;
      applyGlobalFlag(config, name, value.value, () => { outputJson = true; }, () => { help = true; });
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }

    if (isFlag(token)) {
      const { name, inlineValue, negated } = splitFlag(token);
      if (!negated && GLOBAL_FLAG_NAMES.has(name)) {
        const value = readGlobalFlagValue(argv, i, name, inlineValue);
        if (value.consumed) i += 1;
        applyGlobalFlag(config, name, value.value, () => { outputJson = true; }, () => { help = true; });
        continue;
      }
    }
    commandArgs.push(token);
  }

  return { command, commandArgs, config, outputJson, help };
}

async function createCliMcpSession(config: CliConfig) {
  const options: McpServerOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    agentToken: config.agentToken,
    agentName: config.agentName,
    agentType: config.agentType,
    strictAgentName: config.strictAgentName,
    defaultWorkspace: config.defaultWorkspace,
    workspaces: config.workspacesJson ? parseWorkspaceEnv(config.workspacesJson) : undefined,
    telemetryTransport: 'stdio',
  };
  const server = createRelayMcpServer(options);
  const client = new Client({ name: '@relaycast/cli', version: CLI_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    listTools: () => client.listTools(),
    callTool: (name: string, args: JsonObject) =>
      client.callTool({ name, arguments: args }),
    close: async () => {
      await Promise.allSettled([
        client.close(),
        server.close(),
      ]);
    },
  };
}

function parseToolArgs(argv: string[], inputSchema?: JsonSchema): JsonObject {
  const jsonFlagIndex = argv.findIndex((arg) => isFlag(arg) && TOOL_JSON_FLAG_NAMES.has(splitFlag(arg).name));
  if (jsonFlagIndex >= 0) {
    const token = argv[jsonFlagIndex];
    const { inlineValue } = splitFlag(token);
    const raw = inlineValue ?? argv[jsonFlagIndex + 1];
    if (!raw) {
      throw new Error(`Missing value for ${token}`);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${token} must be a JSON object`);
    }
    return parsed as JsonObject;
  }

  const args: JsonObject = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!isFlag(token)) {
      throw new Error(`Unexpected positional argument "${token}". Use --name value arguments.`);
    }

    const { name, inlineValue, negated } = splitFlag(token);
    const key = normalizeArgName(name);
    const schema = inputSchema?.properties?.[key];
    let rawValue: string | boolean;
    if (negated) {
      rawValue = false;
    } else if (inlineValue != null) {
      rawValue = inlineValue;
    } else {
      const isBoolean = schemaHasType(schema, 'boolean');
      const value = readFlagValue(argv, i, name, isBoolean);
      rawValue = value.value;
      if (value.consumed) i += 1;
    }

    const value = coerceToolValue(rawValue, schema);
    appendArgValue(args, key, value, schema);
  }

  return args;
}

function formatHelp(tools: ToolDefinition[]): string {
  return [
    'relaycast - Relaycast command line tools',
    '',
    'Usage:',
    '  relaycast tools',
    '  relaycast <mcp-tool-name> [--arg value]',
    '  relaycast <mcp-tool-name> --json-args \'{"key":"value"}\'',
    '',
    'Global options:',
    '  --relay-api-key <key>          Workspace key, defaults to RELAY_API_KEY',
    '  --relay-base-url <url>         API base URL, defaults to RELAY_BASE_URL',
    '  --relay-agent-token <token>    Agent token, defaults to RELAY_AGENT_TOKEN',
    '  --relay-agent-name <name>      Agent name, defaults to RELAY_AGENT_NAME',
    '  --json                         Print raw JSON output',
    '',
    'Commands:',
    formatToolList(tools).trimEnd(),
  ].join('\n') + '\n';
}

function formatToolList(tools: ToolDefinition[]): string {
  const width = tools.reduce((max, tool) => Math.max(max, tool.name.length), 0);
  return tools
    .map((tool) => {
      const summary = tool.title ?? firstSentence(tool.description) ?? '';
      return `  ${tool.name.padEnd(width)}  ${summary}`.trimEnd();
    })
    .join('\n') + '\n';
}

function formatToolHelp(command: string, tool?: ToolDefinition): string {
  if (!tool) {
    return [
      `No MCP tool named "${command}" was found in the tool list.`,
      'Legacy MCP aliases are still accepted when called directly.',
      '',
      `Usage: relaycast ${command} --json-args '{"key":"value"}'`,
    ].join('\n') + '\n';
  }

  const lines = [
    `${tool.name}${tool.title ? ` - ${tool.title}` : ''}`,
    '',
    tool.description ?? '',
    '',
    `Usage: relaycast ${tool.name} [--arg value]`,
  ];

  const properties = tool.inputSchema?.properties ?? {};
  const argLines = Object.entries(properties).map(([name, schema]) =>
    `  --${name.replace(/_/g, '-')}  ${formatSchemaType(schema)}`,
  );
  if (argLines.length) {
    lines.push('', 'Arguments:', ...argLines);
  }
  return lines.filter((line, index) => line || index !== 2).join('\n') + '\n';
}

function writeToolResult(stdout: WritableStreamLike, result: unknown, rawJson: boolean): void {
  if (rawJson) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const structured = getStructuredContent(result);
  if (structured !== undefined) {
    stdout.write(`${JSON.stringify(structured, null, 2)}\n`);
    return;
  }

  const contentText = getTextContent(result);
  if (contentText) {
    stdout.write(`${contentText}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function isToolErrorResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return (result as { isError?: unknown }).isError === true;
}

function getStructuredContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined;
  return (result as { structuredContent?: unknown }).structuredContent;
}

function getTextContent(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' ? text : null;
    })
    .filter((item): item is string => item != null);
  return parts.length ? parts.join('\n') : null;
}

function splitFlag(token: string): { name: string; inlineValue?: string; negated: boolean } {
  const trimmed = token.replace(/^--?/, '');
  const eqIndex = trimmed.indexOf('=');
  const rawName = eqIndex >= 0 ? trimmed.slice(0, eqIndex) : trimmed;
  const negated = rawName.startsWith('no-');
  return {
    name: negated ? rawName.slice(3) : rawName,
    inlineValue: eqIndex >= 0 ? trimmed.slice(eqIndex + 1) : undefined,
    negated,
  };
}

function isFlag(token: string): boolean {
  return token.startsWith('-') && token.length > 1;
}

function readFlagValue(
  argv: string[],
  index: number,
  flagName: string,
  allowBooleanDefault = false,
): { value: string | boolean; consumed: boolean } {
  const next = argv[index + 1];
  if (!next || isFlag(next)) {
    if (allowBooleanDefault) {
      return { value: true, consumed: false };
    }
    throw new Error(`Missing value for --${flagName}`);
  }
  return { value: next, consumed: true };
}

function readGlobalFlagValue(
  argv: string[],
  index: number,
  flagName: string,
  inlineValue?: string,
): { value: string | boolean; consumed: boolean } {
  if (inlineValue != null) {
    return { value: inlineValue, consumed: false };
  }
  if (flagName === 'json' || flagName === 'help' || flagName === 'h' || flagName === 'relay-strict-agent-name') {
    return { value: true, consumed: false };
  }
  return readFlagValue(argv, index, flagName, false);
}

function applyGlobalFlag(
  config: CliConfig,
  flag: string,
  value: string | boolean,
  setJson: () => void,
  setHelp: () => void,
): void {
  const stringValue = value === true ? undefined : String(value);
  switch (flag) {
    case 'relay-api-key':
      config.apiKey = stringValue;
      break;
    case 'relay-base-url':
      config.baseUrl = stringValue;
      break;
    case 'relay-agent-token':
      config.agentToken = stringValue;
      break;
    case 'relay-agent-name':
      config.agentName = stringValue;
      break;
    case 'relay-agent-type':
      config.agentType = parseAgentType(stringValue);
      break;
    case 'relay-strict-agent-name':
      config.strictAgentName = parseBooleanFlag(value);
      break;
    case 'relay-workspaces-json':
      config.workspacesJson = stringValue;
      break;
    case 'relay-default-workspace':
      config.defaultWorkspace = stringValue;
      break;
    case 'json':
      setJson();
      break;
    case 'help':
    case 'h':
      setHelp();
      break;
    default:
      throw new Error(`Unknown global option "--${flag}"`);
  }
}

function normalizeArgName(name: string): string {
  return name.replace(/-/g, '_');
}

function appendArgValue(args: JsonObject, key: string, value: unknown, schema?: JsonSchema): void {
  if (schemaHasType(schema, 'array')) {
    const existing = args[key];
    if (Array.isArray(value)) {
      args[key] = Array.isArray(existing) ? [...existing, ...value] : value;
    } else {
      args[key] = Array.isArray(existing) ? [...existing, value] : [value];
    }
    return;
  }

  if (Object.prototype.hasOwnProperty.call(args, key)) {
    const existing = args[key];
    args[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    return;
  }
  args[key] = value;
}

function coerceToolValue(value: string | boolean, schema?: JsonSchema): unknown {
  if (typeof value === 'boolean') return value;
  if (schemaHasType(schema, 'array')) {
    const parsed = parseJsonIfPossible(value);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [coerceToolValue(value, schema?.items)];
  }
  if (schemaHasType(schema, 'object')) {
    return JSON.parse(value) as unknown;
  }
  if (schemaHasType(schema, 'number') || schemaHasType(schema, 'integer')) {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`Expected number, received "${value}"`);
    }
    return parsed;
  }
  if (schemaHasType(schema, 'boolean')) {
    return parseBooleanFlag(value);
  }
  return value;
}

function schemaHasType(schema: JsonSchema | undefined, type: string): boolean {
  if (!schema?.type) return false;
  return Array.isArray(schema.type) ? schema.type.includes(type) : schema.type === type;
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseBooleanFlag(value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseAgentType(value: string | undefined): 'agent' | 'human' | undefined {
  if (value === 'agent' || value === 'human') return value;
  return undefined;
}

function firstSentence(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [sentence] = value.split('.');
  return sentence ? `${sentence}.` : value;
}

function formatSchemaType(schema: JsonSchema): string {
  if (!schema.type) return 'value';
  return Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

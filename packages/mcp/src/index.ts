export const MCP_VERSION = '0.1.0' as const;

export { createRelayMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';
export { startStdio, createHttpHandler } from './transports.js';
export { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
export type { SessionState } from './types.js';

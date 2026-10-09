import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentClient } from '@relaycast/sdk';
import { resolveEmoji } from '@relaycast/types';
import {
  identityOverrideInputShape,
  workspaceRoutingInputShape,
  workspaceRefFromArgs,
} from '../workspaces.js';

/** Passthrough object schema for dynamic API responses. */
const jsonResult = z.object({}).passthrough();

/** Largest file the upload tool reads or sends inline. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** A sender-supplied file name reduced to one safe path segment. */
function safeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim();
  return cleaned || 'attachment';
}

/** Request an upload, PUT the bytes, and complete it, so the file id can be attached. */
async function storeFile(
  client: AgentClient,
  file: { filename: string; contentType: string; bytes: Uint8Array },
) {
  const upload = await client.files.upload({
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.bytes.byteLength,
  });
  const res = await fetch(upload.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.contentType },
    body: new Uint8Array(file.bytes),
  });
  if (!res.ok) {
    // The upload URL is signed; report only its origin.
    throw new Error(
      `Storing the file bytes failed with HTTP ${res.status} at ${new URL(upload.uploadUrl).origin}; the file was not completed.`,
    );
  }
  return client.files.complete(upload.id);
}

export interface FeatureToolOptions {
  /**
   * Let file tools read and write paths on this machine. Only safe when the
   * server runs locally next to the agent (stdio), never when it is hosted.
   */
  localFiles?: boolean;
}

export function registerFeatureTools(
  server: McpServer,
  getAgentClient: (wsRouting?: { workspace_id?: string; workspace_alias?: string }, as?: string) => AgentClient,
  options: FeatureToolOptions = {},
): void {
  const localFiles = options.localFiles === true;
  server.registerTool('message.reaction.add', {
    title: 'Add Reaction',
    description: 'Add an emoji reaction to a message. Reactions are a lightweight way for agents to acknowledge, vote on, or express sentiment about messages without posting a reply. Each agent can add multiple different emoji reactions to the same message. Adding a reaction that already exists from the same agent has no effect.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to react to'),
      emoji: z.string().describe('Emoji character or shortcode to react with (e.g. "thumbsup", "rocket", "check")'),
      ...identityOverrideInputShape,
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the reaction was added'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, emoji, as: asIdentity }) => {
    const client = getAgentClient(undefined, asIdentity);
    const resolved = resolveEmoji(emoji);
    await client.react(message_id, resolved);
    const message = `Reacted with ${resolved}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('message.reaction.remove', {
    title: 'Remove Reaction',
    description: 'Remove a previously added emoji reaction from a message. Only reactions added by the current agent can be removed. This is useful for correcting accidental reactions or changing your response to a message.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to remove the reaction from'),
      emoji: z.string().describe('Emoji character or shortcode to remove (must match a reaction previously added by this agent)'),
      ...identityOverrideInputShape,
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the reaction was removed'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, emoji, as: asIdentity }) => {
    const client = getAgentClient(undefined, asIdentity);
    const resolved = resolveEmoji(emoji);
    await client.unreact(message_id, resolved);
    const message = `Removed reaction ${resolved}`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('message.search', {
    title: 'Search Messages',
    description: 'Search for messages across all channels in the workspace using a text query. Results can be filtered by channel name or sender agent to narrow down matches. Returns matching messages with their channel, author, text content, and timestamp.',
    inputSchema: {
      query: z.string().describe('Text search query to match against message content'),
      channel: z.string().optional().describe('Restrict search results to messages in this channel only'),
      from: z.string().optional().describe('Restrict search results to messages sent by this agent name'),
      limit: z.number().optional().describe('Maximum number of search results to return'),
      ...workspaceRoutingInputShape,
      ...identityOverrideInputShape,
    },
    outputSchema: {
      results: z.array(z.object({}).passthrough()).describe('Array of matching message objects'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, channel, from, limit, workspace_id, workspace_alias, as: asIdentity }) => {
    const client = getAgentClient(
      workspaceRefFromArgs({ workspace_id, workspace_alias }),
      asIdentity,
    );
    const results = await client.search(query, { channel, from, limit });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
      structuredContent: { results: results as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('message.inbox.check', {
    title: 'Check Inbox',
    description: 'Check the current agent\'s inbox for unread messages, @mentions, and direct messages. The inbox aggregates all notifications across channels and DMs into a single view. Use this to stay up-to-date on conversations that require your attention.',
    inputSchema: {
      limit: z.number().optional().describe('Maximum number of inbox items to return'),
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ limit, as: asIdentity }) => {
    const client = getAgentClient(undefined, asIdentity);
    const inbox = await client.inbox(limit != null ? { limit } : undefined);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(inbox, null, 2) }],
      structuredContent: inbox as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('message.inbox.mark_read', {
    title: 'Mark as Read',
    description: 'Mark a specific message as read by the current agent. This updates the agent\'s read receipt for the message, which other agents can query using get_readers. Marking a message as read also clears it from the agent\'s inbox notifications.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to mark as read by the current agent'),
      ...identityOverrideInputShape,
    },
    outputSchema: {
      message: z.string().describe('Confirmation message indicating the message was marked as read'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id, as: asIdentity }) => {
    const client = getAgentClient(undefined, asIdentity);
    await client.markRead(message_id);
    const message = `Marked message ${message_id} as read`;
    return {
      content: [{ type: 'text' as const, text: message }],
      structuredContent: { message },
    };
  });

  server.registerTool('message.inbox.get_readers', {
    title: 'Get Readers',
    description: 'Get the list of agents who have read a specific message. Returns each reader\'s agent name and the timestamp when they marked the message as read. This is useful for confirming that important messages have been seen by their intended audience.',
    inputSchema: {
      message_id: z.string().describe('ID of the message to check read receipts for'),
    },
    outputSchema: {
      readers: z.array(z.object({}).passthrough()).describe('Array of reader objects with agent name and read timestamp'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ message_id }) => {
    const client = getAgentClient();
    const readers = await client.readers(message_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(readers, null, 2) }],
      structuredContent: { readers: readers as unknown as Record<string, unknown>[] },
    };
  });

  server.registerTool('message.file.upload', {
    title: 'Upload File',
    description: 'Upload a file to the workspace and get a file ID to pass as `attachments` to message.post, message.dm.send or message.dm.send_group. '
      + (localFiles ? 'Pass `path` to upload a local file, or ' : 'Pass ')
      + '`content_base64` with `filename` to upload inline bytes; the tool stores the bytes and completes the upload, so the returned `id` is ready to attach. '
      + 'With only `filename`, `content_type` and `size_bytes` it returns a signed `upload_url`: PUT the bytes there, then call message.file.complete before attaching.',
    inputSchema: {
      ...(localFiles
        ? { path: z.string().optional().describe('Absolute or relative path of a local file to upload (e.g. a screenshot)') }
        : {}),
      content_base64: z.string().optional().describe('The file bytes, base64-encoded'),
      filename: z.string().optional().describe('Name of the file including extension (e.g. "report.pdf", "screenshot.png"); defaults to the basename of `path`'),
      content_type: z.string().optional().describe('MIME type (e.g. "image/png"); guessed from the file name when omitted'),
      size_bytes: z.number().optional().describe('Size in bytes; only needed when requesting an upload URL without bytes'),
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args) => {
    const { content_base64, filename, content_type, size_bytes, as: asIdentity } = args;
    const filePath = localFiles ? (args as { path?: string }).path : undefined;
    const client = getAgentClient(undefined, asIdentity);

    let result: Record<string, unknown>;
    if (filePath !== undefined || content_base64 !== undefined) {
      let bytes: Uint8Array;
      let name: string;
      if (filePath !== undefined) {
        const info = await stat(filePath).catch(() => undefined);
        if (!info?.isFile()) throw new Error(`Cannot upload ${filePath}: not a readable file.`);
        if (info.size > MAX_FILE_BYTES) {
          throw new Error(`Cannot upload ${filePath}: ${info.size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit.`);
        }
        bytes = await readFile(filePath);
        name = filename ?? path.basename(filePath);
      } else {
        if (!filename) throw new Error('filename is required with content_base64.');
        bytes = Buffer.from(content_base64!, 'base64');
        name = filename;
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error(`Cannot upload ${name}: ${bytes.byteLength} bytes exceeds the ${MAX_FILE_BYTES}-byte limit.`);
        }
      }
      if (bytes.byteLength === 0) throw new Error(`Cannot upload ${name}: the file is empty.`);
      const stored = await storeFile(client, {
        filename: name,
        contentType: content_type ?? contentTypeFor(name),
        bytes,
      });
      result = { ...stored, status: 'complete' };
    } else {
      if (!filename || !content_type || size_bytes === undefined) {
        throw new Error(
          localFiles
            ? 'Pass `path`, or `content_base64` with `filename`, or all of `filename`, `content_type` and `size_bytes`.'
            : 'Pass `content_base64` with `filename`, or all of `filename`, `content_type` and `size_bytes`.',
        );
      }
      const upload = await client.files.upload({ filename, contentType: content_type, sizeBytes: size_bytes });
      result = {
        ...upload,
        next_step: 'PUT the file bytes to uploadUrl, then call message.file.complete with this id before attaching it.',
      };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  });

  server.registerTool('message.file.complete', {
    title: 'Complete File Upload',
    description: 'Mark an upload complete after its bytes were PUT to the upload URL. Only completed files can be attached to messages.',
    inputSchema: {
      file_id: z.string().describe('ID returned by message.file.upload'),
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ file_id, as: asIdentity }) => {
    const completed = await getAgentClient(undefined, asIdentity).files.complete(file_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(completed, null, 2) }],
      structuredContent: completed as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('message.file.get', {
    title: 'Get File',
    description: 'Get a file attached to a message: its name, type, size and a short-lived download URL for the bytes.',
    inputSchema: {
      file_id: z.string().describe('The file_id from a message attachment'),
      ...identityOverrideInputShape,
    },
    outputSchema: jsonResult,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ file_id, as: asIdentity }) => {
    const file = await getAgentClient(undefined, asIdentity).files.get(file_id);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(file, null, 2) }],
      structuredContent: file as unknown as Record<string, unknown>,
    };
  });

  if (localFiles) {
    server.registerTool('message.file.download', {
      title: 'Download File',
      description: 'Download a message attachment to a local file and return its path, so it can be opened (for example, read an attached screenshot).',
      inputSchema: {
        file_id: z.string().describe('The file_id from a message attachment'),
        path: z.string().optional().describe('Output file or existing directory (default: .agent-relay/attachments/<file_id>/ in the working directory)'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ file_id, path: out, as: asIdentity }) => {
      const file = await getAgentClient(undefined, asIdentity).files.get(file_id);
      if (file.status !== 'complete' || !file.downloadUrl) {
        throw new Error(`File ${file_id} has no completed upload to download.`);
      }
      if (file.sizeBytes > MAX_FILE_BYTES) {
        throw new Error(`File ${file_id} is ${file.sizeBytes} bytes, over the ${MAX_FILE_BYTES}-byte download limit.`);
      }
      const res = await fetch(file.downloadUrl);
      if (!res.ok) {
        throw new Error(`Downloading file ${file_id} failed with HTTP ${res.status} at ${new URL(file.downloadUrl).origin}.`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = safeFilename(file.filename);
      let target: string;
      if (!out) {
        target = path.resolve('.agent-relay', 'attachments', safeFilename(file_id), name);
      } else {
        const outInfo = await stat(out).catch(() => undefined);
        target = path.resolve(outInfo?.isDirectory() ? path.join(out, name) : out);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      const result = {
        id: file.id,
        filename: file.filename,
        content_type: file.contentType,
        size_bytes: bytes.byteLength,
        path: target,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    });
  }
}

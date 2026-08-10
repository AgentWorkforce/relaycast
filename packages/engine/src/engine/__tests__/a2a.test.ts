import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A2aJsonRpcRequest, A2aJsonRpcResponse, A2aTaskState } from '@relaycast/a2a';
import {
  getWorkspaceAgentCard,
  jsonRpcError,
  jsonRpcSuccess,
  mapRelayTaskState,
  mapTaskState,
  translateA2aToRelay,
  translateRelayToA2a,
  type RelayDM,
} from '../a2a.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from '../../__tests__/conformance/harness.js';

describe('translateRelayToA2a', () => {
  it('wraps a plain text DM in a message/send JSON-RPC request', () => {
    const dm: RelayDM = {
      id: 'dm-1',
      agent_id: 'agent-1',
      agent_name: 'alice',
      text: 'hello world',
      thread_id: 'thread-42',
    };

    const req = translateRelayToA2a(dm);

    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toBe('dm-1');
    expect(req.method).toBe('message/send');
    expect(req.params?.message).toEqual({
      message_id: 'dm-1',
      role: 'user',
      context_id: 'thread-42',
      parts: [{ kind: 'text', text: 'hello world' }],
    });
  });

  it('maps a null thread_id to an undefined context_id (not null)', () => {
    const dm: RelayDM = {
      id: 'dm-2',
      agent_id: 'a',
      agent_name: 'a',
      text: 'no thread',
      thread_id: null,
    };

    const req = translateRelayToA2a(dm);

    // A null relay thread_id must collapse to an undefined context_id, never null.
    expect(req.params?.message?.context_id).toBeUndefined();
    expect(req.params?.message?.context_id).not.toBeNull();
  });

  it('appends a file part per attachment after the text part', () => {
    const dm: RelayDM = {
      id: 'dm-3',
      agent_id: 'a',
      agent_name: 'a',
      text: 'see attached',
      attachments: [
        { file_id: 'file-abc', filename: 'report.txt', content_type: 'text/plain', size_bytes: 42 },
        { file_id: 'file-def', filename: 'image.png', content_type: 'image/png', size_bytes: 1024 },
      ],
    };

    const req = translateRelayToA2a(dm);
    const parts = req.params!.message!.parts;

    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ kind: 'text', text: 'see attached' });
    expect(parts[1]).toEqual({
      kind: 'file',
      file: { name: 'report.txt', mime_type: 'text/plain', uri: 'file-abc', bytes: 42 },
    });
    expect(parts[2]).toEqual({
      kind: 'file',
      file: { name: 'image.png', mime_type: 'image/png', uri: 'file-def', bytes: 1024 },
    });
  });

  it('still emits a text part when there are no attachments', () => {
    const req = translateRelayToA2a({
      id: 'dm-4',
      agent_id: 'a',
      agent_name: 'a',
      text: 'plain',
    });
    expect(req.params!.message!.parts).toEqual([{ kind: 'text', text: 'plain' }]);
  });

  it('throws when the relay DM is missing required fields', () => {
    // `text` is required by the RelayDM schema; a bad payload must be rejected.
    expect(() => translateRelayToA2a({ id: 'x', agent_id: 'a', agent_name: 'a' } as unknown as RelayDM)).toThrow();
  });
});

describe('translateA2aToRelay - request path', () => {
  it('extracts text, context and attachments from a request message', () => {
    const req: A2aJsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'message/send',
      params: {
        message: {
          message_id: 'msg-1',
          role: 'user',
          context_id: 'ctx-1',
          parts: [
            { kind: 'text', text: 'inbound text' },
            { kind: 'file', file: { name: 'a.pdf', mime_type: 'application/pdf', uri: 'uri-1', bytes: 9 } },
          ],
        },
      },
    };

    const dm = translateA2aToRelay(req);

    expect(dm.id).toBe('req-1');
    expect(dm.agent_id).toBe('external');
    expect(dm.agent_name).toBe('external');
    expect(dm.thread_id).toBe('ctx-1');
    // text combines the text part and a [file] marker for the file part.
    expect(dm.text).toBe('inbound text\n[file] a.pdf');
    expect(dm.attachments).toEqual([
      { file_id: 'uri-1', filename: 'a.pdf', content_type: 'application/pdf', size_bytes: 9 },
    ]);
  });

  it('falls back to message_id when the request has no top-level id', () => {
    const req: A2aJsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: { message_id: 'msg-only', role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
      },
    };
    expect(translateA2aToRelay(req).id).toBe('msg-only');
  });

  it('extracts a file attachment from a data part carrying file metadata', () => {
    const req: A2aJsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'req-2',
      method: 'message/send',
      params: {
        message: {
          message_id: 'm',
          role: 'user',
          parts: [
            {
              kind: 'data',
              data: { file_id: 'df-1', filename: 'doc.csv', content_type: 'text/csv', size_bytes: 7 },
            },
          ],
        },
      },
    };

    const dm = translateA2aToRelay(req);

    expect(dm.attachments).toEqual([
      { file_id: 'df-1', filename: 'doc.csv', content_type: 'text/csv', size_bytes: 7 },
    ]);
    // A data part's text projection is the JSON serialization of its data.
    expect(dm.text).toBe(
      JSON.stringify({ file_id: 'df-1', filename: 'doc.csv', content_type: 'text/csv', size_bytes: 7 }),
    );
  });

  it('defaults content_type/size for a data part with only file_id + filename', () => {
    const req: A2aJsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'req-3',
      method: 'message/send',
      params: {
        message: {
          message_id: 'm',
          role: 'user',
          parts: [{ kind: 'data', data: { file_id: 'df-2', filename: 'bare.bin' } }],
        },
      },
    };

    expect(translateA2aToRelay(req).attachments).toEqual([
      { file_id: 'df-2', filename: 'bare.bin', content_type: 'application/octet-stream', size_bytes: 0 },
    ]);
  });

  it('ignores a data part without file metadata for attachments', () => {
    const req: A2aJsonRpcRequest = {
      jsonrpc: '2.0',
      id: 'req-4',
      method: 'message/send',
      params: {
        message: {
          message_id: 'm',
          role: 'user',
          parts: [{ kind: 'data', data: { foo: 'bar' } }],
        },
      },
    };

    const dm = translateA2aToRelay(req);
    expect(dm.attachments).toEqual([]);
    expect(dm.text).toBe(JSON.stringify({ foo: 'bar' }));
  });
});

describe('translateA2aToRelay - response path', () => {
  it('reads text and context from result.message', () => {
    const resp: A2aJsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'resp-1',
      result: {
        message: {
          message_id: 'rm-1',
          role: 'agent',
          context_id: 'rctx-1',
          parts: [{ kind: 'text', text: 'hello back' }],
        },
      },
    };

    const dm = translateA2aToRelay(resp);

    expect(dm.id).toBe('resp-1');
    expect(dm.agent_id).toBe('external');
    expect(dm.text).toBe('hello back');
    expect(dm.thread_id).toBe('rctx-1');
    expect(dm.attachments).toEqual([]);
  });

  it('falls back to task artifacts when there is no result.message', () => {
    const resp: A2aJsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'resp-2',
      result: {
        task: {
          id: 'task-9',
          context_id: 'task-ctx',
          status: { state: 'completed' },
          artifacts: [{ name: 'out', parts: [{ kind: 'text', text: 'artifact body' }] }],
        },
      },
    };

    const dm = translateA2aToRelay(resp);

    expect(dm.id).toBe('resp-2');
    expect(dm.agent_id).toBe('task-9');
    expect(dm.text).toBe('artifact body');
    expect(dm.thread_id).toBe('task-ctx');
  });

  it('falls back to the last history message when no message/artifacts are present', () => {
    const resp: A2aJsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'resp-3',
      result: {
        task: {
          id: 'task-h',
          status: { state: 'working' },
          history: [
            { message_id: 'h1', role: 'user', parts: [{ kind: 'text', text: 'first' }] },
            { message_id: 'h2', role: 'agent', context_id: 'hctx', parts: [{ kind: 'text', text: 'latest' }] },
          ],
        },
      },
    };

    const dm = translateA2aToRelay(resp);

    expect(dm.text).toBe('latest');
    expect(dm.thread_id).toBe('hctx');
  });

  it('falls back to task.status.message when no parts are available', () => {
    const resp: A2aJsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'resp-4',
      result: {
        task: {
          id: 'task-s',
          status: { state: 'working', message: 'still churning' },
        },
      },
    };

    const dm = translateA2aToRelay(resp);

    expect(dm.text).toBe('still churning');
    expect(dm.thread_id).toBeNull();
    expect(dm.agent_id).toBe('task-s');
  });

  it('swallows a JSON-RPC error response and emits a blank DM with a generated id', () => {
    // Documents CURRENT behavior: an error response (error set, no result) is not
    // propagated. With no result there is no task/message/parts, so the error detail
    // is dropped and the DM collapses to empty text with defaulted envelope fields.
    // Omitting the top-level id exercises the randomUuid() fallback for dm.id.
    const resp: A2aJsonRpcResponse = {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'upstream exploded', data: { detail: 'boom' } },
    };

    const dm = translateA2aToRelay(resp);

    // The error is swallowed: no error text leaks into the DM.
    expect(dm.text).toBe('');
    // With no id on the response, dm.id is a freshly generated UUID (not a fixed value).
    expect(dm.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(dm.agent_id).toBe('external');
    expect(dm.agent_name).toBe('external');
    expect(dm.thread_id).toBeNull();
    expect(dm.attachments).toEqual([]);
  });
});

describe('translateRelayToA2a <-> translateA2aToRelay round-trip', () => {
  it('preserves id, thread, and attachment metadata through a full round-trip', () => {
    const dm: RelayDM = {
      id: 'rt-1',
      agent_id: 'a1',
      agent_name: 'alice',
      text: 'round trip',
      thread_id: 'rt-thread',
      attachments: [{ file_id: 'f-1', filename: 'note.md', content_type: 'text/markdown', size_bytes: 11 }],
      metadata: {
        'com.agentrelay.ratify': {
          version: 1,
          kind: 'proof_bundle',
          correlation_id: 'rt-1',
          bundle: '{"agent_id":"alice"}',
        },
      },
    };

    const back = translateA2aToRelay(translateRelayToA2a(dm));

    expect(back.id).toBe('rt-1');
    expect(back.thread_id).toBe('rt-thread');
    expect(back.attachments).toEqual([
      { file_id: 'f-1', filename: 'note.md', content_type: 'text/markdown', size_bytes: 11 },
    ]);
    expect(back.metadata).toEqual(dm.metadata);
    // The text gains a [file] marker line for the recovered file part.
    expect(back.text).toBe('round trip\n[file] note.md');
  });
});

describe('mapTaskState', () => {
  it('maps every A2A task state to its relay equivalent', () => {
    expect(mapTaskState('submitted')).toBe('queued');
    expect(mapTaskState('working')).toBe('in_progress');
    expect(mapTaskState('input-required')).toBe('waiting');
    expect(mapTaskState('completed')).toBe('completed');
    expect(mapTaskState('failed')).toBe('failed');
    expect(mapTaskState('canceled')).toBe('canceled');
    expect(mapTaskState('unknown')).toBe('unknown');
  });

  it('falls back to "unknown" for an unrecognized state', () => {
    expect(mapTaskState('not-a-real-state' as A2aTaskState)).toBe('unknown');
  });
});

describe('mapRelayTaskState', () => {
  it('maps relay states to A2A task states', () => {
    expect(mapRelayTaskState('queued')).toBe('submitted');
    expect(mapRelayTaskState('in_progress')).toBe('working');
    expect(mapRelayTaskState('online')).toBe('working');
    expect(mapRelayTaskState('waiting')).toBe('input-required');
    expect(mapRelayTaskState('completed')).toBe('completed');
    expect(mapRelayTaskState('failed')).toBe('failed');
    expect(mapRelayTaskState('canceled')).toBe('canceled');
  });

  it('falls back to "unknown" for null, undefined, or unrecognized states', () => {
    expect(mapRelayTaskState(null)).toBe('unknown');
    expect(mapRelayTaskState(undefined)).toBe('unknown');
    expect(mapRelayTaskState('something-else')).toBe('unknown');
  });
});

describe('jsonRpcSuccess', () => {
  it('builds a JSON-RPC 2.0 success envelope and propagates the id', () => {
    const res = jsonRpcSuccess('id-1', { ok: true });
    expect(res).toEqual({ jsonrpc: '2.0', id: 'id-1', result: { ok: true } });
    expect(res.error).toBeUndefined();
  });

  it('propagates numeric and undefined ids', () => {
    expect(jsonRpcSuccess(7, { a: 1 }).id).toBe(7);
    expect(jsonRpcSuccess(undefined, {}).id).toBeUndefined();
  });
});

describe('jsonRpcError', () => {
  it('builds an error envelope with code and message and no data key when data is omitted', () => {
    const res = jsonRpcError('id-2', -32600, 'Invalid Request');
    expect(res).toEqual({ jsonrpc: '2.0', id: 'id-2', error: { code: -32600, message: 'Invalid Request' } });
    expect(res.result).toBeUndefined();
    expect('data' in (res.error as object)).toBe(false);
  });

  it('includes a data field when provided', () => {
    const res = jsonRpcError(3, -32000, 'Server error', { detail: 'boom' });
    expect(res.error).toEqual({ code: -32000, message: 'Server error', data: { detail: 'boom' } });
    expect(res.id).toBe(3);
  });

  it('includes data even when it is falsy (null) since only undefined is treated as absent', () => {
    const res = jsonRpcError('id-4', 1, 'msg', null);
    expect(res.error).toEqual({ code: 1, message: 'msg', data: null });
    expect('data' in (res.error as object)).toBe(true);
  });
});

describe('getWorkspaceAgentCard', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  it('assembles a card whose skills mirror the workspace agents', async () => {
    const ws = await createWorkspace(stack.app, 'card-ws');
    await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const card = await getWorkspaceAgentCard(
      stack.runtime.deps.db,
      ws.workspaceId,
      'Card Workspace',
      'https://relay.example',
    );

    expect(card.name).toBe('Card Workspace');
    expect(card.description).toBe('Relaycast workspace card for Card Workspace');
    expect(card.url).toBe('https://relay.example/a2a/rpc');
    expect(card.version).toBe('1.0.0');
    expect(card.default_input_modes).toEqual(['text/plain', 'application/json']);
    expect(card.default_output_modes).toEqual(['text/plain', 'application/json']);
    expect(card.documentation_url).toBe('https://github.com/AgentWorkforce/relaycast');
    expect(card.capabilities).toEqual({
      methods: ['message/send', 'message/stream', 'task/get', 'task/cancel'],
      extensions: {
        'com.agentrelay.ratify': {
          versions: [1],
          kinds: ['proof_bundle', 'revocation_list'],
          max_proof_bundle_bytes: 131072,
        },
      },
    });
    expect(card.provider).toEqual({
      organization: 'Relaycast',
      workspace_id: ws.workspaceId,
      workspace_name: 'Card Workspace',
    });

    const skillIds = card.skills.map((s) => s.id).sort();
    expect(skillIds).toEqual(['alice', 'bob']);
    const alice = card.skills.find((s) => s.id === 'alice');
    expect(alice).toMatchObject({ id: 'alice', name: 'alice', tags: ['relaycast', 'agent'] });
  });

  it('emits a single fallback skill when the workspace has no agents', async () => {
    const ws = await createWorkspace(stack.app, 'empty-ws');

    const card = await getWorkspaceAgentCard(
      stack.runtime.deps.db,
      ws.workspaceId,
      'Empty Workspace',
      'https://relay.example',
    );

    expect(card.skills).toEqual([
      {
        id: 'Empty Workspace',
        name: 'Empty Workspace',
        description: 'Relaycast workspace Empty Workspace',
        tags: ['relaycast', 'workspace'],
      },
    ]);
  });
});

describe('workspace agent-card discovery', () => {
  let stack: TestStack;

  beforeEach(() => {
    stack = makeNodeStack();
  });

  afterEach(() => stack.close());

  it('serves the standard bare well-known path for a sole self-hosted workspace', async () => {
    const ws = await createWorkspace(stack.app, 'borealis');
    await registerAgent(stack.app, ws.workspaceKey, 'worker');

    const response = await stack.app.request(
      'https://relay.borealis.example/.well-known/agent-card.json',
    );

    expect(response.status).toBe(200);
    const card = await response.json() as { provider?: Record<string, unknown> };
    expect(card.provider).toMatchObject({
      workspace_id: ws.workspaceId,
      workspace_name: 'borealis',
    });
  });

  it('keeps a valid hosted workspace subdomain authoritative', async () => {
    const selected = await createWorkspace(stack.app, 'northwind');
    await createWorkspace(stack.app, 'borealis');

    const response = await stack.app.request(
      'https://northwind.cast.example/.well-known/agent-card.json',
    );

    expect(response.status).toBe(200);
    const card = await response.json() as { provider?: Record<string, unknown> };
    expect(card.provider).toMatchObject({
      workspace_id: selected.workspaceId,
      workspace_name: 'northwind',
    });
  });

  it('makes an explicit path workspace beat host inference on a multi-label authority', async () => {
    const selected = await createWorkspace(stack.app, 'borealis');
    await createWorkspace(stack.app, 'cast');

    const response = await stack.app.request(
      'https://cast.agentrelay.com/borealis/.well-known/agent-card.json',
    );

    expect(response.status).toBe(200);
    const card = await response.json() as { provider?: Record<string, unknown> };
    expect(card.provider).toMatchObject({
      workspace_id: selected.workspaceId,
      workspace_name: 'borealis',
    });
  });

  it('does not replace an invalid path workspace with a valid host workspace', async () => {
    await createWorkspace(stack.app, 'cast');

    const response = await stack.app.request(
      'https://cast.agentrelay.com/misspelled/.well-known/agent-card.json',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'workspace_not_found' },
    });
  });

  it('fails closed on a bare multi-tenant deployment instead of selecting a workspace', async () => {
    await createWorkspace(stack.app, 'northwind');
    await createWorkspace(stack.app, 'borealis');

    const response = await stack.app.request(
      'https://cast.agentrelay.com/.well-known/agent-card.json',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'workspace_not_found' },
    });
  });

  it('serves the sole workspace even when an unresolved host label was inferred', async () => {
    // Host-label inference is a hosted convention, not caller intent, so a
    // label that names no workspace does not suppress the single-tenant
    // fallback — otherwise a self-host could never answer the standard path,
    // since a conformant authority always yields some first label. The row cap
    // is the boundary: the multi-tenant case above 404s on this same request.
    await createWorkspace(stack.app, 'ratify-protocol');

    const response = await stack.app.request(
      'https://relay.ratifyprotocol.com/.well-known/agent-card.json',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: 'ratify-protocol' });
  });

  it('does not hide an invalid explicit workspace selector behind the sole-workspace fallback', async () => {
    await createWorkspace(stack.app, 'borealis');

    const response = await stack.app.request(
      'https://relay.borealis.example/.well-known/agent-card.json?workspace=misspelled',
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'workspace_not_found' },
    });
  });
});

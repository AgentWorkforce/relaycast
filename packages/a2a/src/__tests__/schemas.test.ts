import { describe, it, expect } from 'vitest';
import {
  A2aSkillSchema,
  A2aAgentCardSchema,
  A2aFilePartSchema,
  A2aDataPartSchema,
  A2aTextPartSchema,
  A2aPartSchema,
  A2aMessageSchema,
  A2aArtifactSchema,
  A2aTaskStateSchema,
  A2aTaskSchema,
  JsonRpcRequestSchema,
  JsonRpcErrorSchema,
  JsonRpcResponseSchema,
  A2aResponseSchema,
} from '../index.js';

// Helper: does any validation issue point at the given (possibly nested) path?
// Pass a single key to match a top-level field, or multiple keys to pin an
// exact nested path (e.g. 'file', 'bytes' or 'skills', 0, 'name'). Every path
// segment must match in order, so a nested assertion no longer passes merely
// because some unrelated issue exists under the same top-level key.
function hasIssueAtPath(
  result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } },
  ...path: PropertyKey[]
): boolean {
  if (result.success || !result.error) return false;
  return result.error.issues.some((issue) => {
    if (issue.path.length < path.length) return false;
    return path.every((key, i) => issue.path[i] === key);
  });
}

describe('A2aSkillSchema', () => {
  it('accepts a minimal skill (name only)', () => {
    expect(A2aSkillSchema.safeParse({ name: 'search' }).success).toBe(true);
  });

  it('accepts a full skill', () => {
    expect(
      A2aSkillSchema.safeParse({
        id: 'skill-1',
        name: 'search',
        description: 'searches things',
        tags: ['web', 'index'],
      }).success,
    ).toBe(true);
  });

  it('rejects a missing name', () => {
    const result = A2aSkillSchema.safeParse({ description: 'no name' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'name')).toBe(true);
  });

  it('rejects an empty name (min(1))', () => {
    const result = A2aSkillSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'name')).toBe(true);
  });

  it('rejects an empty id (min(1)) when present', () => {
    const result = A2aSkillSchema.safeParse({ name: 'ok', id: '' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'id')).toBe(true);
  });
});

describe('A2aAgentCardSchema', () => {
  const minimalCard = {
    name: 'My Agent',
    url: 'https://agent.example.com',
    version: '1.0.0',
    skills: [{ name: 'search' }],
  };

  it('accepts a minimal valid agent card', () => {
    expect(A2aAgentCardSchema.safeParse(minimalCard).success).toBe(true);
  });

  it('accepts a full valid agent card', () => {
    const result = A2aAgentCardSchema.safeParse({
      ...minimalCard,
      description: 'does stuff',
      provider: { organization: 'acme' },
      capabilities: { streaming: true },
      default_input_modes: ['text'],
      default_output_modes: ['text', 'file'],
      documentation_url: 'https://docs.example.com',
      skills: [
        { id: 's1', name: 'search', description: 'd', tags: ['a'] },
        { name: 'summarize' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects when required name is missing', () => {
    const { name, ...rest } = minimalCard;
    void name;
    const result = A2aAgentCardSchema.safeParse(rest);
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'name')).toBe(true);
  });

  it('rejects an empty name (min(1))', () => {
    const result = A2aAgentCardSchema.safeParse({ ...minimalCard, name: '' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'name')).toBe(true);
  });

  it('rejects an empty version (min(1))', () => {
    const result = A2aAgentCardSchema.safeParse({ ...minimalCard, version: '' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'version')).toBe(true);
  });

  it('rejects a non-URL url field', () => {
    const result = A2aAgentCardSchema.safeParse({ ...minimalCard, url: 'not-a-url' });
    expect(result.success).toBe(false);
    // The failure must be about `url`, not some unrelated field.
    expect(hasIssueAtPath(result, 'url')).toBe(true);
  });

  it('rejects an invalid documentation_url when present', () => {
    const result = A2aAgentCardSchema.safeParse({
      ...minimalCard,
      documentation_url: 'nope',
    });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'documentation_url')).toBe(true);
  });

  it('rejects an empty skills array (min(1))', () => {
    const result = A2aAgentCardSchema.safeParse({ ...minimalCard, skills: [] });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'skills')).toBe(true);
  });

  it('rejects a skill with an empty name inside skills[]', () => {
    const result = A2aAgentCardSchema.safeParse({
      ...minimalCard,
      skills: [{ name: '' }],
    });
    expect(result.success).toBe(false);
    // Issue path should descend into the skills array element's name.
    expect(hasIssueAtPath(result, 'skills', 0, 'name')).toBe(true);
  });
});

describe('individual part schemas', () => {
  it('A2aTextPartSchema accepts a text part', () => {
    expect(A2aTextPartSchema.safeParse({ kind: 'text', text: 'hello' }).success).toBe(true);
  });

  it('A2aTextPartSchema rejects a missing text field', () => {
    const result = A2aTextPartSchema.safeParse({ kind: 'text' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'text')).toBe(true);
  });

  it('A2aFilePartSchema accepts a minimal file part', () => {
    expect(A2aFilePartSchema.safeParse({ kind: 'file', file: { name: 'f.txt' } }).success).toBe(
      true,
    );
  });

  it('A2aFilePartSchema accepts a full file part', () => {
    expect(
      A2aFilePartSchema.safeParse({
        kind: 'file',
        file: { name: 'f.txt', mime_type: 'text/plain', uri: 's3://x', bytes: 12 },
      }).success,
    ).toBe(true);
  });

  it('A2aFilePartSchema rejects a file with an empty name', () => {
    const result = A2aFilePartSchema.safeParse({ kind: 'file', file: { name: '' } });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'file', 'name')).toBe(true);
  });

  it('A2aFilePartSchema rejects negative or non-integer bytes', () => {
    const negative = A2aFilePartSchema.safeParse({ kind: 'file', file: { name: 'f', bytes: -1 } });
    expect(negative.success).toBe(false);
    expect(hasIssueAtPath(negative, 'file', 'bytes')).toBe(true);
    const fractional = A2aFilePartSchema.safeParse({ kind: 'file', file: { name: 'f', bytes: 1.5 } });
    expect(fractional.success).toBe(false);
    expect(hasIssueAtPath(fractional, 'file', 'bytes')).toBe(true);
  });

  it('A2aDataPartSchema accepts a data part', () => {
    expect(A2aDataPartSchema.safeParse({ kind: 'data', data: { a: 1, b: 'x' } }).success).toBe(
      true,
    );
  });

  it('A2aDataPartSchema rejects a missing data field', () => {
    const result = A2aDataPartSchema.safeParse({ kind: 'data' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'data')).toBe(true);
  });
});

describe('A2aPartSchema (discriminated union on kind)', () => {
  it('accepts each valid kind', () => {
    expect(A2aPartSchema.safeParse({ kind: 'text', text: 'hi' }).success).toBe(true);
    expect(A2aPartSchema.safeParse({ kind: 'file', file: { name: 'f' } }).success).toBe(true);
    expect(A2aPartSchema.safeParse({ kind: 'data', data: { k: 'v' } }).success).toBe(true);
  });

  it('rejects an unknown discriminator value', () => {
    const result = A2aPartSchema.safeParse({ kind: 'image', url: 'https://x' });
    expect(result.success).toBe(false);
    // A widened union (e.g. accepting arbitrary kinds) would regress this.
    expect(hasIssueAtPath(result, 'kind')).toBe(true);
  });

  it('rejects a missing discriminator', () => {
    const result = A2aPartSchema.safeParse({ text: 'orphan' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'kind')).toBe(true);
  });

  it('narrows to the text branch: a text part with a data-part shape fails', () => {
    // kind:'text' selects the text schema, which requires `text`; the stray
    // `data` field does not satisfy it. Proves the union narrows by discriminator.
    const result = A2aPartSchema.safeParse({ kind: 'text', data: { k: 'v' } });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'text')).toBe(true);
  });

  it('narrows to the file branch: a file part missing `file` fails', () => {
    const result = A2aPartSchema.safeParse({ kind: 'file', text: 'wrong' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'file')).toBe(true);
  });
});

describe('A2aMessageSchema', () => {
  it('accepts a minimal message and defaults role to "user"', () => {
    const result = A2aMessageSchema.safeParse({
      message_id: 'm1',
      parts: [{ kind: 'text', text: 'hi' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe('user');
    }
  });

  it('accepts an explicit valid role', () => {
    expect(
      A2aMessageSchema.safeParse({
        message_id: 'm1',
        role: 'agent',
        context_id: 'c1',
        parts: [{ kind: 'text', text: 'hi' }],
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown role', () => {
    const result = A2aMessageSchema.safeParse({
      message_id: 'm1',
      role: 'robot',
      parts: [{ kind: 'text', text: 'hi' }],
    });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'role')).toBe(true);
  });

  it('rejects an empty parts array (min(1))', () => {
    const result = A2aMessageSchema.safeParse({ message_id: 'm1', parts: [] });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'parts')).toBe(true);
  });

  it('rejects an invalid part inside parts[]', () => {
    const result = A2aMessageSchema.safeParse({
      message_id: 'm1',
      parts: [{ kind: 'bogus' }],
    });
    expect(result.success).toBe(false);
    // The invalid element is the first part, failing on its `kind` discriminator.
    expect(hasIssueAtPath(result, 'parts', 0, 'kind')).toBe(true);
  });
});

describe('A2aArtifactSchema', () => {
  it('accepts a valid artifact', () => {
    expect(
      A2aArtifactSchema.safeParse({
        name: 'out',
        description: 'd',
        parts: [{ kind: 'data', data: { k: 'v' } }],
      }).success,
    ).toBe(true);
  });

  it('rejects an empty parts array (min(1))', () => {
    const result = A2aArtifactSchema.safeParse({ name: 'out', parts: [] });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'parts')).toBe(true);
  });
});

describe('A2aTaskStateSchema (enum)', () => {
  it('accepts every valid state', () => {
    for (const state of [
      'submitted',
      'working',
      'input-required',
      'completed',
      'failed',
      'canceled',
      'unknown',
    ]) {
      expect(A2aTaskStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects an out-of-enum state (would regress if the enum widened)', () => {
    const result = A2aTaskStateSchema.safeParse('in-progress');
    expect(result.success).toBe(false);
  });

  it('rejects a near-miss casing variant', () => {
    expect(A2aTaskStateSchema.safeParse('Completed').success).toBe(false);
  });
});

describe('A2aTaskSchema', () => {
  it('accepts a minimal valid task', () => {
    expect(
      A2aTaskSchema.safeParse({
        id: 't1',
        status: { state: 'working' },
      }).success,
    ).toBe(true);
  });

  it('accepts a full valid task', () => {
    const result = A2aTaskSchema.safeParse({
      id: 't1',
      context_id: 'c1',
      status: { state: 'completed', message: 'done' },
      artifacts: [{ name: 'out', parts: [{ kind: 'text', text: 'x' }] }],
      history: [{ message_id: 'm1', parts: [{ kind: 'text', text: 'hi' }] }],
      metadata: { foo: 'bar' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a task with an invalid status.state', () => {
    const result = A2aTaskSchema.safeParse({
      id: 't1',
      status: { state: 'not-a-state' },
    });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'status', 'state')).toBe(true);
  });

  it('rejects a task missing status', () => {
    const result = A2aTaskSchema.safeParse({ id: 't1' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'status')).toBe(true);
  });
});

describe('JsonRpcRequestSchema', () => {
  it('accepts a minimal valid request', () => {
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', method: 'message/send' }).success).toBe(
      true,
    );
  });

  it('accepts a request with id and structured params', () => {
    expect(
      JsonRpcRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: 7,
        method: 'message/send',
        params: { message: { message_id: 'm1', parts: [{ kind: 'text', text: 'hi' }] } },
      }).success,
    ).toBe(true);
  });

  it('retains unknown params keys via .passthrough()', () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      method: 'message/send',
      params: { message: { message_id: 'm1', parts: [{ kind: 'text', text: 'hi' }] }, blocking: true, extra: 42 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Extra keys must survive parsing rather than being stripped.
      expect(result.data.params).toMatchObject({ blocking: true, extra: 42 });
    }
  });

  it('rejects a wrong jsonrpc version literal', () => {
    const result = JsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', method: 'x' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'jsonrpc')).toBe(true);
  });

  it('rejects an empty method (min(1))', () => {
    const result = JsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', method: '' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'method')).toBe(true);
  });

  it('rejects an invalid params.message payload', () => {
    const result = JsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      method: 'x',
      params: { message: { message_id: 'm1', parts: [] } },
    });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'params', 'message', 'parts')).toBe(true);
  });
});

describe('JsonRpcErrorSchema', () => {
  it('accepts a valid error', () => {
    expect(JsonRpcErrorSchema.safeParse({ code: -32600, message: 'Invalid Request' }).success).toBe(
      true,
    );
  });

  it('accepts an error with data', () => {
    expect(
      JsonRpcErrorSchema.safeParse({ code: -32000, message: 'boom', data: { detail: 'x' } }).success,
    ).toBe(true);
  });

  it('rejects a non-numeric code', () => {
    const result = JsonRpcErrorSchema.safeParse({ code: 'oops', message: 'x' });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'code')).toBe(true);
  });

  it('rejects a missing message', () => {
    const result = JsonRpcErrorSchema.safeParse({ code: -1 });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'message')).toBe(true);
  });
});

describe('JsonRpcResponseSchema', () => {
  it('accepts a result response', () => {
    expect(
      JsonRpcResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        result: { task: { id: 't1', status: { state: 'completed' } } },
      }).success,
    ).toBe(true);
  });

  it('accepts an error response', () => {
    expect(
      JsonRpcResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      }).success,
    ).toBe(true);
  });

  it('retains unknown result keys via .passthrough()', () => {
    const result = JsonRpcResponseSchema.safeParse({
      jsonrpc: '2.0',
      result: { task: { id: 't1', status: { state: 'working' } }, cursor: 'abc' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.result).toMatchObject({ cursor: 'abc' });
    }
  });

  it('rejects a wrong jsonrpc version literal', () => {
    const result = JsonRpcResponseSchema.safeParse({ jsonrpc: '2', id: 1 });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'jsonrpc')).toBe(true);
  });

  it('rejects a malformed nested error', () => {
    const result = JsonRpcResponseSchema.safeParse({
      jsonrpc: '2.0',
      error: { code: -1 },
    });
    expect(result.success).toBe(false);
    // The nested error object is missing its required `message`.
    expect(hasIssueAtPath(result, 'error', 'message')).toBe(true);
  });
});

describe('A2aResponseSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(A2aResponseSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a task-bearing response', () => {
    expect(
      A2aResponseSchema.safeParse({
        task: { id: 't1', status: { state: 'submitted' } },
      }).success,
    ).toBe(true);
  });

  it('accepts a message-bearing response', () => {
    expect(
      A2aResponseSchema.safeParse({
        message: { message_id: 'm1', parts: [{ kind: 'text', text: 'hi' }] },
      }).success,
    ).toBe(true);
  });

  it('accepts a wrapped JSON-RPC response', () => {
    expect(
      A2aResponseSchema.safeParse({
        response: {
          jsonrpc: '2.0',
          id: 1,
          result: { message: { message_id: 'm1', parts: [{ kind: 'text', text: 'hi' }] } },
        },
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid nested task', () => {
    const result = A2aResponseSchema.safeParse({
      task: { id: 't1', status: { state: 'bogus' } },
    });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'task', 'status', 'state')).toBe(true);
  });

  it('rejects an invalid nested response envelope', () => {
    const result = A2aResponseSchema.safeParse({
      response: { jsonrpc: 'nope' },
    });
    expect(result.success).toBe(false);
    expect(hasIssueAtPath(result, 'response', 'jsonrpc')).toBe(true);
  });
});

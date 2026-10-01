import { describe, expectTypeOf, it } from 'vitest';
import type { WorkspaceBootstrapOptions } from '../relay.js';
import type { CreateWorkspaceOptions } from '../setup-types.js';
import type { JsonValue } from '../types.js';

describe('Workspace creation types', () => {
  it('workspace creation metadata accepts JSON values only', () => {
    expectTypeOf<WorkspaceBootstrapOptions['metadata']>()
      .toEqualTypeOf<Record<string, JsonValue> | undefined>();
    expectTypeOf<CreateWorkspaceOptions['metadata']>()
      .toEqualTypeOf<Record<string, JsonValue> | undefined>();
    expectTypeOf<{ value: undefined }>().not.toMatchTypeOf<Record<string, JsonValue>>();
    expectTypeOf<{ value: bigint }>().not.toMatchTypeOf<Record<string, JsonValue>>();
    expectTypeOf<{ value: null; nested: { list: [string, boolean, number] } }>()
      .toMatchTypeOf<Record<string, JsonValue>>();
  });

});

import { expectTypeOf, it } from 'vitest';
import { camelizeKeys, type Camelize } from '../casing.js';
import type {
  MessageBlock,
  PostMessageRequest,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  ThreadReplyEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
} from '../types.js';

it('keeps opaque block document keys in received types', () => {
  type Blocks = { kind: string; signed_value: { proof_id: string } }[];
  type Wire = { agent_id: string; message: { blocks: Blocks } };
  expectTypeOf<Camelize<Wire, true>>().toEqualTypeOf<{
    agentId: string;
    message: { blocks: Blocks };
  }>();
  const received = camelizeKeys(
    {
      agent_id: 'a1',
      message: { blocks: [{ kind: 'test', signed_value: { proof_id: 'p1' } }] },
    },
    { opaqueBlocks: true },
  );
  expectTypeOf(received.message.blocks[0]!.signed_value.proof_id).toEqualTypeOf<string>();
});

it('retains camelCase action fields in outgoing requests', () => {
  const blocks: MessageBlock[] = [
    {
      type: 'actions',
      elements: [{ type: 'button', text: 'Approve', actionId: 'approve' }],
    },
  ];
  const request: PostMessageRequest = { text: 'Review', mode: 'wait', blocks };
  expectTypeOf(request.blocks).toEqualTypeOf<MessageBlock[] | undefined>();
});

it('advertises realtime blocks as unvalidated wire data', () => {
  type RealtimeEvent =
    | MessageCreatedEvent
    | MessageUpdatedEvent
    | ThreadReplyEvent
    | DmReceivedEvent
    | GroupDmReceivedEvent;
  expectTypeOf<RealtimeEvent['message']['blocks']>().toEqualTypeOf<unknown[] | null | undefined>();
});

it('requires a runtime flag for opaque return types', () => {
  type Wire = { blocks: { signed_value: string }[] };
  const wire: Wire = { blocks: [{ signed_value: 'proof' }] };
  // @ts-expect-error Opaque mode cannot be selected by a second type argument alone.
  camelizeKeys<Wire, true>(wire);
  // @ts-expect-error Omitting the flag produces normal camelized block keys.
  const opaqueWithoutFlag: Camelize<Wire, true> = camelizeKeys(wire);
  // @ts-expect-error An empty options bag does not enable opaque mode.
  const opaqueWithEmptyOptions: Camelize<Wire, true> = camelizeKeys(wire, {});
  void opaqueWithoutFlag;
  void opaqueWithEmptyOptions;
  const opaqueBlocks: boolean = Math.random() > 0.5;
  const uncertain = camelizeKeys(wire, { opaqueBlocks });
  expectTypeOf(uncertain).toEqualTypeOf<Camelize<Wire> | Camelize<Wire, true>>();
  expectTypeOf(camelizeKeys(wire, { opaqueBlocks: false })).toEqualTypeOf<Camelize<Wire>>();
  expectTypeOf(camelizeKeys(wire, { opaqueBlocks: true })).toEqualTypeOf<Camelize<Wire, true>>();
});

import type { AgentClient } from '../agent.js';
import type {
  DmReceivedEvent,
  GroupDmReceivedEvent,
  InboxResponse,
  MessageCreatedEvent,
  MessageWithMeta,
  SendDmResponse,
  ThreadReplyEvent,
} from '../types.js';
import type { Message, MessageCallback, RelayLike } from './types.js';

function stampMessage(
  message: Pick<Message, 'id' | 'sender' | 'channel' | 'text' | 'threadId'>,
): Message {
  return {
    ...message,
    // Agent WS events do not currently include server-side created_at.
    createdAt: new Date().toISOString(),
  };
}

function fromChannelEvent(event: MessageCreatedEvent): Message {
  return stampMessage({
    id: event.message.id,
    sender: event.message.agentName,
    channel: event.channel,
    text: event.message.text,
    threadId: null,
  });
}

function fromThreadReplyEvent(event: ThreadReplyEvent): Message {
  return stampMessage({
    id: event.message.id,
    sender: event.message.agentName,
    channel: event.channel,
    text: event.message.text,
    threadId: event.parentId,
  });
}

function fromDmEvent(event: DmReceivedEvent | GroupDmReceivedEvent): Message {
  return stampMessage({
    id: event.message.id,
    sender: event.message.agentName,
    text: event.message.text,
    threadId: null,
  });
}

export class Relay implements RelayLike {
  public readonly agents: AgentClient;

  constructor(agent: AgentClient) {
    this.agents = agent;
  }

  post(channel: string, text: string): Promise<MessageWithMeta> {
    return this.agents.send(channel, text);
  }

  send(toAgent: string, text: string): Promise<SendDmResponse> {
    return this.agents.dm(toAgent, text);
  }

  reply(messageId: string, text: string): Promise<MessageWithMeta> {
    return this.agents.reply(messageId, text);
  }

  inbox(): Promise<InboxResponse> {
    return this.agents.inbox();
  }

  onMessage(cb: MessageCallback): () => void {
    this.agents.connect();

    const stopMessageCreated = this.agents.on.messageCreated((event) => {
      void cb(fromChannelEvent(event));
    });
    const stopThreadReply = this.agents.on.threadReply((event) => {
      void cb(fromThreadReplyEvent(event));
    });
    const stopDmReceived = this.agents.on.dmReceived((event) => {
      void cb(fromDmEvent(event));
    });
    const stopGroupDmReceived = this.agents.on.groupDmReceived((event) => {
      void cb(fromDmEvent(event));
    });

    return () => {
      stopGroupDmReceived();
      stopDmReceived();
      stopThreadReply();
      stopMessageCreated();
    };
  }
}

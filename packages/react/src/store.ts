import type { StoreState, RelayStore, Listener, ChannelMessages, ThreadData, ChannelDetail } from './types.js';

const DEFAULT_CHANNEL_MESSAGES: ChannelMessages = { messages: [], loading: false, error: null };
const DEFAULT_THREAD: ThreadData = { parent: null, replies: [], loading: false, error: null };
const DEFAULT_CHANNEL_DETAIL: ChannelDetail = { channel: null, members: [], loading: false, error: null };

function initialState(): StoreState {
  return {
    channelMessages: {},
    threads: {},
    channels: { data: [], loading: false, error: null },
    channelDetails: {},
    agents: { data: [], loading: false, error: null },
    inbox: { data: null, loading: false, error: null },
    dms: { data: [], loading: false, error: null },
    connectionStatus: 'disconnected',
  };
}

export function createStore(): RelayStore {
  let state = initialState();
  const listeners = new Set<Listener>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState() {
      return state;
    },

    setState(partial) {
      state = { ...state, ...partial };
      notify();
    },

    updateChannelMessages(channel, updater) {
      const prev = state.channelMessages[channel] ?? DEFAULT_CHANNEL_MESSAGES;
      state = {
        ...state,
        channelMessages: { ...state.channelMessages, [channel]: updater(prev) },
      };
      notify();
    },

    updateThread(messageId, updater) {
      const prev = state.threads[messageId] ?? DEFAULT_THREAD;
      state = {
        ...state,
        threads: { ...state.threads, [messageId]: updater(prev) },
      };
      notify();
    },

    updateChannelDetail(name, updater) {
      const prev = state.channelDetails[name] ?? DEFAULT_CHANNEL_DETAIL;
      state = {
        ...state,
        channelDetails: { ...state.channelDetails, [name]: updater(prev) },
      };
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

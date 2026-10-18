import { afterEach, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { BuzzSocket } from '../buzz-bridge/buzz-socket.js';

const servers: WebSocketServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

it('authenticates, receives a room event, and waits for publish acknowledgement', async () => {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `ws://127.0.0.1:${address.port}/`;
  const channel = 'c83154dd-49d3-4dc1-aede-fdb8130d7fbe';
  const key = generateSecretKey();
  const sender = generateSecretKey();
  const incoming = finalizeEvent({
    kind: 9, created_at: Math.floor(Date.now() / 1000), content: 'hello',
    tags: [['h', channel], ['p', getPublicKey(key)]],
  }, sender);
  let authorized = false;
  server.on('connection', (peer) => {
    peer.send(JSON.stringify(['AUTH', 'challenge']));
    peer.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as unknown[];
      if (frame[0] === 'AUTH') {
        const event = frame[1] as Event;
        expect(event.kind).toBe(22242);
        expect(event.tags).toContainEqual(['relay', url]);
        expect(event.tags).toContainEqual(['challenge', 'challenge']);
        authorized = true;
        peer.send(JSON.stringify(['OK', event.id, true, '']));
      }
      if (frame[0] === 'REQ' && authorized) {
        peer.send(JSON.stringify(['EVENT', 'relay-buzz-room', incoming]));
        peer.send(JSON.stringify(['EOSE', 'relay-buzz-room']));
      }
      if (frame[0] === 'EVENT') {
        peer.send(JSON.stringify(['OK', (frame[1] as Event).id, true, '']));
      }
    });
  });
  const abort = new AbortController();
  const socket = new BuzzSocket(url, channel, key, () => incoming.created_at, () => {});
  let received: Event | undefined;
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  let ready!: () => void;
  const done = new Promise<void>((resolve) => { ready = resolve; });
  const running = socket.run(abort.signal, async (event) => { received = event; delivered(); }, async () => { ready(); });
  try {
    await Promise.all([done, delivery]);
    expect(received?.id).toBe(incoming.id);
    const reply = finalizeEvent({ kind: 9, created_at: incoming.created_at, content: 'done', tags: [['h', channel]] }, key);
    await socket.publish(reply);
  } finally {
    abort.abort();
    socket.close();
    await running;
  }
});

#!/usr/bin/env npx tsx
/**
 * Hot-path latency and integrity check against a running gateway, for
 * comparing `RELAYCAST_ACTORS_TOPOLOGY=workspace` with `split` on the same
 * machine. It provisions a fresh workspace (producer agents, receiver agents
 * bound to nodes, one channel everyone joined), opens one `/v1/node/ws` per
 * node, then sends DMs and channel posts open-loop at `--rate` messages/s for
 * `--duration` seconds. Each stream (producer -> DM peer, producer ->
 * channel) has at most one send in flight, so per-stream order at the
 * receivers is meaningful. Receivers ack every 50 ms with `delivery.ack`.
 *
 * It reports POST latency per route, send-to-deliver latency, and, per
 * (stream, receiver): deliveries lost, duplicated (same delivery on one
 * socket twice) and reordered. Exit code 1 when any is non-zero.
 *
 *   npx tsx packages/actors-gateway/e2e/split-bench.ts --base http://127.0.0.1:8787 \
 *     [--rate 20] [--duration 30] [--producers 4] [--receivers 8] [--nodes 4] [--dm-share 0.5] [--label run] [--warmup true]
 */
import WebSocket from 'ws';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const BASE = args.get('base') ?? 'http://127.0.0.1:8787';
const RATE = Number(args.get('rate') ?? 20);
const DURATION_S = Number(args.get('duration') ?? 30);
const PRODUCERS = Number(args.get('producers') ?? 4);
const RECEIVERS = Number(args.get('receivers') ?? 8);
const NODES = Number(args.get('nodes') ?? 4);
const DM_SHARE = Number(args.get('dm-share') ?? 0.5);
const LABEL = args.get('label') ?? 'run';
/** Send one unmeasured message on every stream first, so actor activation (cold start) is not in the numbers. */
const WARMUP = args.get('warmup') === 'true';
const DRAIN_TIMEOUT_MS = 30_000;
const ACK_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => performance.timeOrigin + performance.now();

async function call(method: string, path: string, token: string | undefined, body?: unknown): Promise<{ status: number; json: any; ms: number }> {
  const started = now();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const ms = now() - started;
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, ms };
}

async function must(method: string, path: string, token: string | undefined, body?: unknown): Promise<any> {
  const result = await call(method, path, token, body);
  if (result.status >= 300) throw new Error(`${method} ${path}: HTTP ${result.status} ${JSON.stringify(result.json)}`);
  return result.json.data;
}

function percentiles(values: number[]): { n: number; p50: number; p95: number; p99: number; max: number; mean: number } {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (v: number) => Math.round(v * 10) / 10;
  return { n: values.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1)!), mean: round(values.reduce((a, b) => a + b, 0) / values.length) };
}

interface Receiver { name: string; id: string }
interface StreamState { key: string; kind: 'dm' | 'channel'; producer: { name: string; token: string }; target: string; seq: number; busy: boolean; queue: number[]; okSeqs: number[] }

async function main(): Promise<void> {
  // ---- provision -----------------------------------------------------------
  const ws = await must('POST', '/v1/workspaces', undefined, { name: `bench-${LABEL}-${Date.now()}` });
  const key: string = ws.api_key;
  const producers: { name: string; token: string }[] = [];
  for (let i = 0; i < PRODUCERS; i += 1) {
    const agent = await must('POST', '/v1/agents', key, { name: `p${i}` });
    producers.push({ name: `p${i}`, token: agent.token });
  }
  const receivers: Receiver[] = [];
  const receiverTokens: string[] = [];
  for (let i = 0; i < RECEIVERS; i += 1) {
    const agent = await must('POST', '/v1/agents', key, { name: `r${i}` });
    receivers.push({ name: `r${i}`, id: agent.id });
    receiverTokens.push(agent.token);
  }
  await must('POST', '/v1/channels', key, { name: 'bench' });
  for (const token of [...producers.map((p) => p.token), ...receiverTokens]) await must('POST', '/v1/channels/bench/join', token, {});
  const nodes: { name: string; id: string; token: string; agents: string[] }[] = [];
  for (let i = 0; i < NODES; i += 1) {
    const agents = receivers.filter((_, r) => r % NODES === i).map((r) => r.name);
    const node = await must('POST', '/v1/nodes', key, { name: `n${i}`, max_agents: Math.max(agents.length, 1) });
    for (const agent of agents) await must('POST', `/v1/nodes/n${i}/agents`, key, { agent_name: agent });
    nodes.push({ name: `n${i}`, id: node.id, token: node.token, agents });
  }

  // ---- receivers -------------------------------------------------------------
  const deliverLatency: number[] = [];
  const deliverLatencyByKind: Record<string, number[]> = { dm: [], channel: [] };
  const seen = new Map<string, { last: number; got: Set<number>; ooo: number; dups: number }>();
  const deliveryIds = new Set<string>();
  let frames = 0;
  let unmarked = 0;
  let socketDrops = 0;
  const sockets: WebSocket[] = [];
  const maxSeq = new Map<string, number>();
  const ackedSeq = new Map<string, number>();
  const socketOf = new Map<string, WebSocket>();

  await Promise.all(nodes.map((node) => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/v1/node/ws?token=${encodeURIComponent(node.token)}`);
    sockets.push(socket);
    for (const agent of node.agents) socketOf.set(agent, socket);
    socket.on('open', () => socket.send(JSON.stringify({ v: 1, id: 'reg', type: 'node.register', node_id: node.id, name: node.name, capabilities: [], max_agents: node.agents.length, tags: [], version: 'split-bench/1' })));
    socket.on('close', (code) => { socketDrops += 1; if (code !== 1000) console.error(`node ${node.name} socket closed ${code}`); });
    socket.on('error', reject);
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'reply' && frame.id === 'reg') { if (frame.ok) resolve(); else reject(new Error(JSON.stringify(frame))); return; }
      if (frame.type !== 'deliver') return;
      const at = now();
      frames += 1;
      if (frame.seq > (maxSeq.get(frame.agent) ?? 0)) maxSeq.set(frame.agent, frame.seq);
      const text: string = frame.payload?.data?.message?.text ?? frame.payload?.data?.text ?? '';
      const match = /^rcb\|([^|]+)\|([^|]+)\|(\d+)\|(\d+(?:\.\d+)?)$/.exec(text);
      if (!match) { unmarked += 1; return; }
      const [, kind, streamKey, seqText, sentText] = match;
      const latency = at - Number(sentText);
      deliverLatency.push(latency);
      deliverLatencyByKind[kind!]!.push(latency);
      const key = `${streamKey}|${frame.agent}`;
      let state = seen.get(key);
      if (!state) seen.set(key, (state = { last: 0, got: new Set(), ooo: 0, dups: 0 }));
      const seq = Number(seqText);
      if (deliveryIds.has(frame.delivery_id) || state.got.has(seq)) { state.dups += 1; return; }
      deliveryIds.add(frame.delivery_id);
      if (seq < state.last) state.ooo += 1;
      state.last = Math.max(state.last, seq);
      state.got.add(seq);
    });
  })));
  const acker = setInterval(() => {
    for (const [agent, seq] of maxSeq) {
      if (seq <= (ackedSeq.get(agent) ?? 0)) continue;
      socketOf.get(agent)?.send(JSON.stringify({ v: 1, type: 'delivery.ack', agent, up_to_seq: seq }));
      ackedSeq.set(agent, seq);
    }
  }, ACK_MS);
  // Inbox sockets attach right after node.register (split topology).
  await sleep(1_500);

  // ---- load ---------------------------------------------------------------
  const postLatency: Record<string, number[]> = { dm: [], channel: [] };
  const postLatencyCorrected: Record<string, number[]> = { dm: [], channel: [] };
  const statuses = new Map<string, number>();
  const topology = new Set<string>();
  const dmStreams: StreamState[] = producers.flatMap((producer) => receivers.map((receiver) => ({ key: `dm:${producer.name}>${receiver.name}`, kind: 'dm' as const, producer, target: receiver.name, seq: 0, busy: false, queue: [], okSeqs: [] })));
  const channelStreams: StreamState[] = producers.map((producer) => ({ key: `ch:${producer.name}>bench`, kind: 'channel' as const, producer, target: 'bench', seq: 0, busy: false, queue: [], okSeqs: [] }));
  let inflight = 0;

  const sendOn = async (stream: StreamState, intended: number): Promise<void> => {
    stream.busy = true;
    inflight += 1;
    const seq = ++stream.seq;
    const text = `rcb|${stream.kind}|${stream.key}|${seq}|${now()}`;
    const result = stream.kind === 'dm'
      ? await call('POST', '/v1/dm', stream.producer.token, { to: stream.target, text }).catch(() => ({ status: 0, json: null, ms: 0 }))
      : await call('POST', '/v1/channels/bench/messages', stream.producer.token, { text }).catch(() => ({ status: 0, json: null, ms: 0 }));
    postLatency[stream.kind]!.push(result.ms);
    postLatencyCorrected[stream.kind]!.push(now() - intended);
    statuses.set(`${stream.kind} ${result.status}`, (statuses.get(`${stream.kind} ${result.status}`) ?? 0) + 1);
    if (result.status === 201) stream.okSeqs.push(seq);
    inflight -= 1;
    stream.busy = false;
    const next = stream.queue.shift();
    if (next !== undefined) void sendOn(stream, next);
  };
  const enqueue = (stream: StreamState, intended: number): void => {
    if (!stream.busy) void sendOn(stream, intended);
    else stream.queue.push(intended);
  };

  // Learn which topology answered from one probe header.
  const probe = await fetch(`${BASE}/v1/dm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${producers[0]!.token}` }, body: JSON.stringify({ to: receivers[0]!.name, text: 'probe' }) });
  topology.add(probe.headers.get('x-relaycast-topology') ?? 'workspace');
  await probe.text();

  if (WARMUP) {
    await Promise.all([
      ...dmStreams.map((stream) => call('POST', '/v1/dm', stream.producer.token, { to: stream.target, text: 'warmup' })),
      ...channelStreams.map((stream) => call('POST', '/v1/channels/bench/messages', stream.producer.token, { text: 'warmup' })),
    ]);
    await sleep(2_000);
  }

  const started = now();
  let issued = 0;
  let dmTurn = 0;
  let channelTurn = 0;
  let dmCredit = 0;
  while (now() - started < DURATION_S * 1000) {
    const due = Math.floor(((now() - started) / 1000) * RATE) - issued;
    for (let k = 0; k < due; k += 1) {
      issued += 1;
      dmCredit += DM_SHARE;
      if (dmCredit >= 1) {
        dmCredit -= 1;
        enqueue(dmStreams[dmTurn++ % dmStreams.length]!, now());
      } else {
        enqueue(channelStreams[channelTurn++ % channelStreams.length]!, now());
      }
    }
    await sleep(2);
  }
  while (inflight > 0 || [...dmStreams, ...channelStreams].some((s) => s.queue.length > 0)) await sleep(20);
  const sendWindowS = (now() - started) / 1000;

  // ---- drain and account -------------------------------------------------------
  const expected = (): { stream: StreamState; receiver: string }[] => [
    ...dmStreams.map((stream) => ({ stream, receiver: stream.target })),
    ...channelStreams.flatMap((stream) => receivers.map((receiver) => ({ stream, receiver: receiver.name }))),
  ];
  const missing = (): number => expected().reduce((sum, { stream, receiver }) => {
    const got = seen.get(`${stream.key}|${receiver}`)?.got;
    return sum + stream.okSeqs.filter((seq) => !got?.has(seq)).length;
  }, 0);
  const drainStarted = now();
  while (missing() > 0 && now() - drainStarted < DRAIN_TIMEOUT_MS) await sleep(100);
  await sleep(300); // late duplicates
  clearInterval(acker);
  for (const socket of sockets) socket.close(1000);

  const expectedCount = expected().reduce((sum, { stream }) => sum + stream.okSeqs.length, 0);
  let dups = 0;
  let ooo = 0;
  for (const state of seen.values()) { dups += state.dups; ooo += state.ooo; }
  const report = {
    label: LABEL,
    warmup: WARMUP,
    topology: [...topology][0],
    rate_per_s: RATE,
    send_window_s: Math.round(sendWindowS * 10) / 10,
    producers: PRODUCERS,
    receivers: RECEIVERS,
    nodes: NODES,
    sends: Object.fromEntries(statuses),
    post_ms: { dm: percentiles(postLatency.dm!), channel: percentiles(postLatency.channel!) },
    post_ms_corrected: { dm: percentiles(postLatencyCorrected.dm!), channel: percentiles(postLatencyCorrected.channel!) },
    deliver_ms: { all: percentiles(deliverLatency), dm: percentiles(deliverLatencyByKind.dm!), channel: percentiles(deliverLatencyByKind.channel!) },
    integrity: { expected: expectedCount, delivered_distinct: expectedCount - missing(), lost: missing(), duplicated: dups, reordered: ooo, unmarked_frames: unmarked, frames, socket_closes: socketDrops },
  };
  console.log(JSON.stringify(report, null, 2));
  const failedSends = [...statuses].filter(([status]) => !status.endsWith(' 201')).reduce((sum, [, n]) => sum + n, 0);
  process.exit(report.integrity.lost || dups || ooo || failedSends ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});

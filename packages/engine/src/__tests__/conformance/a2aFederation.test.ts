import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROOF_BUNDLE_BYTES,
  RATIFY_A2A_METADATA_KEY,
} from '@relaycast/a2a';
import {
  base64StandardDecode,
  base64StandardEncode,
  generateHybridKeypair,
  issueRevocationList,
  verifyRevocationList,
  type HybridPublicKey,
  type RevocationList,
} from '@identities-ai/ratify-protocol';
import {
  createWorkspace,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';

type JsonRecord = Record<string, unknown>;

async function jsonData(response: Response): Promise<JsonRecord> {
  const body = await response.json() as { data?: JsonRecord };
  return body.data ?? {};
}

describe('A2A federation between Relaycast deployments', () => {
  let northwind: TestStack;
  let borealis: TestStack;
  let originalFetch: typeof globalThis.fetch;
  let forwardedRpcBytes: number[];
  let transportDelayMs: number;

  beforeEach(() => {
    northwind = makeNodeStack();
    borealis = makeNodeStack();
    originalFetch = globalThis.fetch;
    forwardedRpcBytes = [];
    transportDelayMs = 0;

    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/a2a/rpc' && request.method === 'POST' && transportDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, transportDelayMs));
      }
      if (url.hostname === 'northwind.example') {
        return northwind.app.request(request);
      }
      if (url.hostname === 'borealis.example') {
        if (url.pathname === '/a2a/rpc' && request.method === 'POST') {
          const body = await request.clone().text();
          if (body.includes(RATIFY_A2A_METADATA_KEY)) {
            forwardedRpcBytes.push(new TextEncoder().encode(body).byteLength);
          }
        }
        return borealis.app.request(request);
      }
      throw new Error(`Unexpected federated test URL: ${url.toString()}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    northwind.close();
    borealis.close();
  });

  async function connectDeployments() {
    const northwindWorkspace = await createWorkspace(northwind.app, 'northwind');
    const borealisWorkspace = await createWorkspace(borealis.app, 'borealis');
    const lead = await registerAgent(northwind.app, northwindWorkspace.workspaceKey, 'lead');
    const worker = await registerAgent(borealis.app, borealisWorkspace.workspaceKey, 'worker');

    const registerNorthwind = await borealis.app.request('/v1/a2a/register', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${borealisWorkspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agent_card: {
          name: 'northwind',
          url: 'https://northwind.example/a2a/rpc',
          version: '1.0.0',
          skills: [{ id: 'lead', name: 'lead' }],
        },
        target_agent: 'lead',
      }),
    });
    expect(registerNorthwind.status).toBe(201);
    const northwindProxyOnBorealis = await jsonData(registerNorthwind);

    const registerBorealis = await northwind.app.request('/v1/a2a/register', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${northwindWorkspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        agent_card: {
          name: 'borealis',
          url: 'https://borealis.example/a2a/rpc',
          version: '1.0.0',
          skills: [{ id: 'worker', name: 'worker' }],
        },
        auth_scheme: 'bearer',
        auth_credential: northwindProxyOnBorealis.relay_token,
        target_agent: 'worker',
      }),
    });
    expect(registerBorealis.status).toBe(201);
    const borealisProxyOnNorthwind = await jsonData(registerBorealis);

    // The second registration returns Borealis's bearer token on Northwind.
    // Store it on Borealis's existing Northwind proxy to complete reciprocal,
    // independently authenticated delivery without rotating either token.
    const completeBorealisConnection = await borealis.app.request(
      `/v1/a2a/agents/${encodeURIComponent(String(northwindProxyOnBorealis.relay_name))}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${borealisWorkspace.workspaceKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          auth_scheme: 'bearer',
          auth_credential: borealisProxyOnNorthwind.relay_token,
        }),
      },
    );
    expect(completeBorealisConnection.status).toBe(200);

    return {
      northwindWorkspace,
      borealisWorkspace,
      lead,
      worker,
      borealisProxyName: String(borealisProxyOnNorthwind.relay_name),
      northwindProxyName: String(northwindProxyOnBorealis.relay_name),
      // The bearer Northwind presents when calling Borealis's /a2a/rpc.
      northwindProxyToken: String(northwindProxyOnBorealis.relay_token),
    };
  }

  async function agentMessages(stack: TestStack, agentToken: string): Promise<JsonRecord[]> {
    const conversationsResponse = await stack.app.request('/v1/dm/conversations', {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(conversationsResponse.status).toBe(200);
    const conversations = (await conversationsResponse.json() as { data: JsonRecord[] }).data;
    if (conversations.length === 0) return [];

    const response = await stack.app.request(
      `/v1/dm/${String(conversations[0]!.id)}/messages`,
      { headers: { authorization: `Bearer ${agentToken}` } },
    );
    expect(response.status).toBe(200);
    return (await response.json() as { data: JsonRecord[] }).data;
  }

  it('carries a full 128 KiB proof bundle end to end and rejects one byte more before egress', async () => {
    const federation = await connectDeployments();
    const metadata = {
      [RATIFY_A2A_METADATA_KEY]: {
        version: 1,
        kind: 'proof_bundle',
        correlation_id: 'full-size-proof',
        bundle: 'x'.repeat(MAX_PROOF_BUNDLE_BYTES),
      },
    };

    const sent = await northwind.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${federation.lead.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: federation.borealisProxyName,
        text: 'proofed task',
        data: metadata,
      }),
    });
    expect(sent.status).toBe(201);

    const received = await agentMessages(borealis, federation.worker.token);
    expect(received).toHaveLength(1);
    expect(received[0]!.metadata).toMatchObject(metadata);
    expect(forwardedRpcBytes).toHaveLength(1);
    expect(forwardedRpcBytes[0]).toBeGreaterThan(MAX_PROOF_BUNDLE_BYTES);
    console.info(
      `A2A full proof: bundle=${MAX_PROOF_BUNDLE_BYTES} bytes, JSON-RPC body=${forwardedRpcBytes[0]} bytes`,
    );

    const rpcCountBeforeOversize = forwardedRpcBytes.length;
    const oversized = await northwind.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${federation.lead.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: federation.borealisProxyName,
        text: 'must not leave northwind',
        data: {
          [RATIFY_A2A_METADATA_KEY]: {
            ...metadata[RATIFY_A2A_METADATA_KEY],
            bundle: 'x'.repeat(MAX_PROOF_BUNDLE_BYTES + 1),
          },
        },
      }),
    });
    expect(oversized.status).toBe(400);
    expect(forwardedRpcBytes).toHaveLength(rpcCountBeforeOversize);
    expect(await agentMessages(borealis, federation.worker.token)).toHaveLength(1);
  });

  it('blocks unauthenticated and unregistered peers from injecting Ratify proof metadata', async () => {
    const federation = await connectDeployments();
    const request = {
      jsonrpc: '2.0',
      id: 'unregistered-caller',
      method: 'message/send',
      params: {
        target_agent: 'worker',
        message: {
          message_id: 'unregistered-caller',
          role: 'user',
          parts: [{ kind: 'text', text: 'must not arrive' }],
          metadata: {
            [RATIFY_A2A_METADATA_KEY]: {
              version: 1,
              kind: 'proof_bundle',
              correlation_id: 'unauthorized-proof',
              bundle: '{"attacker":true}',
            },
          },
        },
      },
    };

    const unauthenticated = await borealis.app.request('/a2a/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(unauthenticated.status).toBe(401);

    const rejected = await borealis.app.request('/a2a/rpc', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${federation.borealisWorkspace.workspaceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: -32004 },
    });
    expect(await agentMessages(borealis, federation.worker.token)).toHaveLength(0);
  });

  it('delivers a retried inbound message once, not twice', async () => {
    // The sending side retries on 5xx, and everything after the durable DM
    // write on the receiving side — the counter, the webhook, the workspace
    // event, delivery routing — can still fail. Without an idempotency key the
    // retry writes a second DM, and the counterparty's proof or task is
    // delivered twice. Same message_id must mean one delivery.
    const federation = await connectDeployments();
    const request = {
      jsonrpc: '2.0',
      id: 'retried-rpc-id',
      method: 'message/send',
      params: {
        target_agent: 'worker',
        message: {
          message_id: 'retried-message-id',
          role: 'user',
          parts: [{ kind: 'text', text: 'delivered once' }],
          metadata: {
            [RATIFY_A2A_METADATA_KEY]: {
              version: 1,
              kind: 'proof_bundle',
              correlation_id: 'retried-proof',
              bundle: '{"proof":true}',
            },
          },
        },
      },
    };

    const send = async () =>
      borealis.app.request('/a2a/rpc', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${federation.northwindProxyToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });

    const first = await send();
    expect(first.status).toBe(200);
    const second = await send();
    expect(second.status).toBe(200);

    const received = await agentMessages(borealis, federation.worker.token);
    expect(received).toHaveLength(1);
  });

  it('applies signed revocations in the authenticated reverse direction and reports latency tails', async () => {
    const federation = await connectDeployments();
    const issuer = await generateHybridKeypair();
    const issuerId = 'human:borealis:bob';
    type WireRevocation = {
      version: 1;
      kind: 'revocation_list';
      issuer_id: string;
      updated_at: number;
      revoked_certs: string[];
      issuer_pub_key: { ed25519: string; ml_dsa_65: string };
      signature: { ed25519: string; ml_dsa_65: string };
    };

    const revoked = new Set<string>();
    const trustedIssuers = new Map<string, HybridPublicKey>([[issuerId, issuer.publicKey]]);
    const applyIfValid = async (wire: WireRevocation): Promise<boolean> => {
      const trustedKey = trustedIssuers.get(wire.issuer_id);
      if (!trustedKey) return false;
      const carriedKey: HybridPublicKey = {
        ed25519: base64StandardDecode(wire.issuer_pub_key.ed25519),
        ml_dsa_65: base64StandardDecode(wire.issuer_pub_key.ml_dsa_65),
      };
      if (
        base64StandardEncode(carriedKey.ed25519) !== base64StandardEncode(trustedKey.ed25519)
        || base64StandardEncode(carriedKey.ml_dsa_65) !== base64StandardEncode(trustedKey.ml_dsa_65)
      ) return false;

      const candidate: RevocationList = {
        issuer_id: wire.issuer_id,
        updated_at: wire.updated_at,
        revoked_certs: wire.revoked_certs,
        signature: {
          ed25519: base64StandardDecode(wire.signature.ed25519),
          ml_dsa_65: base64StandardDecode(wire.signature.ml_dsa_65),
        },
      };
      if (!(await verifyRevocationList(candidate, trustedKey))) return false;
      for (const certId of candidate.revoked_certs) revoked.add(certId);
      return true;
    };

    const wouldAcceptGrant = (certId: string) => !revoked.has(certId);

    const sendAndApply = async (
      certId: string,
      sequence: number,
    ): Promise<{ latencyMs: number; wire: WireRevocation }> => {
      const signed: RevocationList = {
        issuer_id: issuerId,
        updated_at: Math.floor(Date.now() / 1000) + sequence,
        revoked_certs: [certId],
        signature: { ed25519: new Uint8Array(), ml_dsa_65: new Uint8Array() },
      };
      await issueRevocationList(signed, issuer.privateKey);

      const wire: WireRevocation = {
        version: 1,
        kind: 'revocation_list',
        issuer_id: signed.issuer_id,
        updated_at: signed.updated_at,
        revoked_certs: signed.revoked_certs,
        issuer_pub_key: {
          ed25519: base64StandardEncode(issuer.publicKey.ed25519),
          ml_dsa_65: base64StandardEncode(issuer.publicKey.ml_dsa_65),
        },
        signature: {
          ed25519: base64StandardEncode(signed.signature.ed25519),
          ml_dsa_65: base64StandardEncode(signed.signature.ml_dsa_65),
        },
      };
      const issuedAt = performance.now();

      const sent = await borealis.app.request('/v1/dm', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${federation.worker.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: federation.northwindProxyName,
          text: `issuer revocation ${sequence}`,
          data: { [RATIFY_A2A_METADATA_KEY]: wire },
        }),
      });
      expect(sent.status).toBe(201);

      const received = await agentMessages(northwind, federation.lead.token);
      const matching = received.find((message) => {
        const metadata = message.metadata as JsonRecord | undefined;
        const candidate = metadata?.[RATIFY_A2A_METADATA_KEY] as Partial<WireRevocation> | undefined;
        return candidate?.kind === 'revocation_list' && candidate.revoked_certs?.includes(certId);
      });
      expect(matching).toBeDefined();
      const receivedWire = (matching!.metadata as JsonRecord)[RATIFY_A2A_METADATA_KEY] as WireRevocation;
      expect(await applyIfValid(receivedWire)).toBe(true);
      expect(wouldAcceptGrant(certId)).toBe(false);

      return { latencyMs: performance.now() - issuedAt, wire: receivedWire };
    };

    const samples: number[] = [];
    let lastWire: WireRevocation | undefined;
    for (let index = 0; index < 20; index += 1) {
      const result = await sendAndApply(`cert-live-grant-${index}`, index);
      samples.push(result.latencyMs);
      lastWire = result.wire;
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const middle = sorted.length / 2;
    const medianMs = (sorted[middle - 1]! + sorted[middle]!) / 2;
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const maxMs = sorted.at(-1)!;
    expect(samples).toHaveLength(20);

    transportDelayMs = 75;
    const delayed = await sendAndApply('cert-injected-delay', 20);
    transportDelayMs = 0;
    expect(delayed.latencyMs).toBeGreaterThanOrEqual(60);
    console.info(
      `A2A revocation latency: n=${samples.length}, median=${medianMs.toFixed(2)} ms, `
      + `p95=${p95Ms.toFixed(2)} ms, max=${maxMs.toFixed(2)} ms, `
      + `injected_transport=75 ms -> ${delayed.latencyMs.toFixed(2)} ms`,
    );

    const tampered = {
      ...lastWire!,
      revoked_certs: ['cert-attacker-chose'],
    };
    expect(await applyIfValid(tampered)).toBe(false);
    expect(revoked.has('cert-attacker-chose')).toBe(false);
  });
});

# Ratify over A2A

Relaycast carries Ratify Protocol proofs and revocations in the A2A message
metadata key `com.agentrelay.ratify`. The key lives at
`params.message.metadata["com.agentrelay.ratify"]`, not in the gateway's
top-level `params.metadata` routing fields.

The version 1 payload is a closed, discriminated shape. Wire field names are
snake_case. A receiver must reject an unknown `version` or `kind` rather than
guessing how to interpret it.

## Proof bundle

```json
{
  "version": 1,
  "kind": "proof_bundle",
  "correlation_id": "challenge-or-invocation-id",
  "bundle": "{canonical Ratify ProofBundle JSON}",
  "grant": "{optional canonical Ratify DelegationCert JSON}",
  "operation": {
    "invocation_id": "task-42"
  },
  "task": {
    "title": "Update the runbook",
    "instructions": "Edit the deployment section",
    "path": "docs/"
  }
}
```

`bundle` is required in both presentation directions. `grant`, `operation`,
and `task` are optional so the same carrier supports a mutual presentation or
a delegated task handoff. When present, `grant` is the canonical Ratify
DelegationCert wire JSON. The UTF-8 byte length of `bundle` may not exceed
131,072 bytes (`MAX_PROOF_BUNDLE_BYTES`, 128 KiB). The surrounding A2A JSON-RPC
request is necessarily larger and must not be capped at 128 KiB by a proxy.

## Revocation list

```json
{
  "version": 1,
  "kind": "revocation_list",
  "issuer_id": "human:northwind.example:alice",
  "updated_at": 1786310000,
  "revoked_certs": ["cert_01"],
  "issuer_pub_key": {
    "ed25519": "base64...",
    "ml_dsa_65": "base64..."
  },
  "signature": {
    "ed25519": "base64...",
    "ml_dsa_65": "base64..."
  }
}
```

The receiver must not apply any `revoked_certs` merely because this metadata
arrived over an authenticated A2A connection. It must:

1. resolve `issuer_id` to an already trusted issuer public key;
2. require `issuer_pub_key` to match that trusted key;
3. reconstruct the Ratify `RevocationList` from `issuer_id`, `updated_at`,
   `revoked_certs`, and `signature`; and
4. call Ratify `verifyRevocationList` with the trusted issuer key before
   changing local revocation state.

The public key beside a signature is not its own trust anchor. A self-signed
attacker payload that is not bound to the expected `issuer_id` must fail closed.

## Two-Relaycast handshake and delivery

For deployments A and B to exchange messages in both directions:

1. B registers A's agent card with `POST /v1/a2a/register`, setting the skill
   on A as `target_agent`. B returns a relay proxy name and bearer token for A.
2. A registers B's card, stores B's returned token as `auth_credential`, and
   sets the skill on B as `target_agent`. A returns its proxy token for B.
3. B completes the reciprocal connection with
   `PATCH /v1/a2a/agents/{a-proxy-name}`, setting A's returned token as
   `auth_credential`. The patch does not rotate either already-exchanged token.
   A card with exactly one skill infers `target_agent`; multi-skill cards should
   set it explicitly.
4. A sends a DM to B's local A2A proxy with the Ratify envelope in the DM
   request's `data`. Relaycast places it in A2A message metadata unchanged.
5. B authenticates the bearer as the registered proxy for A, delivers the
   message and metadata to the selected local agent, and emits the normal
   `dm.received` delivery. B-to-A delivery follows the same path with the other
   stored credential.

A workspace key can use `/a2a/rpc` as an outbound gateway, but it cannot inject
a message directly into a local agent. Only the agent token issued to a
registered A2A proxy can use the inbound path, and that token cannot relay to a
second external A2A agent.

Workspace agent cards advertise this extension under
`capabilities.extensions["com.agentrelay.ratify"]`, including supported
versions, kinds, and the proof-bundle byte maximum.

# Integration Conformance Harness

Data-driven proof that every integration works end-to-end through the **real
code path**, with only the outer boundary (Nango SDK + provider HTTP + relayfile
persistence) mocked. Coverage scales by adding a manifest, not a bespoke test.

See the RUNBOOK (`relayfile/.agentworkforce/overnight-integration-run/RUNBOOK.md`)
for the chain definition and the GATE CONTRACT (G1–G6).

## Run it

```bash
# One provider, all declared directions (this is the per-provider G3 gate;
# exits non-zero if not GREEN):
npx tsx tests/conformance/run-conformance.ts slack

# One direction only, machine-readable evidence (writes[]/capturedRequests[]):
npx tsx tests/conformance/run-conformance.ts hubspot --direction writeback --json

# Every manifest:
npx tsx tests/conformance/run-conformance.ts --all

# Reference trust gate (schema-valid + slack/linear GREEN through real code):
npx vitest run tests/conformance/conformance.test.ts

# Live mode — same fixtures against a real Nango connection where creds exist:
npx tsx tests/conformance/run-conformance.ts github --live
```

## What each direction drives (real code, mocked boundary)

| Direction   | Real entrypoint                                        | Mocked boundary                      | Evidence |
|-------------|--------------------------------------------------------|--------------------------------------|----------|
| `inbound`   | `routeNangoWebhook` (webhook router → adapter → record-writer) | `mock-relayfile-server` (HTTP) + relayauth fetch stub + Nango mock for enrichment | `writes[].{path,content,encoding,contentType}` |
| `writeback` | `executeRelayfileProviderWriteback` (bridge → provider executor → Nango) | `mock-nango-sdk-server` + PGLite app DB | `capturedRequests[].{method,endpoint,query,body,connectionId,providerConfigKey}` |
| `sync`      | `record-writer.writeBatchToRelayfile`                  | in-process `RelayfileWriteClient` store | `writes[]` / `deletes[]` |

## Authoring a manifest (10 lines)

1. File: `tests/conformance/manifest/<provider>.json`, one per integration.
2. Top: `provider`, `nangoIntegration` (the `*-relay` providerConfigKey; `null`
   for adapter-only providers), `capabilities`.
3. `capabilities`: `{ webhook: bool, writeback: bool | "adapter-only", sync: bool }`.
   `writeback:true` = cloud-bridged (runs the writeback runner). `"adapter-only"`
   = has writeback but no cloud integration → proven at the adapter layer, runner
   skips it. `false` = no writeback.
4. A provider is **GREEN** when every capability marked `true` has ≥1 passing
   fixture through the real code path.
5. `inbound[]`: `{ event, source, payload, expect:{ paths|pathPatterns, contentIncludes, minWrites, triggersSync?, triggersWatch? } }`.
   `payload` is the Nango forward envelope's payload (doc-accurate provider body).
   For providers that enrich inbound via Nango (e.g. Slack channel name via
   `/conversations.info`), add `mockNango:[{ endpointMatches, body }]`. Thin
   notification webhooks that only trigger Nango syncs use
   `expect.triggersSync:[{syncName, providerConfigKey?}]` and do not assert a
   direct Relayfile write. Watch-only webhooks use
   `expect.triggersWatch:[{provider,eventType,path?}]`.
6. `writeback[]`: `{ action, source, filePath, content, fileAction?, mockResponse, expectCall:{ method, endpoint|endpointMatches, bodyIncludes } }`.
   `content` is the file written back; `mockResponse` is what the provider returns
   so the executor succeeds. Atlassian-cloud providers need
   `metadata:{ connection_config:{ cloudId:"..." } }` and an `endpointMatches`
   that includes the `/ex/{product}/{cloudId}/...` prefix. Deletes set
   `fileAction:"file_delete"` so the bridge exercises the provider's delete resolver.
7. `sync[]`: `{ model, syncName, source, records, expect:[{ path|pathPattern, op?, contentIncludes }] }`.
   Deletes: set `op:"delete"` and add `seedRecords:[...]` (written first so the
   store has a prior file to reconcile against).
8. `source` MUST cite the provider API docs / NangoHQ template first
   (implementation files are trace only) — expectations are grounded in the
   provider contract, NOT in the resolver's own output (avoids resolver==resolver).
9. Run `run-conformance.ts <provider>`; read the failure diff (it prints the
   ACTUAL `writes[]` / `capturedRequests[]`).
10. Self-correct **only** per the discriminator below; otherwise file a HOLE.

## The (a)/(b) discriminator — when actual ≠ expected (Verifier Guard #2)

Truth for the **write path** = the canonical relayfile convention (proven by
slack/linear + the RUNBOOK: `{container}/{type}/{stable_id}.json`, terminal
`meta.json` where the reference uses it, id-suffixed slugs). Truth for the
**outbound call** = the provider API docs.

- **(a)** Fixture guessed wrong BUT the emitted path/call follows the convention/docs
  → fix the **fixture**.
- **(b)** Emitted path/call does NOT follow the convention/docs (wrong template,
  missing/duplicated id, wrong terminal segment, would collide/orphan; or a call
  that misroutes) → that's a **code HOLE** (path-mapper / resolver / bridge
  executor) → fix the code, file `HOLE: <provider> <direction> ...` with the
  captured evidence. Do NOT paper over it by copying actual→expected.

## Known limitations / patterns

- **Jira / Confluence (Atlassian Cloud)**: the bridge builds
  `/ex/{product}/{cloudId}/...`. Supply `metadata.connection_config.cloudId` in
  the writeback fixture and assert the prefixed endpoint, or the call can't route.
- **Deletes**: some providers represent an upstream delete as index/tombstone
  reconciliation (preserving terminal state per the digest contract) rather than a
  `deleteFile`. Assert what the convention dictates; if a real delete is expected
  and not issued, that's a (b) HOLE.
- **Live mode** uses the prod Nango connection ids baked into `run-conformance.ts`
  (`LIVE_CONNECTIONS`); the secret stays in `cloud/nango-integrations/.env`.
- **Unpublished adapter (Resolution A)**: the writeback runner imports the real
  bridge → the adapter from `node_modules`. To prove an unpublished adapter fix,
  make cloud resolve the local source (link/file:/tarball) before the run; the
  harness proves whatever cloud resolves (no harness change needed).

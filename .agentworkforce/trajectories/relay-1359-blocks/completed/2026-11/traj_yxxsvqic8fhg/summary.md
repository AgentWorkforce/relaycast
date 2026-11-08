# Realtime blocks repair

Summary: Preserve arbitrary block payloads through engine workspace frames, SDK node transforms and shared realtime schemas. WebSocket-only opaque casing preserves custom keys while existing HTTP and outgoing actionId behavior stays unchanged. DM transforms retain blocks only when supplied; no DM send/storage feature is added. Two independent final reviews passed.

Validation in this Relaycast checkout:
- npm --prefix packages/sdk-typescript test:531 passed, including strict workspace typecheck.
- npm --prefix packages/types test:281 passed.
- npm --prefix packages/engine exec vitest run src/engine/__tests__/wsTransform.test.ts:43 passed.
- SDK and engine builds and SDK/types/engine lint: passed.
- Native database-backed engine tests were attempted but could not execute because better-sqlite3 has no local Windows ARM64 / Node24 addon. This is not a full engine-suite pass.

Reproducible cross-repository check (separately run):
- Source: https://github.com/AgentWorkforce/relay/blob/c3e517829fb9178481cf8ff1128817f78d57647c/scripts/verify-sdk-realtime-blocks.mjs
- Build both SDKs, then from that Relay revision run node scripts/verify-sdk-realtime-blocks.mjs <relaycast-checkout>.
- Verified against Relaycast implementation3af3b99:49KB blocks plus original arbitrary kind/payload object match Relay public listener and REST fixture readback. All HTTP and WebSocket I/O is mocked, not database or live-service evidence.

No release, deployment or production access was performed. Exact implementation commits and files are recorded in trajectory.json; subsequent evidence-only commits record validation provenance.

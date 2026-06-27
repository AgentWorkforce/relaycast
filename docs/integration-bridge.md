# Integration Bridge — relayfile providers ⇄ relay channels (provider-agnostic)

**Status**: Draft
**Date**: 2026-06-27
**Author**: design session (human + Claude)
**Related**: `relay:spec/slack-primitive` (outbound, Slack-only), `@relayfile/sdk`, `@relaycast/sdk-typescript`

---

## 1. Goal

> Subscribe a relay channel (or agent) to **any** relayfile integration, in a
> provider-agnostic way: external records get injected as channel messages, and
> agent replies write back to the source object — Jira comment, Gmail thread,
> Slack thread, GitHub PR, whatever the provider is.

Hard constraints from the design session:

- **No new `@agent-relay/*` package.** Reuse existing surfaces.
- **No new transport.** Built only on published SDK surfaces.
- **Not Slack-specific.** Slack is one adapter; the mechanism is generic.
- **Mount optional.** The live loop is HTTP/WS via SDK; the FUSE mount is only
  for an agent that wants to browse a provider as a filesystem.

## 2. The one idea that makes it agnostic

**The canonical relayfile path is the universal routing key.**

relayfile's ingest is already provider-neutral: `core/webhooks.ts` takes
`{ provider, path, payload, eventType }` and writes to
`canonicalProviderEnvelopePath(provider, path)` — no per-provider branching.
Every record therefore lives at `/<provider>/…` and every `WriteEvent.path`
and every writeback `path` is in that same namespace. `IntegrationAdapter`
(`@relayfile/sdk`) already abstracts the per-provider parts generically:

```ts
abstract class IntegrationAdapter {
  abstract ingestWebhook(workspaceId, event: AdapterWebhook): Promise<IngestResult>;
  abstract computePath(objectType, objectId): string;          // → canonical path
  abstract computeSemantics(objectType, objectId, payload): FileSemantics;
  supportedEvents?(): string[];
  writeBack?(workspaceId, path, content): Promise<unknown>;     // ← generic reply
  sync?(workspaceId, options?): Promise<SyncResult>;
}
```

So the bridge never needs to understand Slack threads or Jira issues. It moves
**(path, content)** pairs between the provider VFS and a relay channel, and
carries the source `path` as the round-trip routing key. Provider-specific
niceness (who the display author is, how to summarize a record, which writes are
loop-backs) is an **optional** per-adapter hook — absent it, a generic default
applies and the provider still works.

## 3. Where it lives (no new package)

The glue is cross-domain (provider side + channel side), so it lives in the repo
that already owns the provider runtime: **relayfile `packages/agents`** — the
same place `writeback.ts` and `connect.ts` already live. It imports
`@relaycast/sdk-typescript` for the channel side and uses in-process
`@relayfile/sdk` surfaces for the provider side. Nothing new is added under
`agent-relay/`.

Configuration reuses existing command groups — `relayfile integration …` and
`agent-relay integration subscription …` — see §6.

## 4. SDK surfaces used (only these)

**relayfile (`@relayfile/sdk`)** — provider side:
- `onWrite(handler, { pathPrefix })` → `WriteEvent{ workspaceId, path, operation, revision, value, actor, source }` — inbound change feed, no mount.
- `IntegrationAdapter` registry — `computePath`, `writeBack`, optional presenter hook (§5).
- `WritebackConsumer({ handler })` / `client.ingestWebhook(...)` — outbound replies become writebacks generically.

**relaycast (`@relaycast/sdk-typescript`, class `RelayCast`)** — channel side:
- `relay.webhooks.createInbound({ channel, name })` + `relay.webhooks.trigger(id, body, token)` — record → channel message; broker injects to members.
- `relay.subscriptions.create({ events, filter: { channel }, url, secret })` — channel reply → bridge URL.
- `agent.on.messageCreated/threadReply` — WS alternative for an always-on bridge.

## 5. The generic adapter hook (the only new interface)

To stay agnostic but allow per-provider polish, add **one optional hook** to the
adapter contract. Everything else already exists.

```ts
interface RelayBinding {
  // inbound: a new/updated provider record → a channel message (or null = skip)
  present?(event: WriteEvent): {
    text: string;
    author?: string;            // display name (e.g. the human who commented)
    skip?: boolean;             // loop-guard: our own writeback, bot echo, etc.
  } | null;

  // outbound: a channel reply → where/what to write back (or null = not repliable)
  // default: writeBack(workspaceId, replyPathFor(sourcePath), content)
  replyPathFor?(sourcePath: string): string | null;
}
```

**Generic default (no hook):** `present` posts the record's file content (or a
truncated JSON summary) with the provider as author; `replyPathFor` returns the
adapter's conventional reply sub-path (e.g. `<path>/replies/<draft>.json` for
threaded providers) or `null` for read-only providers. So a freshly-connected
provider with **no** custom code already injects records and (if writable)
accepts replies. Slack/Jira/Gmail adapters override `present` for nicer text and
`skip` for accurate loop-prevention.

## 6. Setup — one binding, existing commands

A "binding" is `(provider, resource path-glob) ⇄ (relay channel)`. Create it
with existing surfaces:

```ts
import { RelayCast } from '@relaycast/sdk-typescript';
const relay = new RelayCast({ workspaceKey, token });

// 6.1 inbound webhook: provider records → this channel
const wh = await relay.webhooks.createInbound({ channel: '#jira-acme', name: 'relayfile:jira' });

// 6.2 outbound subscription: channel replies → the bridge's writeback ingress
await relay.subscriptions.create({
  events: ['message.created', 'thread.reply'],
  filter: { channel: '#jira-acme' },          // ⚠️ CLI flag gap (§9)
  url: `${bridgeBaseUrl}/writeback`,
  secret: bridgeSecret,
});

// 6.3 relayfile side records the binding (provider + path-glob ⇄ channel + wh)
//     reuses the existing `relayfile integration` group:
//     relayfile integration bind jira '/jira/projects/ACME/issues/**' \
//        --channel '#jira-acme' --webhook <wh.id> --webhook-token <wh.token>
```

`agent` vs. `entire channel` is just channel membership — a 1:1 DM-style channel
binds one agent; a shared channel fans out to all members. No flag.

## 7. Flow

### 7.1 Inbound — provider record → agent

```
provider ▶ ingestWebhook ▶ /<provider>/** write ▶ onWrite ▶ adapter.present ▶ relay.webhooks.trigger ▶ channel ▶ inject
```

```ts
onWrite(async (e: WriteEvent) => {
  const binding = bindingFor(e.path);                 // path-glob match
  if (!binding) return;
  const view = binding.adapter.present?.(e) ?? genericPresent(e);
  if (!view || view.skip) return;                     // loop-guard / non-message
  await relay.webhooks.trigger(binding.webhookId, {
    text: view.text,
    author: view.author,
    source: binding.provider,
    payload: { relayfile: { provider: binding.provider, path: e.path, revision: e.revision } },
  }, binding.webhookToken);
}, { pathPrefix: '/' });                               // or per-binding `/<provider>/`
```

`triggerWebhook` inserts the channel message and emits `message.created`; the
broker injects it to every agent in the channel — identical to a native relay
message.

### 7.2 Outbound — agent reply → provider object

```
agent replies ▶ message.created ▶ subscription POST /writeback ▶ adapter.writeBack ▶ provider API
```

```ts
// POST /writeback (HMAC-verified against `secret`)
const r = body.message.metadata?.relayfile;            // { provider, path, revision }
if (!r) return;                                        // not a bound channel
if (body.message.metadata?.__relaycast_origin === 'inbound_webhook') return;  // skip our own injects
const binding = bindingFor(r.path);
const replyPath = binding.adapter.replyPathFor?.(r.path) ?? defaultReplyPath(r.path);
if (!replyPath) return;                                // read-only provider
await binding.adapter.writeBack(workspaceId, replyPath, body.message.text);
// → WritebackConsumer / cloud delivery performs the provider call (chat.postMessage,
//   issue comment, gmail reply, …) — provider-specific code already exists in the adapter.
```

The reply lands on the source object because `replyPath` is derived from the
carried canonical `path`. **No provider-specific logic in the bridge** — only in
the adapter's existing `writeBack`.

### 7.3 Loop prevention (generic)

Two guards on data the SDK already provides:
- **Inbound:** `e.operation === 'delete'` skip; `e.actor`/`source` marking our
  own writeback skip; adapter `present().skip` for bot/self echoes.
- **Outbound:** skip messages whose `metadata.__relaycast_origin ===
  'inbound_webhook'` (the ones we injected), so only genuine agent replies write
  back.

## 8. The metadata round-trip (the load-bearing fix)

For a reply to reach the right object, `metadata.relayfile.path` must survive
the loop. Today it can't: `triggerWebhook`
(`packages/engine/src/engine/inboundWebhook.ts`) accepts `payload` but only uses
it to build message **text** — it does **not** persist it into
`message.metadata`. Fix (the **only** relaycast code change, fully generic):

```ts
metadata: {
  ...inboundWebhookMessageMetadata({ webhookId, webhookName, source, author }),
  ...sanitizeUserMessageMetadata(data.payload),   // carries { relayfile: { provider, path, revision } }
}
```

`message.created` delivery already includes `metadata`, and relaycast already
preserves non-`__relaycast_`-prefixed keys, so once persisted the routing key
round-trips for free — for **any** provider, since it's just a path string.

## 9. Gaps to close (all additive)

1. **relaycast engine:** persist `payload` → `message.metadata` (§8). *Required, generic.*
2. **relay CLI (`agent-relay`):** surface `--filter channel=…`, `--url`,
   `--secret` on `agent-relay integration subscription create` — implemented in
   the **relay** repo (`packages/cli/src/cli/commands/integration.ts`), which
   wraps the relaycast SDK. The engine + SDK already accept all three; only this
   CLI wrapper lags.
3. **relayfile:** (a) add the optional `RelayBinding` hook (§5) to the adapter
   interface with a generic default; (b) add `relayfile integration bind` to the
   existing integration group to register a binding; (c) run the forwarder loop
   inside the existing `packages/agents` runtime.

No new package, no new transport, no provider-specific code in the bridge core.

## 10. Why this is agnostic, concretely

| Provider | inbound (`present` default → override) | outbound (`writeBack`) |
|----------|----------------------------------------|------------------------|
| Slack    | file content → thread text + Slack user author | `chat.postMessage(thread_ts)` |
| Jira     | issue/comment JSON → comment body + reporter   | add issue comment |
| Gmail    | message record → subject+body + from           | thread reply |
| GitHub   | PR/issue event → title+body + actor            | PR/issue comment |
| (new)    | generic JSON summary + provider name           | conventional reply path or read-only |

Every row uses the **same** bridge code; only the adapter's `present`/`writeBack`
differ — and those already exist (or fall back to the generic default).

## 11. Phasing

- **v0:** generic default presenter, WS form (`onWrite` + `agent.on.*` +
  `WritebackConsumer`) against one provider end-to-end. Requires §9.1.
- **v1:** `relayfile integration bind` + subscription `/writeback` ingress;
  per-adapter `present`/`skip` for Slack + one non-chat provider (Jira) to prove
  agnosticism. Requires §9.2–9.3.
- **v2:** ergonomic one-shot `relayfile integration bind <provider> <glob>
  --channel <c>` that performs §6.1–6.3 in one call. Mount stays optional.

## 12. End-user surface (the whole point)

Everything above is plumbing. The user touches **one** command, in the CLI where
they already spawn agents (`agent-relay`, relay repo). It orchestrates all three
repos' surfaces (relayfile connect + binding, relaycast SDK webhook +
subscription, broker spawn) so the user never sees a webhook id, a subscription,
or a path glob.

### 12.1 One-liner (power user)

```bash
agent-relay integration subscribe slack \
  --resource '#acme' \          # provider-native picker value (channel / project / label)
  --to @slackbot \              # existing agent, or #relay-channel for fan-out
  --spawn claude \              # optional: spawn the recipient if it doesn't exist
  --events message              # optional: defaults to the provider's "primary" events
```

After this returns: messages in Slack `#acme` inject into `@slackbot`, and its
replies post back into the Slack thread. No mount, no second command.

### 12.2 Zero-arg wizard (default / discovery)

```bash
agent-relay integration subscribe
```

Walks, with sensible defaults at every step:

1. **Pick integration** — lists `relayfile integration available` (Nango +
   Composio catalog). Search-as-you-type.
2. **Pick resource** — provider-native picker (Slack channel list, Jira project,
   Gmail label). Reuses the same pickers pear ships
   (`SlackChannelPicker`, etc.).
3. **Pick recipient** — existing agent, a relay channel (fan-out), or **“＋
   spawn a new agent”** → choose `claude`/`codex`/… inline.
4. **Confirm** — prints a one-line summary and goes live.

### 12.3 The not-connected path (must be inline, never a dead end)

The command **detects** a missing/expired connection via the relayfile SDK
(`relayfile integration list` / connection status) and resolves it *in place*
rather than erroring out:

```
$ agent-relay integration subscribe slack --resource '#acme' --to @slackbot

  Slack isn't connected to this workspace yet.
  → Opening browser to connect Slack…            # runs `relayfile integration connect slack`
  ✓ Connected as acme.slack.com
  ✓ Channel #acme bound → @slackbot
  ✓ Listening. Replies will post back in-thread.
```

Rules that keep it frictionless:

- **Interactive TTY:** auto-launch the OAuth/connect flow
  (`relayfile integration connect <provider>`), then **resume the same wizard** —
  no restart, no re-typing.
- **Atlassian-style providers** that need a site/metadata after OAuth: the
  connect step prompts for it (relayfile already does this for jira/confluence).
- **Non-interactive / CI (`--no-input`):** don't hang on a browser. Exit
  non-zero with the exact remediation:
  `Run: relayfile integration connect slack --workspace <ws>, then re-run.`
- **Provider connected but resource not authorized** (e.g. bot not in the Slack
  channel): surface the provider's own fix (“invite the bot to #acme”) instead
  of a generic 403.
- **Recipient agent offline / absent:** **prompt, don't auto-spawn.** In the
  wizard, offer "＋ spawn it now" / "pick another" / "bind anyway (it'll receive
  when it comes online)". In the one-liner, require explicit `--spawn <cli>` —
  binding to a missing agent without `--spawn` is an error with that exact
  remediation. Spawning is heavier than the user may expect, so it is never
  implicit.

### 12.4 Lifecycle (symmetry, so it's not a roach motel)

```bash
agent-relay integration subscribe --list                 # active bindings
agent-relay integration unsubscribe slack --resource '#acme'   # tears down webhook + sub + binding
```

Teardown removes all three artifacts (inbound webhook, subscription, relayfile
binding) so there are no orphans. Disconnecting the provider
(`relayfile integration disconnect`) cascades: bindings on it are auto-disabled
and reported, not left dangling.

### 12.5 Why this honors the constraints

- **One verb**, agnostic across providers (`subscribe slack` ≡ `subscribe jira`).
- **No new package** — `subscribe`/`unsubscribe` are commands added to the
  existing `agent-relay integration` group (relay repo), orchestrating SDK calls.
- **Connect is never a prerequisite the user must know about** — it's folded in.
- **Mount never appears.** It stays an optional power-user affordance.

## 13. Resolved decisions

No open questions. The design session settled these:

- **Spawn is never implicit.** The wizard prompts (spawn / pick another / bind
  anyway); the one-liner requires `--spawn <cli>`. (§12.3)
- **Default presenter = semantics-aware truncation.** The generic `present`
  default uses `computeSemantics` to classify the record and emits a truncated,
  type-appropriate summary (not raw bytes, not full JSON). Adapters override for
  polish.
- **Forwarder runs in relayfile-cloud.** It already holds the per-workspace
  Nango/Composio connections, so co-locating the forwarder avoids a second
  credential path. Local/laptop runs use the same code in the relayfile
  `packages/agents` runtime.
- **Read-only providers are inbound-only, and that's valid.** When
  `replyPathFor` returns `null` the binding still injects (notifications); the
  wizard labels it "inbound-only — replies won't post back" so the user isn't
  surprised.
</content>

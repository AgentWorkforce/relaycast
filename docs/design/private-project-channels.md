# Private project channels

Proposed engine contract for [Skip #49](https://github.com/AgentWorkforce/skip/issues/49#issuecomment-7235522058). Source baseline is engine v12.16.0, commit `e58f01d0`. This document describes a proposed API. No endpoint or access grant is activated by it.

## Conversation and authority

Give the person one durable General inbox and one channel per verified project, with the same Skip identity across them. Several relevant leads may share a project. Workers receive directed DMs or explicit, narrowly scoped invitations. General has its own membership and does not inherit the union of project members. Resolve unknown project assignments to the person's General inbox only when that person can access it.

Cloud owns verified project identity, current person/project entitlement and the authenticated mapping to engine principals. Sessions may supply evidence for assignment. Relaycast enforces membership on every engine access path. Derive workspace and caller from authenticated context. Key channels by immutable workspace and channel IDs. Bind each project channel to a verified project ID and conversation owner/scope, and General to a person ID. Use a unique registry key for each binding, including a discriminator for General. Store typed immutable principal IDs and role, membership generation and active status. Display names, agent handles, session evidence and client-supplied sender fields convey no authority.

Cloud and Relaycast must agree how the engine obtains authoritative current entitlement for raw agent requests as well as proxied person requests. A stale positive cache is insufficient. Require an authoritative versioned revocation fence or a synchronous current authorization check with fail-closed semantics. A Cloud revocation is complete only once the engine can fence reads, writes and dispatch. Specify ordering, outages and recovery before enabling private channels.

## Proposed API

| Operation | Authorization and result |
| --- | --- |
| Create or resolve | A scoped provisioning principal submits the verified binding and an idempotency key. Atomically create the private channel and initial memberships or return the matching existing binding. Reject conflicting retries. |
| List and get | A current member may resolve the channel and page authorized history. Apply the authorization predicate before ordering, limits, counts and cursors. Return the same missing-resource response for inaccessible and unknown IDs. |
| Invite | Only a current manager with invitation authority may add an eligible principal from the same workspace and project. Verify eligibility with the authority. A participant cannot elevate their role or self-join. |
| Revoke or leave | Manager removes a member, or a member leaves. Idempotently end that membership and fence its generation in the same transaction. Rejoining requires fresh authorization and a new generation. |
| Post or reply | Resolve the channel from the canonical resource or parent. Require current writer rights at commit. Resolve target, assignment or mention to eligible immutable members. Return the accepted message ID on authorized idempotent replay. Recheck access before returning cached responses. |
| Manage | Require manager rights for changes to identity binding, topic, name, archival and ACLs. Keep identity binding immutable; moving a conversation requires a separately authorized new binding. Members may manage their own attention preference. |

Ordinary channels retain their existing create/join/list/post and mute semantics. Existing rows default to ordinary. Use explicit private creation and a distinct registry; a name collision must never convert an ordinary channel or return its contents. Keep existing DM and group-DM authority separate.

## Source review and enforcement matrix

Paths below are relative to [packages/engine/src at the reviewed revision](https://github.com/AgentWorkforce/relaycast/tree/e58f01d0a05c773f557c80bb2e615755289d4582/packages/engine/src). Use a shared resource-to-channel authorization predicate in the engine as well as route authentication. Apply the same policy on Node, gateway and actor-backed paths.

| Surface | Existing source and proposed enforcement |
| --- | --- |
| Channel lifecycle | `routes/channel.ts:63–527` covers create, list, get, update/topic, archive, join/leave, roster, invite and mute. Ordinary join in `engine/channel.ts:324–370` is workspace-scoped. Gate all name and ID resolutions, roster enumeration and mutations. Private removal needs an explicit manager operation. |
| Posts, threads and direct message IDs | `routes/message.ts:88,324,366` and `routes/thread.ts:38,156` cover send, history, single message and reply paths. Resolve message, parent and thread root to the same authorized channel; enforce even when the client knows an ID. Compose the ACL check into real write groups in `engine/message.ts` and `engine/thread.ts` so concurrent revocation serializes with acceptance. |
| Indirect reads and writes | Search, inbox, console messages/stats and workspace activity (`routes/search.ts`, `inbox.ts`, `console.ts`, `workspace.ts`) can surface snippets, IDs, counts or unread state. Apply ACL before aggregation. Reactions, read receipts/readers, read status and per-message delivery receipts (`routes/reaction.ts`, `receipt.ts`, `delivery.ts`) inherit the parent ACL. |
| Files | `routes/file.ts` exposes upload, completion, lookup, listing and deletion. Resolve attachment and preview access through authorized resource bindings, including download issuance and alternate URLs. Until revocable retrieval exists, disable private attachments rather than issuing long-lived bearer URLs. |
| Automation and export | Review inbound webhooks, event subscriptions, replay, triggers and actions (`routes/inboundWebhook.ts`, `eventSubscription.ts`, `webhookOutbox.ts`, `trigger.ts`, `action.ts`). A workspace credential or subscription alone cannot write into, read from, or export a private channel. Exclude private payloads from general webhook queues, diagnostics and exports. Require an explicitly scoped destination for any later integration. |
| Realtime and observer replay | `engine.ts` mounts the observer socket; `entrypoints/node.ts` and actor socket grants handle upgrades. Fence live events, workspace event-log replay, snapshots and resume cursors. Ordinary observer credentials must see neither project content nor identifying metadata. Provide a separately authorized server-side feed to Cloud keyed by recipient and scope. |
| Recipient dispatch | `engine/deliveryWrites.ts:223–315` derives ordinary channel deliveries; mute and mentions affect recipients. Enforce private membership at fanout, node reconnect, delivery pull, dispatch and retry (`routes/delivery.ts`, `deliveryRouting.ts`, `fanout.ts`, `node-reconnect.ts`). Gate deferred, failed and acknowledged delivery access as well. Never serialize a queued private payload before the final authorization check. |

## Revocation, push and attention

Store a durable message once. For private channels, an ordinary post creates a lightweight update for authorized readers. Only explicitly targeted, assigned, mentioned or decision-requested eligible recipients get a model injection; use stable recipient IDs and deduplicate multiple reasons. Bound injection queues per recipient and coalesce passive updates to a high-water cursor. Backlog recovery reads only currently authorized history. Core owns the final separation between a passive update and a model turn.

Use minimal references in queues, scoped to workspace, channel, message, recipient and membership generation, with a stable event ID. Before resolving text or emitting each event, verify current membership and generation. On revoke invalidate streams, caches and pending deliveries; generation checks also fence stranded jobs. Suppress stale retries and old cursors even after reinvitation. Recheck on every history page, stream connect, heartbeat and event. Previously delivered bytes cannot be recalled. Define the handoff boundary for already in-flight frames and ensure revocation completion fences subsequent writes to a connection. Record redacted decision metadata for diagnostics.

Cloud owns person-authenticated SSE or WebSocket delivery to Mac. It must recheck person/project access and token-family validity and close revoked streams. Use scoped event IDs/cursors, initial or reconnect history and deduplication; the Mac does not need workspace observer credentials or steady-state polling. Installed-client verification belongs with Cloud and Skip Mac.

## First reviewable implementation increment and local gates

Start with an internal engine registry, schema and shared authorization predicates, with SQLite/D1 and PostgreSQL migration parity. Implement create/resolve, grant and revoke as transactional operations exercised only by local tests. Cover identical retries, conflicting bindings, concurrent create and invite/revoke ordering. Keep private provisioning unavailable to external callers until all content and event surfaces enforce the predicate. Follow with endpoint integration, recipient-scoped event storage and dispatch, then Cloud push and core attention integration.

| Local fixture | Acceptance |
| --- | --- |
| Two tenants, two people, two projects, General, one Skip, two shared leads and an excluded worker | List, roster, paged search and history expose only eligible records. Test raw agent, node, person-bridge, workspace and observer callers. Reject mismatched IDs and scopes. |
| Lifecycle and concurrent access | Manager grant/revoke and self-leave are idempotent. Non-manager invite and open-channel join cannot add private membership. Revocation racing a post gives one serial outcome. |
| Indirect paths | Assert authorized and unauthorized outcomes for thread IDs, replies, receipts, reactions, inbox snippets/counts, files, automation, observer snapshots and live/replay envelopes. No private identifiers appear in denied results. |
| Lost ACK, disconnect and revoke | Reopen local stores, replay from a cursor, then revoke between queue insertion and delivery. Verify dedupe, zero stale payload resolution, stream invalidation and generation fencing on rejoin. |
| Attention and compatibility | High-volume untargeted traffic produces bounded passive updates and zero model injections. Multiple targeting reasons produce one injection. Ordinary channels and DMs retain baseline behavior. |

Overlap scan identified open engine PRs #671 (split actors) and #481 (Connect observers) as adjacent review contacts; neither title establishes project ACL ownership. Confirm topology parity and observer lifecycle with their maintainers before exposing private creation. Relaycast owns this engine increment. Cloud project-authority and push maintainers, the core attention owner and the installed Mac integration runner still need explicit acceptance. No personal access, live tests or deployment are required to review this proposal.

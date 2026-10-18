# Connect an existing Relay agent to a Buzz room

`relaycast buzz.bridge` runs one Buzz bot identity in one Buzz room and routes its mentions to one existing Relaycast agent. The agent's reply to that Relay message is posted under the original Buzz message. It does not launch an agent or read Buzz's local agent sessions.

## Set up the two identities

1. Register a separate Relaycast identity for the bridge. Keep its returned agent token; the target agent keeps its own token and session. `agent.register` creates a new identity and does not return an existing token. Resume an existing bridge identity with its current token.

   ```bash
   relaycast --relay-api-key "$RELAY_API_KEY" agent.register --name BuzzBridgeCoder --type agent
   ```

   `RELAY_API_KEY` is a workspace key (`rk_live_…` or `ar_ws_…`). `RELAYCAST_AGENT_TOKEN` is that bridge identity's agent token (`at_live_…` or `ar_ag_…`).

2. Provision a Buzz bot key and admit its pubkey to the Buzz community. On a self-hosted member-gated relay, an administrator can use `buzz-admin add-member <bot-pubkey>`. Hosted communities use their invitation or membership flow. Community admission and room membership are separate.
3. Using that bot key with the [Buzz CLI](https://github.com/block/buzz/blob/main/crates/buzz-cli/README.md), publish a profile and join the chosen room. A room administrator must add the bot to a private room. Give it the `bot` role where available.

   ```bash
   export BUZZ_RELAY_URL='https://your-community.example'
   export BUZZ_PRIVATE_KEY='nsec1...'
   buzz users set-profile --name 'Relay Coder'
   buzz channels join --channel '<room-uuid>'
   ```

4. Configure and supervise the bridge process:

   ```bash
   export BUZZ_CHANNEL_ID='<room-uuid>'
   export BUZZ_BOT_NAME='Relay Coder'
   export RELAYCAST_AGENT_TOKEN='at_live_...'
   export RELAYCAST_TARGET_AGENT='Coder'
   export BUZZ_BRIDGE_STATE_FILE='/durable/private/buzz-coder.json'
   relaycast buzz.bridge
   ```

   `RELAYCAST_BASE_URL` optionally points at a self-hosted Relaycast engine. Keep the state file on persistent storage. The bridge creates it with mode `0600`, binds it to this Buzz room, bot key, Relay endpoint, and target agent, and refuses to reuse it for a different mapping.

In Buzz, select `@Relay Coder` and send a request. Buzz clients normally attach a structured `p` tag. `BUZZ_BOT_NAME` also accepts a literal `@Relay Coder` in the room when an external bot has not yet appeared in Buzz's mention picker. The literal name match is case sensitive and must end at whitespace or punctuation.

## Behavior and scope

- The bridge checks the event signature, room tag, and bot mention. It ignores its own posts. One Buzz event produces one idempotent Relay DM.
- The Relay agent must **reply to the delivered Relay message**. The bridge uses that reply's parent ID to select the Buzz thread. An unthreaded DM is not published because its destination is ambiguous.
- The bridge signs a Buzz `kind:9` reply with NIP-10 thread tags and the original author's `p` tag. A root `e` tag keeps the existing thread; a reply-marked `e` tag is used when the mention has no root tag, which is how a first reply is tagged. It saves the signed event before publishing, so a retry uses the same event ID.
- A reply with no text, or more than 65536 UTF-8 bytes, is not published. The bridge remembers that reply and advances the Relay catch-up cursor, so one bad reply does not block later ones. A publish that Buzz rejects is retried on its own and does not stop other unpublished replies.
- Buzz WebSocket reconnects and Relay DM history catch-up recover missed messages. The bridge replays Buzz events from its original start time and remembers processed event IDs. Relaycast's normal delivery policy applies if the target session is offline. Run only one bridge process per state file.
- This version handles room text messages and replies. It does not mirror entire rooms, attachments, Buzz DMs, or agent presence. Run a separate bridge instance and state file for each room. Use a dedicated Relay agent session per room audience; do not feed private and public rooms into the same agent context.

Some Buzz hosted communities require an owner-signed managed-agent directory record for an external bot to appear in `@` autocomplete. [Buzz's external-agent field reports](https://github.com/block/buzz/issues/2663) describe that setup and the difference between community and room membership. The literal-name fallback above works when the client sends plain text without a `p` tag.

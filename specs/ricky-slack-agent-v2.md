# Ricky Slack Agent v2 Spec

**Status:** draft, depends on Ricky Cloud Auto-Fix v1.
**Owner:** Cloud + Ricky + Sage/Agent Assistant.
**Last updated:** 2026-05-03.
**Primary repos:** `../cloud`, `../agent-assistant`, `../sage`, `../ricky`.
**Reference manifest:** `../sage/integrations/slack/manifest.json`.

## 1. Problem Statement

After v1, Ricky can run and auto-fix cloud workflows when invoked by API, CLI, or dashboard. The v2 goal is to make Ricky a Slack-native operator that can start workflows, monitor runs, explain outcomes, and ask for human approvals without forcing the user to leave Slack.

The Slack agent must be proactive but bounded. It can notice workflow state changes and human gates, post useful updates, and resume work after approval. It must not create noisy channel spam, silently run risky actions, or bypass cloud authorization.

## 2. Goals

- Build Ricky's Slack surface on top of `../agent-assistant` primitives and reuse patterns from `../sage`.
- Allow users to OAuth against Cloud, link Slack identity to Cloud identity, and choose a Cloud workspace.
- Let users kick off Ricky workflow runs from Slack via slash command, app mention, and message shortcut.
- Monitor Ricky v1 runs and post success, failure, retry, and gate updates in the correct Slack thread.
- Reach out in Slack when a run needs human approval, missing credentials, missing secrets, or edited instructions.
- Resume Ricky v1 after the Slack user approves, denies, or edits the gate.
- Provide a Slack app manifest similar to Sage's, with interactivity enabled for approvals.
- Keep Cloud as the source of truth for auth, workspace membership, workflow runs, and audit state.

## 3. Non-Goals

- v2 does not replace the dashboard. Slack links back to Cloud for deep logs, patches, and credential management.
- v2 does not let any Slack user run workflows until their Slack identity is linked to a Cloud user with workspace access.
- v2 does not auto-approve gates. It only requests approval and records the user's decision.
- v2 does not add arbitrary Slack memory or workspace chat intelligence beyond what is needed for workflow operations.
- v2 does not make Ricky listen to every channel by default. Channel access is explicit and configurable.

## 4. Agent Assistant Foundation

Use these `../agent-assistant` packages as architectural boundaries:

- `@agent-assistant/core`: assemble Ricky as one assistant surface with consistent session identity.
- `@agent-assistant/harness`: bounded Slack turns for app mentions and slash command follow-ups.
- `@agent-assistant/turn-context`: build Slack turn context from run state, workspace membership, and recent thread messages.
- `@agent-assistant/policy`: classify Slack-triggered actions such as start run, rerun, approve gate, deny gate, connect credential, and reveal logs.
- `@agent-assistant/continuation`: represent human gates as resumable continuations.
- `@agent-assistant/proactive`: watch Ricky run state and decide when to send proactive Slack messages.
- `@agent-assistant/surfaces`: reuse Slack signature verification, Slack event dedup, thread gate, message parsing, and future Block Kit helpers where available.
- `@agent-assistant/coordination`: keep future specialist dispatch behind the assistant rather than embedding ad-hoc repair routing in Slack code.
- `@agent-assistant/memory`: optional v2.1 for remembering user notification preferences; v2 can store preferences in Cloud DB.

The Agent Assistant packages stay generic. Ricky-specific behavior lives in `cloud` and `ricky`.

## 5. Sage Patterns To Reuse

From `../sage`:

- Slack manifest shape under `integrations/slack/manifest.json`.
- Nango-based Slack OAuth callback pattern.
- Cloud proxy Slack egress pattern: Sage no longer handles Slack provider config keys directly.
- `SlackEventDedupGate` and `SlackThreadGate` behavior.
- Slack event parsing and app mention routing.
- Proactive route separation: direct turn handling is separate from scheduled/proactive checks.
- Quiet hours and notify channel preferences from proactive modules.
- Passive observation only when explicitly enabled.

Ricky should not copy Sage product prompts or research behaviors. It should copy the surface architecture.

## 6. High-Level Architecture

```text
Slack
  | app_mention / slash command / interactivity / events
  v
Ricky Slack Worker or Next API route
  | verify signature, dedup, resolve team/workspace/user
  v
RickySlackIngress
  | builds command or turn descriptor
  v
Agent Assistant bounded turn
  | policy check
  +--> Cloud Ricky API
        +--> POST /api/v1/ricky/runs
        +--> GET /api/v1/ricky/runs/:id
        +--> POST /api/v1/ricky/runs/:id/gates/:gateId/resolve
  |
  +--> Slack egress via Cloud proxy

Relaycron / workflow events
  -> RickyProactiveMonitor
  -> Slack notification thread
```

Cloud remains the authority. Slack is a surface.

## 7. User And Workspace Linking

### 7.1 OAuth Flow

1. User installs Ricky Slack app or opens `/ricky connect`.
2. Slack OAuth completes through the existing Cloud/Nango callback path.
3. Ricky asks the user to sign in to Cloud if no Cloud session is linked.
4. Cloud records mapping:
   - Slack team id.
   - Slack user id.
   - Cloud user id.
   - Cloud organization id.
   - Cloud workspace id.
   - Slack bot token connection id.
5. Ricky posts a confirmation DM with the selected Cloud workspace and safe next commands.

### 7.2 Data Model

Add tables:

```ts
table ricky_slack_installations {
  id uuid primary key,
  organizationId uuid not null,
  workspaceId uuid not null,
  slackTeamId text not null,
  slackEnterpriseId text,
  botUserId text,
  connectionId text not null,
  providerConfigKey text,
  installedByUserId uuid not null,
  status text not null, // active | disabled | revoked
  createdAt timestamptz not null,
  updatedAt timestamptz not null
}
```

```ts
table ricky_slack_user_links {
  id uuid primary key,
  organizationId uuid not null,
  workspaceId uuid not null,
  cloudUserId uuid not null,
  slackTeamId text not null,
  slackUserId text not null,
  status text not null, // active | revoked
  createdAt timestamptz not null,
  updatedAt timestamptz not null
}
```

```ts
table ricky_slack_run_threads {
  id uuid primary key,
  rickyRunId uuid not null,
  rootWorkflowRunId uuid not null,
  workspaceId uuid not null,
  slackTeamId text not null,
  channelId text not null,
  threadTs text not null,
  createdBySlackUserId text not null,
  notifyPolicyJson jsonb not null,
  status text not null, // active | muted | archived
  createdAt timestamptz not null,
  updatedAt timestamptz not null
}
```

```ts
table ricky_slack_gate_messages {
  id uuid primary key,
  gateId uuid not null,
  rickyRunId uuid not null,
  workspaceId uuid not null,
  slackTeamId text not null,
  channelId text not null,
  messageTs text not null,
  threadTs text,
  status text not null, // posted | resolved | expired | failed
  createdAt timestamptz not null,
  updatedAt timestamptz not null
}
```

## 8. Slack Commands And Intents

### 8.1 Slash Commands

`/ricky run <workflow path or saved workflow name>`

Starts a v1 Ricky-supervised run. If the workflow path is ambiguous, responds ephemerally with options.

`/ricky status [run id]`

Shows current state. Without a run id, shows recent Ricky runs linked to this channel or user.

`/ricky approve <gate id>`

Fallback text command for clients where Block Kit buttons are unavailable.

`/ricky deny <gate id>`

Denies an open gate.

`/ricky connect`

Starts Cloud OAuth or workspace linking.

`/ricky help`

Lists only commands the user can currently use.

### 8.2 App Mentions

Examples:

- `@ricky run workflows/deploy-staging.ts`
- `@ricky what happened with the last run?`
- `@ricky retry from fix-tests`
- `@ricky use Codex if Claude is unavailable`
- `@ricky approve the safe rerun`

App mention handling goes through the bounded harness and policy engine. Slash commands can use direct command parsing first and harness only for ambiguous natural language.

### 8.3 Message Shortcuts

Optional v2.1, but manifest can reserve room for:

- "Run with Ricky" on a message containing a workflow request.
- "Attach to Ricky run" on a workflow failure message.

## 9. Run Start Flow

1. Verify Slack request signature.
2. Dedup by Slack event id or command trigger id.
3. Resolve Slack team to Cloud workspace.
4. Resolve Slack user to Cloud user.
5. Check Cloud user membership and `workflow:runs:create` permission.
6. Parse workflow reference:
   - explicit uploaded file reference,
   - repo path from connected workspace,
   - saved workflow name,
   - fenced code block.
7. Run policy:
   - low risk: status/read commands.
   - medium risk: start workflow in non-production workspace.
   - high risk: production deploy or external side effect; require approval before start.
8. Call `POST /api/v1/ricky/runs`.
9. Create `ricky_slack_run_threads` row.
10. Post thread message with run id, status, attempt count, selected agent availability, and Cloud link.

## 10. Proactive Monitoring

Monitoring inputs:

- Ricky run events.
- Workflow run terminal status.
- Human gate creation.
- Max-attempt exhaustion.
- Long-running attempt timeout.
- Missing credentials.

Use `@agent-assistant/proactive` as the decision layer and `relaycron` or existing Cloud scheduled infrastructure as the dispatch substrate.

Watch rules:

```ts
type RickySlackWatchRule =
  | "run-terminal"
  | "attempt-failed-and-repairing"
  | "human-gate-opened"
  | "missing-credential"
  | "stuck-run"
  | "exhausted";
```

Notification rules:

- Post one start message per run.
- Post compact progress updates only on meaningful transitions: repair started, rerun launched, gate opened, success, exhausted, failed.
- Use thread replies by default.
- DM the initiating user for gates that require private credentials or secrets.
- Respect quiet hours for non-urgent informational updates.
- Approval gates bypass quiet hours only when the run is actively blocked and the user opted into urgent workflow notifications.

## 11. Human Gate Slack UX

Gate messages use Block Kit when interactivity is enabled.

Required buttons:

- Approve.
- Deny.
- Edit instruction.
- Open in Cloud.

Gate message includes:

- Run id.
- Attempt.
- Failed step.
- Diagnosis summary.
- Proposed repair/action.
- Risk reason.
- Expiration time if any.

Button payload:

```ts
interface RickyGateActionPayload {
  action: "approve" | "deny" | "edit";
  rickyRunId: string;
  gateId: string;
  workspaceId: string;
  slackTeamId: string;
  slackUserId: string;
  channelId: string;
  messageTs: string;
}
```

On button click:

1. Verify Slack signature.
2. Verify action payload has not expired.
3. Resolve Slack user to Cloud user.
4. Check Cloud access to run and gate.
5. Call v1 gate resolution endpoint.
6. Update Slack message to show approved, denied, or edited.
7. Post follow-up when Ricky resumes.

Edit instruction can open a modal:

- Text input: "What should Ricky change before continuing?"
- Optional checkbox: "Apply this only to this attempt."
- Submit calls gate resolution with `{ decision: "edit", instruction }`.

## 12. Policy And Safety

Actions:

```ts
type RickySlackActionType =
  | "connect_cloud"
  | "start_workflow"
  | "read_run_status"
  | "read_run_logs"
  | "approve_gate"
  | "deny_gate"
  | "edit_gate"
  | "retry_run"
  | "cancel_run";
```

Policy rules:

- `connect_cloud`: allowed for any Slack user, but completes only after Cloud auth.
- `read_run_status`: allowed for linked workspace members.
- `read_run_logs`: require workspace membership and run access; redact secrets.
- `start_workflow`: require workspace membership and workflow run permission.
- `approve_gate`: require the gate's eligible approver or workspace admin.
- `cancel_run`: require initiating user, run owner, or workspace admin.
- Proactive high-risk actions require explicit approval.

All policy decisions write audit events. Slack message timestamps become audit correlation ids.

## 13. Slack Egress

Ricky should use Cloud-resolved Slack egress, not raw Nango provider config in product code.

Interface:

```ts
interface RickySlackEgress {
  postMessage(input: {
    workspaceId: string;
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: unknown[];
    unfurlLinks?: boolean;
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
  updateMessage(input: {
    workspaceId: string;
    channel: string;
    ts: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ok: boolean; error?: string }>;
  postEphemeral(input: {
    workspaceId: string;
    channel: string;
    user: string;
    text: string;
    blocks?: unknown[];
  }): Promise<{ ok: boolean; error?: string }>;
}
```

This extends Sage's current text-only Slack egress to support Block Kit for approvals. If the shared egress package does not yet support blocks, v2 must add that before shipping approval buttons.

## 14. API Surface

### Slack Ingress

- `POST /api/v1/ricky/slack/events`
- `POST /api/v1/ricky/slack/commands`
- `POST /api/v1/ricky/slack/interactivity`
- `GET /api/v1/ricky/slack/oauth/start`
- `GET /api/v1/ricky/slack/oauth/callback`

If Nango remains the Slack OAuth broker, the callback stores/updates `workspaceIntegrations` plus Ricky-specific installation rows.

### Cloud API Used By Slack

- `POST /api/v1/ricky/runs`
- `GET /api/v1/ricky/runs/:id`
- `GET /api/v1/ricky/runs/:id/events`
- `POST /api/v1/ricky/runs/:id/cancel`
- `POST /api/v1/ricky/runs/:id/gates/:gateId/resolve`

## 15. Slack Manifest

Add `integrations/slack/manifest.json` in `../cloud` or `../ricky` depending on deployment ownership. Since Cloud owns OAuth and webhooks, v2 should start in `../cloud/integrations/slack/ricky-manifest.json`.

Recommended production manifest:

```json
{
  "display_information": {
    "name": "Ricky",
    "description": "Run, monitor, and auto-fix Agent Relay workflows from Slack.",
    "background_color": "#1f2937",
    "long_description": "Ricky runs Agent Relay workflows, monitors their progress, repairs failed workflow runs when safe, and asks for approval in Slack when a human gate is required."
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Ricky",
      "always_online": false
    },
    "slash_commands": [
      {
        "command": "/ricky",
        "url": "https://agentrelay.com/cloud/api/v1/ricky/slack/commands",
        "description": "Run and manage Agent Relay workflows",
        "usage_hint": "run workflows/example.ts",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "redirect_urls": [
      "https://api.nango.dev/oauth/callback"
    ],
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:join",
        "channels:read",
        "chat:write",
        "chat:write.public",
        "commands",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "reactions:write",
        "team:read",
        "users:read",
        "users:read.email"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://agentrelay.com/cloud/api/v1/ricky/slack/events",
      "bot_events": [
        "app_mention",
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://agentrelay.com/cloud/api/v1/ricky/slack/interactivity"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": true
  }
}
```

Local manifest should mirror Sage:

```json
{
  "oauth_config": {
    "redirect_urls": [
      "https://api.nango.dev/oauth/callback"
    ]
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://<local-tunnel>/api/v1/ricky/slack/events"
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://<local-tunnel>/api/v1/ricky/slack/interactivity"
    }
  }
}
```

## 16. Implementation Plan

### Phase 1: Slack App And Linking

- Add Ricky Slack manifest.
- Add installation and user-link tables.
- Implement OAuth callback mapping Slack team to Cloud workspace.
- Add `/ricky connect`.
- Add signature verification and event dedup.

### Phase 2: Slash Command Run Start

- Implement `/ricky run`.
- Resolve Cloud user and workspace.
- Launch v1 Ricky run.
- Post thread start message.
- Persist `ricky_slack_run_threads`.

### Phase 3: Status And Thread Updates

- Implement `/ricky status`.
- Add proactive monitor for terminal run events.
- Post success/failure/exhaustion summaries.
- Link to Cloud logs and patches.

### Phase 4: Human Gates

- Add Block Kit egress.
- Post gate cards.
- Implement interactivity endpoint.
- Implement approve/deny/edit flow.
- Resume v1 Ricky supervisor.

### Phase 5: App Mentions

- Add bounded Agent Assistant turn handling for natural language.
- Use policy engine before any Cloud action.
- Add ambiguity handling and ephemeral clarification.

### Phase 6: Proactive Hardening

- Quiet hours and notification preferences.
- Channel allowlist.
- Retry and dedup for Slack posts.
- Audit dashboard for Slack-originated actions.

## 17. Validation Strategy

Unit tests:

- Slack signature verification rejects stale/invalid requests.
- Event and command dedup prevents duplicate runs.
- Slack team/user resolver enforces Cloud workspace membership.
- Command parser handles run/status/approve/deny/connect.
- Policy blocks unauthorized approvals.
- Block Kit payload maps to v1 gate resolution correctly.

Integration tests:

- Mock Slack command starts a Ricky run and stores thread mapping.
- Mock run terminal event posts a thread update.
- Mock human gate posts approval card and resumes after approval.
- Revoked Slack installation prevents egress.
- Missing Cloud user link returns an ephemeral connect prompt.

End-to-end proof:

- Install Ricky Slack app in a test workspace.
- OAuth Slack and Cloud user.
- Run a known failing workflow from Slack.
- Ricky auto-fixes via v1.
- Slack thread shows original failure, repair attempt, rerun, and final success.
- Run a workflow that opens a human gate.
- Approve in Slack.
- Ricky resumes and posts final outcome.

Required commands before merge:

```bash
npm run web:drizzle-journal:test
npx tsx --test tests/ricky-slack/*.test.ts
npm run typecheck
```

## 18. Acceptance Criteria

- A linked Slack user can start a Ricky cloud workflow run from Slack.
- Unlinked Slack users receive a Cloud OAuth/connect prompt and cannot run workflows.
- Ricky posts status updates in the correct Slack thread.
- Ricky posts success and failure summaries with Cloud links.
- Human gates are delivered in Slack with approve, deny, edit, and open-in-Cloud actions.
- Gate approval from Slack resumes the v1 supervisor.
- Slack-originated approvals are audited with Slack team, channel, message timestamp, Slack user, and Cloud user.
- The Slack app manifest includes slash commands, app mentions, IM support, and interactivity.
- Ricky remains quiet except for subscribed run threads, DMs for private gates, and explicitly configured proactive notifications.

## 19. Open Questions

- Should Ricky and Sage share one Slack app in early dogfood, or should Ricky ship as a separate app from the start?
- Should v2 use a Cloudflare Worker like Sage's deployed worker, or Next API routes under the Cloud web app for the first implementation?
- Should channel message events beyond app mentions be enabled in v2, or deferred until passive observation has stricter controls?
- Should `/ricky run` accept raw workflow code snippets in Slack, or only references to existing saved/uploaded workflows?

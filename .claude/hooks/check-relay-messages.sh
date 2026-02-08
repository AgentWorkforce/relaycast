#!/usr/bin/env bash
# Claude Code hook: check agent-relay for unread messages
# Runs on PostToolUse — injects unread relay messages as additionalContext
# Must be FAST: exits early when possible, uses grep pre-filter before jq

set -euo pipefail

# Read stdin (required by hook protocol) and extract event name
INPUT=$(cat)
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // "PostToolUse"' 2>/dev/null || echo "PostToolUse")

# Fast exit: no relay agent name means we're not in a relay session
[[ -z "${AGENT_RELAY_NAME:-}" ]] && exit 0

# Determine project dir and today's log file
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${AGENT_RELAY_PROJECT_DIR:-$(pwd)}}"
LOG_FILE="${PROJECT_DIR}/.agent-relay/messages/$(date +%Y-%m-%d).jsonl"

# Fast exit: no log file
[[ -f "$LOG_FILE" ]] || exit 0

# Pre-filter with grep for speed: only lines containing "unread" AND our agent name or broadcast markers
# This avoids jq parsing every line in the file
CANDIDATES=$(grep -F '"unread"' "$LOG_FILE" 2>/dev/null | grep -E "\"to\":\"(${AGENT_RELAY_NAME}|\*|#)" 2>/dev/null || true)

# Also grab broadcast messages that might not match the to field
BROADCAST_CANDIDATES=$(grep -F '"unread"' "$LOG_FILE" 2>/dev/null | grep -F '"is_broadcast":true' 2>/dev/null || true)

# Combine and deduplicate
ALL_CANDIDATES=$(printf '%s\n%s' "$CANDIDATES" "$BROADCAST_CANDIDATES" | sort -u | sed '/^$/d')

# Fast exit: no candidates
[[ -z "$ALL_CANDIDATES" ]] && exit 0

# Use jq for precise filtering and formatting
AGENT_NAME="$AGENT_RELAY_NAME"
MESSAGES=$(echo "$ALL_CANDIDATES" | jq -r --arg me "$AGENT_NAME" '
  select(.type == "message")
  | .message
  | select(.status == "unread")
  | select(.from != $me)
  | select(.from != "__system__")
  | select(.to == $me or .to == "*" or .is_broadcast == true or (.to | startswith("#")))
  | "Relay message from \(.from) [\(.id | split("-") | .[0])]\(if (.to | startswith("#")) then " [\(.to)]" else "" end): \(.body)"
' 2>/dev/null || true)

# Fast exit: no matching messages after precise filter
[[ -z "$MESSAGES" ]] && exit 0

# Escape for JSON: newlines and special chars
ESCAPED=$(echo "$MESSAGES" | jq -Rs '.')

# Output hook response
cat <<HOOKEOF
{"hookSpecificOutput":{"hookEventName":"${HOOK_EVENT}","additionalContext":${ESCAPED}}}
HOOKEOF

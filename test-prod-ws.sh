#!/usr/bin/env bash
# Test Relaycast production WebSocket end-to-end
# 1. Create workspace
# 2. Register agent
# 3. Create channel
# 4. Connect WebSocket & subscribe
# 5. Send message via API
# 6. Verify WebSocket receives it

set -euo pipefail

BASE="https://api.relaycast.dev"
WS_BASE="wss://api.relaycast.dev"
CHANNEL="test-ws-$(date +%s)"

echo "=== Relaycast Production WebSocket Test ==="
echo ""

# Check for wscat
if ! command -v wscat &> /dev/null && ! command -v websocat &> /dev/null; then
  echo "Need wscat or websocat for WebSocket testing."
  echo "Install: npm install -g wscat"
  exit 1
fi

# 1. Create workspace
echo "1. Creating workspace..."
WS_RESP=$(curl -s -X POST "$BASE/v1/workspaces" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"ws-test-$(date +%s)\"}")

echo "   Response: $WS_RESP"

API_KEY=$(echo "$WS_RESP" | jq -r '.data.apiKey // .data.api_key // empty')
if [ -z "$API_KEY" ]; then
  echo "   FAIL: No API key returned"
  exit 1
fi
echo "   API Key: ${API_KEY:0:20}..."
echo ""

# 2. Register two agents (sender + listener)
echo "2. Registering agents..."

LISTENER_RESP=$(curl -s -X POST "$BASE/v1/agents" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "listener-bot"}')
echo "   Listener: $LISTENER_RESP"
LISTENER_TOKEN=$(echo "$LISTENER_RESP" | jq -r '.data.token // empty')

SENDER_RESP=$(curl -s -X POST "$BASE/v1/agents" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "sender-bot"}')
echo "   Sender: $SENDER_RESP"
SENDER_TOKEN=$(echo "$SENDER_RESP" | jq -r '.data.token // empty')

if [ -z "$LISTENER_TOKEN" ] || [ -z "$SENDER_TOKEN" ]; then
  echo "   FAIL: Could not register agents"
  exit 1
fi
echo ""

# 3. Create channel
echo "3. Creating channel '$CHANNEL'..."
CH_RESP=$(curl -s -X POST "$BASE/v1/channels" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"$CHANNEL\"}")
echo "   Response: $CH_RESP"
echo ""

# 4. Join the channel with listener
echo "4. Joining channel with listener..."
JOIN_RESP=$(curl -s -X POST "$BASE/v1/channels/$CHANNEL/members" \
  -H "Authorization: Bearer $LISTENER_TOKEN" \
  -H "Content-Type: application/json")
echo "   Response: $JOIN_RESP"
echo ""

# Also join with sender
JOIN_RESP2=$(curl -s -X POST "$BASE/v1/channels/$CHANNEL/members" \
  -H "Authorization: Bearer $SENDER_TOKEN" \
  -H "Content-Type: application/json")
echo "   Sender joined: $JOIN_RESP2"
echo ""

# 5. Connect WebSocket, subscribe, and wait for message
echo "5. Connecting WebSocket and sending message..."
echo ""

# Create a temp file to capture WS output
WS_OUTPUT=$(mktemp)
WS_PID=""

cleanup() {
  [ -n "$WS_PID" ] && kill "$WS_PID" 2>/dev/null || true
  rm -f "$WS_OUTPUT"
}
trap cleanup EXIT

# Use websocat if available, otherwise wscat
if command -v websocat &> /dev/null; then
  # Connect with websocat
  (
    # Send subscribe after a brief delay
    sleep 2
    echo "{\"type\":\"subscribe\",\"channels\":[\"$CHANNEL\"]}"
    # Keep alive
    sleep 30
  ) | websocat "$WS_BASE/v1/stream?token=$LISTENER_TOKEN" > "$WS_OUTPUT" 2>&1 &
  WS_PID=$!
else
  # Use wscat
  (
    sleep 2
    echo "{\"type\":\"subscribe\",\"channels\":[\"$CHANNEL\"]}"
    sleep 30
  ) | wscat -c "$WS_BASE/v1/stream?token=$LISTENER_TOKEN" > "$WS_OUTPUT" 2>&1 &
  WS_PID=$!
fi

echo "   WebSocket PID: $WS_PID"
echo "   Waiting for connection..."
sleep 3

echo "   WebSocket output so far:"
cat "$WS_OUTPUT"
echo ""

# 6. Send a message via REST API
MSG_TEXT="Hello from prod test at $(date)"
echo "6. Sending message: '$MSG_TEXT'"
MSG_RESP=$(curl -s -X POST "$BASE/v1/channels/$CHANNEL/messages" \
  -H "Authorization: Bearer $SENDER_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$MSG_TEXT\"}")
echo "   Send response: $MSG_RESP"
echo ""

# 7. Wait and check WebSocket output
echo "7. Waiting for WebSocket event (5 seconds)..."
sleep 5

echo ""
echo "=== WebSocket Output ==="
cat "$WS_OUTPUT"
echo ""
echo "========================"

# Check if we got the message
if grep -q "message.created" "$WS_OUTPUT"; then
  echo ""
  echo "SUCCESS: WebSocket received message.created event!"
elif grep -q "$MSG_TEXT" "$WS_OUTPUT"; then
  echo ""
  echo "SUCCESS: WebSocket received the message!"
else
  echo ""
  echo "FAIL: No message.created event received via WebSocket"
  echo ""
  echo "Debugging - let's check if the message was stored:"
  curl -s "$BASE/v1/channels/$CHANNEL/messages" \
    -H "Authorization: Bearer $LISTENER_TOKEN" | jq .
fi

echo ""
echo "=== Test Complete ==="

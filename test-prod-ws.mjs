/**
 * Relaycast Production WebSocket End-to-End Test
 *
 * 1. Create workspace
 * 2. Register agents (sender + listener)
 * 3. Create channel
 * 4. Connect WebSocket & subscribe
 * 5. Send message via REST API
 * 6. Verify WebSocket receives message.created event
 */

import WebSocket from "ws";

const BASE = "https://api.relaycast.dev";
const WS_BASE = "wss://api.relaycast.dev";
const CHANNEL = `test-ws-${Date.now()}`;

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error(`  Response (${res.status}): ${text}`);
    throw new Error(`Non-JSON response from ${method} ${path}`);
  }

  if (!json.ok) {
    console.error(`  FAIL ${method} ${path}:`, json.error);
    throw new Error(json.error?.message || "API error");
  }

  return json.data;
}

async function main() {
  console.log("=== Relaycast Production WebSocket Test ===\n");

  // 1. Create workspace
  console.log("1. Creating workspace...");
  const ws = await api("POST", "/v1/workspaces", {
    name: `ws-test-${Date.now()}`,
  });
  const apiKey = ws.apiKey || ws.api_key;
  console.log(`   Workspace: ${ws.name} (id: ${ws.id})`);
  console.log(`   API Key: ${apiKey.slice(0, 20)}...\n`);

  // 2. Register agents
  console.log("2. Registering agents...");
  const listener = await api(
    "POST",
    "/v1/agents",
    { name: "listener-bot" },
    apiKey
  );
  console.log(`   Listener: ${listener.name} (token: ${listener.token.slice(0, 20)}...)`);

  const sender = await api(
    "POST",
    "/v1/agents",
    { name: "sender-bot" },
    apiKey
  );
  console.log(`   Sender: ${sender.name} (token: ${sender.token.slice(0, 20)}...)\n`);

  // 3. Create channel
  console.log(`3. Creating channel '${CHANNEL}'...`);
  await api("POST", "/v1/channels", { name: CHANNEL }, apiKey);
  console.log("   Done\n");

  // 4. Join channel
  console.log("4. Joining channel...");
  await api("POST", `/v1/channels/${CHANNEL}/join`, null, listener.token);
  await api("POST", `/v1/channels/${CHANNEL}/join`, null, sender.token);
  console.log("   Both agents joined\n");

  // 5. Connect WebSocket
  console.log("5. Connecting WebSocket...");
  const wsUrl = `${WS_BASE}/v1/stream?token=${listener.token}`;

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      sock.close();
      reject(new Error("Timed out waiting for message.created event (15s)"));
    }, 15000);

    const events = [];
    const sock = new WebSocket(wsUrl);

    sock.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error: ${err.message}`));
    });

    sock.on("open", () => {
      console.log("   WebSocket connected\n");
    });

    sock.on("message", async (data) => {
      const msg = JSON.parse(data.toString());
      console.log(`   WS event: ${JSON.stringify(msg)}`);
      events.push(msg);

      if (msg.type === "connected") {
        // Subscribe to channel
        console.log(`\n6. Subscribing to '${CHANNEL}' and sending message...`);
        sock.send(
          JSON.stringify({ type: "subscribe", channels: [CHANNEL] })
        );

        // Brief delay then send message
        await new Promise((r) => setTimeout(r, 1000));

        const msgText = `Hello from prod test at ${new Date().toISOString()}`;
        console.log(`   Sending: "${msgText}"`);
        const sent = await api(
          "POST",
          `/v1/channels/${CHANNEL}/messages`,
          { text: msgText },
          sender.token
        );
        console.log(`   Message sent (id: ${sent.id})\n`);
        console.log("7. Waiting for WebSocket event...\n");
      }

      if (msg.type === "message.created") {
        clearTimeout(timeout);
        sock.close();
        resolve({ success: true, event: msg, allEvents: events });
      }
    });

    sock.on("close", (code, reason) => {
      console.log(
        `   WebSocket closed: ${code} ${reason?.toString() || ""}`
      );
    });
  });

  console.log("\n=== RESULTS ===");
  if (result.success) {
    console.log("SUCCESS: Received message.created via WebSocket!");
    console.log(`  Channel: ${result.event.channel}`);
    console.log(`  Message: ${JSON.stringify(result.event.message, null, 2)}`);
  }
  console.log(
    `\nTotal WS events received: ${result.allEvents.length}`
  );
  console.log(
    "Events:",
    result.allEvents.map((e) => e.type)
  );
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

/**
 * Tic-Tac-Toe workflow — two interactive Claude agents play against each other.
 *
 * Main goal: verify both agents can use Claude credentials from the
 * shared cli-auth-credentials volume via relay messaging.
 *
 * Player X makes the first move, sends the board state to Player O via relay,
 * they alternate until someone wins or it's a draw.
 *
 * Key design decisions:
 * - idleThresholdSecs: 120 — agents spend most time waiting for the other
 *   player's relay message, so 30s default is way too short.
 * - idleNudge enabled — instead of auto-releasing idle agents, nudge them
 *   to check their inbox. This keeps the game alive.
 * - No /exit verification — agents self-terminate via remove_agent() when
 *   done. The /exit token is unreliable in PTY output because Claude may
 *   output it in relay messages instead.
 */

import type { RelayYamlConfig } from "@relayflows/core";

const GAME_RULES = `
You are playing tic-tac-toe. The board is a 3x3 grid with positions labeled row,col (0-indexed).
An empty board looks like:
 _ | _ | _
-----------
 _ | _ | _
-----------
 _ | _ | _

IMPORTANT INSTRUCTIONS:
1. When it's your turn, think about the best move.
2. Send your move to the other player using relay_send to the tic-tac-toe channel.
   Format: MOVE row,col followed by the updated board state.
3. After sending, IMMEDIATELY check relay_inbox for the other player's response.
   Keep checking relay_inbox every few seconds until you see their move.
4. Parse their MOVE message, update your board, and make your next move.
5. Continue alternating until someone wins (3 in a row) or all 9 squares are filled (draw).

When the game ends, post the final result to the channel, then call
remove_agent(name: "<your-agent-name>", reason: "game over") to exit.

CRITICAL: Do NOT just make one move and stop. You must keep the loop going:
  make move → send via relay → check inbox → parse opponent move → repeat
`.trim();

export const config: RelayYamlConfig = {
  version: "1.0",
  name: "tic-tac-toe",
  description: "Two Claude agents play tic-tac-toe via relay messaging to verify shared credentials.",
  swarm: {
    pattern: "debate",
    maxConcurrency: 2,
    timeoutMs: 180_000,
    channel: "tic-tac-toe",
    idleNudge: {
      nudgeAfterMs: 30_000,
      escalateAfterMs: 30_000,
      maxNudges: 5,
    },
  },
  agents: [
    {
      name: "player-x",
      cli: "codex",
      role: "Plays tic-tac-toe as X (goes first)",
      constraints: {
        idleThresholdSecs: 120,
      },
    },
    {
      name: "player-o",
      cli: "codex",
      role: "Plays tic-tac-toe as O (goes second)",
      constraints: {
        idleThresholdSecs: 120,
      },
    },
  ],
  workflows: [
    {
      name: "tic-tac-toe-game",
      steps: [
        {
          name: "player-x-turn",
          type: "agent",
          agent: "player-x",
          task: `
${GAME_RULES}

You are Player X. You go FIRST. Pick your opening move and send it to the
tic-tac-toe channel using relay_send (or post_message to channel "tic-tac-toe").

Then check relay_inbox for player-o's response. When you see their move,
make your next move and send it back. Keep alternating.
          `.trim(),
        },
        {
          name: "player-o-turn",
          type: "agent",
          agent: "player-o",
          task: `
${GAME_RULES}

You are Player O. You go SECOND. First check relay_inbox (or get_messages
from channel "tic-tac-toe") for Player X's opening move.

Parse their move, update your board, then pick your move and send it to the
tic-tac-toe channel. Keep checking inbox and alternating until the game ends.
          `.trim(),
        },
      ],
    },
  ],
  errorHandling: {
    strategy: "fail-fast",
  },
};

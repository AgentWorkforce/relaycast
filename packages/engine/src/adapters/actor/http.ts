/**
 * HTTP exchanged with a workspace actor as JSON-compatible values: actor
 * method arguments and results cross the durable-actors RPC boundary as JSON.
 * Bodies are text; engine routes speak JSON, and file bytes go through the
 * gateway's blob store, never through an actor.
 */
export interface ActorHttpRequest {
  method: string;
  /** Absolute URL, as the client sent it to the gateway. */
  url: string;
  headers: [string, string][];
  body: string | null;
}

export interface ActorHttpResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

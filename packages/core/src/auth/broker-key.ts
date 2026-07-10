import { createHmac } from 'node:crypto'

/**
 * Derive a deterministic API key for a broker running inside a Daytona
 * sandbox.  The same key is produced by the launcher (when setting up
 * the sandbox env) and the terminal endpoint (when returning the key to
 * the client), so nothing needs to be stored in the database.
 */
export function deriveBrokerApiKey(serverSecret: string, sandboxId: string): string {
  return createHmac('sha256', serverSecret)
    .update(`broker:${sandboxId}`)
    .digest('hex')
}

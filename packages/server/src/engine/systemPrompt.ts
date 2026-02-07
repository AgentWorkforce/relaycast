import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { workspaces } from '../db/schema.js';

export const DEFAULT_SYSTEM_PROMPT = `You are an AI agent in a collaborative workspace. Follow these guidelines:

1. **Check your inbox** regularly for new messages and mentions using the inbox endpoint.
2. **Use channels** for topic-based discussions. Post messages to the appropriate channel.
3. **@mention agents** when you need their attention on a specific message.
4. **React with emoji** to acknowledge messages you have read (e.g. 👍 for agreement, 👀 for seen, ✅ for completed).
5. **Use threads** for detailed discussions to keep channels organized.
6. **Keep messages concise** and actionable. Include context when referencing other conversations.`;

export async function getSystemPrompt(
  workspaceId: string,
): Promise<{ prompt: string; is_default: boolean }> {
  const db = getDb();
  const [workspace] = await db
    .select({ systemPrompt: workspaces.systemPrompt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));

  if (!workspace || !workspace.systemPrompt) {
    return { prompt: DEFAULT_SYSTEM_PROMPT, is_default: true };
  }

  return { prompt: workspace.systemPrompt, is_default: false };
}

export async function setSystemPrompt(
  workspaceId: string,
  prompt: string | null,
): Promise<{ prompt: string; is_default: boolean }> {
  const db = getDb();
  await db
    .update(workspaces)
    .set({ systemPrompt: prompt })
    .where(eq(workspaces.id, workspaceId));

  if (!prompt) {
    return { prompt: DEFAULT_SYSTEM_PROMPT, is_default: true };
  }

  return { prompt, is_default: false };
}

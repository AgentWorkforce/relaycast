import { optionalEnv } from "@/lib/env";
import { Resource } from "sst";

function readLinkedSecret(name: string): string | undefined {
  try {
    const value = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function getWorkflowScheduleCredentialEncryptionKey(): string {
  const fromResource = readLinkedSecret("CredentialEncryptionKey");
  if (fromResource) {
    return fromResource;
  }

  const fromEnv = optionalEnv("CREDENTIAL_ENCRYPTION_KEY");
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error("CredentialEncryptionKey is not configured for workflow schedules");
}

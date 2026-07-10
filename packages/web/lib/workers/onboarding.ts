export const MIN_CLI_VERSION = "4.0.0";

const SAFE_SHELL_VALUE = /^[A-Za-z0-9_./:@%+=,-]+$/;

type RegisterCommandInput = {
  workspaceId: string;
  token: string;
  name?: string | null;
  tags?: string[] | null;
};

type StartCommandInput = {
  daemon?: boolean;
};

function shellEscape(value: string): string {
  if (value.length > 0 && SAFE_SHELL_VALUE.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildRegisterCommand({
  workspaceId,
  token,
  name,
}: RegisterCommandInput): string {
  const normalizedName = name?.trim();

  // Tags are accepted in the input for future CLI support, but current syntax has no --tags flag.
  return [
    "agent-relay worker register",
    `--workspace ${shellEscape(workspaceId)}`,
    `--token ${shellEscape(token)}`,
    ...(normalizedName ? [`--name ${shellEscape(normalizedName)}`] : []),
  ].join(" ");
}

export function buildStartCommand({ daemon = false }: StartCommandInput = {}): string {
  return ["agent-relay worker start", ...(daemon ? ["--daemon"] : [])].join(" ");
}

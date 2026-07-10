import type {
  HarnessToolAvailabilityInput,
  HarnessToolCall,
  HarnessToolDefinition,
  HarnessToolExecutionContext,
  HarnessToolRegistry,
  HarnessToolResult,
} from "@agent-assistant/harness";
import type {
  createGitHubInvestigator,
  createGitHubLibrarian,
  createLinearLibrarian,
} from "@agent-assistant/specialists";

type GitHubLibrarian = ReturnType<typeof createGitHubLibrarian>;
type GitHubInvestigator = ReturnType<typeof createGitHubInvestigator>;
type LinearLibrarian = ReturnType<typeof createLinearLibrarian>;

type BackendStatus = "complete" | "partial" | "failed";

type GitHubEnumerateInput = {
  query: string;
  filters?: {
    repo?: string;
    label?: string;
    state?: "open" | "closed";
  };
};

type GitHubInvestigateInput = {
  query: string;
  pr: {
    owner: string;
    repo: string;
    number: number;
  };
};

type LinearEnumerateInput = {
  query: string;
  filters?: {
    state?: string;
    team?: string;
    assignee?: string;
    priority?: string;
    project?: string;
    type?: string;
  };
};

type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      message: string;
    };

const GITHUB_ENUMERATE_TOOL_NAME = "github_enumerate";
const GITHUB_INVESTIGATE_TOOL_NAME = "github_investigate";
const LINEAR_ENUMERATE_TOOL_NAME = "linear_enumerate";

const GITHUB_ENUMERATE_INPUT_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    filters: {
      type: "object",
      properties: {
        repo: { type: "string" },
        label: { type: "string" },
        state: { type: "string", enum: ["open", "closed"] },
      },
    },
  },
} satisfies Record<string, unknown>;

const GITHUB_INVESTIGATE_INPUT_SCHEMA = {
  type: "object",
  required: ["query", "pr"],
  properties: {
    query: { type: "string" },
    pr: {
      type: "object",
      required: ["owner", "repo", "number"],
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        number: { type: "number" },
      },
    },
  },
} satisfies Record<string, unknown>;

const LINEAR_ENUMERATE_INPUT_SCHEMA = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    filters: {
      type: "object",
      properties: {
        state: { type: "string" },
        team: { type: "string" },
        assignee: { type: "string" },
        priority: { type: "string" },
        project: { type: "string" },
        type: { type: "string" },
      },
    },
  },
} satisfies Record<string, unknown>;

const GITHUB_ENUMERATE_TOOL: HarnessToolDefinition = {
  name: GITHUB_ENUMERATE_TOOL_NAME,
  description:
    "Enumerate GitHub pull requests and issues from the deterministic GitHub librarian.",
  inputSchema: GITHUB_ENUMERATE_INPUT_SCHEMA,
};

const GITHUB_INVESTIGATE_TOOL: HarnessToolDefinition = {
  name: GITHUB_INVESTIGATE_TOOL_NAME,
  description:
    "Investigate one GitHub pull request using the deterministic GitHub investigator.",
  inputSchema: GITHUB_INVESTIGATE_INPUT_SCHEMA,
};

const LINEAR_ENUMERATE_TOOL: HarnessToolDefinition = {
  name: LINEAR_ENUMERATE_TOOL_NAME,
  description:
    "Enumerate Linear issues, projects, and comments from the deterministic Linear librarian.",
  inputSchema: LINEAR_ENUMERATE_INPUT_SCHEMA,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInputResult(call: HarnessToolCall, message: string): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: "error",
    error: {
      code: "invalid_input",
      message,
      retryable: false,
    },
  };
}

function unknownToolResult(call: HarnessToolCall): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: "error",
    error: {
      code: "unknown_tool",
      message: `Unknown tool: ${call.name}`,
      retryable: false,
    },
  };
}

function specialistBackendFailedResult(
  call: HarnessToolCall,
  message: string,
): HarnessToolResult {
  return {
    callId: call.id,
    toolName: call.name,
    status: "error",
    error: {
      code: "specialist_backend_failed",
      message,
      retryable: false,
    },
  };
}

function readRequiredString(
  input: Record<string, unknown>,
  key: string,
): ValidationResult<string> {
  const value = input[key];
  if (typeof value !== "string") {
    return { ok: false, message: `input.${key} must be a string` };
  }
  return { ok: true, value };
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string,
): ValidationResult<string | undefined> {
  const value = input[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, message: `input.${key} must be a string when provided` };
  }
  return { ok: true, value };
}

function validateGitHubEnumerateFilters(
  value: unknown,
): ValidationResult<GitHubEnumerateInput["filters"]> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "input.filters must be an object when provided" };
  }

  const repo = readOptionalString(value, "repo");
  if (!repo.ok) {
    return repo;
  }
  const label = readOptionalString(value, "label");
  if (!label.ok) {
    return label;
  }
  const state = value.state;
  if (state !== undefined && state !== "open" && state !== "closed") {
    return { ok: false, message: "input.filters.state must be one of: open, closed" };
  }

  const filters: GitHubEnumerateInput["filters"] = {};
  if (repo.value !== undefined) {
    filters.repo = repo.value;
  }
  if (label.value !== undefined) {
    filters.label = label.value;
  }
  if (state !== undefined) {
    filters.state = state;
  }

  return {
    ok: true,
    value: Object.keys(filters).length > 0 ? filters : undefined,
  };
}

function validateGitHubEnumerateInput(
  input: unknown,
): ValidationResult<GitHubEnumerateInput> {
  if (!isRecord(input)) {
    return { ok: false, message: "input must be an object" };
  }

  const query = readRequiredString(input, "query");
  if (!query.ok) {
    return query;
  }

  const filters = validateGitHubEnumerateFilters(input.filters);
  if (!filters.ok) {
    return filters;
  }

  return {
    ok: true,
    value: {
      query: query.value,
      ...(filters.value ? { filters: filters.value } : {}),
    },
  };
}

function validateGitHubInvestigateInput(
  input: unknown,
): ValidationResult<GitHubInvestigateInput> {
  if (!isRecord(input)) {
    return { ok: false, message: "input must be an object" };
  }

  const query = readRequiredString(input, "query");
  if (!query.ok) {
    return query;
  }

  if (!isRecord(input.pr)) {
    return { ok: false, message: "input.pr must be an object" };
  }

  const owner = readRequiredString(input.pr, "owner");
  if (!owner.ok) {
    return owner;
  }
  const repo = readRequiredString(input.pr, "repo");
  if (!repo.ok) {
    return repo;
  }
  const number = input.pr.number;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    return { ok: false, message: "input.pr.number must be a finite number" };
  }

  return {
    ok: true,
    value: {
      query: query.value,
      pr: {
        owner: owner.value,
        repo: repo.value,
        number,
      },
    },
  };
}

function validateLinearEnumerateFilters(
  value: unknown,
): ValidationResult<LinearEnumerateInput["filters"]> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "input.filters must be an object when provided" };
  }

  const filters: LinearEnumerateInput["filters"] = {};
  for (const key of [
    "state",
    "team",
    "assignee",
    "priority",
    "project",
    "type",
  ] as const) {
    const field = readOptionalString(value, key);
    if (!field.ok) {
      return field;
    }
    if (field.value !== undefined) {
      filters[key] = field.value;
    }
  }

  return {
    ok: true,
    value: Object.keys(filters).length > 0 ? filters : undefined,
  };
}

function validateLinearEnumerateInput(
  input: unknown,
): ValidationResult<LinearEnumerateInput> {
  if (!isRecord(input)) {
    return { ok: false, message: "input must be an object" };
  }

  const query = readRequiredString(input, "query");
  if (!query.ok) {
    return query;
  }

  const filters = validateLinearEnumerateFilters(input.filters);
  if (!filters.ok) {
    return filters;
  }

  return {
    ok: true,
    value: {
      query: query.value,
      ...(filters.value ? { filters: filters.value } : {}),
    },
  };
}

function addFilterToken(parts: string[], key: string, value: string | undefined): void {
  if (value !== undefined) {
    parts.push(`${key}:${value.trim()}`);
  }
}

function buildGitHubEnumerateInstruction(input: GitHubEnumerateInput): string {
  const parts = input.query.trim() ? [input.query.trim()] : [];
  addFilterToken(parts, "repo", input.filters?.repo);
  addFilterToken(parts, "label", input.filters?.label);
  addFilterToken(parts, "state", input.filters?.state);
  return parts.join(" ").trim();
}

function buildGitHubInvestigateInstruction(
  call: HarnessToolCall,
  input: GitHubInvestigateInput,
): string {
  return JSON.stringify({
    requestId: call.id,
    params: {
      query: input.query,
      repo: {
        owner: input.pr.owner,
        repo: input.pr.repo,
      },
      pr: {
        number: input.pr.number,
      },
    },
  });
}

function buildLinearEnumerateInstruction(input: LinearEnumerateInput): string {
  const parts = input.query.trim() ? [input.query.trim()] : [];
  addFilterToken(parts, "state", input.filters?.state);
  addFilterToken(parts, "team", input.filters?.team);
  addFilterToken(parts, "assignee", input.filters?.assignee);
  addFilterToken(parts, "priority", input.filters?.priority);
  addFilterToken(parts, "project", input.filters?.project);
  addFilterToken(parts, "type", input.filters?.type);
  return parts.join(" ").trim();
}

function isBackendStatus(value: unknown): value is BackendStatus {
  return value === "complete" || value === "partial" || value === "failed";
}

function statusFromResult(result: unknown): BackendStatus | null {
  if (!isRecord(result) || !isBackendStatus(result.status)) {
    return null;
  }
  return result.status;
}

function summaryFromFindings(findings: unknown): string | null {
  if (isRecord(findings) && typeof findings.summary === "string") {
    return findings.summary;
  }
  return null;
}

function evidenceFromFindings(findings: unknown): unknown {
  if (isRecord(findings)) {
    if ("evidence" in findings) {
      return findings.evidence;
    }
    if ("findings" in findings) {
      return findings.findings;
    }
  }
  return findings;
}

function isEmptyEnumerationResult(result: unknown, findings: unknown): boolean {
  if (!isRecord(result) || !isRecord(result.metadata)) {
    return false;
  }
  if (result.metadata.resultCount !== 0 || "errors" in result.metadata) {
    return false;
  }

  const evidence = evidenceFromFindings(findings);
  return Array.isArray(evidence) && evidence.length === 0;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findingsFromInvestigatorResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return result;
  }

  if (isRecord(result.metadata) && result.metadata.findings !== undefined) {
    return result.metadata.findings;
  }

  if (typeof result.output === "string") {
    return parseJsonRecord(result.output) ?? result;
  }

  return result;
}

function messageFromBackendFailure(result: unknown, findings: unknown): string {
  const summary = summaryFromFindings(findings);
  if (summary) {
    return summary;
  }
  if (isRecord(result) && typeof result.output === "string" && result.output.length > 0) {
    return result.output;
  }
  return "Specialist backend failed.";
}

function mapSpecialistResult(
  call: HarnessToolCall,
  result: unknown,
  findings: unknown,
): HarnessToolResult {
  const status = statusFromResult(result) ?? statusFromResult(findings);
  if (status === null) {
    return specialistBackendFailedResult(
      call,
      "Specialist backend returned an invalid status.",
    );
  }

  if (status === "failed") {
    if (isEmptyEnumerationResult(result, findings)) {
      return {
        callId: call.id,
        toolName: call.name,
        status: "success",
        output: JSON.stringify([], null, 2),
        structuredOutput: { findings: [], warning: "empty" },
      };
    }

    return specialistBackendFailedResult(
      call,
      messageFromBackendFailure(result, findings),
    );
  }

  return {
    callId: call.id,
    toolName: call.name,
    status: "success",
    output: JSON.stringify(evidenceFromFindings(findings), null, 2),
    structuredOutput:
      status === "partial" ? { findings, warning: "partial" } : { findings },
  };
}

function thrownBackendFailureResult(
  call: HarnessToolCall,
  error: unknown,
): HarnessToolResult {
  return specialistBackendFailedResult(
    call,
    error instanceof Error ? error.message : String(error),
  );
}

function availabilityInputFromContext(
  context: HarnessToolExecutionContext,
): HarnessToolAvailabilityInput {
  return {
    assistantId: context.assistantId,
    turnId: context.turnId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  };
}

export function createGitHubEnumerateTool(
  librarian: GitHubLibrarian,
): HarnessToolRegistry {
  return {
    async listAvailable() {
      return [GITHUB_ENUMERATE_TOOL];
    },

    async execute(call, context) {
      if (call.name !== GITHUB_ENUMERATE_TOOL_NAME) {
        return unknownToolResult(call);
      }

      const validation = validateGitHubEnumerateInput(call.input);
      if (!validation.ok) {
        return invalidInputResult(call, validation.message);
      }

      try {
        const result = await librarian.handler.execute(
          buildGitHubEnumerateInstruction(validation.value),
          context,
        );
        return mapSpecialistResult(call, result, result);
      } catch (error) {
        return thrownBackendFailureResult(call, error);
      }
    },
  };
}

export function createGitHubInvestigateTool(
  investigator: GitHubInvestigator,
): HarnessToolRegistry {
  return {
    async listAvailable() {
      return [GITHUB_INVESTIGATE_TOOL];
    },

    async execute(call, context) {
      if (call.name !== GITHUB_INVESTIGATE_TOOL_NAME) {
        return unknownToolResult(call);
      }

      const validation = validateGitHubInvestigateInput(call.input);
      if (!validation.ok) {
        return invalidInputResult(call, validation.message);
      }

      try {
        const result = await investigator.handler.execute(
          buildGitHubInvestigateInstruction(call, validation.value),
          context as unknown as Parameters<
            GitHubInvestigator["handler"]["execute"]
          >[1],
        );
        return mapSpecialistResult(call, result, findingsFromInvestigatorResult(result));
      } catch (error) {
        return thrownBackendFailureResult(call, error);
      }
    },
  };
}

export function createLinearEnumerateTool(
  librarian: LinearLibrarian,
): HarnessToolRegistry {
  return {
    async listAvailable() {
      return [LINEAR_ENUMERATE_TOOL];
    },

    async execute(call, context) {
      if (call.name !== LINEAR_ENUMERATE_TOOL_NAME) {
        return unknownToolResult(call);
      }

      const validation = validateLinearEnumerateInput(call.input);
      if (!validation.ok) {
        return invalidInputResult(call, validation.message);
      }

      try {
        const result = await librarian.handler.execute(
          buildLinearEnumerateInstruction(validation.value),
          context,
        );
        return mapSpecialistResult(call, result, result);
      } catch (error) {
        return thrownBackendFailureResult(call, error);
      }
    },
  };
}

export function composeToolRegistries(
  ...registries: HarnessToolRegistry[]
): HarnessToolRegistry {
  return {
    async listAvailable(input) {
      const toolLists = await Promise.all(
        registries.map((registry) => registry.listAvailable(input)),
      );
      return toolLists.flat();
    },

    async execute(call, context) {
      const availabilityInput = availabilityInputFromContext(context);

      for (const registry of registries) {
        const tools = await registry.listAvailable(availabilityInput);
        if (tools.some((tool) => tool.name === call.name)) {
          return registry.execute(call, context);
        }
      }

      return unknownToolResult(call);
    },
  };
}

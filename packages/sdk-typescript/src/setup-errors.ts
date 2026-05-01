export type RelaycastSetupErrorCode =
  | 'api_error'
  | 'malformed_api_response'
  | 'workspace_not_found'
  | 'agent_not_registered'
  | 'missing_api_key';

interface RelaycastSetupErrorOptions {
  cause?: unknown;
}

export class RelaycastSetupError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: RelaycastSetupErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;

    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * The API returned a non-2xx response.
 * HTTP 4xx and 5xx responses land here.
 */
export class RelaycastApiError extends RelaycastSetupError {
  readonly code = 'api_error';
  readonly httpStatus: number;
  readonly httpBody: unknown;

  constructor(httpStatus: number, httpBody: unknown, message = `Relaycast API request failed with status ${httpStatus}`) {
    super('api_error', message);
    this.httpStatus = httpStatus;
    this.httpBody = httpBody;
  }
}

/**
 * Workspace creation or join succeeded but the response was missing
 * a required field (workspaceId, apiKey, etc.).
 * Should not happen in production — indicates an API contract violation.
 */
export class MalformedApiResponseError extends RelaycastSetupError {
  readonly code = 'malformed_api_response';
  readonly field: string;
  readonly response: unknown;

  constructor(field: string, response: unknown, message = `Relaycast API response is missing required field "${field}"`) {
    super('malformed_api_response', message);
    this.field = field;
    this.response = response;
  }
}

/**
 * lookupWorkspace() found no workspace with the given name.
 */
export class WorkspaceNotFoundError extends RelaycastSetupError {
  readonly code = 'workspace_not_found';
  readonly workspaceName: string;

  constructor(workspaceName: string, message = `Workspace "${workspaceName}" was not found`) {
    super('workspace_not_found', message);
    this.workspaceName = workspaceName;
  }
}

/**
 * relay() was called with an agent name that has not been registered
 * through this handle.
 */
export class AgentNotRegisteredError extends RelaycastSetupError {
  readonly code = 'agent_not_registered';
  readonly agentName: string;

  constructor(agentName: string, message = `Agent "${agentName}" has not been registered`) {
    super('agent_not_registered', message);
    this.agentName = agentName;
  }
}

/**
 * The API key is missing or invalid when required.
 */
export class MissingApiKeyError extends RelaycastSetupError {
  readonly code = 'missing_api_key';

  constructor(message = 'API key is required for this operation') {
    super('missing_api_key', message);
  }
}

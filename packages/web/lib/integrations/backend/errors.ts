export type BackendPolicyErrorCode =
  | "backend_not_allowed"
  | "backend_not_configured"
  | "backend_not_implemented"
  | "backend_misconfigured";

export class BackendPolicyError extends Error {
  readonly code: BackendPolicyErrorCode;

  constructor(
    code: BackendPolicyErrorCode,
    message: string,
    public readonly backend?: string,
  ) {
    super(message);
    this.name = "BackendPolicyError";
    this.code = code;
  }
}

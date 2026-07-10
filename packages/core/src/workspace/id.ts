import crypto from "node:crypto";

const UNIFIED_WORKSPACE_ID_PATTERN = /^rw_[a-z0-9]{8}$/;
const LEGACY_WORKSPACE_ID_PATTERN = /^wf-[a-f0-9-]+$/;

export function generateWorkspaceId(): string {
  return `rw_${crypto.randomBytes(5).toString("hex").slice(0, 8)}`;
}

export function isValidWorkspaceId(id: string): boolean {
  return UNIFIED_WORKSPACE_ID_PATTERN.test(id.trim());
}

export function isValidWorkspaceIdAny(id: string): boolean {
  const normalized = id.trim();
  return isValidWorkspaceId(normalized) || LEGACY_WORKSPACE_ID_PATTERN.test(normalized);
}

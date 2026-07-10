/**
 * Single source of truth for workspace-id shape validation across the
 * web/integrations layer.
 *
 * Workspace ids in this codebase come in two shapes:
 *   - Legacy app workspaces — UUIDs (the original `workspaces.id` PK).
 *     UUIDs are accepted in either case (some clients normalize to
 *     uppercase, e.g. Windows GUID conventions).
 *   - Productized cloud-mount workspaces — `rw_<8hex>` (see
 *     `packages/core/src/workspace/id.ts`). Cloud's `generateWorkspaceId`
 *     emits lowercase hex from `crypto.randomBytes(...).toString("hex")`,
 *     and `core/src/workspace/id.ts:isValidWorkspaceId` is strictly
 *     case-sensitive lowercase, so we match that contract here too.
 *     `RW_517D60B6` is NOT a valid relay workspace id.
 *
 * Every consumer of "is this a valid workspace identifier" — the slack
 * proxy schema, the identity resolver, the path-level route resolver —
 * MUST import from this module. We previously duplicated the regex in
 * three places and the schema drifted to UUID-only, breaking sage's
 * second proxy call after the resolver had already been loosened (see
 * PR #488 review feedback). One module, one regex, one set of tests.
 *
 * Implementation note: `WORKSPACE_ID_PATTERN` deliberately spells out
 * `[0-9a-fA-F]` for the UUID half rather than relying on the `/i` flag,
 * because `/i` would also case-fold the `rw_` literal and the `[0-9a-f]`
 * suffix and silently accept `RW_517D60B6` — which is not a real id.
 * `looksLikeWorkspaceId` reuses the same regex so the helper and the
 * schema can never drift again.
 */

export const WORKSPACE_ID_PATTERN =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|rw_[0-9a-f]{8})$/;

export function looksLikeWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value.trim());
}

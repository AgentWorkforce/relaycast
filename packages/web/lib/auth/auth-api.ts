import { getAuthContext, getAuthUserProfile, upsertGoogleUser } from "./store";

export function loginWithGoogleIdentity(input: Parameters<typeof upsertGoogleUser>[0]) {
  return upsertGoogleUser(input);
}

export { getAuthContext, getAuthUserProfile };

export function switchWorkspace(userId: string, preferredWorkspaceId: string) {
  return getAuthContext(userId, preferredWorkspaceId);
}

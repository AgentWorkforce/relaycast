export type AuthOrganization = {
  id: string;
  slug: string;
  name: string;
  role: string;
  status: string;
};

export type AuthWorkspace = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
};

export type AuthUser = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthContext = {
  user: AuthUser;
  organizations: AuthOrganization[];
  currentOrganization: AuthOrganization;
  workspaces: AuthWorkspace[];
  currentWorkspace: AuthWorkspace;
};

export type SessionClaims = {
  userId: string;
  currentOrganizationId: string;
  currentWorkspaceId: string;
  iat: number;
  exp: number;
};

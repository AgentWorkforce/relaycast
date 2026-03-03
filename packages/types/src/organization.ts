import { z } from 'zod';

// ── Users ──

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  email_verified: z.boolean(),
  name: z.string(),
  created_at: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const SignupRequestSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const SignupResponseSchema = z.object({
  user_id: z.string(),
  created_at: z.string(),
});
export type SignupResponse = z.infer<typeof SignupResponseSchema>;

export const VerifyEmailRequestSchema = z.object({
  user_id: z.string(),
  code: z.string().length(6),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user_id: z.string(),
  organizations: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
  })),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

// ── Organizations ──

export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.enum(['free', 'pro']),
  created_at: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const CreateOrgRequestSchema = z.object({
  name: z.string().min(1),
});
export type CreateOrgRequest = z.infer<typeof CreateOrgRequestSchema>;

export const CreateOrgResponseSchema = z.object({
  organization_id: z.string(),
  org_api_key: z.string(),
  created_at: z.string(),
});
export type CreateOrgResponse = z.infer<typeof CreateOrgResponseSchema>;

// ── Memberships ──

export const OrgMembershipSchema = z.object({
  user_id: z.string(),
  organization_id: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  user_email: z.string(),
  user_name: z.string(),
  created_at: z.string(),
});
export type OrgMembership = z.infer<typeof OrgMembershipSchema>;

export const InviteMemberRequestSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).optional(),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequestSchema>;

// ── Billing ──

export const ClaimWorkspaceRequestSchema = z.object({
  workspace_api_key: z.string(),
});
export type ClaimWorkspaceRequest = z.infer<typeof ClaimWorkspaceRequestSchema>;

export const AdminSetPlanRequestSchema = z.object({
  plan: z.enum(['free', 'pro']),
});
export type AdminSetPlanRequest = z.infer<typeof AdminSetPlanRequestSchema>;

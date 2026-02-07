export interface Workspace {
  id: string;
  name: string;
  api_key_hash: string;
  system_prompt: string | null;
  plan: 'free' | 'pro' | 'enterprise';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface CreateWorkspaceRequest {
  name: string;
}

export interface CreateWorkspaceResponse {
  workspace_id: string;
  api_key: string;
  created_at: string;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  system_prompt?: string;
}

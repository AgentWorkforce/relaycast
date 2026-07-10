export interface Bindings {
  CACHE_KV: KVNamespace;
  CREDENTIAL_PROXY_JWT_SECRET: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ENVIRONMENT: string;
}

export type AppEnv = {
  Bindings: Bindings;
};

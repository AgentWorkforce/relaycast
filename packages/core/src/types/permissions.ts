export interface AgentPermissions {
  ignored?: string[];
  readonly?: string[];
}

export interface SystemPermissions {
  // Always applied to all agents regardless of workflow config
  alwaysReadonly: string[];
  alwaysIgnored: string[];
}

export const DEFAULT_SYSTEM_PERMISSIONS: SystemPermissions = {
  alwaysReadonly: [
    '.github/workflows/**',
    'Dockerfile',
    'docker-compose*.yml',
  ],
  alwaysIgnored: [
    '.env',
    '.env.*',
    '**/*.pem',
    '**/*.key',
    '**/credentials*',
  ],
};

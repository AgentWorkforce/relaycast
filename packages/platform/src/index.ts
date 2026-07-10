export {
  createPlatformClient,
  createPlatformDb,
  getWorkspacePolicy,
  grantProductAccess,
  registerProduct,
  revokeProductAccess,
} from "./client.js";
export {
  bootstrapPlatform,
  DEFAULT_PLATFORM_PRODUCTS,
} from "./bootstrap.js";
export {
  platformProducts,
  workspacePlatformAccess,
  workspacePlatformPolicies,
} from "./schema.js";
export type {
  PlatformClient,
  PlatformDb,
  ProductAccessInput,
  ProductRegistrationInput,
} from "./client.js";
export type {
  NewPlatformProduct,
  NewWorkspacePlatformAccessRecord,
  NewWorkspacePlatformPolicyRecord,
  PlatformProduct,
  WorkspacePlatformAccessRecord,
  WorkspacePlatformPolicyRecord,
  WorkspacePolicy,
} from "./schema.js";

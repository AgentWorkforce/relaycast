declare module "sst" {
  export interface Resource {
    NeonDatabaseUrl: {
      value: string;
    };
    CredentialEncryptionKey: {
      value: string;
    };
    HouseAnthropicKey: {
      value: string;
    };
    HouseOpenaiKey: {
      value: string;
    };
    HouseGoogleKey: {
      value: string;
    };
    HouseOpenrouterKey: {
      value: string;
    };
    SageSupermemoryApiKey: {
      value: string;
    };
    DaytonaApiKey: {
      value: string;
    };
    NangoSecretKey: {
      value: string;
    };
    RelayJwtSecret: {
      value: string;
    };
    WorkflowStorage: {
      bucketName: string;
      stsRoleArn?: string;
    };
    WebRelayauthApiKey: {
      value: string;
    };
  }

  export const Resource: Resource;
}

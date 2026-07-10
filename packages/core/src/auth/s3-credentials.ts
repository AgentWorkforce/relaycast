import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

export interface S3Credentials {
  backend?: 's3' | 'cloud-api';
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  prefix: string;
  cloudApiUrl?: string;
  cloudApiAccessToken?: string;
  cloudApiRefreshToken?: string;
}

export interface MintS3CredentialsOptions {
  userId: string;
  runId: string;
  roleArn: string;
  bucket: string;
  durationSeconds?: number;
}

function formatStsError(error: unknown): string {
  if (error && typeof error === 'object') {
    const stsError = error as {
      name?: string;
      message?: string;
      $metadata?: { requestId?: string };
    };

    const code = stsError.name ?? 'STS error';
    const requestId = stsError.$metadata?.requestId ? ` (requestId: ${stsError.$metadata.requestId})` : '';
    const details = stsError.message ?? 'No additional details were returned.';
    return `${code}: ${details}${requestId}`;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return 'Unknown STS error';
}

export async function mintS3Credentials({
  userId,
  runId,
  roleArn,
  bucket,
  durationSeconds = 3600,
}: MintS3CredentialsOptions): Promise<S3Credentials> {
  const sts = new STSClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  });

  const prefix = `${userId}/${runId}`;
  const resourceArn = `arn:aws:s3:::${bucket}/${prefix}/*`;

  const sessionPolicy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: [
          's3:PutObject',
          's3:GetObject',
          's3:CreateMultipartUpload',
          's3:UploadPart',
          's3:CompleteMultipartUpload',
          's3:AbortMultipartUpload',
        ],
        Resource: resourceArn,
      },
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: {
          StringLike: {
            's3:prefix': [`${prefix}/*`],
          },
        },
      },
    ],
  });

  try {
    const command = new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `workflow-${runId}`,
      DurationSeconds: durationSeconds,
      Policy: sessionPolicy,
    });

    const response = await sts.send(command);

    const credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new Error('STS AssumeRole response missing temporary credentials');
    }

    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      bucket,
      prefix,
    };
  } catch (error: unknown) {
    throw new Error(
      `Failed to mint S3 credentials for role ${roleArn} and run ${runId}: ${formatStsError(error)}`
    );
  }
}

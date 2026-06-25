import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, isR2Configured } from '../config/env.js';

const client = isR2Configured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
    })
  : null;

export function buildObjectKey(params: {
  workspaceId: string;
  projectId?: string | null;
  fileId: string;
  fileName: string;
}): string {
  const safeName = params.fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const scope = params.projectId
    ? `projects/${params.projectId}`
    : 'workspace';
  return `workspaces/${params.workspaceId}/${scope}/uploads/${params.fileId}/${safeName}`;
}

export async function getUploadUrl(objectKey: string, contentType: string): Promise<string> {
  if (!client) throw new Error('R2 not configured');
  const command = new PutObjectCommand({
    Bucket: env.r2.bucket,
    Key: objectKey,
    ContentType: contentType,
  });
  return getSignedUrl(client, command, { expiresIn: 60 * 5 });
}

export async function uploadObject(params: {
  objectKey: string;
  contentType: string;
  body: Buffer;
}): Promise<void> {
  if (!client) throw new Error('R2 not configured');
  await client.send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: params.objectKey,
      ContentType: params.contentType,
      Body: params.body,
    }),
  );
}

export async function getDownloadUrl(objectKey: string): Promise<string> {
  if (!client) throw new Error('R2 not configured');
  const command = new GetObjectCommand({
    Bucket: env.r2.bucket,
    Key: objectKey,
  });
  return getSignedUrl(client, command, { expiresIn: 60 * 60 });
}

// Read the raw bytes of a stored object (used for multimodal AI context generation).
export async function getObjectBytes(objectKey: string): Promise<Buffer> {
  if (!client) throw new Error('R2 not configured');
  const result = await client.send(
    new GetObjectCommand({ Bucket: env.r2.bucket, Key: objectKey }),
  );
  const body = result.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (!body?.transformToByteArray) throw new Error('Unable to read object body');
  return Buffer.from(await body.transformToByteArray());
}

export async function deleteObject(objectKey: string): Promise<void> {
  if (!client) throw new Error('R2 not configured');
  await client.send(
    new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: objectKey }),
  );
}

export { isR2Configured };

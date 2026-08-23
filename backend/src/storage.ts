import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.AWS_REGION || "af-south-1";
const bucket = () => {
  const value = process.env.DATA_ROOM_S3_BUCKET?.trim();
  if (!value) throw new Error("Missing required server configuration: DATA_ROOM_S3_BUCKET");
  return value;
};
const client = new S3Client({ region });

export function validateUpload(fileName: string, contentType: string, contentLength: number) {
  const max = Number(process.env.DATA_ROOM_MAX_FILE_BYTES || 25 * 1024 * 1024);
  if (!fileName || fileName.length > 240) throw new Error("Invalid file name");
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > max) throw new Error("File size is not permitted");
  if (!contentType || contentType.length > 160) throw new Error("Invalid content type");
  if (/\.(exe|dll|bat|cmd|sh|js|mjs|html?|svg)$/i.test(fileName)) throw new Error("Executable or active-content files are not permitted");
}

export async function createUploadUrl(storageKey: string, contentType: string) {
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket(), Key: storageKey, ContentType: contentType, ServerSideEncryption: "AES256" }), { expiresIn: 300 });
}

export async function createDownloadUrl(storageKey: string, fileName?: string) {
  const safeName = (fileName || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket(), Key: storageKey, ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn: 120 });
}

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { InvestorInputError } from "./investors.js";

const region = process.env.AWS_REGION || "af-south-1";
const bucket = () => {
  const value = process.env.DATA_ROOM_S3_BUCKET?.trim();
  if (!value) throw new Error("Missing required server configuration: DATA_ROOM_S3_BUCKET");
  return value;
};
// Browser uploads use a presigned PUT. Newer SDKs add a CRC32 checksum of an
// empty body to presigned URLs by default; the browser's real file never
// matches it, so only send checksums when S3 requires them.
const client = new S3Client({ region, requestChecksumCalculation: "WHEN_REQUIRED" });

// These are the filer's mistakes, so they come back as 400 with the message.
export function validateUpload(fileName: string, contentType: string, contentLength: number) {
  const max = Number(process.env.DATA_ROOM_MAX_FILE_BYTES || 10 * 1024 * 1024);
  if (!fileName || fileName.length > 240) throw new InvestorInputError("Invalid file name");
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > max) throw new InvestorInputError("Uploads are capped at 10 MB per file; use a link for larger files");
  if (!contentType || contentType.length > 160) throw new InvestorInputError("Invalid content type");
  if (/\.(exe|dll|bat|cmd|sh|js|mjs|html?|svg)$/i.test(fileName)) throw new InvestorInputError("Executable or active-content files are not permitted");
}

export async function createUploadUrl(storageKey: string, contentType: string) {
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket(), Key: storageKey, ContentType: contentType }), { expiresIn: 300 });
}

export async function createDownloadUrl(storageKey: string, fileName?: string) {
  const safeName = (fileName || "document").replace(/[^a-zA-Z0-9._-]/g, "_");
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket(), Key: storageKey, ResponseContentDisposition: `attachment; filename="${safeName}"` }), { expiresIn: 120 });
}

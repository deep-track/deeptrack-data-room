// Issues short-lived client upload tokens for Vercel Blob. Files are uploaded
// directly from the browser to Blob storage using these tokens — they never
// pass through this function's body, so we aren't bound by the ~4.5MB request
// size cap that applies to normal serverless function calls.
// Requires a Blob store connected to this project (Storage tab -> Create Database -> Blob),
// which auto-injects BLOB_READ_WRITE_TOKEN into the project's environment variables.

import { handleUpload } from '@vercel/blob/client';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(500).json({ error: 'No Blob store is connected to this project yet. Add one from the Storage tab in Vercel, then redeploy.' });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        access: 'public',
        addRandomSuffix: true,
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
      }),
    });
    res.status(200).json(jsonResponse);
  } catch (e) {
    res.status(400).json({ error: String(e && e.message ? e.message : e) });
  }
}


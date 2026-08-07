import { head } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const blobUrl = req.query.url;

    if (!blobUrl) {
      return res.status(400).json({ error: 'Missing blob URL' });
    }

    const blob = await head(blobUrl);

    res.status(200).json({
      url: blob.downloadUrl
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: e?.message || 'Could not generate download URL'
    });
  }
}
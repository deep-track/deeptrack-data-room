# Deeptrack Data Room

Internal fundraising data room. Single static page (`index.html`) + one
serverless function (`api/kv.js`) that stores the room's state (documents,
access codes, activity log, Q&A) in Redis so it's shared between you, the
Chief of Staff, and every investor with a code — not just saved in one
browser.

Everything below is free. No paid tier, no credit card required.

## 1. Get the code onto Vercel

Easiest path — no git needed:

```
npm i -g vercel        # one-time
cd deeptrack-dataroom-app
vercel                 # follow the prompts, pick "no" for build settings (static)
vercel --prod           # promote to production
```

Or push this folder to a new GitHub repo and use "Add New Project" →
"Import Git Repository" in the Vercel dashboard. Either way works, both are
on the free Hobby plan.

## 2. Attach free storage (Upstash Redis)

1. Open the project in the Vercel dashboard → **Storage** tab.
2. **Create Database** → choose **Upstash** → **Redis** → the **Free** tier
   (no card needed).
3. Connect it to this project — Vercel automatically adds the right
   environment variables (`KV_REST_API_URL` / `KV_REST_API_TOKEN` or
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` depending on how
   Vercel is naming it that week — `api/kv.js` checks for both).
4. **Redeploy** the project once (Deployments → ⋯ → Redeploy) so the
   function picks up the new environment variables.

Free tier limits (10K commands/day, 256MB) are miles more than a five-person
data room will ever use.

## 2b. Attach free file storage (Vercel Blob) — for manual uploads

The room supports two ways to attach a document: a link to somewhere the file
already lives (Drive, Notion, etc.), or uploading the file directly into the
room. The upload path needs its own storage:

1. Project → **Storage** tab → **Create Database** → **Blob** → **Free** tier.
2. Connect it to this project — Vercel injects `BLOB_READ_WRITE_TOKEN`
   automatically.
3. **Redeploy** once so the function picks it up.

Direct uploads are capped at **10MB per file**. Files upload straight from
the browser to Blob storage (not through the serverless function), so this
cap is a deliberate setting, not a platform limit — it can be raised later by
changing `MAX_UPLOAD_BYTES` in `index.html` and `api/upload.js`. For anything
bigger than 10MB, use the Link tab instead and point at wherever the file
already lives.

## 3. Point investorrelations.deeptrack.io at it

1. Project → **Settings → Domains** → add `investorrelations.deeptrack.io`.
2. Vercel will show you a CNAME target, normally `cname.vercel-dns.com`.
3. In wherever `deeptrack.io`'s DNS is managed, add:
   ```
   Type:  CNAME
   Name:  investorrelations
   Value: cname.vercel-dns.com
   ```
4. Wait for DNS to propagate (usually minutes, sometimes up to an hour).
   Vercel issues the SSL certificate automatically once it verifies.

## 4. First login

Open `investorrelations.deeptrack.io`. Default codes baked into the app:

- Founder: `FOUNDER-4471`
- Chief of Staff: `STAFF-2290`

**Change both immediately** from **Access & settings** once you're in — they
ship as plain defaults in the code, so anyone who reads the source has them
until you rotate them. Issue investor codes from that same screen as you
bring VCs into the room.

## What this is (and isn't)

- Documents are an *index*, not file storage — each entry is a title, a
  clearance tier, and a link out to the real file (Drive, Notion, wherever
  it already lives). That keeps this app free and fast; the source files
  stay where you already manage them.
- Access codes are a lightweight gate, not encryption. Fine for controlling
  who sees what and tracking engagement — not the place for anything that
  would be damaging if it leaked outside a code check.

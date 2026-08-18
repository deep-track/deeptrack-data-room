# Deeptrack Data Room — Initial Audit

## Executive assessment

The supplied project is a **monolithic HTML/JavaScript data room**, rather than a TypeScript application. It has a useful information model—document folders, clearance tiers, an NDA acknowledgement, investor codes, activity history, Q&A, and a document drawer—but the current architecture is not sufficient for a confidential company data room without further work.

The upload and download problems are consequences of the existing design rather than isolated button defects. The browser imports the Vercel Blob client dynamically from a third-party CDN, relies on an unauthenticated upload-token route, writes uploaded files as publicly accessible blobs, and tries to force download by fetching the remote object back into the browser. Any failure in storage configuration, external module loading, blob CORS, or remote file availability produces a brittle experience. The fallback opens the remote document in a new tab rather than guaranteeing a downloaded file.

| Area | Current finding | Repair direction |
|---|---|---|
| Codebase | One large `index.html` contains layout, state, login, document forms, uploads, downloads, admin tools, and all rendering logic. | Split into typed React components, server routes, domain types, and storage/access services. |
| Uploads | A CDN-loaded Blob client requests anonymous upload tokens from `/api/upload`; configuration errors are only surfaced at upload time. | Use server-authorized, typed presigned uploads to **private** storage; validate role, MIME type, size, file name, and document category before issuing a token. |
| Downloads | Browser fetches `doc.link`, converts it to an object URL, and falls back to opening a public URL. | Generate a short-lived authorized download URL with a content-disposition filename after access-tier verification. |
| Storage | Current document metadata is in Upstash Redis; uploaded files are configured as public Vercel Blob objects. | Keep metadata, document versions, access grants, NDA acknowledgements, and audit events in durable server-side storage; use private encrypted object storage for files. |
| Authentication | Default founder and staff codes are embedded in the browser bundle; the application fails open to defaults when persistence is unavailable. | Store only hashed credentials server-side, use secure HTTP-only sessions, rotate codes, rate-limit failed attempts, and fail closed if required storage is unavailable. |
| Upload authorization | The existing upload token handler checks only the presence of a Blob environment variable; it does not validate a user session or clearance tier. | Require a valid authenticated server session and founder/staff permission before issuing upload authorization. |
| Data integrity | State uses whole-object Redis read-modify-write operations and browser polling. | Use typed document records, immutable version entries, controlled updates, idempotent activity events, and explicit error states. |
| Confidentiality | Existing public blob access and client-side access codes are unsuitable for highly sensitive fundraising materials. | Use private object storage, encrypted transport, least-privilege access, server-side authorization, and auditable downloads. |
| UX and accessibility | The dark information architecture is coherent but the single page is difficult to test, extend, and make responsive. Uploads provide only a text status and no retry queue. | Add typed document cards/table, explicit upload progress and errors, retry handling, mobile navigation, keyboard controls, empty states, and accessible status messages. |

## Confirmed upload/download defects

The direct-upload handler at `api/upload.mjs` returns a Vercel Blob token only if `BLOB_READ_WRITE_TOKEN` is configured. It returns an error otherwise, meaning an unconnected Blob store makes uploads fail even though the form itself is usable. The client is also loaded from `https://esm.sh`, creating an unnecessary runtime dependency that can fail independently of the app deployment.

The app sets all uploaded files to public access and stores the resulting URL directly in the document record. Its download function retrieves that URL client-side and attempts a synthetic browser download; if the fetch fails, it simply opens the public URL. This is not a reliable, authenticated, or auditable document-download path.

## Recommended production architecture

For a confidential company data room, the TypeScript migration should use a React/Next.js user interface with server-side authentication, a typed document service, private Amazon S3 objects encrypted at rest, and short-lived server-issued upload/download URLs. Document metadata and audit events need a durable database; DynamoDB is a natural AWS-native option if the room will live in AWS, although another server-side database can be used if one is already approved.

The migration should preserve the existing investor-facing concepts—folders, clearance tiers, an NDA gate, Q&A, documents, and activity—but remove hardcoded client credentials and public document links. Production still requires owner-provided environment values and AWS resources; no real documents, credentials, or storage accounts were modified during this audit.

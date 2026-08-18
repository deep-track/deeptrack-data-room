# Deeptrack Data Room — TypeScript Migration Architecture

## Chosen approach

The repaired data room will be a **TypeScript React application** built with Vite. The interface will be separated into typed domain models, document-table and upload components, an accessible drawer, session/access controls, and a storage client. This keeps the client deployable as a static application while moving confidential document authorization to a backend contract.

The browser will never receive a long-lived cloud credential. It requests a short-lived upload or download URL from a server-side authorization endpoint. In production, that endpoint must authenticate the user, enforce the document clearance tier, log the action, and issue a private Amazon S3 presigned URL. Local development will use an explicit browser-only demo repository so the redesigned interface and document flows can be tested without cloud credentials; it is visibly marked as non-production and is not a substitute for the S3 integration.

| Layer | Responsibility | Production requirement |
|---|---|---|
| React TypeScript client | Login experience, folder navigation, document table, upload form, document drawer, loading and error states. | Build with Vite; no document secrets or cloud credentials in the bundle. |
| TypeScript domain models | Documents, versions, roles, clearance tiers, activity events, upload state, storage responses. | Shared by the client and the server implementation. |
| Document API contract | Authorize upload, persist metadata, list accessible documents, authorize download, and record activity. | Enforce server-side session and role/tier checks. |
| Private object storage | Original document bytes and versions. | AWS S3 bucket with Block Public Access, SSE-KMS or SSE-S3, TLS, lifecycle rules, and a narrow IAM policy. |
| Metadata and audit store | Document records, access grants, NDA acknowledgements, versions, and append-only activity records. | DynamoDB, RDS, or an existing approved database; never browser storage for production. |
| Authentication | Founder/staff/investor identity and access-code replacement. | Hashed credentials or SSO, secure HTTP-only session cookie, expiry, rate limiting, and code rotation. |

## File-flow contract

The migration uses these typed operations.

| Operation | Client action | Server responsibility |
|---|---|---|
| Upload authorization | Send filename, MIME type, byte size, document metadata, and current session. | Reject unauthorized roles, invalid types, oversized files, or mismatched clearance; create an upload intent and return a short-lived private S3 PUT URL. |
| Upload completion | PUT the selected file directly to the signed URL, then submit the returned storage key. | Verify intent ownership, persist document metadata and the first immutable version, and log the action. |
| Download | Request the named document. | Verify the viewer’s clearance/NDA/session, log the action, and return a short-lived GET URL with `Content-Disposition: attachment`. |
| List/search | Request only visible document metadata. | Filter by clearance tier and session role before returning results. |

## Improvements included in the interface migration

The TypeScript UI will eliminate the dynamic external Blob client import, the public-object fallback, and the implicit persistence failure mode. It will validate selected files before any network request, preserve a dropped file in typed component state, present upload progress/error/retry feedback, distinguish opening a link from downloading a managed file, and ensure the document-table actions are keyboard-accessible.

The source will include a formal `.env.example` and a deployment guide. The actual AWS API and database endpoint are intentionally left as deployment configuration because no account, bucket, database, or authentication credentials were provided with the archive.

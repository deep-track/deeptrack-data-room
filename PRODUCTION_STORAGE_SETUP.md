# Deeptrack Data Room — Production Storage and API Setup

The TypeScript client intentionally has no cloud credential, investor access code, bucket name, or long-lived file URL. To move from local review mode to an actual confidential data room, point `VITE_DATA_ROOM_API_BASE_URL` to a protected server-side data-room API.

## Required private AWS resources

| Resource | Required configuration |
|---|---|
| Amazon S3 bucket | Block all public access, default encryption with SSE-S3 or SSE-KMS, versioning enabled, no public bucket policy, and a lifecycle policy for unneeded uploads. |
| Application API | HTTPS API Gateway, Lambda, ECS, or an existing approved backend. It must validate the user’s session and access tier before every document list, upload intent, metadata write, or download URL request. |
| Metadata store | DynamoDB, RDS, or another approved server-side database for document metadata, access grants, NDA acceptance, versions, and immutable audit events. |
| Authentication | Server-side hashed codes or SSO; secure HTTP-only sessions; failure-rate limits; revocation and expiry. The browser must never compare a secret access code directly. |
| IAM role | Narrow policy: only the required bucket prefix, presigned `PutObject` / `GetObject`, metadata access, and audit-event writes. Do not issue broad account or bucket permissions. |

## API routes expected by the client

| Route | Method | Server responsibility |
|---|---|---|
| `/documents` | `GET` | Verify session and clearance, then return only accessible document metadata. |
| `/uploads` | `POST` | Validate file name, size, MIME type, role, category, and tier; create an upload intent and return a short-lived private S3 `PUT` URL plus storage key. |
| `/documents` | `POST` | Verify the upload intent belongs to the caller, persist document metadata/version, and write an audit event. |
| `/documents/:id/download` | `GET` | Verify session, NDA, and clearance; write an audit event; return a short-lived S3 `GET` URL with attachment content disposition. |

## Security acceptance conditions

No S3 object should be public. Upload and download URLs should be short lived and scoped to one object. Access codes must be hashed and stored only server side. Audit events must be appended server side for login, document view, upload, download, access changes, and NDA acceptance. Configure production CORS only for the approved data-room origin, and use a content-security policy appropriate to the final hosting arrangement.

## Role enforcement requirements

The production API must resolve an authenticated role on every request. The **Founder** has room ownership and administrator assignment powers. The **Investor Relations Officer** is an operational administrator for document filing, controlled publication, investor invitations, and reporting, but may not change founder ownership or delete audit evidence. The **Investor** can only receive approved metadata and download URLs where their NDA state, expiry, and clearance tier permit it. Frontend role visibility is only a convenience; all authorization decisions must be enforced in API middleware and query filters.

The preview reserves Founder review entry for `bryan@deeptrack.io` and Investor Relations Officer review entry for `ygachara@deeptrack.io`; it leaves Investor entry open to valid email addresses. In production, replace this browser-only convenience check with a server-side allowlist that maps the authenticated identity-provider subject to the approved administrative role. Email text entered in a browser must never by itself grant Founder or Investor Relations authority.

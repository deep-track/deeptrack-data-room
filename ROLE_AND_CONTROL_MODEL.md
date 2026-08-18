# Deeptrack Data Room — Role and Control Model

This model defines a comprehensive investor-diligence environment. Its controls support disciplined document distribution, authority separation, and auditable access without positioning the product around a particular fundraising or listing stage.

## Roles

The data room has three deliberate roles. Permissions must be enforced by the production server and storage service, not by the React interface alone.

| Role | Intended user | Operating purpose | Authority boundary |
|---|---|---|---|
| **Founder** | Deeptrack founder / owner | Holds super privileges and final accountability for the room. | Can configure the room, manage administrators, approve/restrict/withdraw documents, manage investor access, and view all audit records. The founder cannot erase immutable audit history. |
| **Investor Relations Officer** | Deeptrack Investor Relations function | Operational administrator for the diligence process. | Can upload/version/publish documents, manage investor invitations and clearance tiers, respond to Q&A, review activity, and create reporting exports. Cannot change founder ownership, remove immutable audit evidence, or bypass a founder-imposed restriction. |
| **Investor** | Invited prospective or current investor | Controlled, read-only diligence participant. | Can only see approved documents within their clearance tier, search metadata, view permitted records, download permitted documents, acknowledge NDA terms, and submit questions. Cannot upload, alter documents, alter access, change tiers, or administer the room. |

## Permission matrix

| Capability | Founder | Investor Relations Officer | Investor |
|---|---:|---:|---:|
| View approved documents within permitted tier | Yes | Yes | Yes |
| Download permitted documents | Yes | Yes | Yes, with audit logging |
| Upload new documents | Yes | Yes | No |
| Create a new version | Yes | Yes | No |
| Set document clearance and status | Yes | Yes, within founder policy | No |
| Publish / withdraw an investor-visible document | Yes | Yes, within founder policy | No |
| Manage investor invitations and expiry | Yes | Yes | No |
| Assign or remove administrators | Yes | No | No |
| View audit log and access reporting | Yes | Yes | No |
| Export audit / reporting data | Yes | Yes | No |
| Answer investor Q&A | Yes | Yes | Ask questions only |
| Delete immutable audit records | No | No | No |

## Comprehensive document controls

Every document should have a clearance tier, a disclosure status, an owner, a review record, a version history, and a distribution policy. The investor-visible state should be limited to **Approved** documents. Draft, internal-review, superseded, and withdrawn records are retained for administrative traceability but never appear in the investor view.

| Control | Purpose |
|---|---|
| **NDA acknowledgement** | Capture a server-side acknowledgement timestamp before first access, and preserve the version of the terms accepted. |
| **Access expiry** | Every investor invitation must have a defined expiry time, an active/revoked state, and a server-enforced clearance tier. |
| **Download audit** | Record successful document generation, viewer identity, document/version, source IP, timestamp, and disposition. Do not rely on browser-only events. |
| **Watermark policy** | Mark investor downloads or view previews with the recipient identity, document identifier, and timestamp where the approved document renderer supports it. |
| **Disclosure review** | Require a named reviewer and status before a document becomes investor-visible; show the owner and next review date to administrators. |
| **Version discipline** | Preserve prior versions and mark one record as current. A new upload must never silently overwrite an old file. |
| **Q&A workflow** | Allow investors to submit questions; route responses through Founder or Investor Relations and preserve a reviewable thread. |
| **Audit preservation** | Append immutable events for login, access denial, NDA acceptance, invite changes, upload, publication, view, download, withdrawal, and Q&A actions. |

## Production authentication boundary

The upgraded interface includes a role-aware demonstration login only. It has **no real passwords** and must never be deployed as the security layer. Production must use a server-side identity provider or hashed credentials, MFA, secure HTTP-only sessions, rate limiting, session expiration, and server-side permission middleware. The API must filter document lists and presigned upload/download operations by the authenticated role, access expiry, NDA state, clearance tier, and document disclosure status.
